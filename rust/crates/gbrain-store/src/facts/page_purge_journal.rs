//! The journal reads of a page purge (src/core/engine-sql/page-purge-sweep.ts `listPageTimelineReceipts` and
//! src/core/engine-sql/facts-purge.ts `listPageChangeReasons`, `listRequestsRecordingReasons`), served from the request
//! records and the page's saved versions.
//!
//! The SQL reads `persistence_requests` jsonb columns: `->` is `Value::get` (NULL for a missing key or a value that is not an
//! object), `->>` is `jsonb_field_text` (a string's contents, any other value's jsonb text, NULL for JSON null), and
//! `outcome ? 'k'` is whether a top-level key, array element or scalar string equals `k`. A request keeps its page and source,
//! so a read is one scan of the request records (as the purge plan's journal reads are).

use super::purge_plan::requests;
use crate::Store;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::links::no_nul;
use crate::pages::versions_of;
use crate::timeline_queries::jsonb_field_text;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `LIMIT 10000` of the reason-recording request read.
const RECORDING_LIMIT: usize = 10_000;

/// jsonb `?`: the object has the key, the array has the string element, or the value is that string.
fn has_key(value: &Value, key: &str) -> bool {
    match value {
        Value::Object(o) => o.contains_key(key),
        Value::Array(items) => items.iter().any(|v| v.as_str() == Some(key)),
        Value::String(s) => s == key,
        _ => false,
    }
}

/// `intent->>'reason'`.
fn intent_reason(r: &RequestRecord) -> Option<String> {
    r.intent.get("reason").and_then(jsonb_field_text)
}

/// `outcome->'reason_recorded'->>'reason'`.
fn outcome_reason(r: &RequestRecord) -> Option<String> {
    r.outcome
        .as_ref()?
        .get("reason_recorded")?
        .get("reason")
        .and_then(jsonb_field_text)
}

impl Store {
    /// `listPageTimelineReceipts`: `{ id, principal_kind, principal_id, sequence, summary, source, bullet, diff }` of the
    /// source's add_timeline_entry requests under `slugs` whose outcome has an `entry` (and, with `with_diffs`, its edit_page
    /// requests whose outcome has a `diff`) after sequence `after`, by sequence, up to `limit`. Sequences are text.
    pub fn list_page_timeline_receipts(
        &self,
        source_id: &str,
        slugs: &[String],
        limit: i64,
        after: &str,
        with_diffs: bool,
    ) -> Result<Vec<Value>> {
        let op = "listPageTimelineReceipts";
        no_nul(op, &[("sourceId", source_id), ("after", after)])?;
        for slug in slugs {
            no_nul(op, &[("slugs", slug)])?;
        }
        let limit = usize::try_from(limit)
            .map_err(|_| StoreError::invalid(format!("{op}: LIMIT must not be negative")))?;
        let after: i64 = after.trim().parse().map_err(|_| {
            StoreError::invalid(format!(
                "{op}: invalid input syntax for type bigint: \"{after}\""
            ))
        })?;
        let read = self.read()?;
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let rows = requests(&*read, |r| {
            r.source_id == source_id
                && wanted.contains(r.slug.as_str())
                && i64::try_from(r.sequence).is_ok_and(|s| s > after)
                && r.outcome.as_ref().is_some_and(|o| {
                    (r.operation == "add_timeline_entry" && has_key(o, "entry"))
                        || (with_diffs && r.operation == "edit_page" && has_key(o, "diff"))
                })
        })?;
        Ok(rows
            .into_iter()
            .take(limit)
            .map(|r| {
                let outcome = r.outcome.as_ref();
                let entry_text = |field: &str| {
                    outcome
                        .and_then(|o| o.get("entry"))
                        .and_then(|e| e.get(field))
                        .and_then(jsonb_field_text)
                };
                let top_text = |field: &str| {
                    outcome
                        .and_then(|o| o.get(field))
                        .and_then(jsonb_field_text)
                };
                json!({
                    "id": r.id,
                    "principal_kind": r.principal_kind,
                    "principal_id": r.principal_id,
                    "sequence": r.sequence.to_string(),
                    "summary": entry_text("summary"),
                    "source": entry_text("source"),
                    "bullet": top_text("bullet"),
                    "diff": top_text("diff"),
                })
            })
            .collect())
    }

    /// `listPageChangeReasons`: `{ reason }` for each distinct reason (NULL once, when any source has none) in the page's saved
    /// versions' `change_reason`, the source's requests' `intent->>'reason'` under the slug and their
    /// `outcome->'reason_recorded'->>'reason'`; NULL first, then in byte order (the SQL's `UNION` has no order).
    pub fn list_page_change_reasons(
        &self,
        source_id: &str,
        slug: &str,
        page_id: i64,
    ) -> Result<Vec<Value>> {
        no_nul(
            "listPageChangeReasons",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        let mut reasons: BTreeSet<Option<String>> = BTreeSet::new();
        if let Ok(id) = u64::try_from(page_id) {
            for v in versions_of(&*read, id)? {
                reasons.insert(v.change_reason.clone());
            }
        }
        for r in requests(&*read, |r| r.source_id == source_id && r.slug == slug)? {
            reasons.insert(intent_reason(&r));
            reasons.insert(outcome_reason(&r));
        }
        // `Option`'s order puts `None` first, then the strings in byte order.
        Ok(reasons
            .into_iter()
            .map(|reason| json!({ "reason": reason }))
            .collect())
    }

    /// `listRequestsRecordingReasons`: `{ id, principal_kind, principal_id }` of the source's requests under the slug whose intent
    /// has a non-null `reason` or whose outcome has a `reason_recorded` key (a JSON null counts: it is not SQL NULL), by sequence,
    /// the first 10000.
    pub fn list_requests_recording_reasons(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Vec<Value>> {
        no_nul(
            "listRequestsRecordingReasons",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        let rows = requests(&*read, |r| {
            r.source_id == source_id
                && r.slug == slug
                && (intent_reason(r).is_some()
                    || r.outcome
                        .as_ref()
                        .is_some_and(|o| o.get("reason_recorded").is_some()))
        })?;
        Ok(rows
            .into_iter()
            .take(RECORDING_LIMIT)
            .map(|r| json!({ "id": r.id, "principal_kind": r.principal_kind, "principal_id": r.principal_id }))
            .collect())
    }
}
