//! The worktree, binding and source writes of a managed clone's transaction and of its commit:
//! the store half of the write members of `src/core/engine-sql/topology-store.ts`
//! (rust/docs/store/persistence.md, "Topology store").
//!
//! Each write changes what the SQL it replaces in `topology-clone.ts`, `topology-recovery.ts`
//! and `topology-locks.ts` changes. A row the SQL `WHERE` matches nothing for changes nothing
//! here too; the callers run inside one store write transaction, so a later refusal undoes them.

use super::super::uuid_param;
use super::{
    SOURCE_BINDING, SourceBindingRecord, WORKTREE_STATES, read_worktree_record, scan_records,
    source_binding_key, source_id_param, worktree_key,
};
use crate::cli_reads::sources::insert_source_in;
use crate::env::Env;
use crate::error::Result;
use crate::kv::KvWrite;
use crate::sources::{read_source, source_key};
use crate::{Store, get_json, put_json};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// One `UPDATE persistence_worktrees ... WHERE id=$1` of the topology store.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorktreeUpdate {
    /// `recoverWorktree`: `state = 'recovering'`.
    Recover,
    /// `recoverWorktreeWithManifest`: `state = 'recovering'`, `manifest = $2`.
    RecoverWithManifest { manifest: Value },
    /// `setWorktreeManifest`: `manifest = $2`.
    Manifest { manifest: Value },
    /// `activateWorktree`: `state = 'active'`.
    Activate,
}

/// The source of a managed clone's commit (`insertCloneSource`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneSourceInsert {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub local_path: Option<String>,
    #[serde(default)]
    pub config: Map<String, Value>,
    pub incarnation: String,
}

/// Applies `update` to worktree `id`. A missing worktree changes nothing.
pub(crate) fn topology_update_worktree_in(
    tx: &mut dyn KvWrite,
    id: &str,
    update: &WorktreeUpdate,
) -> Result<()> {
    let id = uuid_param(id, "worktreeId")?;
    let Some(mut w) = read_worktree_record(&*tx, &id)? else {
        return Ok(());
    };
    let manifest = |m: &Value| Some(m.clone()).filter(|m| !m.is_null());
    match update {
        WorktreeUpdate::Recover => w.state = "recovering".into(),
        WorktreeUpdate::RecoverWithManifest { manifest: m } => {
            w.state = "recovering".into();
            w.manifest = manifest(m);
        }
        WorktreeUpdate::Manifest { manifest: m } => w.manifest = manifest(m),
        WorktreeUpdate::Activate => w.state = "active".into(),
    }
    debug_assert!(WORKTREE_STATES.contains(&w.state.as_str()));
    put_json(tx, &worktree_key(&id), &w)
}

/// `advanceGeneration(ids)`: each listed worktree's `topology_generation` goes up by one, then
/// each source binding of those worktrees takes its worktree's new generation.
pub(crate) fn topology_advance_generation_in(tx: &mut dyn KvWrite, ids: &[String]) -> Result<()> {
    let mut generations = HashMap::new();
    for id in ids {
        let id = uuid_param(id, "worktreeId")?;
        if generations.contains_key(&id) {
            continue;
        }
        let Some(mut w) = read_worktree_record(&*tx, &id)? else {
            continue;
        };
        w.topology_generation += 1;
        put_json(tx, &worktree_key(&id), &w)?;
        generations.insert(id, w.topology_generation);
    }
    let bindings: Vec<SourceBindingRecord> =
        scan_records(&*tx, SOURCE_BINDING, "persistence source binding")?;
    for mut b in bindings {
        if let Some(generation) = generations.get(&b.worktree_id) {
            b.topology_generation = *generation;
            put_json(tx, &source_binding_key(&b.source_id), &b)?;
        }
    }
    Ok(())
}

/// `unbindSource(sourceId, incarnation)`: deletes the source's binding when it is of that
/// incarnation.
pub(crate) fn topology_unbind_source_in(
    tx: &mut dyn KvWrite,
    source_id: &str,
    incarnation: &str,
) -> Result<()> {
    let source_id = source_id_param(source_id)?;
    let incarnation = uuid_param(incarnation, "sourceIncarnation")?;
    let key = source_binding_key(source_id);
    let binding: Option<SourceBindingRecord> = get_json(&*tx, &key)?;
    if binding.is_some_and(|b| b.source_incarnation == incarnation) {
        tx.delete(&key)?;
    }
    Ok(())
}

/// `insertCloneSource(row)`: the clone's source with the incarnation the clone recorded.
/// Refuses a taken id or name, as `insertSource` does.
pub(crate) fn topology_insert_source_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    input: &CloneSourceInsert,
) -> Result<()> {
    let incarnation = uuid_param(&input.incarnation, "incarnation")?;
    insert_source_in(
        tx,
        env,
        &input.id,
        &input.name,
        input.local_path.as_deref(),
        &input.config,
        Some(&incarnation),
    )
    .map(|_| ())
}

/// `resetSourceCheckpoint(id, incarnation)`: no last commit and no last sync time, when the
/// source is of that incarnation.
pub(crate) fn topology_reset_source_checkpoint_in(
    tx: &mut dyn KvWrite,
    id: &str,
    incarnation: &str,
) -> Result<()> {
    let incarnation = uuid_param(incarnation, "incarnation")?;
    let Some(mut s) = read_source(&*tx, id)? else {
        return Ok(());
    };
    if s.incarnation != incarnation {
        return Ok(());
    }
    s.last_commit = None;
    s.last_sync_at_us = None;
    put_json(tx, &source_key(id), &s)
}

impl Store {
    /// One `UPDATE persistence_worktrees ... WHERE id=$1` of the topology store.
    pub fn topology_update_worktree(&self, id: &str, update: &WorktreeUpdate) -> Result<()> {
        self.write(|tx| topology_update_worktree_in(tx, id, update))
    }

    /// `topologyStore().advanceGeneration(worktreeIds)`.
    pub fn topology_advance_generation(&self, ids: &[String]) -> Result<()> {
        self.write(|tx| topology_advance_generation_in(tx, ids))
    }

    /// `topologyStore().unbindSource(sourceId, incarnation)`.
    pub fn topology_unbind_source(&self, source_id: &str, incarnation: &str) -> Result<()> {
        self.write(|tx| topology_unbind_source_in(tx, source_id, incarnation))
    }

    /// `topologyStore().insertCloneSource(row)`.
    pub fn topology_insert_source(&self, input: &CloneSourceInsert) -> Result<()> {
        self.write(|tx| topology_insert_source_in(tx, &*self.env, input))
    }

    /// `topologyStore().resetSourceCheckpoint(id, incarnation)`.
    pub fn topology_reset_source_checkpoint(&self, id: &str, incarnation: &str) -> Result<()> {
        self.write(|tx| topology_reset_source_checkpoint_in(tx, id, incarnation))
    }
}
