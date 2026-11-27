//! Worktree refresh: the refresh rows, the reads its recovery makes and the writes held behind it
//! (`refreshStore()`, rust/docs/store/managed-mode.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// One `refreshStore()` read: `{ kind, ...args }` (gbrain-store `RefreshRead`).
    #[napi]
    pub fn refresh_rows<'env>(&self, env: &'env Env, what: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.refresh_rows(&required(what, "refreshRows input")?)
        })
    }

    /// One `refreshStore()` write: `{ kind, ...args }` (gbrain-store `RefreshWrite`).
    #[napi]
    pub fn refresh_write<'env>(&self, env: &'env Env, what: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.refresh_write(&required(what, "refreshWrite input")?)
        })
    }
}
