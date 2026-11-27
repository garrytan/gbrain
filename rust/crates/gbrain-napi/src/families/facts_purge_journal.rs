//! Group 5 facts members, the purge statements over the write journal and the change-reason
//! tombstones: one `#[napi] impl Brain` block over `gbrain_store::facts::purge_journal`
//! (src/core/engine-sql/facts-purge.ts).
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::purge_journal::{DeletePageRequestQuery, PurgeEffectsQuery};

#[napi]
impl Brain {
    /// `readDeletePageRequest(sourceId, requestId)`: resolves `{ id, request_id, state, source_id, outcome }` or null.
    #[napi]
    pub fn read_delete_page_request<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DeletePageRequestQuery = required(args, "readDeletePageRequest args")?;
            s.read_delete_page_request(&a)
        })
    }

    /// `listPurgeEffects(requestId)`: resolves `{ kind, state, error_code, parked }` rows.
    #[napi]
    pub fn list_purge_effects<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeEffectsQuery = required(args, "listPurgeEffects args")?;
            s.list_purge_effects(&a)
        })
    }
}
