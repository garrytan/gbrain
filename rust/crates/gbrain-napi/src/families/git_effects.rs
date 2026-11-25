//! The managed Git effect runner: its worktree checks, its yield and its plain outcome
//! (`gitEffectStore()`, rust/docs/store/managed-mode.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// One `gitEffectStore()` read: `{ kind, ...args }` (gbrain-store `GitEffectRead`).
    #[napi]
    pub fn git_effect_rows<'env>(&self, env: &'env Env, what: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.git_effect_rows(&required(what, "gitEffectRows input")?)
        })
    }

    /// One `gitEffectStore()` write: `{ kind, ...args }` (gbrain-store `GitEffectWrite`).
    #[napi]
    pub fn git_effect_write<'env>(
        &self,
        env: &'env Env,
        what: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.git_effect_write(&required(what, "gitEffectWrite input")?)
        })
    }
}
