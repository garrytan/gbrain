//! Checkpoint reads of the persistence doctor (`src/core/engine-sql/doctor-checkpoints.ts`,
//! `src/core/engine-sql/doctor-brain.ts`; rust/docs/store/cli-reads-doctor-checkpoints.md): the
//! derived-origin parks whose page is still a tombstone (`listDerivedOriginParks`) and the failed
//! requests a blocked managed-sync cursor waits on (`listContentBlockedReceipts`).
//!
//! Each read evaluates its statement over the `op_checkpoints` parents (`op_checkpoint.rs`), the
//! page records and the request records. Text keys sort in byte order (`COLLATE "C"`).

use super::op_checkpoint::list_op_checkpoint_records_in;
use super::{all_requests, json_text};
use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::read_page_by_id;
use serde_json::{Value, json};

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

impl Store {
    /// `listDerivedOriginParks(op)`.
    pub fn list_derived_origin_parks(&self, op: &str) -> Result<Value> {
        list_derived_origin_parks_in(&*self.read()?, op)
    }

    /// `listContentBlockedReceipts()`.
    pub fn list_content_blocked_receipts(&self) -> Result<Value> {
        list_content_blocked_receipts_in(&*self.read()?)
    }
}
