//! Worktree bindings: the `persistence_worktrees`, `persistence_host_bindings` and
//! `persistence_source_bindings` rows of an unmanaged writer claim
//! (`src/core/engine-sql/worktree-claim.ts`; rust/docs/store/persistence.md, "Worktree bindings").
//!
//! A claim (`claimWorktreeBinding`) records one worktree per checkout, its path on each host and
//! the source that lives under it. The claim's checks (the source lock, the admin checks, the
//! overlap and the physical-root files) stay in TypeScript; the store keeps the three rows and
//! refuses what the tables' keys, foreign keys and CHECKs refuse on Postgres.
//!
//! Keys, all under `d 0x09`:
//!
//! | Key | Record |
//! |---|---|
//! | `d 0x09 0x01 <worktree id>` | one `persistence_worktrees` row (`WorktreeRecord`), JSON |
//! | `d 0x09 0x02 <worktree id> 0x00 <host id>` | one `persistence_host_bindings` row (`HostBindingRecord`), JSON |
//! | `d 0x09 0x03 <source id>` | one `persistence_source_bindings` row (`SourceBindingRecord`), JSON |
//!
//! Ids are lower-case UUID text. A source binding has no foreign key to its source, as on
//! Postgres: a removed or re-created source leaves its binding, and the readers compare the
//! binding's incarnation with the source's. A writer deactivation or a pre-activation release
//! retires worktrees (the rows are kept) and deletes their bindings (worktrees/release.rs, which
//! also keeps the brain mode).
//!
//! The writer admin members (`src/core/engine-sql/writer-admin.ts`) read and change the same rows:
//! `writer_admin_state_text` is the topology document `--expected-state` hashes, and a writer
//! transfer's prepare and cancel move one worktree between `active` and `draining`. An accept
//! records the successor's host binding, rebinds the sources' content receipts
//! (`content_receipt_rows` and `swap_config_value`) and gives the worktree to the successor at
//! the next epoch.

use super::effects::all_effects;
use super::{all_requests, extra_is_null, uuid_param, violation};
use crate::cli_reads::pg_text::jsonb_text;
use crate::config::{config_key, read_config};
use crate::env::{Env, iso};
use crate::error::{Result, StoreError};
use crate::facts::jsonb_time;
use crate::jobs::legacy_lock_rows;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::sources::all_sources;
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

mod release;
pub(crate) use release::add_persistence_counters_in;
pub use release::{CounterDelta, ReleaseRead};

/// `persistence_worktrees.state` CHECK.
const WORKTREE_STATES: &[&str] = &["active", "draining", "recovering", "retired"];
/// `persistence_host_bindings.git_durability` CHECK (null is allowed).
const GIT_DURABILITY: &[&str] = &["enabled", "disabled"];

pub(super) const WORKTREE: u8 = 0x01;
pub(super) const HOST_BINDING: u8 = 0x02;
pub(super) const SOURCE_BINDING: u8 = 0x03;

/// One stored worktree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct WorktreeRecord {
    pub(super) id: String,
    #[serde(default)]
    pub(super) owner_host_id: Option<String>,
    #[serde(default)]
    pub(super) owner_epoch: i64,
    #[serde(default = "one")]
    pub(super) topology_generation: i64,
    #[serde(default = "active")]
    pub(super) state: String,
    #[serde(default)]
    pub(super) manifest: Option<Value>,
    #[serde(default)]
    pub(super) heartbeat_at_us: Option<i64>,
    #[serde(default)]
    pub(super) created_at_us: i64,
}

/// One stored host binding: where a worktree is on one host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct HostBindingRecord {
    pub(super) worktree_id: String,
    pub(super) host_id: String,
    pub(super) local_path: String,
    pub(super) coordination_path: String,
    #[serde(default)]
    pub(super) git_durability: Option<String>,
}

/// One stored source binding: the worktree a source lives in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct SourceBindingRecord {
    pub(super) source_id: String,
    pub(super) source_incarnation: String,
    pub(super) worktree_id: String,
    #[serde(default)]
    pub(super) relative_path: String,
    #[serde(default = "one")]
    pub(super) topology_generation: i64,
}

fn one() -> i64 {
    1
}

fn active() -> String {
    "active".into()
}

/// `insertWorktree(input)`: the column defaults of `persistence_worktrees` for what is left out.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInsert {
    pub id: String,
    #[serde(default)]
    pub owner_host_id: Option<String>,
    #[serde(default)]
    pub owner_epoch: Option<i64>,
    #[serde(default)]
    pub topology_generation: Option<i64>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub manifest: Option<Value>,
}

/// `insertHostBinding(input)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBindingInsert {
    pub worktree_id: String,
    pub host_id: String,
    pub local_path: String,
    pub coordination_path: String,
    #[serde(default)]
    pub git_durability: Option<String>,
}

/// `insertSourceBinding(input)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBindingInsert {
    pub source_id: String,
    pub incarnation: String,
    pub worktree_id: String,
    #[serde(default)]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub topology_generation: Option<i64>,
}

fn prefix(tag: u8) -> Vec<u8> {
    vec![keys::PERSISTENCE, super::WORKTREES, tag]
}

pub(super) fn worktree_key(id: &str) -> Vec<u8> {
    let mut key = prefix(WORKTREE);
    key.extend_from_slice(id.as_bytes());
    key
}

pub(super) fn host_binding_key(worktree_id: &str, host_id: &str) -> Vec<u8> {
    let mut key = prefix(HOST_BINDING);
    key.extend_from_slice(worktree_id.as_bytes());
    key.push(0);
    key.extend_from_slice(host_id.as_bytes());
    key
}

pub(super) fn source_binding_key(source_id: &str) -> Vec<u8> {
    let mut key = prefix(SOURCE_BINDING);
    key.extend_from_slice(source_id.as_bytes());
    key
}

/// Every record under one tag, in key order.
pub(super) fn scan_records<T: for<'de> Deserialize<'de>>(
    read: &dyn KvRead,
    tag: u8,
    what: &str,
) -> Result<Vec<T>> {
    let mut rows = Vec::new();
    let mut bad: Option<String> = None;
    scan_prefix(read, &prefix(tag), false, &mut |_, v| {
        match serde_json::from_slice::<T>(v) {
            Ok(r) => rows.push(r),
            Err(e) => bad = Some(e.to_string()),
        }
        bad.is_none()
    })?;
    match bad {
        Some(e) => Err(StoreError::invalid(format!("a {what} record: {e}"))),
        None => Ok(rows),
    }
}

pub(super) fn read_worktree_record(read: &dyn KvRead, id: &str) -> Result<Option<WorktreeRecord>> {
    get_json(read, &worktree_key(id))
}

pub(super) fn read_host_record(
    read: &dyn KvRead,
    worktree_id: &str,
    host_id: &str,
) -> Result<Option<HostBindingRecord>> {
    get_json(read, &host_binding_key(worktree_id, host_id))
}

/// A source id the binding keys can hold (Postgres text holds no NUL).
fn source_id_param(source_id: &str) -> Result<&str> {
    if source_id.contains('\0') {
        return Err(StoreError::invalid("a source id cannot hold NUL"));
    }
    Ok(source_id)
}

/// `manifest->>'prepared_at'`: a string as itself, another JSON value as its text, null as null.
fn prepared_at(manifest: &Option<Value>) -> Value {
    match manifest.as_ref().and_then(|m| m.get("prepared_at")) {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => json!(s),
        Some(other) => json!(other.to_string()),
    }
}

/// `getWorktreeBinding(sourceId, hostId)` (`WORKTREE_BINDING_SQL`): the source's binding with
/// host `host_id`'s paths, null host columns for a null or unbound host; None when unbound.
pub(crate) fn worktree_binding_in(
    read: &dyn KvRead,
    source_id: &str,
    host_id: Option<&str>,
) -> Result<Option<Value>> {
    let host = match host_id {
        None => None,
        Some(h) => Some(uuid_param(h, "hostId")?),
    };
    if source_id.contains('\0') {
        return Ok(None);
    }
    let Some(binding) = get_json::<SourceBindingRecord>(read, &source_binding_key(source_id))?
    else {
        return Ok(None);
    };
    let Some(worktree) = read_worktree_record(read, &binding.worktree_id)? else {
        return Err(StoreError::invalid(format!(
            "source binding {source_id} names worktree {} that is not stored",
            binding.worktree_id
        )));
    };
    let host_row = match &host {
        None => None,
        Some(h) => read_host_record(read, &worktree.id, h)?,
    };
    let canonical_git = read_source(read, source_id)?
        .map(|s| json!(s.config.get("canonical") == Some(&Value::String("git".into()))))
        .unwrap_or(Value::Null);
    Ok(Some(json!({
        "source_id": binding.source_id,
        "source_incarnation": binding.source_incarnation,
        "worktree_id": binding.worktree_id,
        "relative_path": binding.relative_path,
        "topology_generation": binding.topology_generation.to_string(),
        "owner_host_id": worktree.owner_host_id,
        "owner_epoch": worktree.owner_epoch.to_string(),
        "state": worktree.state,
        "local_path": host_row.as_ref().map(|h| h.local_path.clone()),
        "coordination_path": host_row.as_ref().map(|h| h.coordination_path.clone()),
        "git_durability": host_row.as_ref().and_then(|h| h.git_durability.clone()),
        "prepared_at": prepared_at(&worktree.manifest),
        "canonical_git": canonical_git,
    })))
}

/// `isSourceClaimed(sourceId)` (`SOURCE_CLAIMED_SQL`): a binding names the source at its current
/// incarnation.
pub(crate) fn is_source_claimed_in(read: &dyn KvRead, source_id: &str) -> Result<bool> {
    if source_id.contains('\0') {
        return Ok(false);
    }
    let Some(source) = read_source(read, source_id)? else {
        return Ok(false);
    };
    Ok(
        get_json::<SourceBindingRecord>(read, &source_binding_key(source_id))?
            .is_some_and(|b| b.source_incarnation == source.incarnation),
    )
}

/// The claim's overlap read: every host binding of `host_id` with its worktree's owner, by
/// worktree id.
pub(crate) fn host_worktrees_in(read: &dyn KvRead, host_id: &str) -> Result<Vec<Value>> {
    let host = uuid_param(host_id, "hostId")?;
    let mut out = Vec::new();
    for h in scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")? {
        if h.host_id != host {
            continue;
        }
        let owner = read_worktree_record(read, &h.worktree_id)?.and_then(|w| w.owner_host_id);
        out.push(json!({
            "worktree_id": h.worktree_id,
            "host_id": h.host_id,
            "local_path": h.local_path,
            "coordination_path": h.coordination_path,
            "git_durability": h.git_durability,
            "owner_host_id": owner,
        }));
    }
    Ok(out)
}

/// The topology lock's local read (`listHostTopologyRows`): every host binding of `host_id` with
/// its worktree's owner, epoch, state and topology generation. A binding whose worktree row is
/// gone is left out, as the SQL join leaves it out.
pub(crate) fn host_topology_rows_in(read: &dyn KvRead, host_id: &str) -> Result<Vec<Value>> {
    let host = uuid_param(host_id, "hostId")?;
    let mut out = Vec::new();
    for h in scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")? {
        if h.host_id != host {
            continue;
        }
        let Some(w) = read_worktree_record(read, &h.worktree_id)? else {
            continue;
        };
        out.push(json!({
            "worktree_id": w.id,
            "owner_host_id": w.owner_host_id,
            "owner_epoch": w.owner_epoch,
            "state": w.state,
            "topology_generation": w.topology_generation,
            "local_path": h.local_path,
            "coordination_path": h.coordination_path,
        }));
    }
    Ok(out)
}

/// The source bindings of one worktree (`listWorktreeMembers`): `{ source_id, relative_path }` by
/// byte source id.
pub(crate) fn worktree_members_in(read: &dyn KvRead, worktree_id: &str) -> Result<Vec<Value>> {
    let id = uuid_param(worktree_id, "worktreeId")?;
    let mut rows: Vec<SourceBindingRecord> =
        scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?
            .into_iter()
            .filter(|b| b.worktree_id == id)
            .collect();
    rows.sort_by(|a, b| a.source_id.as_bytes().cmp(b.source_id.as_bytes()));
    Ok(rows
        .into_iter()
        .map(|b| json!({ "source_id": b.source_id, "relative_path": b.relative_path }))
        .collect())
}

/// One worktree's owner and state, or None.
pub(crate) fn worktree_in(read: &dyn KvRead, id: &str) -> Result<Option<Value>> {
    let id = uuid_param(id, "worktreeId")?;
    Ok(read_worktree_record(read, &id)?
        .map(|w| json!({ "owner_host_id": w.owner_host_id, "state": w.state })))
}

/// One host binding's paths, or None.
pub(crate) fn host_binding_in(
    read: &dyn KvRead,
    worktree_id: &str,
    host_id: &str,
) -> Result<Option<Value>> {
    let worktree_id = uuid_param(worktree_id, "worktreeId")?;
    let host_id = uuid_param(host_id, "hostId")?;
    Ok(read_host_record(read, &worktree_id, &host_id)?
        .map(|h| json!({ "local_path": h.local_path, "coordination_path": h.coordination_path })))
}

/// `INSERT INTO persistence_worktrees`: refuses a taken id and a state the CHECK refuses.
pub(crate) fn insert_worktree_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    input: &WorktreeInsert,
) -> Result<()> {
    let id = uuid_param(&input.id, "worktreeId")?;
    let owner_host_id = match &input.owner_host_id {
        None => None,
        Some(h) => Some(uuid_param(h, "ownerHostId")?),
    };
    let state = input.state.clone().unwrap_or_else(active);
    if !WORKTREE_STATES.contains(&state.as_str()) {
        return Err(violation(format!("\"{state}\" is not a worktree state")));
    }
    let key = worktree_key(&id);
    if read_worktree_record(&*tx, &id)?.is_some() {
        return Err(violation(format!("worktree {id} already exists")));
    }
    let record = WorktreeRecord {
        id,
        owner_host_id,
        owner_epoch: input.owner_epoch.unwrap_or(0),
        topology_generation: input.topology_generation.unwrap_or(1),
        state,
        manifest: input.manifest.clone().filter(|m| !m.is_null()),
        heartbeat_at_us: None,
        created_at_us: env.now_micros(),
    };
    put_json(tx, &key, &record)
}

/// `INSERT INTO persistence_host_bindings`: refuses an unknown worktree, a taken (worktree, host)
/// and a Git-durability value the CHECK refuses.
pub(crate) fn insert_host_binding_in(
    tx: &mut dyn KvWrite,
    input: &HostBindingInsert,
) -> Result<()> {
    let worktree_id = uuid_param(&input.worktree_id, "worktreeId")?;
    let host_id = uuid_param(&input.host_id, "hostId")?;
    if let Some(g) = &input.git_durability
        && !GIT_DURABILITY.contains(&g.as_str())
    {
        return Err(violation(format!(
            "\"{g}\" is not a Git durability setting"
        )));
    }
    if read_worktree_record(&*tx, &worktree_id)?.is_none() {
        return Err(violation(format!("worktree {worktree_id} does not exist")));
    }
    let key = host_binding_key(&worktree_id, &host_id);
    if get_json::<HostBindingRecord>(&*tx, &key)?.is_some() {
        return Err(violation(format!(
            "worktree {worktree_id} is already bound on host {host_id}"
        )));
    }
    let record = HostBindingRecord {
        worktree_id,
        host_id,
        local_path: input.local_path.clone(),
        coordination_path: input.coordination_path.clone(),
        git_durability: input.git_durability.clone(),
    };
    put_json(tx, &key, &record)
}

/// `INSERT INTO persistence_source_bindings`: refuses an unknown worktree and a source that
/// already has a binding.
pub(crate) fn insert_source_binding_in(
    tx: &mut dyn KvWrite,
    input: &SourceBindingInsert,
) -> Result<()> {
    let source_id = source_id_param(&input.source_id)?;
    let incarnation = uuid_param(&input.incarnation, "sourceIncarnation")?;
    let worktree_id = uuid_param(&input.worktree_id, "worktreeId")?;
    if read_worktree_record(&*tx, &worktree_id)?.is_none() {
        return Err(violation(format!("worktree {worktree_id} does not exist")));
    }
    let key = source_binding_key(source_id);
    if get_json::<SourceBindingRecord>(&*tx, &key)?.is_some() {
        return Err(violation(format!(
            "source {source_id} already has a worktree binding"
        )));
    }
    let record = SourceBindingRecord {
        source_id: source_id.to_string(),
        source_incarnation: incarnation,
        worktree_id,
        relative_path: input.relative_path.clone().unwrap_or_default(),
        topology_generation: input.topology_generation.unwrap_or(1),
    };
    put_json(tx, &key, &record)
}

/// The `unbound` step of the source delete (engine-sql/sources.ts `deleteSourceRecord`): the
/// source's binding goes when it binds `incarnation`, the deleted row's; a binding of another
/// incarnation stays for `gbrain repair orphan-bindings`. The worktree and host rows stay.
/// The request states `listOrphanBindings` counts as pending and `deleteOrphanBinding` refuses on.
const PENDING_REQUEST_STATES: [&str; 4] = ["queued", "deferred", "running", "recovering"];

fn pending_requests(read: &dyn KvRead, source_id: &str, incarnation: &str) -> Result<i64> {
    Ok(all_requests(read)?
        .iter()
        .filter(|r| {
            r.source_id == source_id
                && r.source_incarnation.eq_ignore_ascii_case(incarnation)
                && PENDING_REQUEST_STATES.contains(&r.state.as_str())
        })
        .count() as i64)
}

/// `listOrphanBindings({ limit })` (engine-sql/repair-bookkeeping.ts ORPHANS): each source binding whose source is gone
/// (`source_removed`) or holds another incarnation (`incarnation_replaced`), with its pending requests, in byte order of
/// source id, at most `limit` when given. The store's source delete removes its binding in the same write, so a binding
/// written straight through `insertSourceBinding` is the way one shows up here.
pub(crate) fn list_orphan_bindings_in(
    read: &dyn KvRead,
    limit: Option<usize>,
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut bindings = scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?;
    bindings.sort_by(|a, b| a.source_id.cmp(&b.source_id));
    for b in bindings {
        let reason = match read_source(read, &b.source_id)? {
            None => "source_removed",
            Some(s) if !s.incarnation.eq_ignore_ascii_case(&b.source_incarnation) => {
                "incarnation_replaced"
            }
            Some(_) => continue,
        };
        out.push(json!({
            "source_id": b.source_id,
            "source_incarnation": b.source_incarnation,
            "worktree_id": b.worktree_id,
            "reason": reason,
            "pending_requests": pending_requests(read, &b.source_id, &b.source_incarnation)?,
        }));
        if limit.is_some_and(|n| out.len() >= n) {
            break;
        }
    }
    Ok(out)
}

/// `deleteOrphanBinding({ source_id, source_incarnation })`: deletes the binding when it is still that incarnation's,
/// still orphaned and has no pending request; true when it deleted one.
pub(crate) fn delete_orphan_binding_in(
    tx: &mut dyn KvWrite,
    source_id: &str,
    incarnation: &str,
) -> Result<bool> {
    let key = source_binding_key(source_id);
    let Some(binding) = get_json::<SourceBindingRecord>(&*tx, &key)? else {
        return Ok(false);
    };
    if !binding.source_incarnation.eq_ignore_ascii_case(incarnation) {
        return Ok(false);
    }
    if read_source(&*tx, source_id)?
        .is_some_and(|s| s.incarnation.eq_ignore_ascii_case(incarnation))
    {
        return Ok(false);
    }
    if pending_requests(&*tx, source_id, incarnation)? > 0 {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}

pub(crate) fn remove_source_binding_in(
    tx: &mut dyn KvWrite,
    source_id: &str,
    incarnation: &str,
) -> Result<()> {
    let key = source_binding_key(source_id);
    if let Some(binding) = get_json::<SourceBindingRecord>(&*tx, &key)?
        && binding.source_incarnation.eq_ignore_ascii_case(incarnation)
    {
        tx.delete(&key)?;
    }
    Ok(())
}

/// `stampWorktreeHeartbeats(hostId)`: `heartbeat_at = now()` on every worktree `host_id` owns.
pub(crate) fn stamp_worktree_heartbeats_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    host_id: &str,
) -> Result<u64> {
    let host = uuid_param(host_id, "hostId")?;
    let now = env.now_micros();
    let mut stamped = 0;
    for mut w in scan_records::<WorktreeRecord>(&*tx, WORKTREE, "worktree")? {
        if w.owner_host_id.as_deref() != Some(host.as_str()) {
            continue;
        }
        w.heartbeat_at_us = Some(now);
        put_json(tx, &worktree_key(&w.id), &w)?;
        stamped += 1;
    }
    Ok(stamped)
}

/// The host-binding half of `listManagedRootBindings(hostId)`: one row per source bound under a
/// worktree that `host_id` binds (`local_path`, `source_id`, `source_incarnation`, `worktree_id`,
/// `topology_generation` as text), by worktree then source.
pub(crate) fn host_root_bindings_in(read: &dyn KvRead, host_id: &str) -> Result<Vec<Value>> {
    let host = uuid_param(host_id, "hostId")?;
    let hosts: Vec<HostBindingRecord> =
        scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")?
            .into_iter()
            .filter(|h| h.host_id == host)
            .collect();
    if hosts.is_empty() {
        return Ok(Vec::new());
    }
    let sources = scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?;
    let mut out = Vec::new();
    for h in &hosts {
        for s in sources.iter().filter(|s| s.worktree_id == h.worktree_id) {
            out.push(json!({
                "local_path": h.local_path,
                "source_id": s.source_id,
                "source_incarnation": s.source_incarnation,
                "worktree_id": s.worktree_id,
                "topology_generation": s.topology_generation.to_string(),
            }));
        }
    }
    Ok(out)
}

/// `listHostRepositoryRoots(hostId)`: every host binding of `host_id` (a stored binding always has a
/// local path, so `local_path IS NOT NULL` holds for each), joined to the
/// source bindings of its worktree (a binding with none gives one row with `source_id` null), by local
/// path in byte order, then source id. `LEFT JOIN ... ORDER BY h.local_path COLLATE "C"` sets no order
/// within one path; byte order of the source id makes it total here.
pub(crate) fn host_repository_roots_in(read: &dyn KvRead, host_id: &str) -> Result<Vec<Value>> {
    let host = uuid_param(host_id, "hostId")?;
    let sources = scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?;
    let mut rows: Vec<(String, Option<String>)> = Vec::new();
    for h in scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")? {
        if h.host_id != host {
            continue;
        }
        let path = h.local_path.clone();
        let named: Vec<&SourceBindingRecord> = sources
            .iter()
            .filter(|s| s.worktree_id == h.worktree_id)
            .collect();
        if named.is_empty() {
            rows.push((path, None));
        } else {
            rows.extend(
                named
                    .into_iter()
                    .map(|s| (path.clone(), Some(s.source_id.clone()))),
            );
        }
    }
    rows.sort();
    Ok(rows
        .into_iter()
        .map(|(local_path, source_id)| json!({ "local_path": local_path, "source_id": source_id }))
        .collect())
}

/// `listPendingGitEffectPaths(hostId)`: per queued or running `git` effect whose data names a
/// `relative_path`, that path (`data ->> 'relative_path'`), its source's local path, and the local
/// path of its worktree's binding on `host_id` (none without a host or a binding), at most 10,000, in
/// effect order (Postgres sets none). A `host_id` that is not a uuid is refused as `$1::uuid` refuses it.
pub(crate) fn pending_git_effect_paths_in(
    read: &dyn KvRead,
    host_id: Option<&str>,
) -> Result<Vec<Value>> {
    let host = host_id.map(|h| uuid_param(h, "hostId")).transpose()?;
    let hosts: Vec<HostBindingRecord> = match &host {
        Some(h) => scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")?
            .into_iter()
            .filter(|b| &b.host_id == h)
            .collect(),
        None => Vec::new(),
    };
    let mut out = Vec::new();
    for e in all_effects(read)? {
        if out.len() >= 10_000 {
            break;
        }
        if e.kind != "git" || !(e.state == "queued" || e.state == "running") {
            continue;
        }
        let Some(rel) = e.data.get("relative_path") else {
            continue;
        };
        let source_path = match &e.source_id {
            Some(id) => read_source(read, id)?.and_then(|s| s.local_path),
            None => None,
        };
        let worktree_path = e
            .worktree_id
            .as_ref()
            .and_then(|w| hosts.iter().find(|b| &b.worktree_id == w))
            .map(|b| b.local_path.clone());
        out.push(json!({
            "rel": crate::timeline_queries::jsonb_field_text(rel),
            "source_path": source_path,
            "worktree_path": worktree_path,
        }));
    }
    Ok(out)
}

/// A worktree's heartbeat, as ISO text (for tests and diagnostics).
pub(crate) fn worktree_heartbeat_in(read: &dyn KvRead, id: &str) -> Result<Option<String>> {
    let id = uuid_param(id, "worktreeId")?;
    Ok(read_worktree_record(read, &id)?
        .and_then(|w| w.heartbeat_at_us)
        .map(iso))
}

/// `config->>'kind'`: a string as itself, another JSON value as its jsonb text, null as null.
pub(super) fn kind_text(config: &serde_json::Map<String, Value>) -> Value {
    match config.get("kind") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => json!(s),
        Some(other) => json!(jsonb_text(other)),
    }
}

/// `jsonb_agg` over no rows is null.
fn agg(rows: Vec<Value>) -> Value {
    if rows.is_empty() {
        Value::Null
    } else {
        Value::Array(rows)
    }
}

/// `WRITER_ADMIN_STATE_SQL` (`engine-sql/writer-admin.ts`): the writer topology as jsonb text,
/// read in one snapshot. `enabled` and `mode_epoch` are the stored brain mode
/// (worktrees/release.rs); `skill_bundles_enabled` and `writer_protocol_floor` hold their column
/// defaults. A store with no brain id has no brain row (null).
pub(crate) fn writer_admin_state_text_in(read: &dyn KvRead, brain_id: &str) -> Result<String> {
    let brain = if brain_id.is_empty() {
        Value::Null
    } else {
        let mode = release::brain_mode_in(read)?;
        json!({
            "id": brain_id,
            "enabled": mode.enabled,
            "skill_bundles_enabled": false,
            "writer_protocol_floor": 1,
            "mode_epoch": mode.mode_epoch,
        })
    };
    let mut sources = all_sources(read)?;
    sources.sort_by(|a, b| a.id.as_bytes().cmp(b.id.as_bytes()));
    let sources = sources
        .iter()
        .map(|s| {
            json!([
                s.id,
                s.incarnation,
                s.archived,
                s.local_path,
                kind_text(&s.config)
            ])
        })
        .collect();
    let worktrees = scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")?
        .into_iter()
        .map(|w| {
            json!([
                w.id,
                w.owner_host_id,
                w.owner_epoch.to_string(),
                w.topology_generation.to_string(),
                w.state,
                w.manifest
            ])
        })
        .collect();
    let bindings = scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?
        .into_iter()
        .map(|b| {
            json!([
                b.source_id,
                b.source_incarnation,
                b.worktree_id,
                b.relative_path,
                b.topology_generation.to_string()
            ])
        })
        .collect();
    let hosts = scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")?
        .into_iter()
        .map(|h| {
            json!([
                h.worktree_id,
                h.host_id,
                h.local_path,
                h.coordination_path,
                h.git_durability
            ])
        })
        .collect();
    let state = json!({
        "brain": brain,
        "sources": agg(sources),
        "fallback": read_config(read, "sync.repo_path")?,
        "worktrees": agg(worktrees),
        "bindings": agg(bindings),
        "hosts": agg(hosts),
        "legacy_locks": agg(legacy_lock_rows(read)?),
    });
    Ok(jsonb_text(&state))
}

/// The `preparedTransferWorktree()` read: the first worktree by id that is `draining` with a
/// manifest, or None.
pub(crate) fn prepared_transfer_worktree_in(read: &dyn KvRead) -> Result<Option<String>> {
    Ok(scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")?
        .into_iter()
        .find(|w| w.state == "draining" && w.manifest.is_some())
        .map(|w| w.id))
}

/// The `lockWorktree(id)` read: `{ owner_host_id, owner_epoch (text), state, manifest }`, or
/// None.
pub(crate) fn worktree_owner_in(read: &dyn KvRead, id: &str) -> Result<Option<Value>> {
    let id = uuid_param(id, "worktreeId")?;
    Ok(read_worktree_record(read, &id)?.map(|w| {
        json!({
            "owner_host_id": w.owner_host_id,
            "owner_epoch": w.owner_epoch.to_string(),
            "state": w.state,
            "manifest": w.manifest,
        })
    }))
}

/// `readWorktreeManifest(id)`: the worktree's manifest, or None when it has none or is missing.
pub(crate) fn worktree_manifest_in(read: &dyn KvRead, id: &str) -> Result<Option<Value>> {
    let id = uuid_param(id, "worktreeId")?;
    Ok(read_worktree_record(read, &id)?.and_then(|w| w.manifest))
}

/// `publicationPending(worktreeId)`: a request on the worktree that is running, recovering or
/// holds a recovery record, or an effect on it that holds one.
pub(crate) fn worktree_publication_pending_in(read: &dyn KvRead, id: &str) -> Result<bool> {
    let id = uuid_param(id, "worktreeId")?;
    let on_worktree = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .is_some_and(|w| w.eq_ignore_ascii_case(&id))
    };
    for r in all_requests(read)? {
        if on_worktree(r.extra.get("worktree_id"))
            && (r.state == "running" || r.state == "recovering" || !extra_is_null(&r, "recovery"))
        {
            return Ok(true);
        }
    }
    Ok(all_effects(read)?.iter().any(|e| {
        e.worktree_id
            .as_deref()
            .is_some_and(|w| w.eq_ignore_ascii_case(&id))
            && e.recovery.as_ref().is_some_and(|v| !v.is_null())
    }))
}

/// `markWorktreeDraining(id, manifest)`: `state = 'draining'` and the manifest with
/// `prepared_at = now()` (jsonb `timestamptz` text). A missing worktree changes nothing.
pub(crate) fn mark_worktree_draining_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    id: &str,
    manifest: &Value,
) -> Result<()> {
    let id = uuid_param(id, "worktreeId")?;
    let Value::Object(map) = manifest else {
        return Err(StoreError::invalid("a transfer manifest is a JSON object"));
    };
    let Some(mut w) = read_worktree_record(&*tx, &id)? else {
        return Ok(());
    };
    let mut map = map.clone();
    map.insert("prepared_at".into(), json!(jsonb_time(env.now_micros())));
    w.state = "draining".into();
    w.manifest = Some(Value::Object(map));
    put_json(tx, &worktree_key(&id), &w)
}

/// `reactivateWorktree(id)`: `state = 'active'`, `manifest = NULL`. A missing worktree changes
/// nothing.
pub(crate) fn reactivate_worktree_in(tx: &mut dyn KvWrite, id: &str) -> Result<()> {
    let id = uuid_param(id, "worktreeId")?;
    let Some(mut w) = read_worktree_record(&*tx, &id)? else {
        return Ok(());
    };
    w.state = "active".into();
    w.manifest = None;
    put_json(tx, &worktree_key(&id), &w)
}

/// `upsertHostBinding(row)`: the accepting host's paths for the worktree. An existing binding
/// keeps its Git durability; a new one has none. Refuses an unknown worktree, as the foreign key
/// does.
pub(crate) fn upsert_host_binding_in(
    tx: &mut dyn KvWrite,
    input: &HostBindingInsert,
) -> Result<()> {
    let worktree_id = uuid_param(&input.worktree_id, "worktreeId")?;
    let host_id = uuid_param(&input.host_id, "hostId")?;
    if read_worktree_record(&*tx, &worktree_id)?.is_none() {
        return Err(violation(format!("worktree {worktree_id} does not exist")));
    }
    let git_durability =
        read_host_record(&*tx, &worktree_id, &host_id)?.and_then(|h| h.git_durability);
    let record = HostBindingRecord {
        local_path: input.local_path.clone(),
        coordination_path: input.coordination_path.clone(),
        worktree_id,
        host_id,
        git_durability,
    };
    put_json(
        tx,
        &host_binding_key(&record.worktree_id, &record.host_id),
        &record,
    )
}

/// `acceptWorktreeOwner(id, hostId)`: `hostId` owns the worktree at the next epoch, `active`,
/// heartbeat now; the manifest is kept. A missing worktree changes nothing.
pub(crate) fn accept_worktree_owner_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    id: &str,
    host_id: &str,
) -> Result<()> {
    let id = uuid_param(id, "worktreeId")?;
    let host_id = uuid_param(host_id, "hostId")?;
    let Some(mut w) = read_worktree_record(&*tx, &id)? else {
        return Ok(());
    };
    w.owner_host_id = Some(host_id);
    w.owner_epoch += 1;
    w.state = "active".into();
    w.heartbeat_at_us = Some(env.now_micros());
    put_json(tx, &worktree_key(&id), &w)
}

/// `contentReceiptRows(worktreeIds, hostId, sourceIds)`: for each source bound to one of
/// `worktree_ids` (only `source_ids` when given) at its current, unarchived incarnation, with a
/// host binding on `host_id` and a content receipt config row, `{ source_id, incarnation,
/// relative_path, local_path, brain_id, key, value }`; source ids in byte order. A brain without
/// an id has none.
pub(crate) fn content_receipt_rows_in(
    read: &dyn KvRead,
    brain_id: &str,
    worktree_ids: &[String],
    host_id: &str,
    source_ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    let host = uuid_param(host_id, "hostId")?;
    let worktrees = worktree_ids
        .iter()
        .map(|w| uuid_param(w, "worktreeIds"))
        .collect::<Result<Vec<_>>>()?;
    if brain_id.is_empty() {
        return Ok(Vec::new());
    }
    let sources = all_sources(read)?;
    let mut bindings = scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?;
    bindings.sort_by(|a, b| a.source_id.as_bytes().cmp(b.source_id.as_bytes()));
    let mut out = Vec::new();
    for b in &bindings {
        if !worktrees.contains(&b.worktree_id)
            || source_ids.is_some_and(|ids| !ids.contains(&b.source_id))
        {
            continue;
        }
        let current = sources.iter().any(|s| {
            s.id == b.source_id
                && !s.archived
                && s.incarnation.eq_ignore_ascii_case(&b.source_incarnation)
        });
        if !current {
            continue;
        }
        let Some(h) = read_host_record(read, &b.worktree_id, &host)? else {
            continue;
        };
        let key = format!(
            "shared_skills.content.v1.{}.{}",
            b.source_id, b.source_incarnation
        );
        let Some(value) = read_config(read, &key)? else {
            continue;
        };
        out.push(json!({
            "source_id": b.source_id,
            "incarnation": b.source_incarnation,
            "relative_path": b.relative_path,
            "local_path": h.local_path,
            "brain_id": brain_id,
            "key": key,
            "value": value,
        }));
    }
    Ok(out)
}

/// `swapConfigValue(key, value, expected)`: sets config `key` to `value` only while it holds
/// `expected`; whether it was set.
pub(crate) fn swap_config_value_in(
    tx: &mut dyn KvWrite,
    key: &str,
    value: &str,
    expected: &str,
) -> Result<bool> {
    if read_config(&*tx, key)?.as_deref() != Some(expected) {
        return Ok(false);
    }
    tx.put(&config_key(key)?, value.as_bytes())?;
    Ok(true)
}

impl Store {
    /// `listOrphanBindings({ limit })`.
    pub fn list_orphan_bindings(&self, limit: Option<usize>) -> Result<Vec<Value>> {
        let read = self.read()?;
        list_orphan_bindings_in(&*read, limit)
    }

    /// `deleteOrphanBinding({ source_id, source_incarnation })`.
    pub fn delete_orphan_binding(&self, source_id: &str, incarnation: &str) -> Result<bool> {
        self.write(|tx| delete_orphan_binding_in(tx, source_id, incarnation))
    }

    /// `listHostTopologyRows(hostId)`.
    pub fn list_host_topology_rows(&self, host_id: &str) -> Result<Vec<Value>> {
        host_topology_rows_in(&*self.read()?, host_id)
    }

    /// `listPendingGitEffectPaths(hostId)`: the paths the queued and running git effects are about to commit.
    pub fn list_pending_git_effect_paths(&self, host_id: Option<&str>) -> Result<Vec<Value>> {
        pending_git_effect_paths_in(&*self.read()?, host_id)
    }

    /// `listHostRepositoryRoots(hostId)`: the host's bound local paths with the sources named on them.
    pub fn list_host_repository_roots(&self, host_id: &str) -> Result<Vec<Value>> {
        host_repository_roots_in(&*self.read()?, host_id)
    }

    /// `listWorktreeMembers(worktreeId)`.
    pub fn list_worktree_members(&self, worktree_id: &str) -> Result<Vec<Value>> {
        worktree_members_in(&*self.read()?, worktree_id)
    }

    /// `readWriterAdminState()`: the writer topology as jsonb text.
    pub fn writer_admin_state_text(&self) -> Result<String> {
        writer_admin_state_text_in(&*self.read()?, self.brain_id())
    }

    /// The id of the worktree a prepared transfer holds, or None.
    pub fn prepared_transfer_worktree(&self) -> Result<Option<String>> {
        prepared_transfer_worktree_in(&*self.read()?)
    }

    /// One worktree's `{ owner_host_id, owner_epoch, state, manifest }`, or None.
    pub fn read_worktree_owner(&self, id: &str) -> Result<Option<Value>> {
        worktree_owner_in(&*self.read()?, id)
    }

    /// One worktree's manifest, or None.
    pub fn read_worktree_manifest(&self, id: &str) -> Result<Option<Value>> {
        worktree_manifest_in(&*self.read()?, id)
    }

    /// Records the accepting host's paths for a worktree, keeping its Git durability.
    pub fn upsert_host_binding(&self, input: &HostBindingInsert) -> Result<()> {
        self.write(|tx| upsert_host_binding_in(tx, input))
    }

    /// Gives a worktree to `host_id` at the next epoch, `active`.
    pub fn accept_worktree_owner(&self, id: &str, host_id: &str) -> Result<()> {
        self.write(|tx| accept_worktree_owner_in(tx, &*self.env, id, host_id))
    }

    /// The content receipt rows a transfer accept or a set-path rebind may move.
    pub fn content_receipt_rows(
        &self,
        worktree_ids: &[String],
        host_id: &str,
        source_ids: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        content_receipt_rows_in(
            &*self.read()?,
            self.brain_id(),
            worktree_ids,
            host_id,
            source_ids,
        )
    }

    /// Sets config `key` to `value` only while it holds `expected`; whether it was set.
    pub fn swap_config_value(&self, key: &str, value: &str, expected: &str) -> Result<bool> {
        self.write(|tx| swap_config_value_in(tx, key, value, expected))
    }

    /// Whether a publication on the worktree is still running or recovering.
    pub fn worktree_publication_pending(&self, id: &str) -> Result<bool> {
        worktree_publication_pending_in(&*self.read()?, id)
    }

    /// Marks a worktree draining with the prepared transfer's manifest.
    pub fn mark_worktree_draining(&self, id: &str, manifest: &Value) -> Result<()> {
        self.write(|tx| mark_worktree_draining_in(tx, &*self.env, id, manifest))
    }

    /// Returns a draining worktree to active and clears its manifest.
    pub fn reactivate_worktree(&self, id: &str) -> Result<()> {
        self.write(|tx| reactivate_worktree_in(tx, id))
    }

    /// `getWorktreeBinding(sourceId, hostId)`.
    pub fn get_worktree_binding(
        &self,
        source_id: &str,
        host_id: Option<&str>,
    ) -> Result<Option<Value>> {
        worktree_binding_in(&*self.read()?, source_id, host_id)
    }

    /// `isSourceClaimed(sourceId)`.
    pub fn is_source_claimed(&self, source_id: &str) -> Result<bool> {
        is_source_claimed_in(&*self.read()?, source_id)
    }

    /// The claim's overlap read of host `host_id`'s bindings.
    pub fn list_host_worktrees(&self, host_id: &str) -> Result<Vec<Value>> {
        host_worktrees_in(&*self.read()?, host_id)
    }

    /// One worktree's `{ owner_host_id, state }`, or None.
    pub fn read_worktree(&self, id: &str) -> Result<Option<Value>> {
        worktree_in(&*self.read()?, id)
    }

    /// One host binding's `{ local_path, coordination_path }`, or None.
    pub fn read_host_binding(&self, worktree_id: &str, host_id: &str) -> Result<Option<Value>> {
        host_binding_in(&*self.read()?, worktree_id, host_id)
    }

    /// Records a worktree row.
    pub fn insert_worktree(&self, input: &WorktreeInsert) -> Result<()> {
        self.write(|tx| insert_worktree_in(tx, &*self.env, input))
    }

    /// Records a host binding row.
    pub fn insert_host_binding(&self, input: &HostBindingInsert) -> Result<()> {
        self.write(|tx| insert_host_binding_in(tx, input))
    }

    /// Records a source binding row.
    pub fn insert_source_binding(&self, input: &SourceBindingInsert) -> Result<()> {
        self.write(|tx| insert_source_binding_in(tx, input))
    }

    /// `stampWorktreeHeartbeats(hostId)`: how many worktrees were stamped.
    pub fn stamp_worktree_heartbeats(&self, host_id: &str) -> Result<u64> {
        self.write(|tx| stamp_worktree_heartbeats_in(tx, &*self.env, host_id))
    }

    /// The host-binding rows of `listManagedRootBindings(hostId)`.
    pub fn list_host_root_bindings(&self, host_id: &str) -> Result<Vec<Value>> {
        host_root_bindings_in(&*self.read()?, host_id)
    }

    /// A worktree's heartbeat as ISO text, or None.
    pub fn read_worktree_heartbeat(&self, id: &str) -> Result<Option<String>> {
        worktree_heartbeat_in(&*self.read()?, id)
    }
}
