//! Managed source topology: the lifecycle reads, writes and receipts under topology locks
//! (`topologyStore()`, rust/docs/store/managed-mode.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// One `topologyStore()` read: `{ kind, ...args }` (gbrain-store `TopologyRead`).
    #[napi]
    pub fn topology_rows<'env>(&self, env: &'env Env, what: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.topology_rows(&required(what, "topologyRows input")?)
        })
    }

    /// One `topologyStore()` write: `{ kind, ...args }` (gbrain-store `TopologyWrite`).
    #[napi]
    pub fn topology_write<'env>(&self, env: &'env Env, what: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.topology_write(&required(what, "topologyWrite input")?)
        })
    }
}
