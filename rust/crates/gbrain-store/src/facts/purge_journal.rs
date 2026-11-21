//! Group 5 facts members, the purge statements over the write journal and the change-reason
//! tombstones (src/core/engine-sql/facts-purge.ts, `facts/purge-reasons.ts` and `facts/purge-verify.ts`).
//!
//! - `insertReasonPurgeTombstones(sourceId, commits, paths)`: stores each `(commit, path)` pair of
//!   the source once (`ON CONFLICT DO NOTHING`); the number added. The pairs are the two arrays
//!   zipped, as `unnest($2, $3)` pairs them; arrays of different lengths would put a NULL in a
//!   `NOT NULL` column, so they refuse with `constraint_violation`, as does a source that does not
//!   exist (the `sources` foreign key).
//! - `listGitEffectsCarryingReason(sourceId, needle, escaped, foldedJson)`: the source's `git`
//!   effects whose data, as jsonb text after `lower()`, holds one of the three needles, in effect id
//!   order, each `{ id, state, request_id, data }` with the `request_id` of the request that queued it.
//! - `listPageGitEffectsForStrip(sourceId, slug)`: the source's `git` effects whose `data->>'slug'`
//!   is the slug and whose data has a `commit_line`, `commit_trailers` or `commit_trailer` key (a JSON
//!   null value counts, as `data->'k' IS NOT NULL` does), in effect id order.
//! - `setPurgeEffectData(effectId, data)`: replaces one effect's data; an id no effect has changes
//!   nothing. `effectId` is the bigint as text; other text refuses, as `$1::bigint` does.
//! - `listPageChangeReasons(sourceId, slug, pageId)`: the change reasons of the page's versions and the
//!   `intent->>'reason'` and `outcome->'reason_recorded'->>'reason'` of the slug's requests, each once
//!   (`UNION`), null included, in byte order (null first).
//! - `listRequestsRecordingReasons(sourceId, slug)`: the slug's requests with an `intent->>'reason'`
//!   or a `reason_recorded` outcome key, by sequence, at most 10000, each `{ id, principal_kind,
//!   principal_id }`.
//! - `countPagePurgeTombstones(sourceId, slug)`: the slug's `page_purges` tombstones.
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
//! Keys: a change-reason tombstone is `F 0x10 source \0 commit \0 path` with the JSON value
//! `{"created_at_us": <i64>}`; the key is the table's primary key. Deleting a source removes its
//! tombstones ([`remove_source_rows`]).

use crate::cli_reads::pg_text::{jsonb_text, pg_lower};
use crate::env::is_uuid;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::facts::page_purges::source_purges;
use crate::journal::RequestRecord;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::versions_of;
use crate::persistence::{EffectRecord, all_effects, effect_by_id, request_effects, write_effect};
use crate::sources::read_source;
use crate::timeline_queries::jsonb_field_text;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The byte after `keys::FACT` that marks a change-reason tombstone.
const REASON_TOMBSTONE: u8 = 0x10;
/// `LIMIT 10000` of the requests that record a reason.
const REQUEST_LIMIT: usize = 10_000;
/// The keys whose presence marks a Git effect the strip rewrites.
const COMMIT_KEYS: [&str; 3] = ["commit_line", "commit_trailers", "commit_trailer"];

/// What is stored for a change-reason tombstone besides its key.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TombstoneRecord {
    created_at_us: i64,
}

/// `insertReasonPurgeTombstones`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ReasonTombstonesInsert {
    pub source_id: String,
    pub commits: Vec<String>,
    pub paths: Vec<String>,
}

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

fn tombstone_key(parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::FACT, REASON_TOMBSTONE];
    for part in parts {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key
}

/// Removes every change-reason tombstone of a source, for the source delete.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    scan_prefix(tx, &tombstone_key(&[source_id]), false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for k in doomed {
        tx.delete(&k)?;
    }
    Ok(())
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

/// A Git effect row with the request id of the request that queued it; none when no request has the
/// effect's journal id (the inner join drops it).
fn git_effect_row(read: &dyn KvRead, e: &EffectRecord) -> Result<Option<Value>> {
    let request: Option<RequestRecord> = get_json(read, &keys::request(&e.request_id))?;
    Ok(request.map(|r| json!({ "id": e.id.to_string(), "state": e.state, "request_id": r.request_id, "data": e.data })))
}

/// The source's `git` effects that pass `keep`, in id order, as Git effect rows.
fn git_effects(
    read: &dyn KvRead,
    source_id: &str,
    keep: impl Fn(&Value) -> bool,
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for e in all_effects(read)? {
        if e.kind == "git" && e.source_id.as_deref() == Some(source_id) && keep(&e.data) {
            out.extend(git_effect_row(read, &e)?);
        }
    }
    Ok(out)
}

impl Store {
    /// `insertReasonPurgeTombstones(sourceId, commits, paths)`.
    pub fn insert_reason_purge_tombstones(&self, q: &ReasonTombstonesInsert) -> Result<i64> {
        let op = "insertReasonPurgeTombstones";
        no_nul(op, &[("sourceId", &q.source_id)])?;
        for text in q.commits.iter().chain(&q.paths) {
            no_nul(op, &[("a commit or path", text)])?;
        }
        if q.commits.len() != q.paths.len() {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                format!(
                    "{op}: commits and paths differ in length, so a pair would have a null commit or path"
                ),
            ));
        }
        let created_at_us = self.env.now_micros();
        self.write(|tx| {
            if q.commits.is_empty() {
                return Ok(0);
            }
            if read_source(tx, &q.source_id)?.is_none() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("{op}: source \"{}\" does not exist", q.source_id),
                ));
            }
            let mut added = 0;
            for (commit, path) in q.commits.iter().zip(&q.paths) {
                let k = tombstone_key(&[&q.source_id, commit, path]);
                if tx.get(&k)?.is_none() {
                    put_json(tx, &k, &TombstoneRecord { created_at_us })?;
                    added += 1;
                }
            }
            Ok(added)
        })
    }

    /// `listGitEffectsCarryingReason(sourceId, needle, escaped, foldedJson)`.
    pub fn list_git_effects_carrying_reason(
        &self,
        q: &GitEffectsReasonQuery,
    ) -> Result<Vec<Value>> {
        no_nul(
            "listGitEffectsCarryingReason",
            &[
                ("sourceId", &q.source_id),
                ("needle", &q.needle),
                ("escaped", &q.escaped),
                ("foldedJson", &q.folded_json),
            ],
        )?;
        let read = self.read()?;
        git_effects(&*read, &q.source_id, |data| {
            let text = pg_lower(&jsonb_text(data));
            [&q.needle, &q.escaped, &q.folded_json]
                .iter()
                .any(|n| text.contains(n.as_str()))
        })
    }

    /// `listPageGitEffectsForStrip(sourceId, slug)`.
    pub fn list_page_git_effects_for_strip(&self, q: &SourceSlugArgs) -> Result<Vec<Value>> {
        no_nul(
            "listPageGitEffectsForStrip",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        git_effects(&*read, &q.source_id, |data| {
            field(data, "slug").and_then(jsonb_field_text).as_deref() == Some(q.slug.as_str())
                && COMMIT_KEYS.iter().any(|k| field(data, k).is_some())
        })
    }

    /// `setPurgeEffectData(effectId, data)`.
    pub fn set_purge_effect_data(&self, q: &EffectDataUpdate) -> Result<()> {
        let op = "setPurgeEffectData";
        let id: i64 = q.effect_id.trim().parse().map_err(|_| {
            StoreError::invalid(format!(
                "{op}: effectId \"{}\" is not a bigint",
                q.effect_id
            ))
        })?;
        self.write(|tx| {
            let Some(mut effect) = effect_by_id(tx, id)? else {
                return Ok(());
            };
            effect.data = q.data.clone();
            write_effect(tx, &effect)
        })
    }

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

    /// `countPagePurgeTombstones(sourceId, slug)`.
    pub fn count_page_purge_tombstones(&self, q: &SourceSlugArgs) -> Result<i64> {
        let op = "countPagePurgeTombstones";
        no_nul(op, &[("sourceId", &q.source_id), ("slug", &q.slug)])?;
        let read = self.read()?;
        let count = source_purges(&*read, &q.source_id, op)?
            .iter()
            .filter(|(slug, _)| *slug == q.slug)
            .count();
        Ok(count as i64)
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

    #[test]
    fn a_tombstone_key_ends_each_part_with_a_nul() {
        let k = tombstone_key(&["s", "c", "p"]);
        assert_eq!(k, [keys::FACT, REASON_TOMBSTONE, b's', 0, b'c', 0, b'p', 0]);
        assert!(k.starts_with(&tombstone_key(&["s"])));
        assert!(!tombstone_key(&["s2"]).starts_with(&tombstone_key(&["s"])));
    }
}
