//! Group 5 facts members, the purge statements over the write journal (src/core/engine-sql/facts-purge.ts, `facts/purge-reasons.ts` and `facts/purge-verify.ts`).
//!
//! - `listPageChangeReasons(sourceId, slug, pageId)`: the change reasons of the page's versions and the
//!   `intent->>'reason'` and `outcome->'reason_recorded'->>'reason'` of the slug's requests, each once
//!   (`UNION`), null included, in byte order (null first).
//! - `listRequestsRecordingReasons(sourceId, slug)`: the slug's requests with an `intent->>'reason'`
//!   or a `reason_recorded` outcome key, by sequence, at most 10000, each `{ id, principal_kind,
//!   principal_id }`.
//! - `readDeletePageRequest(sourceId, requestId)`: the newest `delete_page` request of the source with
//!   this request id, `{ id, request_id, state, source_id, outcome }`, null for none.
//! - `listPurgeEffects(requestId)`: the request's effects in kind order, each `{ kind, state,
//!   error_code, parked }`; `parked` is whether `data->'parked'` is a non-empty array.
//!
//! A request id is a UUID (`::uuid`), compared in lower case; other text is `invalid_argument`.
//! The row locks (`FOR UPDATE OF e`) are no-ops (decision C of persistence.rs). Effect kinds sort
//! in byte order; Postgres sorts them by the database collation, which agrees for the lower-case
//! ASCII kinds the journal writes.
//!
//! The change-reason tombstones (`reason_purge_tombstones`) are the `reason_tombstones.rs` family;
//! this module keeps no records of its own. `listGitEffectsCarryingReason`, `listPageGitEffectsForStrip` and
//! `setPurgeEffectData` are `persistence/purge_effects.rs`; `countPagePurgeTombstones` is `facts/page_purges.rs`.

use crate::env::is_uuid;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::versions_of;
use crate::persistence::{all_effects, request_effects};
use crate::timeline_queries::jsonb_field_text;
use crate::{Store, keys};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The byte after `keys::FACT` that marks a change-reason tombstone.
/// `LIMIT 10000` of the requests that record a reason.
const REQUEST_LIMIT: usize = 10_000;

/// `listGitEffectsCarryingReason`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GitEffectsReasonQuery {
    pub source_id: String,
    pub needle: String,
    pub escaped: String,
    pub folded_json: String,
}

/// The `(sourceId, slug)` of `listPageGitEffectsForStrip`, `listRequestsRecordingReasons` and
/// `countPagePurgeTombstones`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSlugArgs {
    pub source_id: String,
    pub slug: String,
}

/// `setPurgeEffectData`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectDataUpdate {
    pub effect_id: String,
    pub data: Value,
}

/// `listPageChangeReasons`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PageChangeReasonsQuery {
    pub source_id: String,
    pub slug: String,
    pub page_id: i64,
}

/// `readDeletePageRequest`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DeletePageRequestQuery {
    pub source_id: String,
    pub request_id: String,
}

/// `listPurgeEffects`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeEffectsQuery {
    pub request_id: String,
}

/// `findPurgeBlockedPublication({ sourceId, slugs, ownRequest })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockedPublicationQuery {
    pub source_id: String,
    pub slugs: Vec<String>,
    pub own_request: String,
}

/// A `::uuid` argument in lower case.
fn uuid_arg(op: &str, name: &str, text: &str) -> Result<String> {
    if is_uuid(text) {
        Ok(text.to_lowercase())
    } else {
        Err(StoreError::invalid(format!("{op}: {name} is not a UUID")))
    }
}

/// Every request row, in key order.
fn all_requests(read: &dyn KvRead) -> Result<Vec<RequestRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::REQUEST], false, &mut |_, v| {
        match serde_json::from_slice::<RequestRecord>(v) {
            Ok(r) => out.push(r),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// `data -> key` for an object, none otherwise (`->` on a scalar or array is NULL).
fn field<'a>(data: &'a Value, key: &str) -> Option<&'a Value> {
    data.as_object().and_then(|o| o.get(key))
}

/// `intent->>'reason'`.
fn intent_reason(r: &RequestRecord) -> Option<String> {
    field(&r.intent, "reason").and_then(jsonb_field_text)
}

/// `outcome->'reason_recorded'`.
fn reason_recorded(r: &RequestRecord) -> Option<&Value> {
    r.outcome.as_ref().and_then(|o| field(o, "reason_recorded"))
}

impl Store {
    /// `listPageChangeReasons(sourceId, slug, pageId)`.
    pub fn list_page_change_reasons(&self, q: &PageChangeReasonsQuery) -> Result<Vec<Value>> {
        no_nul(
            "listPageChangeReasons",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let mut reasons: BTreeSet<Option<String>> = BTreeSet::new();
        if let Ok(page_id) = u64::try_from(q.page_id) {
            for v in versions_of(&*read, page_id)? {
                reasons.insert(v.change_reason);
            }
        }
        for r in all_requests(&*read)? {
            if r.source_id == q.source_id && r.slug == q.slug {
                reasons.insert(intent_reason(&r));
                reasons.insert(
                    reason_recorded(&r)
                        .and_then(|v| field(v, "reason"))
                        .and_then(jsonb_field_text),
                );
            }
        }
        Ok(reasons
            .into_iter()
            .map(|reason| json!({ "reason": reason }))
            .collect())
    }

    /// `listRequestsRecordingReasons(sourceId, slug)`.
    pub fn list_requests_recording_reasons(&self, q: &SourceSlugArgs) -> Result<Vec<Value>> {
        no_nul(
            "listRequestsRecordingReasons",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let mut rows: Vec<RequestRecord> = all_requests(&*read)?
            .into_iter()
            .filter(|r| {
                r.source_id == q.source_id
                    && r.slug == q.slug
                    && (intent_reason(r).is_some() || reason_recorded(r).is_some())
            })
            .collect();
        rows.sort_by_key(|r| r.sequence);
        Ok(rows
            .into_iter()
            .take(REQUEST_LIMIT)
            .map(|r| json!({ "id": r.id, "principal_kind": r.principal_kind, "principal_id": r.principal_id }))
            .collect())
    }

    /// `readDeletePageRequest(sourceId, requestId)`.
    pub fn read_delete_page_request(&self, q: &DeletePageRequestQuery) -> Result<Value> {
        let op = "readDeletePageRequest";
        no_nul(op, &[("sourceId", &q.source_id)])?;
        let request_id = uuid_arg(op, "requestId", &q.request_id)?;
        let read = self.read()?;
        let newest = all_requests(&*read)?
            .into_iter()
            .filter(|r| {
                r.source_id == q.source_id
                    && r.operation == "delete_page"
                    && r.request_id.to_lowercase() == request_id
            })
            .max_by_key(|r| (r.created_at_us, r.sequence));
        Ok(newest.map_or(Value::Null, |r| {
            json!({ "id": r.id, "request_id": r.request_id.to_lowercase(), "state": r.state, "source_id": r.source_id, "outcome": r.outcome })
        }))
    }

    /// `findPurgeBlockedPublication(sourceId, slugs, ownRequest)`: one unfinished write request (queued, deferred,
    /// running or recovering, or carrying a recovery) of the source on one of the slugs, else one unfinished
    /// `withdrawal-mirror` effect of the source whose `data.targets` name one of the slugs, neither of the request
    /// `ownRequest`; null for none. The SQL takes the first row of its `UNION ALL` with no `ORDER BY`: here the request
    /// arm wins, each arm in key order.
    pub fn find_purge_blocked_publication(&self, q: &BlockedPublicationQuery) -> Result<Value> {
        let op = "findPurgeBlockedPublication";
        let own = uuid_arg(op, "ownRequest", &q.own_request)?;
        let slugs: BTreeSet<&str> = q.slugs.iter().map(String::as_str).collect();
        let read = self.read()?;
        let requests = all_requests(&*read)?;
        for r in &requests {
            let unfinished = matches!(
                r.state.as_str(),
                "queued" | "deferred" | "running" | "recovering"
            ) || r.extra.get("recovery").is_some_and(|v| !v.is_null());
            if r.source_id == q.source_id
                && r.id.to_lowercase() != own
                && slugs.contains(r.slug.as_str())
                && unfinished
            {
                return Ok(
                    json!({ "request_id": r.request_id.to_lowercase(), "slug": r.slug, "state": r.state }),
                );
            }
        }
        for e in all_effects(&*read)? {
            if e.kind != "withdrawal-mirror"
                || e.source_id.as_deref() != Some(q.source_id.as_str())
                || e.request_id.to_lowercase() == own
            {
                continue;
            }
            if e.state == "committed" && e.recovery.as_ref().is_none_or(Value::is_null) {
                continue;
            }
            let Some(request) = requests
                .iter()
                .find(|r| r.id.eq_ignore_ascii_case(&e.request_id))
            else {
                continue;
            };
            let targets = field(&e.data, "targets")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for t in targets {
                if let Some(slug) = field(&t, "slug").and_then(jsonb_field_text)
                    && slugs.contains(slug.as_str())
                {
                    return Ok(
                        json!({ "request_id": request.request_id.to_lowercase(), "slug": slug, "state": e.state }),
                    );
                }
            }
        }
        Ok(Value::Null)
    }

    /// `listPurgeEffects(requestId)`. A `parked` value that is not an array refuses, as
    /// `jsonb_array_length` refuses a scalar or an object.
    pub fn list_purge_effects(&self, q: &PurgeEffectsQuery) -> Result<Vec<Value>> {
        let op = "listPurgeEffects";
        let request_id = uuid_arg(op, "requestId", &q.request_id)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for e in request_effects(&*read, &request_id)? {
            let parked = match field(&e.data, "parked") {
                None => false,
                Some(Value::Array(items)) => !items.is_empty(),
                Some(_) => {
                    return Err(StoreError::invalid(format!(
                        "{op}: effect {} has a parked value that is not an array",
                        e.id
                    )));
                }
            };
            rows.push(json!({ "kind": e.kind, "state": e.state, "error_code": e.error_code, "parked": parked }));
        }
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_reason_reads_as_the_arrow_operators_read_it() {
        assert_eq!(
            field(&json!({ "reason": "x" }), "reason").and_then(jsonb_field_text),
            Some("x".into())
        );
        assert_eq!(
            field(&json!({ "reason": null }), "reason").and_then(jsonb_field_text),
            None
        );
        assert_eq!(
            field(&json!({ "reason": 5 }), "reason").and_then(jsonb_field_text),
            Some("5".into())
        );
        assert_eq!(field(&json!(["reason"]), "reason"), None);
        // `outcome->'reason_recorded' IS NOT NULL` holds for a JSON null value.
        assert!(field(&json!({ "reason_recorded": null }), "reason_recorded").is_some());
    }
}
