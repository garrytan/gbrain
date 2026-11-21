//! The topology store: the reads a source lifecycle change makes before its first write, and
//! the writes of a managed clone's transaction and commit (rust/docs/store/persistence.md,
//! "Topology store"). TypeScript side:
//! src/core/rust-engine/store-members/topology-store.ts.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// The source's `{ incarnation, config, last_commit, local_path }`, or null.
    #[napi]
    pub fn topology_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.topology_source(&source_id))
    }

    /// The source's `{ id, incarnation, archived, local_path, config, name, last_commit }`, or null.
    #[napi]
    pub fn topology_lifecycle_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.topology_lifecycle_source(&source_id))
    }

    /// Host `hostId`'s worktrees with owner, epoch, state, generation and paths.
    #[napi]
    pub fn topology_host_worktrees<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.topology_host_worktrees(&host_id))
    }

    /// The source ids bound to the worktrees, in order.
    #[napi]
    pub fn topology_members<'env>(
        &self,
        env: &'env Env,
        worktree_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.topology_members(&worktree_ids))
    }

    /// The worktree rows `{ id, owner_host_id, state, owner_epoch, topology_generation }`, by id.
    #[napi]
    pub fn topology_owners<'env>(
        &self,
        env: &'env Env,
        worktree_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.topology_owners(&worktree_ids))
    }

    /// The worktree's canonical stamp (md5 text).
    #[napi]
    pub fn topology_canonical_stamp<'env>(
        &self,
        env: &'env Env,
        worktree_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.topology_canonical_stamp(&worktree_id))
    }

    /// The unsettled request rows of the sources or worktrees, by sequence.
    #[napi]
    pub fn topology_unsettled_requests<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        worktree_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.topology_unsettled_requests(&source_ids, &worktree_ids)
        })
    }

    /// One blocking effect `{ id, source_id }` of the sources or worktrees, or null.
    #[napi]
    pub fn topology_blocking_effect<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        worktree_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.topology_blocking_effect(&source_ids, &worktree_ids)
        })
    }

    /// One worktree update `{ kind: 'recover' | 'recover_with_manifest' | 'manifest' |
    /// 'activate', manifest? }`. A missing worktree changes nothing.
    #[napi]
    pub fn topology_update_worktree<'env>(
        &self,
        env: &'env Env,
        worktree_id: String,
        update: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.topology_update_worktree(&worktree_id, &required(update, "worktree update")?)
        })
    }

    /// Each worktree's generation goes up by one; its source bindings take the new generation.
    #[napi]
    pub fn topology_advance_generation<'env>(
        &self,
        env: &'env Env,
        worktree_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.topology_advance_generation(&worktree_ids))
    }

    /// Deletes the source's binding when it is of that incarnation.
    #[napi]
    pub fn topology_unbind_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.topology_unbind_source(&source_id, &incarnation)
        })
    }

    /// The clone's source `{ id, name, localPath, config, incarnation }`.
    #[napi]
    pub fn topology_insert_source<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.topology_insert_source(&required(input, "insertCloneSource input")?)
        })
    }

    /// No last commit and no last sync time for the source of that incarnation.
    #[napi]
    pub fn topology_reset_source_checkpoint<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.topology_reset_source_checkpoint(&source_id, &incarnation)
        })
    }

    /// The topology change with this id, or null.
    #[napi]
    pub fn topology_change<'env>(
        &self,
        env: &'env Env,
        change_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.topology_change(&change_id))
    }

    /// One change update `{ kind: 'save_recovery' | 'commit' | 'release' | 'clear_recovery' |
    /// 'settle_retire', ... }`: the updated row, or null when its guard does not hold.
    #[napi]
    pub fn topology_update_change<'env>(
        &self,
        env: &'env Env,
        change_id: String,
        update: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.update_topology_change(&change_id, &required(update, "topology change update")?)
        })
    }

    /// The other recovering remove and purge changes of the source incarnation, by id.
    #[napi]
    pub fn topology_retire_admissions<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
        principal_id: String,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.topology_retire_admissions(&source_id, &incarnation, &principal_id, &request_id)
        })
    }
}
