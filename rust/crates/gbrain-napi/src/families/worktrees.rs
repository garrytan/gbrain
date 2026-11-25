//! Worktree bindings: the rows an unmanaged writer claim records, and the reads of them
//! (rust/docs/store/persistence.md, "Worktree bindings").
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `getWorktreeBinding(sourceId, hostId)`: the binding row, or null.
    #[napi]
    pub fn get_worktree_binding<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        host_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_worktree_binding(&source_id, host_id.as_deref())
        })
    }

    /// `isSourceClaimed(sourceId)`.
    #[napi]
    pub fn is_source_claimed<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.is_source_claimed(&source_id))
    }

    /// The claim's overlap read: host `hostId`'s bindings with their worktree's owner.
    #[napi]
    pub fn list_host_worktrees<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_host_worktrees(&host_id))
    }

    /// One worktree's `{ owner_host_id, state }`, or null.
    #[napi]
    pub fn read_worktree<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_worktree(&id))
    }

    /// One host binding's `{ local_path, coordination_path }`, or null.
    #[napi]
    pub fn read_host_binding<'env>(
        &self,
        env: &'env Env,
        worktree_id: String,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_host_binding(&worktree_id, &host_id))
    }

    /// `readWriterAdminState()`: the writer topology as jsonb text.
    #[napi]
    pub fn writer_admin_state_text<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.writer_admin_state_text())
    }

    /// The id of the worktree a prepared transfer holds, or null.
    #[napi]
    pub fn prepared_transfer_worktree<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.prepared_transfer_worktree())
    }

    /// One worktree's `{ owner_host_id, owner_epoch, state, manifest }`, or null.
    #[napi]
    pub fn read_worktree_owner<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_worktree_owner(&id))
    }

    /// `readWorktreeManifest(id)`: the worktree's manifest, or null.
    #[napi]
    pub fn read_worktree_manifest<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_worktree_manifest(&id))
    }

    /// Records the accepting host's paths for a worktree, keeping its Git durability.
    #[napi]
    pub fn upsert_host_binding<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.upsert_host_binding(&required(input, "upsertHostBinding input")?)
        })
    }

    /// Gives a worktree to `hostId` at the next epoch, `active`.
    #[napi]
    pub fn accept_worktree_owner<'env>(
        &self,
        env: &'env Env,
        id: String,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.accept_worktree_owner(&id, &host_id))
    }

    /// The content receipt rows a transfer accept or a set-path rebind may move.
    #[napi]
    pub fn content_receipt_rows<'env>(
        &self,
        env: &'env Env,
        worktree_ids: Vec<String>,
        host_id: String,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.content_receipt_rows(&worktree_ids, &host_id, source_ids.as_deref())
        })
    }

    /// Sets config `key` to `value` only while it holds `expected`; whether it was set.
    #[napi]
    pub fn swap_config_value<'env>(
        &self,
        env: &'env Env,
        key: String,
        value: String,
        expected: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.swap_config_value(&key, &value, &expected))
    }

    /// Whether a publication on the worktree is still running or recovering.
    #[napi]
    pub fn worktree_publication_pending<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.worktree_publication_pending(&id))
    }

    /// Marks a worktree draining with a prepared transfer's manifest.
    #[napi]
    pub fn mark_worktree_draining<'env>(
        &self,
        env: &'env Env,
        id: String,
        manifest: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.mark_worktree_draining(&id, &manifest))
    }

    /// Returns a draining worktree to active and clears its manifest.
    #[napi]
    pub fn reactivate_worktree<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.reactivate_worktree(&id))
    }

    /// `listOrphanBindings({ limit })`: the orphan source bindings by source id.
    #[napi]
    pub fn list_orphan_bindings<'env>(
        &self,
        env: &'env Env,
        limit: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_orphan_bindings(limit.filter(|n| *n >= 1.0).map(|n| n.floor() as usize))
        })
    }

    /// `deleteOrphanBinding({ source_id, source_incarnation })`: whether it deleted the binding.
    #[napi]
    pub fn delete_orphan_binding<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_orphan_binding(&source_id, &incarnation)
        })
    }

    /// `listHostTopologyRows(hostId)`: each host binding of the host with its worktree's owner,
    /// epoch, state and topology generation.
    #[napi]
    pub fn list_host_topology_rows<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_host_topology_rows(&host_id))
    }

    /// `listPendingGitEffectPaths(hostId)`: the relative paths of the queued and running git effects, with their roots.
    #[napi]
    pub fn list_pending_git_effect_paths<'env>(
        &self,
        env: &'env Env,
        host_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_pending_git_effect_paths(host_id.as_deref())
        })
    }

    /// `listHostRepositoryRoots(hostId)`: the host's bound local paths, each with its source (or null), by byte path.
    #[napi]
    pub fn list_host_repository_roots<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_host_repository_roots(&host_id))
    }

    /// `listWorktreeMembers(worktreeId)`: the worktree's source bindings by byte source id.
    #[napi]
    pub fn list_worktree_members<'env>(
        &self,
        env: &'env Env,
        worktree_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_worktree_members(&worktree_id))
    }

    /// Records a worktree row.
    #[napi]
    pub fn insert_worktree<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_worktree(&required(input, "insertWorktree input")?)
        })
    }

    /// Records a host binding row.
    #[napi]
    pub fn insert_host_binding<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_host_binding(&required(input, "insertHostBinding input")?)
        })
    }

    /// Records a source binding row.
    #[napi]
    pub fn insert_source_binding<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_source_binding(&required(input, "insertSourceBinding input")?)
        })
    }

    /// `stampWorktreeHeartbeats(hostId)`: how many worktrees were stamped.
    #[napi]
    pub fn stamp_worktree_heartbeats<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.stamp_worktree_heartbeats(&host_id))
    }

    /// The host-binding rows of `listManagedRootBindings(hostId)`.
    #[napi]
    pub fn list_host_root_bindings<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_host_root_bindings(&host_id))
    }

    /// A worktree's heartbeat as ISO text, or null.
    #[napi]
    pub fn read_worktree_heartbeat<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_worktree_heartbeat(&id))
    }

    /// `listOrphanBindingRows(limit)`: resolves the orphaned source bindings, by source id.
    #[napi]
    pub fn list_orphan_binding_rows<'env>(
        &self,
        env: &'env Env,
        limit: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_orphan_binding_rows(limit))
    }

    /// `listWorktreeIds()`: resolves every worktree id.
    #[napi]
    pub fn list_worktree_ids<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_worktree_ids())
    }

    /// `listOwnerBindings(hostId)`: resolves the worktrees another host owns, oldest first.
    #[napi]
    pub fn list_owner_bindings<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_owner_bindings(&host_id))
    }
}
