//! Managed source topology (`topologyStore()`, `src/core/engine-sql/topology-store.ts`;
//! rust/docs/store/managed-mode.md): the reads and writes a source lifecycle
//! change makes under its topology locks, its receipt accounting, and the moved-checkout reads.
//!
//! Each kind answers what its Postgres statement answers, from the worktree, host-binding and
//! source-binding records (`worktrees.rs`), the source records (`sources.rs`), the request,
//! effect and counter records (`persistence.rs`, `effects.rs`) and the topology change records
//! (`topology.rs`).
//!
//! Locks. The statements' row locks (`FOR UPDATE`, `FOR SHARE`) are no reads here; the TypeScript
//! member does not call them at all. Their guarantee holds another way: an explicit transaction is
//! Serialized (it holds the store's writer, so no other commit interleaves with what it read), and
//! under optimistic transactions every record read below is in the transaction's read set, so a
//! racing change aborts the commit with `write_conflict` instead of being missed. No file lock, no
//! process-wide mutex and no busy error is added.

use super::effect_worker::pg_uuid;
use super::effects::all_effects;
use super::topology::{TopologyChangeRecord, all_change_records, put_change_record, to_row};
use super::worktree_admission::all_refreshes;
use super::worktrees::{
    CounterDelta, HOST_BINDING, HostBindingInsert, HostBindingRecord, SOURCE_BINDING,
    SourceBindingRecord, WorktreeInsert, add_persistence_counters_in, host_binding_key,
    insert_host_binding_in, insert_worktree_in, read_host_record, read_worktree_record,
    scan_records, source_binding_key, worktree_key,
};
use super::write_claim_terms::worktree_of;
use super::{all_requests, extra_is_null, extra_time, json_text};
use crate::env::Env;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::sources::{SourceRecord, read_source, source_key};
use crate::{get_json, put_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// `state IN ACTIVE_REFRESH_STATES_SQL`.
const ACTIVE_REFRESH_STATES: [&str; 5] = [
    "draining",
    "fenced",
    "merged",
    "syncing",
    "recovery_required",
];
/// `archive_expires_at=now()+interval '72 hours'`.
const ARCHIVE_WINDOW_US: i64 = 72 * 3600 * 1_000_000;

/// One read of `topologyStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TopologyRead {
    Worktrees {
        ids: Vec<String>,
    },
    ActiveRefresh {
        ids: Vec<String>,
        refresh_id: Option<String>,
    },
    MemberSources {
        ids: Vec<String>,
    },
    WorktreeHasMember {
        worktree_id: String,
    },
    HostBinding {
        worktree_id: String,
        host_id: String,
    },
    CanonicalStamp {
        worktree_id: String,
    },
    UnsettledRequests {
        sources: Vec<String>,
        worktrees: Vec<String>,
    },
    BlockingEffect {
        sources: Vec<String>,
        worktrees: Vec<String>,
    },
    HostBindingPaths {
        host_id: String,
    },
    SupersedableRetires {
        source_id: String,
        incarnation: String,
        principal: String,
        request_id: String,
    },
    Change {
        id: String,
    },
    Source {
        id: String,
    },
    SupersededRetire {
        request_id: String,
        source_id: String,
        principal: String,
        incarnation: Option<String>,
    },
    BindingDigests {
        source_id: String,
    },
    RetireState {
        source_id: String,
        expired_only: bool,
    },
    OauthClientOf {
        source_id: String,
    },
    IsExpiredArchive {
        source_id: String,
    },
    CountSourcePages {
        source_id: String,
    },
    OtherHostBindings {
        host_id: String,
        source_id: String,
    },
    WorktreeExists {
        id: String,
    },
    RetirableState {
        source_id: String,
    },
    MovedRoot {
        worktree_id: String,
        host_id: String,
    },
    WorktreeMembers {
        worktree_id: String,
    },
    BrainId {},
    WorktreeOwner {
        id: String,
    },
    WorktreeManifest {
        id: String,
    },
    WorktreeManifestOwner {
        id: String,
    },
    RecoveringChangesOf {
        worktree_id: String,
    },
    OwnerActivity {
        ids: Vec<String>,
    },
    OpenWrites {},
}

/// One write of `topologyStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TopologyWrite {
    AdvanceGeneration {
        worktrees: Vec<String>,
    },
    ChargeReceipt {
        key: String,
        bytes: i64,
    },
    SettleRetire {
        id: String,
        state: String,
        outcome: Value,
        terminal_bytes: i64,
    },
    AddTerminalBytes {
        key: String,
        delta: i64,
    },
    ReleaseIntent {
        key: String,
        intent_bytes: i64,
    },
    ReleaseRecoveryBytes {
        key: String,
        bytes: i64,
    },
    ClearChangeRecovery {
        id: String,
    },
    DeletePageBatch {
        source_id: String,
        limit: i64,
    },
    UpdateSourceRoot {
        id: String,
        local_path: String,
        name: Option<String>,
        config: Value,
    },
    InsertSource {
        id: String,
        name: String,
        local_path: Option<String>,
        config: Value,
        incarnation: String,
    },
    ArchiveSource {
        id: String,
        config: Value,
    },
    RestoreSource {
        id: String,
        config: Value,
    },
    SetSourceLocalPath {
        id: String,
        local_path: String,
    },
    SetHostBindingPath {
        worktree_id: String,
        host_id: String,
        local_path: String,
    },
    SetBindingRelativePath {
        source_id: String,
        relative_path: String,
    },
    DeleteSourceIncarnation {
        source_id: String,
        incarnation: String,
    },
    RescrubRemovedSource {
        source_id: String,
    },
    DeleteSourceBinding {
        source_id: String,
        incarnation: String,
    },
    DeleteManagedSyncCursors {
        source_id: String,
    },
    SetWorktreeManifest {
        id: String,
        manifest: Value,
    },
    MergeCanonicalStamp {
        id: String,
        stamp: String,
    },
    InsertWorktree {
        id: String,
        host_id: String,
    },
    InsertHostBinding {
        worktree_id: String,
        host_id: String,
        local_path: String,
        coordination_path: String,
    },
    UpsertSourceBinding {
        source_id: String,
        incarnation: String,
        worktree_id: String,
        relative_path: String,
    },
    InsertRecoveringWorktree {
        id: String,
        host_id: String,
    },
    SetWorktreeState {
        id: String,
        state: String,
    },
    RecoverWorktreeWithManifest {
        id: String,
        manifest: Value,
    },
    InsertCloneBinding {
        source_id: String,
        incarnation: String,
        worktree_id: String,
    },
    SetChangeRecovery {
        id: String,
        recovery: Value,
        only_recovering: bool,
    },
    CloseChange {
        id: String,
        state: String,
        outcome: Value,
    },
    CommitChange {
        id: String,
        outcome: Value,
    },
    ResetSourceSync {
        id: String,
        incarnation: String,
    },
}

fn uuids(ids: &[String]) -> Result<Vec<String>> {
    ids.iter().map(|id| pg_uuid(id)).collect()
}

fn bindings(read: &dyn KvRead) -> Result<Vec<SourceBindingRecord>> {
    scan_records(read, SOURCE_BINDING, "source binding")
}

fn host_bindings(read: &dyn KvRead) -> Result<Vec<HostBindingRecord>> {
    scan_records(read, HOST_BINDING, "host binding")
}

fn changes_by_id(read: &dyn KvRead, id: &str) -> Result<Option<TopologyChangeRecord>> {
    let id = pg_uuid(id)?;
    Ok(all_change_records(read)?
        .into_iter()
        .find(|r| r.id.eq_ignore_ascii_case(&id)))
}

fn object(value: &Value, what: &str) -> Result<Map<String, Value>> {
    match value {
        Value::Object(map) => Ok(map.clone()),
        _ => Err(StoreError::invalid(format!("{what} must be a JSON object"))),
    }
}

fn source_row(r: &SourceRecord) -> Value {
    json!({
        "id": r.id,
        "incarnation": r.incarnation,
        "archived": r.archived,
        "local_path": r.local_path,
        "config": Value::Object(r.config.clone()),
        "name": r.name,
        "last_commit": r.last_commit,
    })
}

fn requests_of(
    read: &dyn KvRead,
    sources: &[String],
    worktrees: &[String],
) -> Result<Vec<super::RequestRecord>> {
    Ok(all_requests(read)?
        .into_iter()
        .filter(|r| {
            sources.contains(&r.source_id) || worktree_of(r).is_some_and(|w| worktrees.contains(&w))
        })
        .collect())
}

fn topology_rows_in(
    read: &dyn KvRead,
    env: &dyn Env,
    brain_id: &str,
    what: &TopologyRead,
) -> Result<Value> {
    match what {
        TopologyRead::Worktrees { ids } => {
            let mut ids = uuids(ids)?;
            ids.sort();
            ids.dedup();
            let mut rows = Vec::new();
            for id in &ids {
                if let Some(w) = read_worktree_record(read, id)? {
                    rows.push(json!({ "id": w.id, "owner_host_id": w.owner_host_id, "state": w.state,
                        "owner_epoch": w.owner_epoch, "topology_generation": w.topology_generation }));
                }
            }
            Ok(Value::Array(rows))
        }
        TopologyRead::ActiveRefresh { ids, refresh_id } => {
            let ids = uuids(ids)?;
            let except = refresh_id.as_deref().map(pg_uuid).transpose()?;
            let mut found: Vec<_> = all_refreshes(read)?
                .into_iter()
                .filter(|f| {
                    ids.iter().any(|w| w.eq_ignore_ascii_case(&f.worktree_id))
                        && ACTIVE_REFRESH_STATES.contains(&f.state.as_str())
                        && except
                            .as_deref()
                            .is_none_or(|e| !f.id.eq_ignore_ascii_case(e))
                })
                .collect();
            found.sort_by(|a, b| a.id.cmp(&b.id));
            Ok(found.first().map_or(
                Value::Null,
                |f| json!({ "id": f.id, "state": f.state, "source_ids": f.source_ids }),
            ))
        }
        TopologyRead::MemberSources { ids } => {
            let ids = uuids(ids)?;
            let mut members: Vec<String> = bindings(read)?
                .into_iter()
                .filter(|b| ids.contains(&b.worktree_id.to_lowercase()))
                .map(|b| b.source_id)
                .collect();
            members.sort();
            Ok(json!(members))
        }
        TopologyRead::WorktreeHasMember { worktree_id } => {
            let w = pg_uuid(worktree_id)?;
            Ok(json!(
                bindings(read)?
                    .iter()
                    .any(|b| b.worktree_id.eq_ignore_ascii_case(&w))
            ))
        }
        TopologyRead::HostBinding {
            worktree_id,
            host_id,
        } => {
            let (w, h) = (pg_uuid(worktree_id)?, pg_uuid(host_id)?);
            Ok(read_host_record(read, &w, &h)?.map_or(
                Value::Null,
                |b| json!({ "local_path": b.local_path, "coordination_path": b.coordination_path }),
            ))
        }
        TopologyRead::CanonicalStamp { worktree_id } => {
            let w = pg_uuid(worktree_id)?;
            let mut parts: Vec<(u64, String)> = Vec::new();
            for b in bindings(read)?
                .into_iter()
                .filter(|b| b.worktree_id.eq_ignore_ascii_case(&w))
            {
                for p in crate::sources::all_source_pages(read, &b.source_id)? {
                    parts.push((
                        p.id,
                        format!("{}:{}:{}", p.id, p.knowledge_revision, b.source_incarnation),
                    ));
                }
            }
            parts.sort_by_key(|(id, _)| *id);
            let text = parts
                .into_iter()
                .map(|(_, t)| t)
                .collect::<Vec<_>>()
                .join(",");
            Ok(json!(crate::facts::md5_hex(&text)))
        }
        TopologyRead::UnsettledRequests { sources, worktrees } => {
            let worktrees = uuids(worktrees)?;
            let mut rows: Vec<_> = requests_of(read, sources, &worktrees)?
                .into_iter()
                .filter(|r| {
                    matches!(
                        r.state.as_str(),
                        "queued" | "deferred" | "running" | "recovering"
                    ) || !extra_is_null(r, "recovery")
                })
                .collect();
            rows.sort_by_key(|r| r.sequence);
            Ok(Value::Array(rows.iter().map(|r| r.to_row()).collect()))
        }
        TopologyRead::BlockingEffect { sources, worktrees } => {
            let worktrees = uuids(worktrees)?;
            let mut found: Vec<_> = all_effects(read)?
                .into_iter()
                .filter(|e| {
                    e.source_id.as_ref().is_some_and(|s| sources.contains(s))
                        || e.worktree_id
                            .as_ref()
                            .is_some_and(|w| worktrees.contains(&w.to_lowercase()))
                })
                .filter(|e| {
                    e.recovery.is_some()
                        || e.state == "running"
                        || (e.kind == "withdrawal-mirror" && e.state == "queued")
                })
                .collect();
            found.sort_by_key(|e| e.id);
            Ok(found.first().map_or(
                Value::Null,
                |e| json!({ "id": e.id, "source_id": e.source_id }),
            ))
        }
        TopologyRead::HostBindingPaths { host_id } => {
            let h = pg_uuid(host_id)?;
            Ok(Value::Array(
                host_bindings(read)?
                    .into_iter()
                    .filter(|b| b.host_id.eq_ignore_ascii_case(&h))
                    .map(|b| json!({ "local_path": b.local_path }))
                    .collect(),
            ))
        }
        TopologyRead::SupersedableRetires {
            source_id,
            incarnation,
            principal,
            request_id,
        } => {
            let (inc, p, r) = (
                pg_uuid(incarnation)?,
                pg_uuid(principal)?,
                pg_uuid(request_id)?,
            );
            let mut rows: Vec<_> = all_change_records(read)?
                .into_iter()
                .filter(|c| {
                    &c.source_id == source_id
                        && c.source_incarnation
                            .as_deref()
                            .is_some_and(|i| i.eq_ignore_ascii_case(&inc))
                        && c.state == "recovering"
                        && c.recovery.is_none()
                        && (c.operation == "remove" || c.operation == "purge")
                        && !(c.principal_id.eq_ignore_ascii_case(&p)
                            && c.request_id.eq_ignore_ascii_case(&r))
                })
                .collect();
            rows.sort_by(|a, b| a.id.cmp(&b.id));
            Ok(Value::Array(rows.iter().map(to_row).collect()))
        }
        TopologyRead::Change { id } => {
            Ok(changes_by_id(read, id)?.map_or(Value::Null, |c| to_row(&c)))
        }
        TopologyRead::Source { id } => {
            Ok(read_source(read, id)?.map_or(Value::Null, |s| source_row(&s)))
        }
        TopologyRead::SupersededRetire {
            request_id,
            source_id,
            principal,
            incarnation,
        } => {
            let (r, p) = (pg_uuid(request_id)?, pg_uuid(principal)?);
            let inc = incarnation.as_deref().map(pg_uuid).transpose()?;
            let mut rows: Vec<_> = all_change_records(read)?
                .into_iter()
                .filter(|c| {
                    c.request_id.eq_ignore_ascii_case(&r)
                        && &c.source_id == source_id
                        && !c.principal_id.eq_ignore_ascii_case(&p)
                        && (c.operation == "remove" || c.operation == "purge")
                        && c.source_incarnation.as_deref().map(str::to_lowercase) != inc
                })
                .collect();
            rows.sort_by_key(|c| c.created_at_us);
            Ok(rows.first().map_or(Value::Null, to_row))
        }
        TopologyRead::BindingDigests { source_id } => {
            let mut rows = Vec::new();
            if let Some(b) = get_json::<SourceBindingRecord>(read, &source_binding_key(source_id))?
                && let Some(w) = read_worktree_record(read, &b.worktree_id.to_lowercase())?
            {
                rows.push(json!({ "digest": json_text(w.manifest.as_ref().and_then(|m| m.get("digest"))) }));
            }
            Ok(Value::Array(rows))
        }
        TopologyRead::RetireState {
            source_id,
            expired_only,
        } => {
            let now = env.now_micros();
            Ok(read_source(read, source_id)?.map_or(Value::Null, |s| {
                json!({ "incarnation": s.incarnation, "archived": s.archived,
                "due": !*expired_only || crate::sources::source_expired(&s, now) })
            }))
        }
        TopologyRead::OauthClientOf { source_id } => {
            Ok(json!(crate::jobs::source_oauth_client_in(read, source_id)?))
        }
        TopologyRead::IsExpiredArchive { source_id } => {
            let now = env.now_micros();
            Ok(json!(
                read_source(read, source_id)?
                    .is_some_and(|s| crate::sources::source_expired(&s, now))
            ))
        }
        TopologyRead::CountSourcePages { source_id } => Ok(json!(
            crate::sources::source_page_count_in(read, source_id)?
        )),
        TopologyRead::OtherHostBindings { host_id, source_id } => {
            let h = pg_uuid(host_id)?;
            let mut rows = Vec::new();
            for b in bindings(read)?
                .into_iter()
                .filter(|b| &b.source_id != source_id)
            {
                if let Some(host) = read_host_record(read, &b.worktree_id.to_lowercase(), &h)? {
                    rows.push(json!({ "source_id": b.source_id, "relative_path": b.relative_path, "local_path": host.local_path }));
                }
            }
            Ok(Value::Array(rows))
        }
        TopologyRead::WorktreeExists { id } => {
            Ok(json!(read_worktree_record(read, &pg_uuid(id)?)?.is_some()))
        }
        TopologyRead::RetirableState { source_id } => {
            let pages = crate::sources::source_page_count_in(read, source_id)?;
            let all = bindings(read)?;
            let members = all
                .iter()
                .filter(|b| &b.source_id == source_id)
                .map(|b| {
                    all.iter()
                        .filter(|o| {
                            o.worktree_id.eq_ignore_ascii_case(&b.worktree_id)
                                && o.source_id != b.source_id
                        })
                        .count()
                })
                .sum::<usize>();
            Ok(json!({ "pages": pages, "members": members }))
        }
        TopologyRead::MovedRoot {
            worktree_id,
            host_id,
        } => {
            let (w, h) = (pg_uuid(worktree_id)?, pg_uuid(host_id)?);
            let owner = read_worktree_record(read, &w)?.and_then(|r| r.owner_host_id);
            let local = read_host_record(read, &w, &h)?.map(|b| b.local_path);
            Ok(json!({ "brain_id": brain_id, "owner_host_id": owner, "local_path": local }))
        }
        TopologyRead::WorktreeMembers { worktree_id } => {
            let w = pg_uuid(worktree_id)?;
            let mut rows: Vec<_> = bindings(read)?
                .into_iter()
                .filter(|b| b.worktree_id.eq_ignore_ascii_case(&w))
                .collect();
            rows.sort_by(|a, b| a.source_id.as_bytes().cmp(b.source_id.as_bytes()));
            Ok(Value::Array(
                rows.iter()
                    .map(|b| json!({ "source_id": b.source_id, "relative_path": b.relative_path }))
                    .collect(),
            ))
        }
        TopologyRead::BrainId {} => Ok(json!(brain_id)),
        TopologyRead::WorktreeOwner { id } => Ok(read_worktree_record(read, &pg_uuid(id)?)?
            .map_or(
                Value::Null,
                |w| json!({ "owner_host_id": w.owner_host_id, "state": w.state }),
            )),
        TopologyRead::WorktreeManifest { id } => Ok(read_worktree_record(read, &pg_uuid(id)?)?
            .map_or(Value::Null, |w| {
                json!({ "manifest": w.manifest.map(crate::jsonb::order) })
            })),
        TopologyRead::WorktreeManifestOwner { id } => Ok(read_worktree_record(read, &pg_uuid(id)?)?
            .map_or(Value::Null, |w| {
                json!({ "owner_host_id": w.owner_host_id, "manifest": w.manifest.map(crate::jsonb::order) })
            })),
        TopologyRead::OwnerActivity { ids } => owner_activity_in(read, env, ids),
        TopologyRead::OpenWrites {} => open_writes_in(read),
        TopologyRead::RecoveringChangesOf { worktree_id } => {
            let w = pg_uuid(worktree_id)?;
            // The change order never reaches output: the caller rewrites each row it lists.
            let mut rows: Vec<_> = all_change_records(read)?
                .into_iter()
                .filter(|c| {
                    c.state == "recovering" && c.worktree_ids.iter().any(|x| x.eq_ignore_ascii_case(&w))
                })
                .collect();
            rows.sort_by(|a, b| a.id.cmp(&b.id));
            Ok(Value::Array(
                rows.iter()
                    .map(|c| json!({ "id": c.id, "recovery": c.recovery.clone().map(crate::jsonb::order) }))
                    .collect(),
            ))
        }
    }
}

/// `OPEN_WRITES_SQL`: per worktree holding a queued, deferred, running or recovering request, how many, the oldest
/// creation time and the sources bound to it (byte order of the id, `null` when none is bound).
fn open_writes_in(read: &dyn KvRead) -> Result<Value> {
    let mut open: std::collections::BTreeMap<String, (i64, i64)> =
        std::collections::BTreeMap::new();
    for r in all_requests(read)? {
        let Some(w) = worktree_of(&r) else {
            continue;
        };
        if !matches!(
            r.state.as_str(),
            "queued" | "deferred" | "running" | "recovering"
        ) {
            continue;
        }
        let entry = open.entry(w).or_insert((0, r.created_at_us));
        entry.0 += 1;
        entry.1 = entry.1.min(r.created_at_us);
    }
    let all = bindings(read)?;
    Ok(Value::Array(
        open.into_iter()
            .map(|(worktree, (count, oldest))| {
                let mut sources: Vec<&str> = all
                    .iter()
                    .filter(|b| b.worktree_id.eq_ignore_ascii_case(&worktree))
                    .map(|b| b.source_id.as_str())
                    .collect();
                sources.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
                json!({
                    "worktree_id": worktree,
                    "open_writes": count,
                    "oldest_open": crate::env::iso(oldest),
                    "source_ids": if sources.is_empty() { Value::Null } else { json!(sources) },
                })
            })
            .collect(),
    ))
}

/// `OWNER_ACTIVITY_SQL`: per listed worktree that has an owner, when its owner was last active. This engine keeps
/// no consumer row, so `live` is false and no consumer heartbeat counts (as on PGLite). `last_active` is the greatest
/// of the worktree heartbeat, the newest committed non-sync request's `COALESCE(published_at, completed_at)` and the
/// newest completed managed-sync request of any source's current incarnation on the worktree.
fn owner_activity_in(read: &dyn KvRead, env: &dyn Env, ids: &[String]) -> Result<Value> {
    let now = env.now_micros();
    let mut wanted: Vec<String> = ids.iter().map(|id| id.to_lowercase()).collect();
    wanted.sort();
    wanted.dedup();
    let requests = all_requests(read)?;
    let mut rows = Vec::new();
    for id in &wanted {
        let Some(w) = read_worktree_record(read, id)? else {
            continue;
        };
        let Some(owner) = w.owner_host_id.clone() else {
            continue;
        };
        let here: Vec<_> = requests
            .iter()
            .filter(|r| worktree_of(r).as_deref() == Some(id.as_str()))
            .collect();
        let sync_kind = |r: &super::RequestRecord| {
            json_text(r.intent.get("kind"))
                .unwrap_or_default()
                .starts_with("managed_sync_")
        };
        let foreground = here
            .iter()
            .filter(|r| r.state == "committed" && !sync_kind(r))
            .max_by_key(|r| r.sequence)
            .and_then(|r| extra_time(r, "published_at").or(r.completed_at_us));
        let mut sync: Option<i64> = None;
        let mut seen: Vec<&str> = Vec::new();
        for r in &here {
            if seen.contains(&r.source_id.as_str()) {
                continue;
            }
            seen.push(&r.source_id);
            let Some(source) = read_source(read, &r.source_id)? else {
                continue;
            };
            let newest = here
                .iter()
                .filter(|q| {
                    q.source_id == r.source_id
                        && q.source_incarnation
                            .eq_ignore_ascii_case(&source.incarnation)
                        && q.state == "committed"
                        && sync_kind(q)
                })
                .filter_map(|q| q.completed_at_us)
                .max();
            sync = sync.max(newest);
        }
        let last_active = [w.heartbeat_at_us, foreground, sync]
            .into_iter()
            .flatten()
            .max();
        let oldest_open = here
            .iter()
            .filter(|r| {
                matches!(
                    r.state.as_str(),
                    "queued" | "deferred" | "running" | "recovering"
                )
            })
            .map(|r| r.created_at_us)
            .min();
        rows.push(json!({
            "db_now": crate::env::iso(now),
            "worktree_id": w.id,
            "owner_host_id": owner,
            "live": false,
            "last_active": last_active.map(crate::env::iso),
            "oldest_open": oldest_open.map(crate::env::iso),
        }));
    }
    Ok(Value::Array(rows))
}

fn counter(tx: &mut dyn KvWrite, key: &str, delta: CounterDelta) -> Result<()> {
    add_persistence_counters_in(tx, key, &delta)
}

fn no_delta() -> CounterDelta {
    CounterDelta {
        lifetime_ids: 0,
        terminal_bytes: 0,
        outstanding_count: 0,
        intent_bytes: 0,
        recovery_bytes: 0,
    }
}

fn with_source(
    tx: &mut dyn KvWrite,
    id: &str,
    edit: impl FnOnce(&mut SourceRecord) -> Result<()>,
) -> Result<()> {
    let Some(mut record) = read_source(&*tx, id)? else {
        return Ok(());
    };
    edit(&mut record)?;
    put_json(tx, &source_key(id), &record)
}

fn topology_write_in(tx: &mut dyn KvWrite, env: &dyn Env, what: &TopologyWrite) -> Result<Value> {
    let now = env.now_micros();
    match what {
        TopologyWrite::AdvanceGeneration { worktrees } => {
            let ids = uuids(worktrees)?;
            for id in &ids {
                if let Some(mut w) = read_worktree_record(&*tx, id)? {
                    w.topology_generation += 1;
                    put_json(tx, &worktree_key(id), &w)?;
                }
            }
            for mut b in bindings(&*tx)? {
                let w = b.worktree_id.to_lowercase();
                if !ids.contains(&w) {
                    continue;
                }
                if let Some(worktree) = read_worktree_record(&*tx, &w)? {
                    b.topology_generation = worktree.topology_generation;
                    put_json(tx, &source_binding_key(&b.source_id), &b)?;
                }
            }
            Ok(Value::Null)
        }
        TopologyWrite::ChargeReceipt { key, bytes } => {
            counter(
                tx,
                key,
                CounterDelta {
                    lifetime_ids: 1,
                    terminal_bytes: *bytes,
                    ..no_delta()
                },
            )?;
            Ok(Value::Null)
        }
        TopologyWrite::SettleRetire {
            id,
            state,
            outcome,
            terminal_bytes,
        } => {
            if !["recovering", "committed", "failed"].contains(&state.as_str()) {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("\"{state}\" is not a topology change state"),
                ));
            }
            let Some(mut c) = changes_by_id(&*tx, id)? else {
                return Ok(Value::Null);
            };
            if c.state != "recovering" || c.recovery.is_some() {
                return Ok(Value::Null);
            }
            c.state = state.clone();
            c.outcome = Some(outcome.clone());
            c.terminal_bytes = *terminal_bytes;
            c.updated_at_us = now;
            put_change_record(tx, &c)?;
            Ok(to_row(&c))
        }
        TopologyWrite::AddTerminalBytes { key, delta } => {
            counter(
                tx,
                key,
                CounterDelta {
                    terminal_bytes: *delta,
                    ..no_delta()
                },
            )?;
            Ok(Value::Null)
        }
        TopologyWrite::ReleaseIntent { key, intent_bytes } => {
            counter(
                tx,
                key,
                CounterDelta {
                    outstanding_count: -1,
                    intent_bytes: -*intent_bytes,
                    ..no_delta()
                },
            )?;
            Ok(Value::Null)
        }
        TopologyWrite::ReleaseRecoveryBytes { key, bytes } => {
            counter(
                tx,
                key,
                CounterDelta {
                    recovery_bytes: -*bytes,
                    ..no_delta()
                },
            )?;
            Ok(Value::Null)
        }
        TopologyWrite::ClearChangeRecovery { id } => {
            if let Some(mut c) = changes_by_id(&*tx, id)? {
                c.recovery = None;
                c.recovery_bytes = 0;
                c.intent_bytes = 0;
                c.updated_at_us = now;
                put_change_record(tx, &c)?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::DeletePageBatch { source_id, limit } => {
            let limit = usize::try_from(*limit)
                .map_err(|_| StoreError::invalid("LIMIT must not be negative".to_string()))?;
            Ok(json!(crate::sources::delete_page_batch_in(
                tx, source_id, limit
            )?))
        }
        TopologyWrite::UpdateSourceRoot {
            id,
            local_path,
            name,
            config,
        } => {
            let config = object(config, "config")?;
            with_source(tx, id, |s| {
                s.local_path = Some(local_path.clone());
                if let Some(name) = name {
                    s.name = Some(name.clone());
                }
                s.config = config;
                Ok(())
            })?;
            Ok(Value::Null)
        }
        TopologyWrite::InsertSource {
            id,
            name,
            local_path,
            config,
            incarnation,
        } => {
            if !crate::sources::valid_source_id(id) {
                return Err(StoreError::invalid(
                    "a source id is 1 to 32 characters of a-z, 0-9 and -",
                ));
            }
            if read_source(&*tx, id)?.is_some() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!(
                        "duplicate key value violates unique constraint \"sources_pkey\": source {id} exists"
                    ),
                ));
            }
            let record = SourceRecord {
                id: id.clone(),
                name: Some(name.clone()),
                local_path: local_path.clone(),
                last_sync_at_us: None,
                config: object(config, "config")?,
                incarnation: pg_uuid(incarnation)?,
                archived: false,
                created_at_us: now,
                chunker_version: None,
                archived_at_us: None,
                archive_expires_at_us: None,
                upstream_checked_at_us: None,
                upstream_commit: None,
                upstream_behind: None,
                last_commit: None,
                newest_content_at_us: None,
                purge_epoch: 0,
            };
            put_json(tx, &source_key(id), &record)?;
            Ok(Value::Null)
        }
        TopologyWrite::ArchiveSource { id, config } => {
            let config = object(config, "config")?;
            with_source(tx, id, |s| {
                s.archived = true;
                s.archived_at_us = Some(s.archived_at_us.unwrap_or(now));
                s.archive_expires_at_us =
                    Some(s.archive_expires_at_us.unwrap_or(now + ARCHIVE_WINDOW_US));
                s.config = config;
                Ok(())
            })?;
            Ok(Value::Null)
        }
        TopologyWrite::RestoreSource { id, config } => {
            let config = object(config, "config")?;
            with_source(tx, id, |s| {
                s.archived = false;
                s.archived_at_us = None;
                s.archive_expires_at_us = None;
                s.config = config;
                Ok(())
            })?;
            Ok(Value::Null)
        }
        TopologyWrite::SetSourceLocalPath { id, local_path } => {
            with_source(tx, id, |s| {
                s.local_path = Some(local_path.clone());
                Ok(())
            })?;
            Ok(Value::Null)
        }
        TopologyWrite::SetHostBindingPath {
            worktree_id,
            host_id,
            local_path,
        } => {
            let (w, h) = (pg_uuid(worktree_id)?, pg_uuid(host_id)?);
            if let Some(mut b) = read_host_record(&*tx, &w, &h)? {
                b.local_path = local_path.clone();
                put_json(tx, &host_binding_key(&w, &h), &b)?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::SetBindingRelativePath {
            source_id,
            relative_path,
        } => {
            if let Some(mut b) =
                get_json::<SourceBindingRecord>(&*tx, &source_binding_key(source_id))?
            {
                b.relative_path = relative_path.clone();
                put_json(tx, &source_binding_key(source_id), &b)?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::DeleteSourceIncarnation {
            source_id,
            incarnation,
        } => {
            crate::sources::delete_source_incarnation_in(tx, source_id, &pg_uuid(incarnation)?)?;
            Ok(Value::Null)
        }
        TopologyWrite::RescrubRemovedSource { source_id } => {
            crate::sources::rescrub_removed_source_in(tx, source_id)?;
            Ok(Value::Null)
        }
        TopologyWrite::DeleteSourceBinding {
            source_id,
            incarnation,
        } => {
            let inc = pg_uuid(incarnation)?;
            if let Some(b) = get_json::<SourceBindingRecord>(&*tx, &source_binding_key(source_id))?
                && b.source_incarnation.eq_ignore_ascii_case(&inc)
            {
                tx.delete(&source_binding_key(source_id))?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::DeleteManagedSyncCursors { source_id } => {
            crate::sources::remove_sync_cursors(tx, source_id)?;
            Ok(Value::Null)
        }
        TopologyWrite::SetWorktreeManifest { id, manifest } => {
            let id = pg_uuid(id)?;
            if let Some(mut w) = read_worktree_record(&*tx, &id)? {
                w.manifest = Some(manifest.clone()).filter(|m| !m.is_null());
                put_json(tx, &worktree_key(&id), &w)?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::MergeCanonicalStamp { id, stamp } => {
            let id = pg_uuid(id)?;
            if let Some(mut w) = read_worktree_record(&*tx, &id)? {
                // `COALESCE(manifest,'{}'::jsonb)||jsonb_build_object('canonical_stamp',$2)`.
                let mut map = match w.manifest.take() {
                    Some(Value::Object(m)) => m,
                    _ => Map::new(),
                };
                map.insert("canonical_stamp".into(), json!(stamp));
                w.manifest = Some(Value::Object(map));
                put_json(tx, &worktree_key(&id), &w)?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::InsertWorktree { id, host_id } => {
            insert_worktree_in(
                tx,
                env,
                &WorktreeInsert {
                    id: id.clone(),
                    owner_host_id: Some(host_id.clone()),
                    owner_epoch: Some(1),
                    topology_generation: None,
                    state: None,
                    manifest: None,
                },
            )?;
            Ok(Value::Null)
        }
        TopologyWrite::InsertHostBinding {
            worktree_id,
            host_id,
            local_path,
            coordination_path,
        } => {
            // `ON CONFLICT(worktree_id,host_id) DO NOTHING`.
            if read_host_record(&*tx, &pg_uuid(worktree_id)?, &pg_uuid(host_id)?)?.is_none() {
                insert_host_binding_in(
                    tx,
                    &HostBindingInsert {
                        worktree_id: worktree_id.clone(),
                        host_id: host_id.clone(),
                        local_path: local_path.clone(),
                        coordination_path: coordination_path.clone(),
                        git_durability: None,
                    },
                )?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::UpsertSourceBinding {
            source_id,
            incarnation,
            worktree_id,
            relative_path,
        } => {
            // `INSERT ... SELECT ... FROM persistence_worktrees WHERE id=$3`: no worktree, no row.
            let w = pg_uuid(worktree_id)?;
            let Some(worktree) = read_worktree_record(&*tx, &w)? else {
                return Ok(Value::Null);
            };
            let record = SourceBindingRecord {
                source_id: source_id.clone(),
                source_incarnation: pg_uuid(incarnation)?,
                worktree_id: w,
                relative_path: relative_path.clone(),
                topology_generation: worktree.topology_generation,
            };
            put_json(tx, &source_binding_key(source_id), &record)?;
            Ok(Value::Null)
        }
        TopologyWrite::InsertRecoveringWorktree { id, host_id } => {
            insert_worktree_in(
                tx,
                env,
                &WorktreeInsert {
                    id: id.clone(),
                    owner_host_id: Some(host_id.clone()),
                    owner_epoch: Some(1),
                    topology_generation: None,
                    state: Some("recovering".to_string()),
                    manifest: None,
                },
            )?;
            Ok(Value::Null)
        }
        TopologyWrite::SetWorktreeState { id, state } => {
            if !["active", "recovering"].contains(&state.as_str()) {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("\"{state}\" is not a state this write sets"),
                ));
            }
            let id = pg_uuid(id)?;
            if let Some(mut w) = read_worktree_record(&*tx, &id)? {
                w.state = state.clone();
                put_json(tx, &worktree_key(&id), &w)?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::RecoverWorktreeWithManifest { id, manifest } => {
            let id = pg_uuid(id)?;
            if let Some(mut w) = read_worktree_record(&*tx, &id)? {
                w.state = "recovering".to_string();
                w.manifest = Some(manifest.clone()).filter(|m| !m.is_null());
                put_json(tx, &worktree_key(&id), &w)?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::InsertCloneBinding {
            source_id,
            incarnation,
            worktree_id,
        } => {
            // `INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id)`: the
            // primary key and the worktree's foreign key refuse as Postgres refuses them.
            let w = pg_uuid(worktree_id)?;
            if get_json::<SourceBindingRecord>(&*tx, &source_binding_key(source_id))?.is_some() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!(
                        "duplicate key value violates unique constraint \"persistence_source_bindings_pkey\": source {source_id} is bound"
                    ),
                ));
            }
            if read_worktree_record(&*tx, &w)?.is_none() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    "insert or update on table \"persistence_source_bindings\" violates foreign key constraint: the worktree does not exist".to_string(),
                ));
            }
            let record = SourceBindingRecord {
                source_id: source_id.clone(),
                source_incarnation: pg_uuid(incarnation)?,
                worktree_id: w,
                relative_path: String::new(),
                topology_generation: 1,
            };
            put_json(tx, &source_binding_key(source_id), &record)?;
            Ok(Value::Null)
        }
        TopologyWrite::SetChangeRecovery {
            id,
            recovery,
            only_recovering,
        } => {
            if let Some(mut c) = changes_by_id(&*tx, id)?
                && (!*only_recovering || c.state == "recovering")
            {
                c.recovery = Some(recovery.clone()).filter(|r| !r.is_null());
                c.updated_at_us = now;
                put_change_record(tx, &c)?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::CloseChange { id, state, outcome } => {
            if !["committed", "failed"].contains(&state.as_str()) {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("\"{state}\" is not a state a change closes in"),
                ));
            }
            if let Some(mut c) = changes_by_id(&*tx, id)? {
                // `COALESCE(outcome,'{}'::jsonb)||$3::text::jsonb`.
                let base = c.outcome.take().unwrap_or_else(|| json!({}));
                c.outcome = Some(jsonb_concat(base, outcome));
                c.state = state.clone();
                c.recovery = None;
                c.recovery_bytes = 0;
                c.updated_at_us = now;
                put_change_record(tx, &c)?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::CommitChange { id, outcome } => {
            if let Some(mut c) = changes_by_id(&*tx, id)? {
                // `outcome||$2::text::jsonb`: a null outcome stays null.
                c.outcome = c.outcome.take().map(|base| jsonb_concat(base, outcome));
                c.state = "committed".to_string();
                c.updated_at_us = now;
                put_change_record(tx, &c)?;
            }
            Ok(Value::Null)
        }
        TopologyWrite::ResetSourceSync { id, incarnation } => {
            let inc = pg_uuid(incarnation)?;
            if let Some(mut s) = read_source(&*tx, id)?
                && s.incarnation.eq_ignore_ascii_case(&inc)
            {
                s.last_commit = None;
                s.last_sync_at_us = None;
                put_json(tx, &source_key(id), &s)?;
            }
            Ok(Value::Null)
        }
    }
}

/// `base||extra` of two jsonb objects: the keys of `extra` win; anything else is replaced by `extra`.
fn jsonb_concat(base: Value, extra: &Value) -> Value {
    match (base, extra) {
        (Value::Object(mut left), Value::Object(right)) => {
            for (key, value) in right {
                left.insert(key.clone(), value.clone());
            }
            Value::Object(left)
        }
        (_, other) => other.clone(),
    }
}

impl crate::Store {
    /// One `topologyStore()` read (`TopologyRead`) as JSON.
    pub fn topology_rows(&self, what: &TopologyRead) -> Result<Value> {
        topology_rows_in(&*self.read()?, &*self.env, self.brain_id(), what)
    }

    /// One `topologyStore()` write (`TopologyWrite`); its result as JSON.
    pub fn topology_write(&self, what: &TopologyWrite) -> Result<Value> {
        self.write(|tx| topology_write_in(tx, &*self.env, what))
    }
}
