//! The topology store: the reads a source lifecycle change makes before its first write
//! (rust/docs/store/persistence.md, "Topology store"). TypeScript side:
//! src/core/rust-engine/store-members/topology-store.ts.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

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
}
