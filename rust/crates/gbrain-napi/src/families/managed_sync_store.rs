//! The managed sync's named statements (`runSyncStatement`, rust/docs/store/managed-mode.md, "Managed sync").
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// One read statement of the managed sync, named, with its positional parameters (gbrain-store `sync_store_rows`).
    #[napi]
    pub fn sync_store_rows<'env>(&self, env: &'env Env, name: String, params: Vec<Value>) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.sync_store_rows(&name, &params))
    }

    /// One write statement of the managed sync, named, with its positional parameters (gbrain-store `sync_store_write`).
    #[napi]
    pub fn sync_store_write<'env>(&self, env: &'env Env, name: String, params: Vec<Value>) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.sync_store_write(&name, &params))
    }
}
