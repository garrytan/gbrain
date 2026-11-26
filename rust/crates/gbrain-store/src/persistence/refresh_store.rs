//! Worktree refresh (`refreshStore()`, `src/core/engine-sql/refresh-store.ts`; rust/docs/store/managed-mode.md): the rows
//! `gbrain sources refresh` writes, the reads its recovery and the writes waiting behind it make, and the held-write
//! statements of the refresh barrier.
//!
//! The rows are the refresh keyspace K1 (`worktree_admission.rs`): one `persistence_worktree_refreshes` row per refresh,
//! JSON, keyed by its id. Each kind answers what its Postgres statement answers, from those rows, the request, effect
//! and topology-change records, the source records and the managed-sync checkpoints.
//!
//! Locks. The statements' row locks and session settings are no reads or writes here; the TypeScript member does not call
//! them at all. The guarantee they gave holds another way: an explicit transaction is Serialized (it holds the store's
//! writer, so no other commit interleaves with what it read), and under optimistic transactions every record read below
//! is in the transaction's read set, so a racing change aborts the commit with `write_conflict` instead of being missed.
//! The unique index that allows one active refresh per worktree is checked at the insert, in the same transaction. No file
//! lock, no process-wide mutex and no busy error is added.
//!
//! Fences (lane LM slice 3, I-5). A refresh row is a claim of the run that holds it, identified by the row id under the
//! claim family `CLAIM_REFRESH`. Every write here runs `fence::begin` once in its own write transaction. The claim is
//! taken when the row is created (`insert_draining`) or adopted by a new holder (`adopt_claim`, and `set_holder`, which
//! makes the caller the holder): resume and recovery by a new holder take a NEW claim and overwrite the record, never
//! borrow the old one. Every state mutation (`transition`, `replan`, `mark_merge_started`) checks the claim before it writes
//! (`lease_lost` / `claim_epoch_mismatch` otherwise, nothing written), the terminal states end it, and `hold_for_import`,
//! which releases a request's write claim, checks and ends that claim (`CLAIM_WRITE`). A call with no fence on a store that
//! is not multi-user does none of this and writes no `~L` key.
//!
//! Triggers. `gbrain_release_refresh_barrier` stamps `released_at` when a refresh first reaches `completed` or `aborted`;
//! `transition` does the same.

use super::effect_worker::pg_uuid;
use super::effects::all_effects;
use super::op_checkpoint::list_op_checkpoint_records_in;
use super::topology::all_change_records;
use super::worktree_admission::{
    ACTIVE_REFRESH_STATES, RefreshRecord, all_refreshes, put_refresh, read_refresh,
    released_deferred,
};
use super::worktree_rows::read_worktree_row;
use super::worktrees::read_worktree_record;
use super::{all_requests, extra_is_null, json_text, request_by_id, sync_kind};
use crate::env::{Env, iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::fence;
use crate::journal::{RequestRecord, write_request};
use crate::kv::{KvRead, KvWrite};
use crate::leases::{CLAIM_REFRESH, CLAIM_WRITE, LeaseToken};
use crate::sources::{read_source, source_key};
use crate::{Store, put_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

/// One read of `refreshStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RefreshRead {
    Active {
        worktree_id: String,
    },
    Row {
        id: String,
    },
    Released {
        id: String,
    },
    CompletedTargets {
        worktree_id: String,
        upstream_ref: String,
    },
    Newest {
        worktree_id: String,
    },
    Blocking {
        worktree_id: String,
    },
    RecoveryProbe {
        worktree_id: String,
    },
    DrainCounts {
        worktree_id: String,
    },
    UnfinishedSyncCursor {
        members: Vec<String>,
    },
    MembersPastStart {
        source_ids: Vec<String>,
        barrier_sequence: Option<String>,
    },
    SourceCommits {
        source_ids: Vec<String>,
    },
    MemberCommits {
        source_ids: Vec<String>,
    },
    LaterWrite {
        source_id: String,
        slug: String,
        sequence: String,
    },
    ActiveRows {
        source_id: Option<String>,
    },
    Resumable {
        host_id: String,
        budget_ms: f64,
    },
    Stuck {
        minutes: f64,
    },
    DeferredBacklog {},
    DeferredWaiting {
        source_id: String,
        deferred_refresh_id: Option<String>,
        deferred_import_from: Option<String>,
    },
}

/// One write of `refreshStore()`, named by `kind`; its result is JSON.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RefreshWrite {
    Transition {
        id: String,
        from: Vec<String>,
        to: String,
        outcome: Value,
        terminal: bool,
        #[serde(default)]
        fence: Option<LeaseToken>,
    },
    Replan {
        id: String,
        old_head: String,
        target_head: String,
        #[serde(default)]
        fence: Option<LeaseToken>,
    },
    InsertDraining {
        worktree_id: String,
        source_ids: Vec<String>,
        principal_id: String,
        owner_epoch: String,
        topology_generation: String,
        old_head: String,
        target_head: String,
        upstream_ref: String,
        preserved: Vec<String>,
        outcome: Value,
        #[serde(default)]
        fence: Option<LeaseToken>,
    },
    MarkMergeStarted {
        id: String,
        at_ms: f64,
        #[serde(default)]
        fence: Option<LeaseToken>,
    },
    SetHolder {
        id: String,
        holder: Value,
        #[serde(default)]
        fence: Option<LeaseToken>,
    },
    /// The explicit adoption of an active refresh row by a new holder (resume or recovery): takes a new claim of the
    /// row under the fence, overwriting the record. Rust only (no statement); `true` when the row is active.
    AdoptClaim {
        id: String,
        #[serde(default)]
        fence: Option<LeaseToken>,
    },
    RecordMergedUpstream {
        source_ids: Vec<String>,
        target_head: String,
    },
    HoldForImport {
        id: String,
        token: String,
        import_from: String,
        #[serde(default)]
        fence: Option<LeaseToken>,
    },
}

/// The fence a refresh write carries and the name `fence::begin` reports; `None` for the one write that holds no claim.
fn write_fence(what: &RefreshWrite) -> Option<(&'static str, Option<&LeaseToken>)> {
    Some(match what {
        RefreshWrite::Transition { fence, .. } => ("refresh_transition", fence.as_ref()),
        RefreshWrite::Replan { fence, .. } => ("refresh_replan", fence.as_ref()),
        RefreshWrite::InsertDraining { fence, .. } => ("refresh_insert_draining", fence.as_ref()),
        RefreshWrite::MarkMergeStarted { fence, .. } => {
            ("refresh_mark_merge_started", fence.as_ref())
        }
        RefreshWrite::SetHolder { fence, .. } => ("refresh_set_holder", fence.as_ref()),
        RefreshWrite::AdoptClaim { fence, .. } => ("refresh_adopt_claim", fence.as_ref()),
        RefreshWrite::HoldForImport { fence, .. } => ("refresh_hold_for_import", fence.as_ref()),
        RefreshWrite::RecordMergedUpstream { .. } => return None,
    })
}

fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn extra_str<'a>(record: &'a RefreshRecord, column: &str) -> Option<&'a str> {
    record.extra.get(column).and_then(Value::as_str)
}

/// `SELECT *` of a refresh row, in column order.
fn refresh_row(r: &RefreshRecord) -> Value {
    let pick = |column: &str| r.extra.get(column).cloned().unwrap_or(Value::Null);
    json!({
        "id": r.id,
        "worktree_id": r.worktree_id,
        "source_ids": r.source_ids,
        "principal_id": pick("principal_id"),
        "owner_epoch": pick("owner_epoch"),
        "topology_generation": pick("topology_generation"),
        "state": r.state,
        "old_head": pick("old_head"),
        "target_head": r.target_head,
        "upstream_ref": pick("upstream_ref"),
        "preserved_uncommitted": r.extra.get("preserved_uncommitted").cloned().unwrap_or_else(|| json!([])),
        "outcome": crate::jsonb::order(Value::Object(r.outcome.clone())),
        "created_at": iso(r.created_at_us),
        "updated_at": iso(r.updated_at_us),
        "completed_at": r.completed_at_us.map(iso),
        "barrier_sequence": pick("barrier_sequence"),
        "released_at": r.released_at_us.map(iso),
    })
}

/// `outcome||$n`: the right object's keys replace the left's.
fn merge_outcome(left: &mut Map<String, Value>, right: &Value) {
    if let Value::Object(map) = right {
        for (key, value) in map {
            left.insert(key.clone(), value.clone());
        }
    }
}

fn is_terminal(state: &str) -> bool {
    state == "completed" || state == "aborted"
}

fn active(r: &RefreshRecord) -> bool {
    ACTIVE_REFRESH_STATES.contains(&r.state.as_str())
}

fn newest_first(a: &RefreshRecord, b: &RefreshRecord) -> std::cmp::Ordering {
    b.created_at_us
        .cmp(&a.created_at_us)
        .then_with(|| a.id.cmp(&b.id))
}

/// `COALESCE(last_commit,'')` of a stored source.
fn last_commit_of(read: &dyn KvRead, source_id: &str) -> Result<Option<Option<String>>> {
    Ok(read_source(read, source_id)?.map(|s| s.last_commit))
}

fn sequence_param(text: &str) -> Result<i64> {
    text.trim().parse::<i64>().map_err(|_| {
        StoreError::invalid(format!("invalid input syntax for type bigint: \"{text}\""))
    })
}

/// Worktrees' requests of `worktree_id` (case-folded uuid text).
fn requests_on<'a>(
    requests: &'a [RequestRecord],
    worktree_id: &'a str,
) -> impl Iterator<Item = &'a RequestRecord> {
    requests.iter().filter(move |r| {
        r.extra
            .get("worktree_id")
            .and_then(Value::as_str)
            .is_some_and(|w| same(w, worktree_id))
    })
}

/// `claim_expires_at > now()` of a request record (null reads false).
fn claim_live(r: &RequestRecord, now_us: i64) -> bool {
    r.extra
        .get("claim_expires_at")
        .and_then(Value::as_str)
        .and_then(parse_iso)
        .is_some_and(|expires| expires > now_us)
}

pub(crate) fn refresh_rows_in(
    read: &dyn KvRead,
    env: &dyn Env,
    what: &RefreshRead,
) -> Result<Value> {
    let now = env.now_micros();
    match what {
        RefreshRead::Active { worktree_id } => {
            let w = pg_uuid(worktree_id)?;
            Ok(all_refreshes(read)?
                .iter()
                .find(|r| same(&r.worktree_id, &w) && active(r))
                .map_or(Value::Null, refresh_row))
        }
        RefreshRead::Row { id } => Ok(read_refresh(read, &pg_uuid(id)?)?
            .as_ref()
            .map_or(Value::Null, refresh_row)),
        RefreshRead::Released { id } => Ok(read_refresh(read, &pg_uuid(id)?)?.map_or(Value::Null, |r| {
            json!({ "state": r.state, "old_head": extra_str(&r, "old_head"), "target_head": r.target_head,
                "released": r.released_at_us.is_some() })
        })),
        RefreshRead::CompletedTargets { worktree_id, upstream_ref } => {
            let w = pg_uuid(worktree_id)?;
            let mut rows: Vec<_> = all_refreshes(read)?
                .into_iter()
                .filter(|r| same(&r.worktree_id, &w) && extra_str(r, "upstream_ref") == Some(upstream_ref.as_str()) && r.state == "completed")
                .collect();
            rows.sort_by(newest_first);
            rows.truncate(100);
            Ok(Value::Array(rows.iter().map(|r| json!(r.target_head)).collect()))
        }
        RefreshRead::Newest { worktree_id } => {
            let w = pg_uuid(worktree_id)?;
            let mut rows: Vec<_> = all_refreshes(read)?.into_iter().filter(|r| same(&r.worktree_id, &w)).collect();
            rows.sort_by(newest_first);
            Ok(rows.first().map_or(Value::Null, |r| json!({ "state": r.state, "source_ids": r.source_ids })))
        }
        RefreshRead::Blocking { worktree_id } => {
            let w = pg_uuid(worktree_id)?;
            Ok(all_refreshes(read)?
                .iter()
                .find(|r| {
                    same(&r.worktree_id, &w)
                        && matches!(r.state.as_str(), "draining" | "fenced" | "merged" | "recovery_required")
                })
                .map_or(Value::Null, |r| json!({ "id": r.id, "state": r.state })))
        }
        RefreshRead::RecoveryProbe { worktree_id } => {
            let w = pg_uuid(worktree_id)?;
            let requests = all_requests(read)?;
            let in_flight = |state: &str, claimed: bool| state == "running" && claimed;
            let publication = requests_on(&requests, &w)
                .any(|r| !extra_is_null(r, "recovery") && !in_flight(&r.state, claim_live(r, now)))
                || all_effects(read)?.iter().any(|e| {
                    e.worktree_id.as_deref().is_some_and(|x| same(x, &w))
                        && e.recovery.is_some()
                        && !in_flight(&e.state, e.claim_expires_at_us.is_some_and(|c| c > now))
                });
            let topology = all_change_records(read)?.iter().any(|c| {
                c.recovery
                    .as_ref()
                    .and_then(|r| r.get("worktreeId"))
                    .and_then(Value::as_str)
                    .is_some_and(|x| x == w)
            });
            Ok(json!({ "publication": publication, "topology": topology }))
        }
        RefreshRead::DrainCounts { worktree_id } => {
            let w = pg_uuid(worktree_id)?;
            let refreshes: HashMap<String, RefreshRecord> =
                all_refreshes(read)?.into_iter().map(|r| (r.id.clone(), r)).collect();
            let all = all_requests(read)?;
            let mut requests = 0;
            let mut recovery = 0;
            for r in requests_on(&all, &w) {
                let refresh = r
                    .extra
                    .get("deferred_refresh_id")
                    .and_then(Value::as_str)
                    .and_then(|id| refreshes.get(&id.to_lowercase()));
                if matches!(r.state.as_str(), "queued" | "running" | "recovering") || released_deferred(read, r, refresh)? {
                    requests += 1;
                }
                if !extra_is_null(r, "recovery") {
                    recovery += 1;
                }
            }
            let mut effects = 0;
            for e in all_effects(read)?.iter().filter(|e| e.worktree_id.as_deref().is_some_and(|x| same(x, &w))) {
                if matches!(e.kind.as_str(), "git" | "withdrawal-mirror") && matches!(e.state.as_str(), "queued" | "running") {
                    effects += 1;
                }
                if e.recovery.is_some() {
                    recovery += 1;
                }
            }
            Ok(json!({ "requests": requests, "effects": effects, "recovery": recovery }))
        }
        RefreshRead::UnfinishedSyncCursor { members } => {
            let Value::Array(records) = list_op_checkpoint_records_in(read, "managed-sync")? else {
                return Ok(Value::Null);
            };
            let mut open: Vec<(i64, String, Value)> = Vec::new();
            for record in &records {
                let header = record.pointer("/completed_keys/0").cloned().unwrap_or(Value::Null);
                let done = json_text(header.get("done")).unwrap_or_else(|| "false".into());
                let source = json_text(header.get("sourceId"));
                if done != "true" && source.as_ref().is_some_and(|s| members.contains(s)) {
                    open.push((
                        record.get("updated_at_us").and_then(Value::as_i64).unwrap_or(0),
                        record.get("fingerprint").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        header,
                    ));
                }
            }
            open.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.as_bytes().cmp(b.1.as_bytes())));
            Ok(open.into_iter().next().map_or(Value::Null, |(_, _, header)| {
                json!({ "source_id": json_text(header.get("sourceId")), "header": header })
            }))
        }
        RefreshRead::MembersPastStart { source_ids, barrier_sequence } => {
            let barrier = barrier_sequence.as_deref().map(sequence_param).transpose()?;
            let requests = all_requests(read)?;
            let mut ids = source_ids.clone();
            ids.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            ids.dedup();
            let mut out = Vec::new();
            for id in &ids {
                let Some(last_commit) = last_commit_of(read, id)? else { continue };
                let imported = barrier.is_some_and(|barrier| {
                    requests.iter().any(|r| {
                        &r.source_id == id
                            && i64::try_from(r.sequence).is_ok_and(|s| s > barrier)
                            && matches!(json_text(r.intent.get("kind")).as_deref(), Some("managed_sync_import" | "managed_sync_delete"))
                            && !matches!(r.state.as_str(), "failed" | "conflict" | "cancelled")
                    })
                });
                out.push(json!({ "id": id, "last_commit": last_commit, "imported": imported }));
            }
            Ok(Value::Array(out))
        }
        RefreshRead::SourceCommits { source_ids } => {
            let mut ids = source_ids.clone();
            ids.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            ids.dedup();
            let mut out = Vec::new();
            for id in &ids {
                if let Some(last_commit) = last_commit_of(read, id)? {
                    out.push(json!({ "id": id, "last_commit": last_commit }));
                }
            }
            Ok(Value::Array(out))
        }
        RefreshRead::MemberCommits { source_ids } => {
            let mut ids = source_ids.clone();
            ids.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            ids.dedup();
            let mut out = Vec::new();
            for id in &ids {
                if let Some(last_commit) = last_commit_of(read, id)? {
                    out.push(json!({ "last_commit": last_commit }));
                }
            }
            Ok(Value::Array(out))
        }
        RefreshRead::LaterWrite { source_id, slug, sequence } => {
            let after = sequence_param(sequence)?;
            let mut later: Vec<&RequestRecord> = Vec::new();
            let all = all_requests(read)?;
            for r in &all {
                let imported_file = r.outcome.as_ref().is_some_and(|o| json_text(o.get("imported_file")).as_deref() == Some("true"));
                let connector = r.outcome.as_ref().is_some_and(|o| o.get("connector_database").is_some());
                let sync_row = r.operation == "submit_job"
                    && (sync_kind(&r.intent) || (r.intent.is_null() && imported_file && !connector));
                if &r.source_id == source_id
                    && &r.slug == slug
                    && i64::try_from(r.sequence).is_ok_and(|s| s > after)
                    && r.state == "committed"
                    && !sync_row
                {
                    later.push(r);
                }
            }
            later.sort_by_key(|r| r.sequence);
            Ok(later.first().map_or(Value::Null, |r| json!(r.request_id)))
        }
        RefreshRead::ActiveRows { source_id } => {
            let all = all_requests(read)?;
            let mut rows: Vec<RefreshRecord> = all_refreshes(read)?
                .into_iter()
                .filter(|f| active(f) && source_id.as_ref().is_none_or(|s| f.source_ids.contains(s)))
                .collect();
            rows.sort_by_key(|f| f.created_at_us);
            let mut out = Vec::new();
            for f in &rows {
                let mut row = refresh_row(f);
                let owner = read_worktree_record(read, &f.worktree_id)?.and_then(|w| w.owner_host_id);
                let waiting: Vec<&RequestRecord> = all
                    .iter()
                    .filter(|d| d.state == "deferred" && d.extra.get("deferred_refresh_id").and_then(Value::as_str).is_some_and(|id| same(id, &f.id)))
                    .collect();
                let oldest = waiting.iter().map(|d| d.created_at_us).min();
                row["owner_host_id"] = json!(owner.map(|o| o.to_lowercase()));
                row["deferred_count"] = json!(waiting.len());
                row["deferred_oldest_ms"] = json!(oldest.map(|c| ((now - c) as f64 / 1000.0).round() as i64));
                out.push(row);
            }
            Ok(Value::Array(out))
        }
        RefreshRead::Resumable { host_id, budget_ms } => {
            let host = pg_uuid(host_id)?;
            let cutoff = now - (budget_ms * 1000.0).round() as i64;
            let mut rows: Vec<(bool, RefreshRecord)> = Vec::new();
            for f in all_refreshes(read)? {
                if !matches!(f.state.as_str(), "draining" | "fenced" | "merged" | "syncing") {
                    continue;
                }
                let owned = read_worktree_record(read, &f.worktree_id)?
                    .and_then(|w| w.owner_host_id)
                    .is_some_and(|o| same(&o, &host));
                if !owned {
                    continue;
                }
                let stale = f.updated_at_us < cutoff;
                // `NOT EXISTS (SELECT 1 FROM sources s WHERE s.id=ANY(f.source_ids) AND (s.last_commit IS NULL OR s.last_commit=f.old_head))`.
                let old_head = extra_str(&f, "old_head").map(str::to_owned);
                let mut member_behind = false;
                for id in &f.source_ids {
                    if let Some(s) = read_source(read, id)?
                        && (s.last_commit.is_none() || s.last_commit == old_head)
                    {
                        member_behind = true;
                    }
                }
                if f.state != "syncing" || stale || !member_behind {
                    rows.push((stale, f));
                }
            }
            rows.sort_by(|a, b| (a.1.state == "syncing").cmp(&(b.1.state == "syncing")).then(a.1.created_at_us.cmp(&b.1.created_at_us)));
            rows.truncate(16);
            Ok(Value::Array(
                rows.into_iter()
                    .map(|(stale, f)| {
                        let mut row = refresh_row(&f);
                        row["stale"] = json!(stale);
                        row
                    })
                    .collect(),
            ))
        }
        RefreshRead::Stuck { minutes } => {
            let cutoff = now - (minutes * 60_000_000.0).round() as i64;
            let mut rows: Vec<RefreshRecord> = all_refreshes(read)?.into_iter().filter(|f| active(f) && f.created_at_us < cutoff).collect();
            rows.sort_by_key(|f| f.created_at_us);
            Ok(Value::Array(
                rows.iter()
                    .map(|f| json!({ "id": f.id, "state": f.state, "source_ids": f.source_ids, "updated_at": iso(f.updated_at_us) }))
                    .collect(),
            ))
        }
        RefreshRead::DeferredBacklog {} => {
            let held: Vec<RequestRecord> = all_requests(read)?
                .into_iter()
                .filter(|r| {
                    (!extra_is_null(r, "deferred_refresh_id") || !extra_is_null(r, "deferred_import_from"))
                        && matches!(r.state.as_str(), "deferred" | "queued" | "running" | "recovering")
                })
                .collect();
            let oldest = held.iter().map(|r| r.created_at_us).min();
            Ok(json!({ "count": held.len(), "oldest_age_ms": oldest.map(|c| ((now - c) as f64 / 1000.0).round() as i64) }))
        }
        RefreshRead::DeferredWaiting { source_id, deferred_refresh_id, deferred_import_from } => {
            let refresh_waits = match deferred_refresh_id {
                Some(id) => !read_refresh(read, &pg_uuid(id)?)?.is_some_and(|f| f.released_at_us.is_some()),
                None => false,
            };
            let import_waits = match deferred_import_from {
                Some(from) => !last_commit_of(read, source_id)?.is_some_and(|c| c.as_deref().unwrap_or("") != from),
                None => false,
            };
            Ok(json!({ "waiting": refresh_waits || import_waits }))
        }
    }
}

/// The row's claim is held under `fence` (a row no write would change has no claim to check).
fn refresh_held(
    store: &Store,
    tx: &mut dyn KvWrite,
    r: &RefreshRecord,
    fence: Option<&LeaseToken>,
) -> Result<()> {
    fence::claim_held(store, tx, CLAIM_REFRESH, &r.id.to_lowercase(), fence)
}

pub(crate) fn refresh_write_in(
    store: &Store,
    tx: &mut dyn KvWrite,
    what: &RefreshWrite,
) -> Result<Value> {
    let env = &*store.env;
    let now = env.now_micros();
    if let Some((name, fence)) = write_fence(what) {
        fence::begin(store, tx, fence, name)?;
    }
    match what {
        RefreshWrite::Transition {
            id,
            from,
            to,
            outcome,
            terminal,
            fence,
        } => {
            let Some(mut r) = read_refresh(&*tx, &pg_uuid(id)?)? else {
                return Ok(json!(false));
            };
            if !from.iter().any(|state| state == &r.state) {
                return Ok(json!(false));
            }
            refresh_held(store, tx, &r, fence.as_ref())?;
            // `gbrain_release_refresh_barrier`: the first move into a terminal state releases the barrier.
            if is_terminal(to) && !is_terminal(&r.state) && r.released_at_us.is_none() {
                r.released_at_us = Some(now);
            }
            r.state = to.clone();
            merge_outcome(&mut r.outcome, outcome);
            r.updated_at_us = now;
            if *terminal {
                r.completed_at_us = Some(now);
            }
            put_refresh(tx, &r)?;
            if is_terminal(&r.state) {
                fence::claim_ended(
                    store,
                    tx,
                    CLAIM_REFRESH,
                    &r.id.to_lowercase(),
                    fence.as_ref(),
                )?;
            }
            Ok(json!(true))
        }
        RefreshWrite::Replan {
            id,
            old_head,
            target_head,
            fence,
        } => {
            let Some(mut r) = read_refresh(&*tx, &pg_uuid(id)?)? else {
                return Ok(Value::Null);
            };
            let started = r
                .outcome
                .get("merge_started")
                .and_then(|v| json_text(Some(v)));
            if r.state != "fenced" || started.as_deref() == Some("true") {
                return Ok(Value::Null);
            }
            refresh_held(store, tx, &r, fence.as_ref())?;
            r.extra.insert("old_head".into(), json!(old_head));
            r.target_head = target_head.clone();
            r.updated_at_us = now;
            put_refresh(tx, &r)?;
            Ok(refresh_row(&r))
        }
        RefreshWrite::InsertDraining {
            worktree_id,
            source_ids,
            principal_id,
            owner_epoch,
            topology_generation,
            old_head,
            target_head,
            upstream_ref,
            preserved,
            outcome,
            fence,
        } => {
            let w = pg_uuid(worktree_id)?;
            if read_worktree_row(&*tx, &w)?.is_none() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("worktree_id {w} names no persistence_worktrees row"),
                ));
            }
            // The partial unique index `persistence_worktree_refreshes_active`: one active refresh per worktree.
            if all_refreshes(&*tx)?
                .iter()
                .any(|r| same(&r.worktree_id, &w) && active(r))
            {
                return Ok(json!({ "conflict": true }));
            }
            let barrier = all_requests(&*tx)?.iter().map(|r| r.sequence).max();
            let mut extra = Map::new();
            extra.insert("principal_id".into(), json!(pg_uuid(principal_id)?));
            extra.insert("owner_epoch".into(), json!(owner_epoch));
            extra.insert("topology_generation".into(), json!(topology_generation));
            extra.insert("old_head".into(), json!(old_head));
            extra.insert("upstream_ref".into(), json!(upstream_ref));
            extra.insert("preserved_uncommitted".into(), json!(preserved));
            extra.insert(
                "barrier_sequence".into(),
                barrier.map_or(Value::Null, |s| json!(s.to_string())),
            );
            let mut outcome_map = Map::new();
            merge_outcome(&mut outcome_map, outcome);
            let record = RefreshRecord {
                id: env.new_uuid(),
                worktree_id: w,
                source_ids: source_ids.clone(),
                state: "draining".into(),
                target_head: target_head.clone(),
                outcome: outcome_map,
                created_at_us: now,
                updated_at_us: now,
                completed_at_us: None,
                released_at_us: None,
                extra,
            };
            put_refresh(tx, &record)?;
            fence::claim_taken(
                store,
                tx,
                CLAIM_REFRESH,
                &record.id.to_lowercase(),
                fence.as_ref(),
                "refresh_insert_draining",
                None,
            )?;
            Ok(refresh_row(&record))
        }
        RefreshWrite::MarkMergeStarted { id, at_ms, fence } => {
            let Some(mut r) = read_refresh(&*tx, &pg_uuid(id)?)? else {
                return Ok(json!(false));
            };
            if r.state != "fenced" {
                return Ok(json!(false));
            }
            refresh_held(store, tx, &r, fence.as_ref())?;
            r.outcome.insert("merge_started".into(), json!(true));
            r.outcome
                .insert("merge_started_at".into(), json!(*at_ms as i64));
            r.updated_at_us = now;
            put_refresh(tx, &r)?;
            Ok(json!(true))
        }
        RefreshWrite::AdoptClaim { id, fence } => {
            let Some(r) = read_refresh(&*tx, &pg_uuid(id)?)? else {
                return Ok(json!(false));
            };
            if !active(&r) {
                return Ok(json!(false));
            }
            fence::claim_taken(
                store,
                tx,
                CLAIM_REFRESH,
                &r.id.to_lowercase(),
                fence.as_ref(),
                "refresh_adopt_claim",
                None,
            )?;
            Ok(json!(true))
        }
        RefreshWrite::SetHolder { id, holder, fence } => {
            let Some(mut r) = read_refresh(&*tx, &pg_uuid(id)?)? else {
                return Ok(Value::Null);
            };
            if !active(&r) {
                return Ok(Value::Null);
            }
            // The caller becomes the holder: a new claim of the row, never the old holder's.
            fence::claim_taken(
                store,
                tx,
                CLAIM_REFRESH,
                &r.id.to_lowercase(),
                fence.as_ref(),
                "refresh_set_holder",
                None,
            )?;
            let previous = r
                .outcome
                .get("previous_holder")
                .filter(|v| !v.is_null())
                .or_else(|| r.outcome.get("holder"))
                .cloned();
            r.outcome.insert("holder".into(), holder.clone());
            r.outcome
                .insert("previous_holder".into(), previous.unwrap_or(Value::Null));
            put_refresh(tx, &r)?;
            Ok(Value::Null)
        }
        RefreshWrite::RecordMergedUpstream {
            source_ids,
            target_head,
        } => {
            for id in source_ids {
                if let Some(mut s) = read_source(&*tx, id)? {
                    s.upstream_checked_at_us = Some(now);
                    s.upstream_commit = Some(target_head.clone());
                    s.upstream_behind = Some(0);
                    put_json(tx, &source_key(id), &s)?;
                }
            }
            Ok(Value::Null)
        }
        RefreshWrite::HoldForImport {
            id,
            token,
            import_from,
            fence,
        } => {
            let rid = pg_uuid(id)?;
            let Some(mut r) = request_by_id(&*tx, &rid)? else {
                return Ok(Value::Null);
            };
            let token_matches = r
                .extra
                .get("execution_token")
                .and_then(Value::as_str)
                .is_some_and(|t| same(t, token));
            let started = r
                .extra
                .get("publication_started")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !token_matches || r.state != "running" || !extra_is_null(&r, "recovery") || started {
                return Ok(Value::Null);
            }
            fence::claim_held(store, tx, CLAIM_WRITE, &r.id.to_lowercase(), fence.as_ref())?;
            r.state = "deferred".into();
            r.blocked_reason = None;
            r.updated_at_us = now;
            r.extra
                .insert("deferred_import_from".into(), json!(import_from));
            for column in [
                "deferred_refresh_id",
                "execution_token",
                "claim_expires_at",
                "claim_phase",
            ] {
                r.extra.insert(column.into(), Value::Null);
            }
            write_request(tx, &r)?;
            // The claim is released with the move to `deferred`.
            fence::claim_ended(store, tx, CLAIM_WRITE, &r.id.to_lowercase(), fence.as_ref())?;
            Ok(r.to_row())
        }
    }
}

impl Store {
    /// One `refreshStore()` read (`RefreshRead`) as JSON.
    pub fn refresh_rows(&self, what: &RefreshRead) -> Result<Value> {
        refresh_rows_in(&*self.read()?, &*self.env, what)
    }

    /// One `refreshStore()` write (`RefreshWrite`); its result as JSON.
    pub fn refresh_write(&self, what: &RefreshWrite) -> Result<Value> {
        self.write(|tx| refresh_write_in(self, tx, what))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::TopologyWrite;
    use crate::test_support::store;

    const WT: &str = "d0000000-0000-4000-8000-0000000000d1";
    const HOST: &str = "a0000000-0000-4000-8000-0000000000a1";
    const PRINCIPAL: &str = "b0000000-0000-4000-8000-0000000000b1";

    fn fenced_store() -> Store {
        let s = store();
        s.topology_write(&TopologyWrite::InsertWorktree {
            id: WT.into(),
            host_id: HOST.into(),
        })
        .unwrap();
        s
    }

    fn draining(s: &Store) -> Value {
        s.refresh_write(&RefreshWrite::InsertDraining {
            worktree_id: WT.into(),
            source_ids: vec!["default".into()],
            principal_id: PRINCIPAL.into(),
            owner_epoch: "1".into(),
            topology_generation: "1".into(),
            old_head: "aaa".into(),
            target_head: "bbb".into(),
            upstream_ref: "origin/main".into(),
            preserved: vec![],
            outcome: json!({ "holder": { "pid": 1 } }),
            fence: None,
        })
        .unwrap()
    }

    fn transition(s: &Store, id: &str, from: &[&str], to: &str, terminal: bool) -> bool {
        s.refresh_write(&RefreshWrite::Transition {
            id: id.into(),
            from: from.iter().map(|f| f.to_string()).collect(),
            to: to.into(),
            outcome: json!({}),
            terminal,
            fence: None,
        })
        .unwrap()
        .as_bool()
        .unwrap()
    }

    #[test]
    fn a_worktree_has_one_active_refresh_and_a_terminal_move_releases_the_barrier() {
        let s = fenced_store();
        let row = draining(&s);
        assert_eq!(row["state"], "draining");
        assert_eq!(row["released_at"], Value::Null);
        assert_eq!(
            draining(&s),
            json!({ "conflict": true }),
            "the active index admits one"
        );
        let id = row["id"].as_str().unwrap().to_owned();
        assert!(
            !transition(&s, &id, &["fenced"], "merged", false),
            "a row not in `from` stays"
        );
        assert!(transition(&s, &id, &["draining"], "aborted", true));
        let done = s
            .refresh_rows(&RefreshRead::Row { id: id.clone() })
            .unwrap();
        assert_eq!(done["state"], "aborted");
        assert!(
            done["released_at"].is_string(),
            "the first terminal move releases the barrier"
        );
        assert!(done["completed_at"].is_string());
        assert_eq!(
            draining(&s)["state"],
            "draining",
            "the next refresh may start"
        );
        let none = s
            .refresh_rows(&RefreshRead::Active {
                worktree_id: "e0000000-0000-4000-8000-0000000000e1".into(),
            })
            .unwrap();
        assert_eq!(none, Value::Null);
    }

    #[test]
    fn a_refresh_of_no_worktree_is_a_constraint_violation() {
        let s = store();
        let err = s
            .refresh_write(&RefreshWrite::InsertDraining {
                worktree_id: WT.into(),
                source_ids: vec![],
                principal_id: PRINCIPAL.into(),
                owner_epoch: "1".into(),
                topology_generation: "1".into(),
                old_head: "a".into(),
                target_head: "b".into(),
                upstream_ref: "o".into(),
                preserved: vec![],
                outcome: json!({}),
                fence: None,
            })
            .unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
    }

    #[test]
    fn replan_moves_only_a_fenced_row_whose_merge_has_not_started() {
        let s = fenced_store();
        let id = draining(&s)["id"].as_str().unwrap().to_owned();
        let replan = |s: &Store| {
            s.refresh_write(&RefreshWrite::Replan {
                id: id.clone(),
                old_head: "ccc".into(),
                target_head: "ddd".into(),
                fence: None,
            })
            .unwrap()
        };
        assert_eq!(replan(&s), Value::Null, "a draining row is not replanned");
        assert!(transition(&s, &id, &["draining"], "fenced", false));
        assert!(
            s.refresh_write(&RefreshWrite::MarkMergeStarted {
                id: id.clone(),
                at_ms: 5.0,
                fence: None,
            })
            .unwrap()
            .as_bool()
            .unwrap()
        );
        assert_eq!(replan(&s), Value::Null, "a started merge is not replanned");
    }

    #[test]
    fn the_unfinished_sync_cursor_and_the_members_commits_read_the_stored_sources() {
        let s = fenced_store();
        s.upsert_source(&crate::sources::SourceInput {
            id: "alpha".into(),
            name: None,
            local_path: None,
            last_sync_at: None,
            config: None,
        })
        .unwrap();
        s.advance_source_commit("alpha", "abc123", None).unwrap();
        let commits = s
            .refresh_rows(&RefreshRead::SourceCommits {
                source_ids: vec!["alpha".into(), "gone".into()],
            })
            .unwrap();
        assert_eq!(commits, json!([{ "id": "alpha", "last_commit": "abc123" }]));
        let cursor = s
            .refresh_rows(&RefreshRead::UnfinishedSyncCursor {
                members: vec!["alpha".into()],
            })
            .unwrap();
        assert_eq!(cursor, Value::Null);
    }
}
