//! Writer activation, deactivation and the pre-activation claim release: the brain mode, the
//! release of worktree bindings, the counter charges of a topology receipt and the reads of
//! `writerReleaseStore()` (rust/docs/store/persistence.md, "Writer release").
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// One `writerReleaseStore()` read: `{ kind, ...args }` (gbrain-store `ReleaseRead`).
    #[napi]
    pub fn writer_release_rows<'env>(
        &self,
        env: &'env Env,
        what: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.writer_release_rows(&required(what, "writerReleaseRows input")?)
        })
    }

    /// Turns managed persistence on or off; the new mode epoch as text.
    #[napi]
    pub fn set_brain_enabled<'env>(
        &self,
        env: &'env Env,
        enabled: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_brain_enabled(enabled))
    }

    /// Retires the named worktrees (every worktree with null) and deletes their bindings.
    #[napi]
    pub fn release_worktree_bindings<'env>(
        &self,
        env: &'env Env,
        worktree_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.release_worktree_bindings(worktree_ids.as_deref())
        })
    }

    /// Adds `delta` (`{ lifetime_ids?, terminal_bytes?, ... }`) to the counter row `key`.
    #[napi]
    pub fn add_persistence_counters<'env>(
        &self,
        env: &'env Env,
        key: String,
        delta: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.add_persistence_counters(&key, &required(delta, "addPersistenceCounters delta")?)
        })
    }
}
