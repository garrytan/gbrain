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
}
