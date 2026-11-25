//! The reads of `gbrain repair receipt-compaction` (`readReceiptCompactionWindow`,
//! `listReceiptCompactionCandidates`, `countKeptFailedReceipts`,
//! `src/core/engine-sql/persistence-housekeeping.ts`; rust/docs/store/persistence.md, "Receipt
//! compaction").
//!
//! A candidate is a receipt in one of the named states with no recovery, not compacted, completed
//! before the cutoff, at or below the newest sequence the preview saw, with every effect settled,
//! and not part of a managed-sync run or pass whose cursor is still open. Every request on this
//! engine has a null `worktree_id`, so no receipt is any worktree's newest sync receipt and that
//! exclusion never applies.

use super::effects::request_effects;
use super::housekeeping::jsonb_has;
use super::op_checkpoint::list_op_checkpoint_records_in;
use super::{all_requests, extra_bool, extra_i64, extra_is_null};
use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use serde_json::{Value, json};

/// `interval '1 hour'` in microseconds.
const HOUR_US: f64 = 3_600_000_000.0;

/// `$n::timestamptz` of a cutoff the window read returned.
fn cutoff_micros(op: &str, cutoff: &str) -> Result<i64> {
    parse_iso(cutoff).ok_or_else(|| {
        StoreError::invalid(format!(
            "{op}: invalid input syntax for type timestamp with time zone: \"{cutoff}\""
        ))
    })
}

/// `state IN (...) AND recovery IS NULL AND NOT compacted AND completed_at < cutoff`.
fn uncompacted_before(r: &RequestRecord, states: &[&str], before: i64) -> bool {
    states.contains(&r.state.as_str())
        && extra_is_null(r, "recovery")
        && !extra_bool(r, "compacted")
        && r.completed_at_us.is_some_and(|t| t < before)
}

/// `completed_keys->0` of each checkpoint row of `op`.
fn first_records(read: &dyn KvRead, op: &str) -> Result<Vec<Value>> {
    Ok(list_op_checkpoint_records_in(read, op)?
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row.get("completed_keys").and_then(|k| k.get(0)).cloned())
        .collect())
}

/// `-> key ->> key2` on JSON values that may not be objects.
fn arrow(value: &Value, key: &str) -> Option<String> {
    value.as_object().and_then(|o| fm_text(o, key))
}

/// `OPEN_SYNC_CURSOR_EXCLUSION('r')` is false: the request belongs to a managed-sync run whose
/// cursor is not done, or to a managed-sync pass whose telemetry outcome is still `open`.
fn in_open_sync(r: &RequestRecord, runs: &[Value], passes: &[Value]) -> bool {
    let run = jsonb_has(&r.intent, "runId")
        && arrow(&r.intent, "runId").is_some_and(|id| {
            runs.iter().any(|c| {
                arrow(c, "runId").as_deref() == Some(id.as_str())
                    && arrow(c, "done").as_deref().unwrap_or("false") != "true"
            })
        });
    let pass = jsonb_has(&r.intent, "passId")
        && arrow(&r.intent, "passId").is_some_and(|id| {
            passes.iter().any(|p| {
                let telemetry = p.get("telemetry").cloned().unwrap_or(Value::Null);
                arrow(&telemetry, "pass_id").as_deref() == Some(id.as_str())
                    && arrow(&telemetry, "outcome").as_deref() == Some("open")
            })
        });
    run || pass
}

impl Store {
    /// `readReceiptCompactionWindow(hours)`: now minus `hours` as a UTC ISO time with
    /// microseconds, and the newest request sequence as text (null when there is none).
    pub fn read_receipt_compaction_window(&self, hours: f64) -> Result<Value> {
        let read = self.read()?;
        let cutoff = iso(self.env.now_micros() - (hours * HOUR_US) as i64);
        let max = all_requests(&*read)?.iter().map(|r| r.sequence).max();
        Ok(json!({ "cutoff": cutoff, "max_sequence": max.map(|s| s.to_string()) }))
    }

    /// `listReceiptCompactionCandidates(states, cutoff, maxSequence)`, by sequence.
    pub fn list_receipt_compaction_candidates(
        &self,
        states: &[String],
        cutoff: &str,
        max_sequence: &str,
    ) -> Result<Value> {
        const OP: &str = "listReceiptCompactionCandidates";
        let before = cutoff_micros(OP, cutoff)?;
        let max: i128 = max_sequence.trim().parse().map_err(|_| {
            StoreError::invalid(format!(
                "{OP}: invalid input syntax for type bigint: \"{max_sequence}\""
            ))
        })?;
        let states: Vec<&str> = states.iter().map(String::as_str).collect();
        let read = self.read()?;
        let runs = first_records(&*read, "managed-sync")?;
        let passes = first_records(&*read, "managed-sync-pass")?;
        let mut rows = Vec::new();
        for r in all_requests(&*read)? {
            if !uncompacted_before(&r, &states, before)
                || i128::from(r.sequence) > max
                || in_open_sync(&r, &runs, &passes)
            {
                continue;
            }
            if request_effects(&*read, &r.id)?
                .iter()
                .any(|e| e.state != "committed")
            {
                continue;
            }
            rows.push(r);
        }
        rows.sort_by_key(|r| r.sequence);
        Ok(Value::Array(
            rows.iter()
                .map(|r| {
                    json!({
                        "id": r.id,
                        "request_id": r.request_id,
                        "sequence": r.sequence.to_string(),
                        "source_id": r.source_id,
                        "principal_kind": r.principal_kind,
                        "principal_id": r.principal_id,
                        "state": r.state,
                        "terminal_reservation": extra_i64(r, "terminal_reservation").to_string(),
                    })
                })
                .collect(),
        ))
    }

    /// `countKeptFailedReceipts(cutoff)`: the conflicted, failed and cancelled receipts completed
    /// before `cutoff` with no recovery and not compacted.
    pub fn count_kept_failed_receipts(&self, cutoff: &str) -> Result<Value> {
        let before = cutoff_micros("countKeptFailedReceipts", cutoff)?;
        let states = ["conflict", "failed", "cancelled"];
        let n = all_requests(&*self.read()?)?
            .iter()
            .filter(|r| uncompacted_before(r, &states, before))
            .count();
        Ok(json!(n))
    }
}
