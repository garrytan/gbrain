//! The candidate read of `gbrain repair failed-writes` (`listFailedWriteRequests`,
//! `src/core/engine-sql/repair-plan-scans.ts`; rust/docs/store/repair-bookkeeping.md, "Failed
//! writes").
//!
//! A request of the scope is listed when it is not compacted, keeps its intent, and is a
//! writer-guard refusal (`failed` with `writer_coordinator_required`, or `storage_error` whose
//! message starts `Publication failed (P0001)`), a drift refusal (`conflict` with
//! `source_changed`) or, when the caller passes the moved-entity messages, a managed fact request
//! refused `revision_conflict` with one of them. Without an id, a refused fact request is left out
//! when a later committed fact request of the same source and slug carries its input digest and a
//! different batch key. The rows are in sequence order.

use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::env::iso;
use crate::error::Result;
use crate::journal::RequestRecord;
use crate::persistence::{all_requests, extra_bool, uuid_param};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `value->>key` of a jsonb object column; null for a missing key or a non-object value.
fn text_of(value: Option<&Value>, key: &str) -> Option<String> {
    value
        .and_then(Value::as_object)
        .and_then(|o| fm_text(o, key))
}

fn guard_refusal(r: &RequestRecord) -> bool {
    r.state == "failed"
        && match r.error_code.as_deref() {
            Some("writer_coordinator_required") => true,
            Some("storage_error") => r
                .error_message
                .as_deref()
                .is_some_and(|m| m.starts_with("Publication failed (P0001)")),
            _ => false,
        }
}

fn drift_refusal(r: &RequestRecord) -> bool {
    r.state == "conflict" && r.error_code.as_deref() == Some("source_changed")
}

fn facts_moved_refusal(r: &RequestRecord, messages: &[String]) -> bool {
    r.operation == "extract_facts"
        && r.state == "conflict"
        && r.error_code.as_deref() == Some("revision_conflict")
        && r.error_message
            .as_deref()
            .is_some_and(|m| messages.iter().any(|x| x == m))
}

/// `FACTS_RECOVERED`: a later committed fact request of the same extraction on the same page,
/// from another batch.
fn facts_recovered(r: &RequestRecord, all: &[RequestRecord]) -> bool {
    if r.operation != "extract_facts" {
        return false;
    }
    let Some(digest) = text_of(Some(&r.intent), "inputDigest") else {
        return false;
    };
    let batch = text_of(Some(&r.intent), "batchKey");
    all.iter().any(|c| {
        c.operation == "extract_facts"
            && c.source_id == r.source_id
            && c.slug == r.slug
            && c.state == "committed"
            && c.sequence > r.sequence
            && text_of(Some(&c.intent), "inputDigest")
                .or_else(|| text_of(c.outcome.as_ref(), "input_digest"))
                .is_some_and(|d| d == digest)
            && text_of(Some(&c.intent), "batchKey")
                .or_else(|| text_of(c.outcome.as_ref(), "batch_key"))
                != batch
    })
}

/// `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`: whole seconds.
fn created_at(us: i64) -> String {
    format!("{}Z", &iso(us)[..19])
}

/// The `producer` column: null for a caller's replayable write, else the operation and its kind.
fn producer(r: &RequestRecord, replayable: &[String]) -> Value {
    let owner_put =
        r.operation == "put_page" && r.intent.as_object().is_some_and(|o| o.contains_key("kind"));
    if replayable.contains(&r.operation) && !owner_put {
        return Value::Null;
    }
    let kind = text_of(Some(&r.intent), "kind");
    json!(match kind {
        Some(k) => format!("{}:{k}", r.operation),
        None => r.operation.clone(),
    })
}

fn row(r: &RequestRecord, replayable: &[String]) -> Value {
    json!({
        "id": r.id,
        "request_id": r.request_id,
        "sequence": r.sequence.to_string(),
        "operation": r.operation,
        "source_id": r.source_id,
        "slug": r.slug,
        "digest": r.digest,
        "state": r.state,
        "intent": r.intent,
        "authority": r.authority,
        "created_at": created_at(r.created_at_us),
        "origin": text_of(r.extra.get("error_detail"), "origin"),
        "error_code": r.error_code,
        "page_id": r.page_id.map(|p| p.to_string()),
        "producer": producer(r, replayable),
    })
}

impl Store {
    /// `listFailedWriteRequests(sourceIds, replayable, factsMovedMessages, id)`: the refused
    /// requests the failed-writes preview lists, by sequence.
    pub fn list_failed_write_requests(
        &self,
        source_ids: &[String],
        replayable: &[String],
        facts_moved_messages: Option<&[String]>,
        id: Option<&str>,
    ) -> Result<Value> {
        let id = id
            .map(|i| uuid_param(i, "failed-writes request id"))
            .transpose()?;
        let scope: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut all = all_requests(&*read)?;
        all.sort_by_key(|r| r.sequence);
        let listed: Vec<&RequestRecord> = all
            .iter()
            .filter(|r| {
                scope.contains(r.source_id.as_str())
                    && !extra_bool(r, "compacted")
                    && !r.intent.is_null()
                    && (guard_refusal(r)
                        || drift_refusal(r)
                        || facts_moved_messages.is_some_and(|m| facts_moved_refusal(r, m)))
                    && id.as_deref().is_none_or(|i| r.id == i)
            })
            .filter(|r| id.is_some() || !facts_recovered(r, &all))
            .collect();
        Ok(Value::Array(
            listed.into_iter().map(|r| row(r, replayable)).collect(),
        ))
    }
}
