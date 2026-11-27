//! Grouped publication: the group claims, completion and the import path check
//! (`groupPublishStore()`, rust/docs/store/managed-mode.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// One `groupPublishStore()` read: `{ kind, ...args }` (gbrain-store `GroupRead`).
    #[napi]
    pub fn group_rows<'env>(&self, env: &'env Env, what: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.group_rows(&required(what, "groupRows input")?)
        })
    }

    /// One `groupPublishStore()` write: `{ kind, ...args }` (gbrain-store `GroupWrite`).
    #[napi]
    pub fn group_write<'env>(&self, env: &'env Env, what: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.group_write(&required(what, "groupWrite input")?)
        })
    }
}
