//! The managed sync's named statements (`runSyncStatement`, rust/docs/store/managed-mode.md, "Managed sync").
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// One read statement of the managed sync, named, with its positional parameters (gbrain-store `sync_store_rows`).
    #[napi]
    pub fn sync_store_rows<'env>(
        &self,
        env: &'env Env,
        name: String,
        params: Vec<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.sync_store_rows(&name, &params))
    }

    /// One write statement of the managed sync, named, with its positional parameters (gbrain-store
    /// `sync_store_write_fenced`). `fence` is the caller's host registration (a multi-user brain's lease token): the cursor
    /// statements that take, check or end a sync checkpoint claim run under it; null or absent, the statement runs as it
    /// always did.
    #[napi]
    pub fn sync_store_write<'env>(
        &self,
        env: &'env Env,
        name: String,
        params: Vec<Value>,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<gbrain_store::leases::LeaseToken> = match fence {
                None | Some(Value::Null) => None,
                Some(value) => Some(required(value, "syncStoreWrite fence")?),
            };
            s.sync_store_write_fenced(&name, &params, fence.as_ref())
        })
    }
}
