//! Managed link edits: add_link and remove_link on a managed page and the links fence projection
//! (`manualLinkStore()`, rust/docs/store/managed-mode.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// One `manualLinkStore()` read: `{ kind, ...args }` (gbrain-store `ManualLinkRead`).
    #[napi]
    pub fn manual_link_rows<'env>(
        &self,
        env: &'env Env,
        what: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.manual_link_rows(&required(what, "manualLinkRows input")?)
        })
    }

    /// One `manualLinkStore()` write: `{ kind, ...args }` (gbrain-store `ManualLinkWrite`).
    #[napi]
    pub fn manual_link_write<'env>(
        &self,
        env: &'env Env,
        what: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.manual_link_write(&required(what, "manualLinkWrite input")?)
        })
    }
}
