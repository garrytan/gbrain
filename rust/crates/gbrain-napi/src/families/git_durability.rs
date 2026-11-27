//! Managed Git durability: the skipped-effect catch-up and the host binding's setting
//! (`gitDurabilityStore()`, rust/docs/store/managed-mode.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// One `gitDurabilityStore()` read: `{ kind, ...args }` (gbrain-store `GitDurabilityRead`).
    #[napi]
    pub fn git_durability_rows<'env>(
        &self,
        env: &'env Env,
        what: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.git_durability_rows(&required(what, "gitDurabilityRows input")?)
        })
    }

    /// One `gitDurabilityStore()` write: `{ kind, ...args }` (gbrain-store `GitDurabilityWrite`).
    #[napi]
    pub fn git_durability_write<'env>(
        &self,
        env: &'env Env,
        what: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.git_durability_write(&required(what, "gitDurabilityWrite input")?)
        })
    }
}
