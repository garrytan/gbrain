//! Group 5 facts member `probePurgeDerivations` (src/core/engine-sql/facts-purge.ts): one batch of the
//! fact purge receipt's derivation probe over the stored derivation results (`page_segment_derivations`).
//!
//! The batch is the source's derivation rows (on live or soft-deleted pages, as the SQL joins pages
//! without a `deleted_at` test) after the cursor `(page, pipeline, occurrence)`, in that order, at most
//! `rows`. For each row:
//! - `swept`: the page is one of `pageIds`, the page is soft-deleted, or no live published manifest row
//!   backs the row's occurrence with its segment hash (`derivationSweepScopeSql`);
//! - `candidate`: the row's output and receipt jsonb text, joined by a space, then `lower()` and the
//!   fold (`ς` to `σ`, `i̇` to `i`), is `LIKE` one of `patterns` (`derivationClaimCandidateSql`);
//! - `hit`: a candidate that has one string value or object key, at any depth of the output or the
//!   receipt, which passes the same prefilter and whose folded `gbrain_fact_normalize` text, padded
//!   with a space on each side, holds one of `needles` (`derivationHoldsClaimSql`).
//!
//! The result is `{ scanned, normalized, swept, kept, last_page, last_pipeline, last_occurrence }`:
//! the batch size, the candidates, the hits in and out of the sweep scope, and the batch's last key
//! (`last_occurrence` as text), nulls for an empty batch. A SQL NULL column is `Value::Null` and adds
//! the empty text, as `COALESCE(output::text, '')` does.
//!
//! Pipelines are the lower-case ASCII derivation kinds, so byte order is the collation order. A cursor
//! that names a page but not a pipeline or occurrence compares as the SQL row comparison does: a later
//! page is after it, the same page is not (`NULL`). An occurrence that is not a bigint refuses, as
//! `::bigint` does. A `LIKE` pattern that ends with the escape character refuses, as Postgres does.

use crate::Store;
use crate::cli_reads::pg_text::{jsonb_text, pg_lower};
use crate::error::{Result, StoreError};
use crate::facts::{fact_normalize, like};
use crate::generations::hop_limit;
use crate::links::no_nul;
use crate::page_body::{ProbeDerivation, live_segment_backs, probe_derivations};
use crate::pages::all_pages;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `probePurgeDerivations(sourceId, needles, pageIds, patterns, cursor, rows)`; the cursor comes as its
/// three parts, each null when there is no cursor.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivationProbeQuery {
    pub source_id: String,
    pub needles: Vec<String>,
    pub page_ids: Vec<i64>,
    pub patterns: Vec<String>,
    pub cursor_page: Option<i64>,
    pub cursor_pipeline: Option<String>,
    pub cursor_occurrence: Option<String>,
    pub rows: i64,
}

/// `foldSql(lower(text))`.
fn lower_folded(text: &str) -> String {
    pg_lower(text).replace('ς', "σ").replace("i\u{307}", "i")
}

/// `foldSql(lower(text)) LIKE ANY (patterns)`.
fn has_words(text: &str, patterns: &[String]) -> Result<bool> {
    let folded = lower_folded(text);
    for pattern in patterns {
        if like(&folded, pattern, false)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The string values and object keys at every depth of `value` (`strict $.**`).
fn texts<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(s) => out.push(s),
        Value::Array(items) => items.iter().for_each(|v| texts(v, out)),
        Value::Object(map) => {
            for (k, v) in map {
                out.push(k);
                texts(v, out);
            }
        }
        _ => {}
    }
}

/// `COALESCE(col::text, '')`.
fn column_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        other => jsonb_text(other),
    }
}

/// `derivationHoldsClaimSql` for a candidate row.
fn holds_claim(d: &ProbeDerivation, needles: &[String], patterns: &[String]) -> Result<bool> {
    let mut found = Vec::new();
    texts(&d.output, &mut found);
    texts(&d.receipt, &mut found);
    for text in found {
        if has_words(text, patterns)? {
            let padded = format!(" {} ", lower_folded(&fact_normalize(text)));
            if needles.iter().any(|n| padded.contains(n.as_str())) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Whether key `(page, pipeline, occurrence)` is after the cursor; `None` is SQL NULL.
fn after_cursor(
    page: i64,
    pipeline: &str,
    occurrence: i64,
    cursor: &(i64, Option<String>, Option<i64>),
) -> bool {
    use std::cmp::Ordering::{Equal, Greater, Less};
    match page.cmp(&cursor.0) {
        Greater => true,
        Less => false,
        Equal => match cursor.1.as_deref().map(|c| pipeline.cmp(c)) {
            Some(Greater) => true,
            Some(Equal) => cursor.2.is_some_and(|c| occurrence > c),
            Some(Less) | None => false,
        },
    }
}

impl Store {
    /// `probePurgeDerivations(sourceId, needles, pageIds, patterns, cursor, rows)`.
    pub fn probe_purge_derivations(&self, q: &DerivationProbeQuery) -> Result<Value> {
        let op = "probePurgeDerivations";
        no_nul(
            op,
            &[
                ("sourceId", &q.source_id),
                (
                    "cursor pipeline",
                    q.cursor_pipeline.as_deref().unwrap_or(""),
                ),
            ],
        )?;
        for text in q.needles.iter().chain(&q.patterns) {
            no_nul(op, &[("a needle or pattern", text)])?;
        }
        let limit = hop_limit(q.rows)?;
        let occurrence = match &q.cursor_occurrence {
            None => None,
            Some(text) => Some(text.trim().parse::<i64>().map_err(|_| {
                StoreError::invalid(format!(
                    "{op}: cursor occurrence \"{text}\" is not a bigint"
                ))
            })?),
        };
        let cursor = q
            .cursor_page
            .map(|page| (page, q.cursor_pipeline.clone(), occurrence));
        let scope: BTreeSet<i64> = q.page_ids.iter().copied().collect();
        let read = self.read()?;
        let mut pages: Vec<_> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == q.source_id)
            .collect();
        pages.sort_by_key(|p| p.id);
        let (mut scanned, mut normalized, mut swept, mut kept) = (0i64, 0i64, 0i64, 0i64);
        let mut last: Option<(u64, String, i64)> = None;
        'pages: for page in &pages {
            for d in probe_derivations(&*read, page.id)? {
                if scanned as usize >= limit {
                    break 'pages;
                }
                if cursor
                    .as_ref()
                    .is_some_and(|c| !after_cursor(page.id as i64, &d.kind, d.occurrence_id, c))
                {
                    continue;
                }
                scanned += 1;
                let in_scope = scope.contains(&(page.id as i64))
                    || page.deleted_at_us.is_some()
                    || !live_segment_backs(&*read, page.id, d.occurrence_id, &d.segment_sha256)?;
                let joined = format!("{} {}", column_text(&d.output), column_text(&d.receipt));
                if has_words(&joined, &q.patterns)? {
                    normalized += 1;
                    if holds_claim(&d, &q.needles, &q.patterns)? {
                        if in_scope {
                            swept += 1;
                        } else {
                            kept += 1;
                        }
                    }
                }
                last = Some((page.id, d.kind, d.occurrence_id));
            }
        }
        let (last_page, last_pipeline, last_occurrence) = match last {
            Some((page, pipeline, occurrence)) => {
                (json!(page), json!(pipeline), json!(occurrence.to_string()))
            }
            None => (Value::Null, Value::Null, Value::Null),
        };
        Ok(json!({
            "scanned": scanned, "normalized": normalized, "swept": swept, "kept": kept,
            "last_page": last_page, "last_pipeline": last_pipeline, "last_occurrence": last_occurrence,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cursor_compares_as_a_sql_row_comparison() {
        let full = (5, Some("links".to_string()), Some(9));
        assert!(after_cursor(6, "a", 0, &full));
        assert!(!after_cursor(4, "z", 99, &full));
        assert!(after_cursor(5, "mentions", 0, &full));
        assert!(after_cursor(5, "links", 10, &full));
        assert!(!after_cursor(5, "links", 9, &full));
        let open = (5, None, None);
        assert!(after_cursor(6, "a", 0, &open));
        assert!(!after_cursor(5, "z", 99, &open));
    }

    #[test]
    fn a_claim_must_fill_whole_words_of_one_text() {
        let d = ProbeDerivation {
            kind: "links".into(),
            occurrence_id: 1,
            segment_sha256: String::new(),
            output: json!({ "items": [{ "excerpt": "She PLAYS oboe, daily" }], "plays oboes": 1 }),
            receipt: Value::Null,
        };
        let patterns = vec!["%plays%oboe%".to_string()];
        assert!(holds_claim(&d, &[" plays oboe ".into()], &patterns).unwrap());
        assert!(!holds_claim(&d, &[" plays oboes daily ".into()], &patterns).unwrap());
        assert!(!holds_claim(&d, &[], &patterns).unwrap());
        assert_eq!(lower_folded("ΚΩΣΤΑΣ ς"), "κωστασ σ");
    }
}
