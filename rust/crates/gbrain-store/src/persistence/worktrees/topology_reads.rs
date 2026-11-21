//! The source-lifecycle reads a topology change makes before its first write: the store half of
//! `src/core/engine-sql/topology-store.ts` (rust/docs/store/persistence.md, "Topology store").
//!
//! Each read returns the rows of the SQL it replaces in `topology-clone.ts` and
//! `topology-locks.ts`. The row locks those statements take have no counterpart: this engine runs
//! one write transaction at a time. `owner_epoch` and `topology_generation` are text, as
//! `getWorktreeBinding` returns them; the callers compare them with `String()`.

use super::super::effects::all_effects;
use super::super::{all_requests, extra_is_null, uuid_param};
use super::{
    HOST_BINDING, HostBindingRecord, SOURCE_BINDING, SourceBindingRecord, WORKTREE, WorktreeRecord,
    scan_records,
};
use crate::Store;
use crate::error::Result;
use crate::facts::md5_hex;
use crate::kv::KvRead;
use crate::pages::all_pages;
use crate::sources::read_source;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

/// The request states a lifecycle change waits on (`assertTopologyRequestsSettled`).
const UNSETTLED: &[&str] = &["queued", "deferred", "running", "recovering"];

fn uuid_set(ids: &[String], what: &str) -> Result<HashSet<String>> {
    ids.iter().map(|id| uuid_param(id, what)).collect()
}

/// `SELECT incarnation,config,last_commit,local_path FROM sources WHERE id=$1`, or None.
pub(crate) fn topology_source_in(read: &dyn KvRead, source_id: &str) -> Result<Option<Value>> {
    if source_id.contains('\0') {
        return Ok(None);
    }
    Ok(read_source(read, source_id)?.map(|s| {
        json!({
            "incarnation": s.incarnation,
            "config": Value::Object(s.config),
            "last_commit": s.last_commit,
            "local_path": s.local_path,
        })
    }))
}

/// `SELECT id,incarnation,archived,local_path,config,name,last_commit FROM sources WHERE id=$1`,
/// the first read of a source lifecycle change (`source-lifecycle.ts`), or None.
pub(crate) fn topology_lifecycle_source_in(
    read: &dyn KvRead,
    source_id: &str,
) -> Result<Option<Value>> {
    if source_id.contains('\0') {
        return Ok(None);
    }
    Ok(read_source(read, source_id)?.map(|s| {
        json!({
            "id": s.id,
            "incarnation": s.incarnation,
            "archived": s.archived,
            "local_path": s.local_path,
            "config": Value::Object(s.config),
            "name": s.name,
            "last_commit": s.last_commit,
        })
    }))
}

/// The worktrees host `host_id` binds, with their owner, epoch, state and generation: the
/// `persistence_host_bindings JOIN persistence_worktrees` read of `withTopologyLocks`.
pub(crate) fn topology_host_worktrees_in(read: &dyn KvRead, host_id: &str) -> Result<Vec<Value>> {
    let host = uuid_param(host_id, "hostId")?;
    let worktrees: BTreeMap<String, WorktreeRecord> =
        scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")?
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();
    let mut out = Vec::new();
    for h in scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")? {
        if h.host_id != host {
            continue;
        }
        let Some(w) = worktrees.get(&h.worktree_id) else {
            continue;
        };
        out.push(json!({
            "worktree_id": w.id,
            "owner_host_id": w.owner_host_id,
            "owner_epoch": w.owner_epoch.to_string(),
            "state": w.state,
            "topology_generation": w.topology_generation.to_string(),
            "local_path": h.local_path,
            "coordination_path": h.coordination_path,
        }));
    }
    Ok(out)
}

/// The source ids bound to any of `worktree_ids`, in source-id order.
pub(crate) fn topology_members_in(
    read: &dyn KvRead,
    worktree_ids: &[String],
) -> Result<Vec<String>> {
    let ids = uuid_set(worktree_ids, "worktreeId")?;
    let mut out: Vec<String> =
        scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?
            .into_iter()
            .filter(|b| ids.contains(&b.worktree_id))
            .map(|b| b.source_id)
            .collect();
    out.sort_unstable();
    Ok(out)
}

/// `SELECT id,owner_host_id,state,owner_epoch,topology_generation FROM persistence_worktrees
/// WHERE id=ANY($1::uuid[]) ORDER BY id`.
pub(crate) fn topology_owners_in(read: &dyn KvRead, worktree_ids: &[String]) -> Result<Vec<Value>> {
    let ids = uuid_set(worktree_ids, "worktreeId")?;
    let mut rows: Vec<WorktreeRecord> = scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")?
        .into_iter()
        .filter(|w| ids.contains(&w.id))
        .collect();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(rows
        .into_iter()
        .map(|w| {
            json!({
                "id": w.id,
                "owner_host_id": w.owner_host_id,
                "state": w.state,
                "owner_epoch": w.owner_epoch.to_string(),
                "topology_generation": w.topology_generation.to_string(),
            })
        })
        .collect())
}

/// `topologyCanonicalStamp`: md5 of `<page id>:<knowledge revision>:<binding incarnation>` for
/// every page of every source bound to the worktree, by page id, comma-joined; md5('') for none.
pub(crate) fn topology_canonical_stamp_in(read: &dyn KvRead, worktree_id: &str) -> Result<String> {
    let id = uuid_param(worktree_id, "worktreeId")?;
    let bindings: BTreeMap<String, String> =
        scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?
            .into_iter()
            .filter(|b| b.worktree_id == id)
            .map(|b| (b.source_id, b.source_incarnation))
            .collect();
    let mut parts: Vec<(u64, String)> = Vec::new();
    if !bindings.is_empty() {
        for p in all_pages(read)? {
            if let Some(incarnation) = bindings.get(&p.source_id) {
                parts.push((
                    p.id,
                    format!("{}:{}:{}", p.id, p.knowledge_revision, incarnation),
                ));
            }
        }
    }
    parts.sort_by_key(|(id, _)| *id);
    let joined: Vec<String> = parts.into_iter().map(|(_, text)| text).collect();
    Ok(md5_hex(&joined.join(",")))
}

/// `assertTopologyRequestsSettled`'s request read: every request of `source_ids` or
/// `worktree_ids` that is queued, deferred, running, recovering or holds a recovery record, as
/// `SELECT *` rows by sequence.
pub(crate) fn topology_unsettled_requests_in(
    read: &dyn KvRead,
    source_ids: &[String],
    worktree_ids: &[String],
) -> Result<Vec<Value>> {
    let worktrees = uuid_set(worktree_ids, "worktreeId")?;
    let sources: HashSet<&str> = source_ids.iter().map(String::as_str).collect();
    let mut rows: Vec<_> = all_requests(read)?
        .into_iter()
        .filter(|r| {
            let on_worktree = r
                .extra
                .get("worktree_id")
                .and_then(Value::as_str)
                .is_some_and(|w| worktrees.contains(w));
            (sources.contains(r.source_id.as_str()) || on_worktree)
                && (UNSETTLED.contains(&r.state.as_str()) || !extra_is_null(r, "recovery"))
        })
        .collect();
    rows.sort_by_key(|r| r.sequence);
    Ok(rows.iter().map(|r| r.to_row()).collect())
}

/// `assertTopologyRequestsSettled`'s effect read: one effect of `source_ids` or `worktree_ids`
/// that holds a recovery record, is running, or is a queued withdrawal mirror, as
/// `{ id (text), source_id }`; None when there is none.
pub(crate) fn topology_blocking_effect_in(
    read: &dyn KvRead,
    source_ids: &[String],
    worktree_ids: &[String],
) -> Result<Option<Value>> {
    let worktrees = uuid_set(worktree_ids, "worktreeId")?;
    let sources: HashSet<&str> = source_ids.iter().map(String::as_str).collect();
    Ok(all_effects(read)?
        .into_iter()
        .find(|e| {
            let scoped = e.source_id.as_deref().is_some_and(|s| sources.contains(s))
                || e.worktree_id
                    .as_deref()
                    .is_some_and(|w| worktrees.contains(w));
            scoped
                && (e.recovery.is_some()
                    || e.state == "running"
                    || (e.kind == "withdrawal-mirror" && e.state == "queued"))
        })
        .map(|e| json!({ "id": e.id.to_string(), "source_id": e.source_id })))
}

impl Store {
    /// `topologyStore().source(sourceId)`: the source's incarnation, config, last commit and
    /// local path, or None.
    pub fn topology_source(&self, source_id: &str) -> Result<Option<Value>> {
        topology_source_in(&*self.read()?, source_id)
    }

    /// `topologyStore().lifecycleSource(sourceId)`: the source's id, incarnation, archived flag,
    /// local path, config, name and last commit, or None.
    pub fn topology_lifecycle_source(&self, source_id: &str) -> Result<Option<Value>> {
        topology_lifecycle_source_in(&*self.read()?, source_id)
    }

    /// `topologyStore().hostWorktrees(hostId)`.
    pub fn topology_host_worktrees(&self, host_id: &str) -> Result<Vec<Value>> {
        topology_host_worktrees_in(&*self.read()?, host_id)
    }

    /// `topologyStore().members(worktreeIds)`: the bound source ids, in order.
    pub fn topology_members(&self, worktree_ids: &[String]) -> Result<Vec<String>> {
        topology_members_in(&*self.read()?, worktree_ids)
    }

    /// `topologyStore().lockOwners(worktreeIds)`: the worktree rows, by id.
    pub fn topology_owners(&self, worktree_ids: &[String]) -> Result<Vec<Value>> {
        topology_owners_in(&*self.read()?, worktree_ids)
    }

    /// `topologyStore().canonicalStamp(worktreeId)`.
    pub fn topology_canonical_stamp(&self, worktree_id: &str) -> Result<String> {
        topology_canonical_stamp_in(&*self.read()?, worktree_id)
    }

    /// `topologyStore().unsettledRequests(sourceIds, worktreeIds)`.
    pub fn topology_unsettled_requests(
        &self,
        source_ids: &[String],
        worktree_ids: &[String],
    ) -> Result<Vec<Value>> {
        topology_unsettled_requests_in(&*self.read()?, source_ids, worktree_ids)
    }

    /// `topologyStore().blockingEffect(sourceIds, worktreeIds)`.
    pub fn topology_blocking_effect(
        &self,
        source_ids: &[String],
        worktree_ids: &[String],
    ) -> Result<Option<Value>> {
        topology_blocking_effect_in(&*self.read()?, source_ids, worktree_ids)
    }
}
