//! The statements of `src/core/engine-sql/export-reads.ts`: what `gbrain export` reads. PGLite and
//! Postgres run SQL; these answer the same rows, in the same order and types, from the store's
//! records.
//!
//! What the store does not keep, and what each read answers for it (rust/docs/store/cli-reads-export.md):
//! - no statement timeout: `setLocalStatementTimeout` runs only in TypeScript and does nothing;
//! - no folder rules: the list of sources with an access policy is empty.
//!
//! Keys: none of its own. It reads the page, page-id, page-body, raw-data, withdrawal and fact
//! purge records.

use super::pg_text::{is_pg_space, jsonb_text, pg_lower, timestamptz_text};
use super::reads::pages_after;
use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::facts::purge_ledger::source_purges;
use crate::links::no_nul;
use crate::page_body::{
    ManifestRow, in_generation, manifest_rows, page_u64, read_body_state, segmented_reference,
};
use crate::pages::read_page_by_id;
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

/// One row of `readExportPageRows`: the page as `getPage` gives it and its tags in byte order.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExportPageRow {
    pub page: Value,
    pub tags: Vec<String>,
}

/// `$1::bigint`: an id that is not a 64-bit integer refuses as the cast does.
fn bigint(op: &str, text: &str) -> Result<i64> {
    text.trim().parse().map_err(|_| {
        StoreError::invalid(format!(
            "{op}: invalid input syntax for type bigint: \"{text}\""
        ))
    })
}

/// One row of `normalizeFenceLines`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NormalizedFenceLines {
    pub i: i64,
    pub body: Option<String>,
    pub timeline: Option<String>,
}

/// One row of `readSegmentedPageHead`: the page's segmented-body columns and revision. A page with
/// no body record reads as Postgres's column defaults: `inline`, generation 0, the rest NULL.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SegmentedPageHead {
    pub id: i64,
    pub source_id: String,
    pub slug: String,
    pub body_storage: String,
    pub body_generation: i64,
    pub body_bytes: Option<i64>,
    pub body_lines: Option<i64>,
    pub truth_bytes: Option<i64>,
    pub body_flags: Option<Value>,
    pub segmenter_version: Option<i64>,
    pub revision: Option<String>,
}

/// One row of `readBodyManifestRows`: a published manifest row and the generation it was read at.
/// `sha256` is hex.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BodyManifestRow {
    pub seq: i64,
    pub occurrence_id: i64,
    pub region: String,
    pub sha256: String,
    pub byte_start: i64,
    pub byte_len: i64,
    pub line_start: i64,
    pub line_count: i64,
    pub static_proj_bytes: i64,
    pub static_proj_lines: i64,
    pub outline_count: i64,
    pub has_facts: bool,
    pub has_date: bool,
    pub generation: i64,
}

/// One row of `readBodyManifestMeta`: a manifest row's entry state and protected regions.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BodyManifestMeta {
    pub occurrence_id: i64,
    pub entry_state: Value,
    pub protected_regions: Value,
}

/// One row of `readBodyManifestOutline`: a manifest row's facts slots and stored outline.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BodyManifestOutline {
    pub occurrence_id: i64,
    pub facts_slots: Value,
    pub outline: Value,
}

/// `jsonb_array_length`: the stored columns are arrays (`NOT NULL DEFAULT '[]'`).
fn array_len(value: &Value) -> i64 {
    value
        .as_array()
        .map_or(0, |a| i64::try_from(a.len()).unwrap_or(i64::MAX))
}

/// `string_agg(regexp_replace(lower(line), '[[:space:]]+', ' ', 'g'), chr(10) ORDER BY ord)` over
/// `string_to_array(text, chr(10))`: `None` for an empty text (an empty array aggregates to NULL).
fn normalize_lines(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let mut out = String::with_capacity(line.len());
            let mut in_space = false;
            for c in pg_lower(line).chars() {
                if is_pg_space(c) {
                    if !in_space {
                        out.push(' ');
                    }
                    in_space = true;
                } else {
                    out.push(c);
                    in_space = false;
                }
            }
            out
        })
        .collect();
    Some(lines.join("\n"))
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
pub(crate) fn jsonb_timestamptz(micros: i64) -> String {
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
        let after = bigint(OP, &q.after_id)?;
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

    /// `listPurgeTombstones(sourceId)`: the source's fact purge tombstones and take purge tombstones,
    /// each with every column the purge stored (request id, actor, reason), in byte order of their keys.
    pub fn list_purge_tombstones(&self, source_id: &str) -> Result<serde_json::Value> {
        no_nul("listPurgeTombstones", &[("sourceId", source_id)])?;
        let read = self.read()?;
        Ok(serde_json::json!({
            "facts": crate::facts::purge_ledger::fact_purge_tombstones(&*read, source_id)?,
            "takes": crate::facts::take_purges::take_purge_tombstones(&*read, source_id)?,
        }))
    }

    /// `listExportWithdrawals`: the source's withdrawals (`purged` false) and its fact purge
    /// tombstones (`purged` true, `withdrawn_at` the purge time), ordered by visibility, fact_hash
    /// and subject (byte order), the time as ISO text.
    pub fn list_export_withdrawals(&self, source_id: &str) -> Result<Vec<ExportWithdrawal>> {
        no_nul("listExportWithdrawals", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let withdrawals =
            source_withdrawals(&*read, source_id)?
                .into_iter()
                .map(|w| ExportWithdrawal {
                    visibility: w.visibility,
                    fact_hash: w.fact_hash,
                    withdrawn_at: iso(w.withdrawn_at_us),
                    subject: w.subject,
                    purged: false,
                });
        let purges = source_purges(&*read, source_id)?
            .into_iter()
            .map(|p| ExportWithdrawal {
                visibility: p.visibility,
                fact_hash: p.fact_hash,
                withdrawn_at: iso(p.purged_at_us),
                subject: p.subject,
                purged: true,
            });
        let mut rows: Vec<ExportWithdrawal> = withdrawals.chain(purges).collect();
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

    /// `readExportPageRows`: the live pages among `ids`, in the order given (a repeated id once),
    /// each as `getPage` gives it with its tags in byte order.
    pub fn read_export_page_rows(&self, ids: &[String]) -> Result<Vec<ExportPageRow>> {
        const OP: &str = "readExportPageRows";
        let ids = ids
            .iter()
            .map(|id| bigint(OP, id))
            .collect::<Result<Vec<i64>>>()?;
        let read = self.read()?;
        let mut seen = std::collections::HashSet::new();
        let mut rows = Vec::new();
        for id in ids {
            let Ok(id) = u64::try_from(id) else { continue };
            if !seen.insert(id) {
                continue;
            }
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            if page.deleted_at_us.is_some() {
                continue;
            }
            let mut tags = page.tags.clone();
            tags.sort();
            // The page record decodes its frontmatter in jsonb key order (crate::jsonb), the order the
            // export writes the keys in.
            let row = page.to_page_with_columns(&*read)?;
            rows.push(ExportPageRow { page: row, tags });
        }
        Ok(rows)
    }

    /// `normalizeFenceLines`: `unnest($1, $2) WITH ORDINALITY`, each text normalized line by line.
    /// The shorter list is padded with NULL, as `unnest` pads it.
    pub fn normalize_fence_lines(
        &self,
        bodies: &[String],
        timelines: &[String],
    ) -> Result<Vec<NormalizedFenceLines>> {
        const OP: &str = "normalizeFenceLines";
        for text in bodies.iter().chain(timelines) {
            no_nul(OP, &[("text", text)])?;
        }
        let n = bodies.len().max(timelines.len());
        Ok((0..n)
            .map(|k| NormalizedFenceLines {
                i: i64::try_from(k + 1).unwrap_or(i64::MAX),
                body: bodies.get(k).and_then(|t| normalize_lines(t)),
                timeline: timelines.get(k).and_then(|t| normalize_lines(t)),
            })
            .collect())
    }

    /// `readSegmentedPageHead(pageId)`: `SELECT ... FROM pages WHERE id=$1`, deleted pages included.
    /// `None` when no page has that id.
    pub fn read_segmented_page_head(&self, page_id: i64) -> Result<Option<SegmentedPageHead>> {
        let read = self.read()?;
        let Some(page) = page_u64(page_id)
            .map(|id| read_page_by_id(&*read, id))
            .transpose()?
            .flatten()
        else {
            return Ok(None);
        };
        let state = read_body_state(&*read, page.id)?;
        let state = state.as_ref();
        Ok(Some(SegmentedPageHead {
            id: page_id,
            source_id: page.source_id.clone(),
            slug: page.slug.clone(),
            body_storage: state.map_or_else(|| "inline".into(), |s| s.body_storage.clone()),
            body_generation: state.map_or(0, |s| s.body_generation),
            body_bytes: state.and_then(|s| s.body_bytes),
            body_lines: state.and_then(|s| s.body_lines),
            truth_bytes: state.and_then(|s| s.truth_bytes),
            body_flags: state.and_then(|s| s.body_flags.clone()),
            segmenter_version: state.and_then(|s| s.segmenter_version),
            revision: Some(page.knowledge_revision.clone()),
        }))
    }

    /// `readBodyManifestRows(pageId, generation)`: the rows of generation
    /// `COALESCE($2, pages.body_generation)` with no staging id, in seq order. A missing page with
    /// no generation named reads none (the generation is NULL).
    pub fn read_body_manifest_rows(
        &self,
        page_id: i64,
        generation: Option<i64>,
    ) -> Result<Vec<BodyManifestRow>> {
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let generation = match generation {
            Some(g) => g,
            None => match read_page_by_id(&*read, page)? {
                Some(_) => read_body_state(&*read, page)?.map_or(0, |s| s.body_generation),
                None => return Ok(Vec::new()),
            },
        };
        let mut rows: Vec<BodyManifestRow> = manifest_rows(&*read, page)?
            .into_iter()
            .map(|(_, row)| row)
            .filter(|row| in_generation(row, generation))
            .map(|row| BodyManifestRow {
                seq: row.seq,
                occurrence_id: row.occurrence_id,
                region: row.region,
                sha256: row.sha256,
                byte_start: row.byte_start,
                byte_len: row.byte_len,
                line_start: row.line_start,
                line_count: row.line_count,
                static_proj_bytes: row.static_proj_bytes,
                static_proj_lines: row.static_proj_lines,
                outline_count: array_len(&row.outline),
                has_facts: array_len(&row.facts_slots) > 0,
                has_date: row.date_min.is_some(),
                generation,
            })
            .collect();
        rows.sort_by_key(|row| row.seq);
        Ok(rows)
    }

    /// The published rows of generation `generation` of page `page_id` whose occurrence id is in
    /// `occurrence_ids`, in seq order (Postgres sets none).
    fn named_manifest_rows(
        &self,
        page_id: i64,
        occurrence_ids: &[i64],
        generation: i64,
    ) -> Result<Vec<ManifestRow>> {
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        if occurrence_ids.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut rows: Vec<_> = manifest_rows(&*read, page)?
            .into_iter()
            .map(|(_, row)| row)
            .filter(|row| {
                in_generation(row, generation) && occurrence_ids.contains(&row.occurrence_id)
            })
            .collect();
        rows.sort_by_key(|row| row.seq);
        Ok(rows)
    }

    /// `readBodyManifestMeta(pageId, occurrenceIds, generation)`: the published rows of generation
    /// `generation` whose occurrence id is in `occurrence_ids`, with their entry state and
    /// protected regions. Postgres sets no order; these come in seq order.
    pub fn read_body_manifest_meta(
        &self,
        page_id: i64,
        occurrence_ids: &[i64],
        generation: i64,
    ) -> Result<Vec<BodyManifestMeta>> {
        Ok(self
            .named_manifest_rows(page_id, occurrence_ids, generation)?
            .into_iter()
            .map(|row| BodyManifestMeta {
                occurrence_id: row.occurrence_id,
                entry_state: row.entry_state,
                protected_regions: row.protected_regions,
            })
            .collect())
    }

    /// `readBodyManifestOutline(pageId, occurrenceIds, generation)`: the same rows as
    /// `read_body_manifest_meta`, with their facts slots and stored outline.
    pub fn read_body_manifest_outline(
        &self,
        page_id: i64,
        occurrence_ids: &[i64],
        generation: i64,
    ) -> Result<Vec<BodyManifestOutline>> {
        Ok(self
            .named_manifest_rows(page_id, occurrence_ids, generation)?
            .into_iter()
            .map(|row| BodyManifestOutline {
                occurrence_id: row.occurrence_id,
                facts_slots: row.facts_slots,
                outline: row.outline,
            })
            .collect())
    }

    /// The published rows of generation `generation` of page `page_id`, in no set order.
    fn generation_rows(&self, page_id: i64, generation: i64) -> Result<Vec<ManifestRow>> {
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        Ok(manifest_rows(&*read, page)?
            .into_iter()
            .map(|(_, row)| row)
            .filter(|row| in_generation(row, generation))
            .collect())
    }

    /// `listForcedCutSeqs(pageId, generation)`: the seqs of generation `generation`'s published
    /// rows that end at a forced cut (`cut_kind = 'forced'`), in seq order.
    pub fn list_forced_cut_seqs(&self, page_id: i64, generation: i64) -> Result<Vec<i64>> {
        let mut seqs: Vec<i64> = self
            .generation_rows(page_id, generation)?
            .into_iter()
            .filter(|row| row.cut_kind == "forced")
            .map(|row| row.seq)
            .collect();
        seqs.sort_unstable();
        Ok(seqs)
    }

    /// `readManifestSeqAt(pageId, generation, byteOffset)`: the seq of generation `generation`'s
    /// published row holding stored byte `byte_offset`, the last row starting at or before it
    /// (`ORDER BY byte_start DESC, seq DESC LIMIT 1`). `None` when no row starts that early.
    pub fn read_manifest_seq_at(
        &self,
        page_id: i64,
        generation: i64,
        byte_offset: i64,
    ) -> Result<Option<i64>> {
        Ok(self
            .generation_rows(page_id, generation)?
            .into_iter()
            .filter(|row| row.byte_start <= byte_offset)
            .max_by_key(|row| (row.byte_start, row.seq))
            .map(|row| row.seq))
    }

    /// `readSegmentedVersionBodyBytes(pageId, generation)`: the `body_bytes` of the newest
    /// segmented version of page `page_id` that references generation `generation` and records
    /// a size, or `None` when none does.
    pub fn read_segmented_version_body_bytes(
        &self,
        page_id: i64,
        generation: i64,
    ) -> Result<Option<i64>> {
        let Some(page) = page_u64(page_id) else {
            return Ok(None);
        };
        let read = self.read()?;
        crate::pages::segmented_version_body_bytes(&*read, page, generation)
    }

    /// `listAccessPolicySourceIds()`: the sources, archived ones too, that hold access state
    /// (`access_rules.rs`), by id in byte order (`ORDER BY source_id`).
    pub fn list_access_policy_source_ids(&self) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for source in crate::sources::all_sources(&*read)? {
            if crate::access_rules::has_state(&*read, &source.id)? {
                out.push(source.id);
            }
        }
        out.sort();
        Ok(out)
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
    fn the_withdrawal_list_holds_purge_tombstones_too() {
        let s = store();
        assert!(
            s.insert_fact_withdrawal("default", "world", "a claim", "*", None)
                .unwrap()
        );
        let purge: crate::facts::purge_ledger::FactPurgeInsert = serde_json::from_value(json!({
            "sourceId": "default", "visibility": "private", "subject": "people/a",
            "factHash": "0abc", "requestId": null, "actor": null, "reason": null }))
        .unwrap();
        assert!(s.insert_fact_purge(&purge).unwrap());
        let rows = s.list_export_withdrawals("default").unwrap();
        // `ORDER BY visibility, fact_hash, subject`: the private tombstone first, then the world withdrawal.
        let shape: Vec<(&str, &str, &str, bool)> = rows
            .iter()
            .map(|r| {
                (
                    r.visibility.as_str(),
                    r.fact_hash.as_str(),
                    r.subject.as_str(),
                    r.purged,
                )
            })
            .collect();
        assert_eq!(shape.len(), 2);
        assert_eq!(shape[0], ("private", "0abc", "people/a", true));
        assert_eq!((shape[1].0, shape[1].2, shape[1].3), ("world", "*", false));
        assert!(rows[0].withdrawn_at.ends_with('Z'));
        // The ledger size counts withdrawals only, as the SQL member's `fact_withdrawals` sum does.
        let one = s.read_export_withdrawal_ledger_bytes("default").unwrap();
        assert!(one > 2);
    }

    #[test]
    fn an_empty_ledger_is_two_bytes() {
        let s = store();
        assert_eq!(s.read_export_withdrawal_ledger_bytes("default").unwrap(), 2);
    }

    #[test]
    fn fence_lines_fold_like_postgres() {
        assert_eq!(normalize_lines(""), None);
        assert_eq!(
            normalize_lines("MiXeD\t  Claim\r\nB\n").as_deref(),
            Some("mixed claim \nb\n")
        );
        assert_eq!(
            normalize_lines("a\u{85}b\u{a0}c").as_deref(),
            Some("a b\u{a0}c")
        );
    }

    #[test]
    fn an_inline_page_head_reads_the_column_defaults() {
        let s = store();
        page(&s, "notes/a", "abc");
        let id: i64 = s.list_export_page_keys(&query("0")).unwrap()[0]
            .id
            .parse()
            .unwrap();
        let head = s.read_segmented_page_head(id).unwrap().unwrap();
        assert_eq!(
            (
                head.slug.as_str(),
                head.body_storage.as_str(),
                head.body_generation
            ),
            ("notes/a", "inline", 0)
        );
        assert_eq!(
            (
                head.body_bytes,
                head.body_flags.clone(),
                head.segmenter_version
            ),
            (None, None, None)
        );
        assert!(head.revision.is_some());
        assert_eq!(s.read_segmented_page_head(id + 1000).unwrap(), None);
        assert_eq!(s.read_segmented_page_head(-1).unwrap(), None);
    }

    #[test]
    fn export_rows_give_frontmatter_keys_in_jsonb_order() {
        let s = store();
        let mut frontmatter = serde_json::Map::new();
        frontmatter.insert("status".into(), json!("v"));
        frontmatter.insert("nested".into(), json!({"bb": 1, "a": 2}));
        frontmatter.insert("n".into(), json!(2));
        let input = PageInput {
            page_type: "note".into(),
            title: "T".into(),
            compiled_truth: "body".into(),
            frontmatter: Some(frontmatter),
            ..PageInput::default()
        };
        s.put_page("notes/fm", &input, &PutPageOptions::default())
            .unwrap();
        let id = s.list_export_page_keys(&query("0")).unwrap()[0].id.clone();
        let rows = s.read_export_page_rows(&[id]).unwrap();
        assert_eq!(
            serde_json::to_string(&rows[0].page["frontmatter"]).unwrap(),
            r#"{"n":2,"nested":{"a":2,"bb":1},"status":"v"}"#
        );
    }

    #[test]
    fn an_inline_page_has_no_manifest_rows() {
        let s = store();
        page(&s, "notes/a", "abc");
        let id: i64 = s.list_export_page_keys(&query("0")).unwrap()[0]
            .id
            .parse()
            .unwrap();
        assert!(s.read_body_manifest_rows(id, None).unwrap().is_empty());
        assert!(s.read_body_manifest_rows(id, Some(1)).unwrap().is_empty());
        assert!(
            s.read_body_manifest_rows(id + 1000, None)
                .unwrap()
                .is_empty()
        );
        assert!(
            s.read_body_manifest_meta(id, &[1, 2], 1)
                .unwrap()
                .is_empty()
        );
        assert!(s.read_body_manifest_meta(id, &[], 0).unwrap().is_empty());
        assert!(
            s.read_body_manifest_outline(id, &[1, 2], 1)
                .unwrap()
                .is_empty()
        );
        assert!(s.read_body_manifest_outline(id, &[], 0).unwrap().is_empty());
        assert!(s.list_forced_cut_seqs(id, 1).unwrap().is_empty());
        assert!(s.list_forced_cut_seqs(-1, 1).unwrap().is_empty());
        assert_eq!(s.read_manifest_seq_at(id, 1, 0).unwrap(), None);
        assert_eq!(s.read_segmented_version_body_bytes(id, 1).unwrap(), None);
        assert_eq!(s.read_segmented_version_body_bytes(-1, 1).unwrap(), None);
        assert!(s.list_access_policy_source_ids().unwrap().is_empty());
        s.put_access_policy_state("default").unwrap();
        assert_eq!(
            s.list_access_policy_source_ids().unwrap(),
            vec!["default".to_string()]
        );
        assert_eq!(array_len(&json!([1, 2])), 2);
        assert_eq!(array_len(&Value::Null), 0);
    }
}
