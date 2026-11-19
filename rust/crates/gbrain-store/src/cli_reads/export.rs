//! The statements of `src/core/engine-sql/export-reads.ts`: what `gbrain export` reads. PGLite and
//! Postgres run SQL; these answer the same rows, in the same order and types, from the store's
//! records.
//!
//! What the store does not keep, and what each read answers for it (rust/docs/store/cli-reads-export.md):
//! - no statement timeout: `setLocalStatementTimeout` runs only in TypeScript and does nothing;
//! - no `fact_purges` rows: the withdrawal list holds withdrawals only, each with `purged` false;
//! - no folder rules: the list of sources with an access policy is empty.
//!
//! Keys: none of its own. It reads the page, page-id, page-body, raw-data and withdrawal records.

use super::pg_text::{jsonb_text, timestamptz_text};
use super::reads::pages_after;
use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::links::no_nul;
use crate::page_body::segmented_reference;
use crate::raw_files::page_raw_rows;
use crate::trust::withdrawals::source_withdrawals;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Rows per export batch (`LIMIT 256`).
const EXPORT_BATCH: usize = 256;
/// `left(text, 4097)`: the export reads one character past its 4,096-character path limit.
const KEY_CHARS: usize = 4097;

/// `listExportPageKeys(q)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportPageKeyQuery {
    pub after_id: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default, rename = "type")]
    pub page_type: Option<String>,
    #[serde(default)]
    pub slug_prefix: Option<String>,
}

/// One row of `listExportPageKeys`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExportPageKey {
    pub id: String,
    pub segmented: bool,
    pub slug: String,
    pub source_id: String,
    pub source_path: Option<String>,
    pub source_path_bytes: Option<i64>,
    pub raw_count: i64,
    pub bytes: Option<i64>,
}

/// One row of `listExportWithdrawals`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExportWithdrawal {
    pub visibility: String,
    pub fact_hash: String,
    pub withdrawn_at: String,
    pub subject: String,
    pub purged: bool,
}

/// `left(text, n)`: the first `n` characters.
fn left(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

fn octets(text: &str) -> i64 {
    i64::try_from(text.len()).unwrap_or(i64::MAX)
}

/// `to_jsonb(timestamptz)` with TimeZone UTC: `2026-01-03T00:00:00.215+00:00`, trailing fraction
/// zeros dropped.
fn jsonb_timestamptz(micros: i64) -> String {
    format!("{}:00", timestamptz_text(micros).replacen(' ', "T", 1))
}

impl Store {
    /// `listExportPageKeys`: the next 256 live pages after page id `after_id`, in id order, in
    /// `source_id`, of `type` and under `slug_prefix` (each `None`: any). `bytes` is the SQL's
    /// payload sum: the segmented body's `body_bytes` (an inline page's `compiled_truth` and
    /// `timeline` octets), the frontmatter's jsonb text, the title, slug and source path, each raw
    /// row's jsonb text and source, and the tags. `after_id` that is not an integer refuses, as
    /// the `::bigint` cast does.
    pub fn list_export_page_keys(&self, q: &ExportPageKeyQuery) -> Result<Vec<ExportPageKey>> {
        const OP: &str = "listExportPageKeys";
        let after: i64 = q.after_id.trim().parse().map_err(|_| {
            StoreError::invalid(format!(
                "{OP}: invalid input syntax for type bigint: \"{}\"",
                q.after_id
            ))
        })?;
        let mut texts = Vec::new();
        for (name, value) in [
            ("sourceId", &q.source_id),
            ("type", &q.page_type),
            ("slugPrefix", &q.slug_prefix),
        ] {
            if let Some(v) = value {
                texts.push((name, v.as_str()));
            }
        }
        no_nul(OP, &texts)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        pages_after(&*read, after, &mut |page| {
            if page.deleted_at_us.is_some()
                || q.source_id.as_ref().is_some_and(|s| *s != page.source_id)
                || q.page_type.as_ref().is_some_and(|t| *t != page.page_type)
                || q.slug_prefix
                    .as_ref()
                    .is_some_and(|p| !page.slug.starts_with(p.as_str()))
            {
                return Ok(true);
            }
            let segmented = segmented_reference(&*read, page.id)?;
            let raw = page_raw_rows(&*read, page.id)?;
            let body = match &segmented {
                Some((_, body_bytes)) => *body_bytes,
                None => match (page.compiled_truth.as_deref(), page.timeline.as_deref()) {
                    (Some(truth), Some(timeline)) => Some(octets(truth) + octets(timeline)),
                    _ => None,
                },
            };
            let frontmatter = jsonb_text(&Value::Object(page.frontmatter.clone()));
            let raw_bytes: i64 = raw
                .iter()
                .map(|r| octets(&jsonb_text(&r.data)) + octets(&r.source))
                .sum();
            let tag_bytes: i64 = page.tags.iter().map(|t| octets(t)).sum();
            let source_path_bytes = page.source_path.as_deref().map(octets);
            let bytes = body.map(|b| {
                b + octets(&frontmatter)
                    + octets(&page.title)
                    + octets(&page.slug)
                    + source_path_bytes.unwrap_or(0)
                    + raw_bytes
                    + tag_bytes
            });
            rows.push(ExportPageKey {
                id: page.id.to_string(),
                segmented: segmented.is_some(),
                slug: left(&page.slug, KEY_CHARS),
                source_id: page.source_id.clone(),
                source_path: page.source_path.as_deref().map(|p| left(p, KEY_CHARS)),
                source_path_bytes,
                raw_count: i64::try_from(raw.len()).unwrap_or(i64::MAX),
                bytes,
            });
            Ok(rows.len() < EXPORT_BATCH)
        })?;
        Ok(rows)
    }

    /// `readExportWithdrawalLedgerBytes`: the bytes of the source's withdrawal ledger as the export
    /// sizes it, `sum(octet_length(jsonb_build_object('visibility', 'fact_hash', 'withdrawn_at',
    /// 'subject')::text) + 1) + 2`.
    pub fn read_export_withdrawal_ledger_bytes(&self, source_id: &str) -> Result<i64> {
        no_nul(
            "readExportWithdrawalLedgerBytes",
            &[("sourceId", source_id)],
        )?;
        let read = self.read()?;
        let rows = source_withdrawals(&*read, source_id)?;
        Ok(rows
            .iter()
            .map(|w| {
                let row = json!({
                    "visibility": w.visibility,
                    "fact_hash": w.fact_hash,
                    "withdrawn_at": jsonb_timestamptz(w.withdrawn_at_us),
                    "subject": w.subject,
                });
                octets(&jsonb_text(&row)) + 1
            })
            .sum::<i64>()
            + 2)
    }

    /// `listExportWithdrawals`: the source's withdrawals ordered by visibility, fact_hash and
    /// subject (byte order), `withdrawn_at` as ISO text. The store keeps no purge tombstones, so
    /// every row has `purged` false.
    pub fn list_export_withdrawals(&self, source_id: &str) -> Result<Vec<ExportWithdrawal>> {
        no_nul("listExportWithdrawals", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut rows: Vec<ExportWithdrawal> = source_withdrawals(&*read, source_id)?
            .into_iter()
            .map(|w| ExportWithdrawal {
                visibility: w.visibility,
                fact_hash: w.fact_hash,
                withdrawn_at: iso(w.withdrawn_at_us),
                subject: w.subject,
                purged: false,
            })
            .collect();
        rows.sort_by(|a, b| {
            (
                a.visibility.as_bytes(),
                a.fact_hash.as_bytes(),
                a.subject.as_bytes(),
            )
                .cmp(&(
                    b.visibility.as_bytes(),
                    b.fact_hash.as_bytes(),
                    b.subject.as_bytes(),
                ))
        });
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;

    fn page(s: &Store, slug: &str, body: &str) {
        let input = PageInput {
            page_type: "note".into(),
            title: "T".into(),
            compiled_truth: body.into(),
            ..PageInput::default()
        };
        s.put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
    }

    fn query(after: &str) -> ExportPageKeyQuery {
        ExportPageKeyQuery {
            after_id: after.into(),
            source_id: None,
            page_type: None,
            slug_prefix: None,
        }
    }

    #[test]
    fn keys_follow_the_cursor_and_filters() {
        let s = store();
        page(&s, "notes/a", "abc");
        page(&s, "people/b", "hello");
        let all = s.list_export_page_keys(&query("0")).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].slug, "notes/a");
        assert!(!all[0].segmented);
        assert_eq!(all[0].raw_count, 0);
        // 3 body octets + "{}" + "T" + "notes/a".
        assert_eq!(all[0].bytes, Some(3 + 2 + 1 + 7));
        let after = s.list_export_page_keys(&query(&all[0].id)).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].slug, "people/b");
        let mut prefixed = query("0");
        prefixed.slug_prefix = Some("people/".into());
        assert_eq!(s.list_export_page_keys(&prefixed).unwrap().len(), 1);
        assert!(s.list_export_page_keys(&query("x")).is_err());
    }

    #[test]
    fn timestamps_take_the_jsonb_form() {
        assert_eq!(
            jsonb_timestamptz(1_795_000_000_215_000),
            "2026-11-18T11:06:40.215+00:00"
        );
        assert_eq!(
            jsonb_timestamptz(1_795_000_000_000_000),
            "2026-11-18T11:06:40+00:00"
        );
    }

    #[test]
    fn an_empty_ledger_is_two_bytes() {
        let s = store();
        assert_eq!(s.read_export_withdrawal_ledger_bytes("default").unwrap(), 2);
    }
}
