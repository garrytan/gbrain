//! The managed sync run's journal reads and the `sync.admission` stamp (rust/docs/store/persistence.md, "Sync run
//! reads"), each the store form of one statement in `src/core/engine-sql/sync-run-reads.ts` or
//! `src/core/engine-sql/sync-admission.ts`:
//! - `readAdmittedWriteRequests`: the request rows a principal admitted under the named request ids
//!   (persistence/sync-admitted.ts `readAdmitted`), optionally only the committed ones.
//! - `readPageRevisionWriter` and `readRevisionWriterRequest`: a page's live revision and the request that wrote it,
//!   the two reads of the `concurrent_write` proof (persistence/sync-concurrent-write.ts).
//! - `writeSyncAdmissionStamp`: the `op_checkpoints` row that dates a local `config set sync.admission`.
//! - `readSyncAdmissionEffects`: `sync status`'s two `effective` probes (persistence/sync-admission-sql.ts).
//!
//! Each answers as the SQL statement does: a uuid parameter that is not a UUID is an invalid argument (the `::uuid`
//! cast), `->>` gives a string as is and anything else as its jsonb text, and a timestamp parameter that does not parse
//! is an invalid argument (the `::timestamptz` cast).

use std::collections::HashSet;

use super::housekeeping::HousekeepingRow;
use super::op_checkpoint::parent_key;
use super::projection_queue::parse_timestamptz;
use super::{all_requests, uuid_param};
use crate::cli_reads::pg_text::{jsonb_text, timestamptz_text};
use crate::error::{Result, StoreError};
use crate::jobs::live_lock_token;
use crate::journal::{Principal, read_request};
use crate::kv::KvRead;
use crate::pages::read_page_by_id;
use crate::{Store, get_json, put_json};
use serde::Deserialize;
use serde_json::{Value, json};

/// The request states a destructive request is unpublished in (`r.state IN ('queued','running','recovering')`).
const UNPUBLISHED: [&str; 3] = ["queued", "running", "recovering"];

/// `readSyncAdmissionEffects(input)`: the binds of the two probes.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncAdmissionEffectsQuery {
    pub lock_id: String,
    pub pass_op: String,
    pub pass_key: String,
    #[serde(default)]
    pub set_at: Option<String>,
    pub source_id: String,
    pub incarnation: String,
    pub kinds: Vec<String>,
}

/// `->>` of a JSON value: a string as is, a JSON null or a missing key as NULL, anything else as its jsonb text.
fn arrow_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// `to_jsonb(timestamptz)` with TimeZone UTC: `2026-01-03T00:00:00.215+00:00`, trailing fraction zeros dropped.
fn jsonb_timestamptz(micros: i64) -> String {
    format!("{}:00", timestamptz_text(micros).replacen(' ', "T", 1))
}

/// The pinned-pass probe: the pass row is `open`, its `lease_token` holds the live lease `lock_id`, and (with a
/// `set_at`) it started before `set_at`.
fn pass_pinned(
    read: &dyn KvRead,
    q: &SyncAdmissionEffectsQuery,
    set_at: Option<i64>,
    now: i64,
) -> Result<bool> {
    let Some(row) = get_json::<HousekeepingRow>(read, &parent_key(&q.pass_op, &q.pass_key)?)?
    else {
        return Ok(false);
    };
    let Some(first) = row.completed_keys.as_array().and_then(|keys| keys.first()) else {
        return Ok(false);
    };
    let telemetry = first.get("telemetry");
    if arrow_text(telemetry.and_then(|t| t.get("outcome"))).as_deref() != Some("open") {
        return Ok(false);
    }
    let Some(token) = live_lock_token(read, &q.lock_id, now)? else {
        return Ok(false);
    };
    if arrow_text(first.get("lease_token")).as_deref() != Some(token.as_str()) {
        return Ok(false);
    }
    let Some(set_at) = set_at else {
        return Ok(true);
    };
    match arrow_text(telemetry.and_then(|t| t.get("started_at"))) {
        Some(started) => Ok(parse_timestamptz(&started, "started_at")? < set_at),
        None => Ok(false),
    }
}

/// The destructive-request probe: a request of the source incarnation whose kind is one of `kinds` is still queued,
/// running or recovering, and (with a `set_at`) was admitted before `set_at`.
fn destructive_pending(
    read: &dyn KvRead,
    q: &SyncAdmissionEffectsQuery,
    incarnation: &str,
    set_at: Option<i64>,
) -> Result<bool> {
    Ok(all_requests(read)?.iter().any(|r| {
        r.source_id == q.source_id
            && r.source_incarnation.eq_ignore_ascii_case(incarnation)
            && UNPUBLISHED.contains(&r.state.as_str())
            && arrow_text(r.intent.get("kind")).is_some_and(|k| q.kinds.contains(&k))
            && set_at.is_none_or(|at| r.created_at_us < at)
    }))
}

impl Store {
    /// `readAdmittedWriteRequests(kind, id, requestIds, committedOnly)`: the principal's request rows under the named
    /// request ids, each at most once; only the committed ones when `committed_only`.
    pub fn read_admitted_write_requests(
        &self,
        principal: &Principal,
        request_ids: &[String],
        committed_only: bool,
    ) -> Result<Vec<Value>> {
        let ids = request_ids
            .iter()
            .map(|id| uuid_param(id, "requestId"))
            .collect::<Result<Vec<_>>>()?;
        let read = self.read()?;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for id in ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(r) = read_request(&*read, principal, &id)?
                && (!committed_only || r.state == "committed")
            {
                out.push(r.to_row());
            }
        }
        Ok(out)
    }

    /// `readPageRevisionWriter(pageId, sourceId)`: the page's live revision and the request id that wrote it.
    pub fn read_page_revision_writer(
        &self,
        page_id: u64,
        source_id: &str,
    ) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(read_page_by_id(&*read, page_id)?
            .filter(|p| p.source_id == source_id)
            .map(|p| json!({ "revision": p.knowledge_revision, "writer": p.revision_receipt.request_id })))
    }

    /// `readRevisionWriterRequest(id)`: the request row `id` projected to the proof's columns.
    pub fn read_revision_writer_request(&self, id: &str) -> Result<Option<Value>> {
        let id = uuid_param(id, "id")?;
        let read = self.read()?;
        Ok(
            get_json::<crate::journal::RequestRecord>(&*read, &crate::keys::request(&id))?.map(
                |r| {
                    json!({
                        "request_id": r.request_id.to_lowercase(),
                        "operation": r.operation,
                        "kind": arrow_text(r.intent.get("kind")),
                        "state": r.state,
                        "incarnation": r.source_incarnation.to_lowercase(),
                        "page_id": r.page_id,
                    })
                },
            ),
        )
    }

    /// `writeSyncAdmissionStamp(op, fingerprint, value)`: the checkpoint parent set to `[{value, set_at}]` with `set_at`
    /// the moment of the write (`clock_timestamp()`); returns `set_at` as its jsonb text.
    pub fn write_sync_admission_stamp(
        &self,
        op: &str,
        fingerprint: &str,
        value: &str,
    ) -> Result<String> {
        if value.contains('\0') {
            return Err(StoreError::invalid(
                "a sync.admission value cannot contain NUL",
            ));
        }
        let key = parent_key(op, fingerprint)?;
        self.write(|tx| {
            let now = self.env.now_micros();
            // `set_at` is `clock_timestamp()`, not the transaction's `now()`: a request queued earlier in the same
            // transaction carries `now()` as its `created_at` and must date before the stamp.
            let set_at = jsonb_timestamptz(self.env.clock_micros());
            put_json(
                tx,
                &key,
                &HousekeepingRow {
                    completed_keys: json!([{ "value": value, "set_at": set_at }]),
                    updated_at_us: now,
                },
            )?;
            Ok(set_at)
        })
    }

    /// `readSyncAdmissionEffects(input)`: `{ pinned, destructive }`.
    pub fn read_sync_admission_effects(&self, q: &SyncAdmissionEffectsQuery) -> Result<Value> {
        let incarnation = uuid_param(&q.incarnation, "incarnation")?;
        let set_at = q
            .set_at
            .as_deref()
            .map(|at| parse_timestamptz(at, "setAt"))
            .transpose()?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let pinned = pass_pinned(&*read, q, set_at, now)?;
        let destructive = destructive_pending(&*read, q, &incarnation, set_at)?;
        Ok(json!({ "pinned": pinned, "destructive": destructive }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonb_timestamptz_matches_to_jsonb() {
        // 2026-01-03T00:00:00.215Z
        let micros = 1_767_398_400_215_000;
        assert_eq!(jsonb_timestamptz(micros), "2026-01-03T00:00:00.215+00:00");
        assert_eq!(
            jsonb_timestamptz(1_767_398_400_000_000),
            "2026-01-03T00:00:00+00:00"
        );
        assert_eq!(
            parse_timestamptz(&jsonb_timestamptz(micros), "t").unwrap(),
            micros
        );
    }

    #[test]
    fn arrow_text_folds_like_postgres() {
        assert_eq!(arrow_text(None), None);
        assert_eq!(arrow_text(Some(&Value::Null)), None);
        assert_eq!(arrow_text(Some(&json!("open"))).as_deref(), Some("open"));
        assert_eq!(arrow_text(Some(&json!(3))).as_deref(), Some("3"));
    }
}
