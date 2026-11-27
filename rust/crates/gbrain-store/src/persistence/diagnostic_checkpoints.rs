//! Checkpoint reads of the persistence doctor (`src/core/engine-sql/doctor-checkpoints.ts`,
//! `src/core/engine-sql/doctor-brain.ts`; rust/docs/store/cli-reads-doctor-checkpoints.md): the
//! derived-origin parks whose page is still a tombstone (`listDerivedOriginParks`), the failed
//! requests a blocked managed-sync cursor waits on (`listContentBlockedReceipts`), the git holds of
//! one non-canonical spelling (`countVisibilityNoncanonicalHolds`, `countReadersNoncanonicalHolds`)
//! and the holds a read's hits stamp, with how many held files could affect the read
//! (`readHeldHitRows`).
//!
//! Each read evaluates its statement over the `op_checkpoints` parents (`op_checkpoint.rs`), the
//! page records and the request records. Text keys sort in byte order (`COLLATE "C"`).

use super::op_checkpoint::list_op_checkpoint_records_in;
use super::{all_requests, json_text};
use crate::Store;
use crate::cli_reads::pg_text::pg_lower;
use crate::error::Result;
use crate::kv::KvRead;
use crate::link_queries::retrieval_coverage::token_match;
use crate::pages::{PageRecord, read_page_by_id};
use crate::sources::all_sources;
use serde_json::{Value, json};
use std::collections::HashMap;

/// `x.completed_keys->0->>'<field>'`.
fn first_text(record: &Value, field: &str) -> Option<String> {
    json_text(first(record).and_then(|r| r.get(field)))
}

/// Every source by id, with its incarnation and archive flag.
fn source_incarnations(read: &dyn KvRead) -> Result<HashMap<String, (String, bool)>> {
    Ok(all_sources(read)?
        .into_iter()
        .map(|s| (s.id, (s.incarnation, s.archived)))
        .collect())
}

/// `completed_keys->0`.
fn first(record: &Value) -> Option<&Value> {
    record.get("completed_keys").and_then(|k| k.get(0))
}

/// `listDerivedOriginParks(op)`: the first record of each `op` parent whose fingerprint is the id
/// (as text) of a soft-deleted page, oldest parent first, ties by fingerprint in byte order.
pub(crate) fn list_derived_origin_parks_in(read: &dyn KvRead, op: &str) -> Result<Value> {
    let Value::Array(rows) = list_op_checkpoint_records_in(read, op)? else {
        return Ok(Value::Array(Vec::new()));
    };
    let mut kept: Vec<(i64, String, Value)> = Vec::new();
    for row in rows {
        let fingerprint = row
            .get("fingerprint")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // `p.id::text = o.fingerprint`: only the canonical decimal text of an id matches.
        let Ok(id) = fingerprint.parse::<u64>() else {
            continue;
        };
        if id.to_string() != fingerprint {
            continue;
        }
        if !read_page_by_id(read, id)?.is_some_and(|p| p.deleted_at_us.is_some()) {
            continue;
        }
        let updated = row
            .get("updated_at_us")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        kept.push((
            updated,
            fingerprint.to_owned(),
            first(&row).cloned().unwrap_or(Value::Null),
        ));
    }
    kept.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
    });
    Ok(Value::Array(
        kept.into_iter()
            .map(|(_, _, park)| json!({ "park": park }))
            .collect(),
    ))
}

/// `listContentBlockedReceipts()`: for each unfinished `managed-sync` cursor, the failed, conflicted
/// or cancelled request of its source that it names as pending; by the cursor's source id in byte
/// order.
pub(crate) fn list_content_blocked_receipts_in(read: &dyn KvRead) -> Result<Value> {
    let Value::Array(cursors) = list_op_checkpoint_records_in(read, "managed-sync")? else {
        return Ok(Value::Array(Vec::new()));
    };
    let requests = all_requests(read)?;
    let mut out: Vec<(String, Value)> = Vec::new();
    for cursor in &cursors {
        let Some(head) = first(cursor) else { continue };
        // COALESCE(c.completed_keys->0->>'done','false') <> 'true'
        if json_text(head.get("done")).as_deref() == Some("true") {
            continue;
        }
        let (Some(source), Some(pending)) = (
            json_text(head.get("sourceId")),
            json_text(head.get("pending").and_then(|p| p.get("requestId"))),
        ) else {
            continue;
        };
        for r in &requests {
            if r.request_id != pending
                || r.source_id != source
                || !matches!(r.state.as_str(), "failed" | "conflict" | "cancelled")
            {
                continue;
            }
            out.push((
                source.clone(),
                json!({
                    "source_id": source,
                    "error_code": r.error_code,
                    "error_message": r.error_message,
                    "error_detail": r.extra.get("error_detail").cloned().unwrap_or(Value::Null),
                }),
            ));
        }
    }
    // A stable sort: rows of one source keep the order they were found in.
    out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Ok(Value::Array(out.into_iter().map(|(_, row)| row).collect()))
}

/// `countVisibilityNoncanonicalHolds` / `countReadersNoncanonicalHolds`: the `hold_op` parents whose
/// first record has `code`, names a source that is not archived at the incarnation it records, and
/// (when `source_ids` is given) one of those sources.
pub(crate) fn count_noncanonical_holds_in(
    read: &dyn KvRead,
    hold_op: &str,
    code: &str,
    source_ids: Option<&[String]>,
) -> Result<i64> {
    let Value::Array(rows) = list_op_checkpoint_records_in(read, hold_op)? else {
        return Ok(0);
    };
    let sources = source_incarnations(read)?;
    let mut n = 0;
    for row in &rows {
        if first_text(row, "code").as_deref() != Some(code) {
            continue;
        }
        let (Some(source), Some(incarnation)) =
            (first_text(row, "source_id"), first_text(row, "incarnation"))
        else {
            continue;
        };
        let Some((current, archived)) = sources.get(&source) else {
            continue;
        };
        if *current != incarnation
            || *archived
            || source_ids.is_some_and(|ids| !ids.contains(&source))
        {
            continue;
        }
        n += 1;
    }
    Ok(n)
}

/// The query of `readHeldHitRows`: the hits' page ids, the read's live sources, and the relevance
/// types and whole-word terms (the patterns' words) a held file matches.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldHitQuery {
    pub hold_op: String,
    pub page_ids: Vec<String>,
    pub source_ids: Vec<String>,
    pub types: Vec<String>,
    pub terms: Vec<String>,
    pub cap: i64,
}

/// `readHeldHitRows(query)`: every `hold_op` record naming one of the hits' pages (of a source at
/// the recorded incarnation, archived or not) with its page's revision, in fingerprint byte order;
/// then one row with how many held files (at most `cap`) of the read's unarchived sources could
/// affect it: those naming a hit's page, a page of one of `types`, or whose
/// `lower(concat_ws(' ', path, slug, title))` holds one of `terms` as a whole word.
pub(crate) fn read_held_hit_rows_in(read: &dyn KvRead, q: &HeldHitQuery) -> Result<Value> {
    let Value::Array(rows) = list_op_checkpoint_records_in(read, &q.hold_op)? else {
        return Ok(Value::Array(Vec::new()));
    };
    let sources = source_incarnations(read)?;
    let mut out = Vec::new();
    let mut could_affect: i64 = 0;
    for row in &rows {
        let (Some(source), Some(incarnation)) =
            (first_text(row, "source_id"), first_text(row, "incarnation"))
        else {
            continue;
        };
        let Some((current, archived)) = sources.get(&source) else {
            continue;
        };
        if *current != incarnation {
            continue;
        }
        let page_text = first_text(row, "page_id");
        // `p.id=(... ->>'page_id')::int`: the LEFT JOIN finds the page whose id is that integer.
        let page: Option<PageRecord> = match page_text.as_deref().map(|t| t.trim().parse::<u64>()) {
            Some(Ok(id)) => read_page_by_id(read, id)?,
            _ => None,
        };
        let hit = page_text.as_ref().is_some_and(|t| q.page_ids.contains(t));
        if hit {
            out.push(json!({
                "record": first(row).cloned().unwrap_or(Value::Null),
                "revision": page.as_ref().map(|p| p.knowledge_revision.clone()),
                "could_affect": Value::Null,
            }));
        }
        if could_affect < q.cap && !*archived && q.source_ids.contains(&source) {
            let typed = page
                .as_ref()
                .is_some_and(|p| q.types.contains(&p.page_type));
            let matches = || {
                let parts: Vec<String> = [
                    first_text(row, "path"),
                    first_text(row, "slug"),
                    page.as_ref().map(|p| p.title.clone()),
                ]
                .into_iter()
                .flatten()
                .collect();
                let haystack = pg_lower(&parts.join(" "));
                q.terms.iter().any(|t| token_match(&haystack, t))
            };
            if hit || typed || matches() {
                could_affect += 1;
            }
        }
    }
    out.push(
        json!({ "record": Value::Null, "revision": Value::Null, "could_affect": could_affect }),
    );
    Ok(Value::Array(out))
}

impl Store {
    /// `listDerivedOriginParks(op)`.
    pub fn list_derived_origin_parks(&self, op: &str) -> Result<Value> {
        list_derived_origin_parks_in(&*self.read()?, op)
    }

    /// `listContentBlockedReceipts()`.
    pub fn list_content_blocked_receipts(&self) -> Result<Value> {
        list_content_blocked_receipts_in(&*self.read()?)
    }

    /// `countVisibilityNoncanonicalHolds(holdOp, sourceIds)` and `countReadersNoncanonicalHolds(holdOp,
    /// sourceIds)`: `code` is `visibility_noncanonical` or `readers_noncanonical`.
    pub fn count_noncanonical_holds(
        &self,
        hold_op: &str,
        code: &str,
        source_ids: Option<&[String]>,
    ) -> Result<i64> {
        count_noncanonical_holds_in(&*self.read()?, hold_op, code, source_ids)
    }

    /// `readHeldHitRows(query)`.
    pub fn read_held_hit_rows(&self, q: &HeldHitQuery) -> Result<Value> {
        read_held_hit_rows_in(&*self.read()?, q)
    }
}
