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
//! binding's incarnation with the source's. Rows are not deleted on this engine yet (no writer
//! transfer, rebind or source purge runs here).

use super::{uuid_param, violation};
use crate::env::{Env, iso};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// `persistence_worktrees.state` CHECK.
const WORKTREE_STATES: &[&str] = &["active", "draining", "recovering"];
/// `persistence_host_bindings.git_durability` CHECK (null is allowed).
const GIT_DURABILITY: &[&str] = &["enabled", "disabled"];

const WORKTREE: u8 = 0x01;
const HOST_BINDING: u8 = 0x02;
const SOURCE_BINDING: u8 = 0x03;

/// One stored worktree.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorktreeRecord {
    id: String,
    #[serde(default)]
    owner_host_id: Option<String>,
    #[serde(default)]
    owner_epoch: i64,
    #[serde(default = "one")]
    topology_generation: i64,
    #[serde(default = "active")]
    state: String,
    #[serde(default)]
    manifest: Option<Value>,
    #[serde(default)]
    heartbeat_at_us: Option<i64>,
    #[serde(default)]
    created_at_us: i64,
}

/// One stored host binding: where a worktree is on one host.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct HostBindingRecord {
    worktree_id: String,
    host_id: String,
    local_path: String,
    coordination_path: String,
    #[serde(default)]
    git_durability: Option<String>,
}

/// One stored source binding: the worktree a source lives in.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SourceBindingRecord {
    source_id: String,
    source_incarnation: String,
    worktree_id: String,
    #[serde(default)]
    relative_path: String,
    #[serde(default = "one")]
    topology_generation: i64,
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

fn worktree_key(id: &str) -> Vec<u8> {
    let mut key = prefix(WORKTREE);
    key.extend_from_slice(id.as_bytes());
    key
}

fn host_binding_key(worktree_id: &str, host_id: &str) -> Vec<u8> {
    let mut key = prefix(HOST_BINDING);
    key.extend_from_slice(worktree_id.as_bytes());
    key.push(0);
    key.extend_from_slice(host_id.as_bytes());
    key
}

fn source_binding_key(source_id: &str) -> Vec<u8> {
    let mut key = prefix(SOURCE_BINDING);
    key.extend_from_slice(source_id.as_bytes());
    key
}

/// Every record under one tag, in key order.
fn scan_records<T: for<'de> Deserialize<'de>>(
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

fn read_worktree_record(read: &dyn KvRead, id: &str) -> Result<Option<WorktreeRecord>> {
    get_json(read, &worktree_key(id))
}

fn read_host_record(
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

/// A worktree's heartbeat, as ISO text (for tests and diagnostics).
pub(crate) fn worktree_heartbeat_in(read: &dyn KvRead, id: &str) -> Result<Option<String>> {
    let id = uuid_param(id, "worktreeId")?;
    Ok(read_worktree_record(read, &id)?
        .and_then(|w| w.heartbeat_at_us)
        .map(iso))
}

impl Store {
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
