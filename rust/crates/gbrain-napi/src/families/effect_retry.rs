//! Effect retry reads: the request and effect rows a parked-effect retry reads (store side:
//! `gbrain_store::persistence::effect_retry_reads`, docs in `rust/docs/store/persistence.md`,
//! "Effect retry reads").
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readSourceRequestById(sourceId, id)`: the request row, or `null`.
    #[napi]
    pub fn read_source_request_by_id<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_request_by_id(&source_id, &id))
    }

    /// `listSourceRequestsByRequestId(sourceId, requestId)`: at most two request rows.
    #[napi]
    pub fn list_source_requests_by_request_id<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_source_requests_by_request_id(&source_id, &request_id)
        })
    }

    /// `listRetryTrackedEffects(requestRowId, parkedOnly, failedCodes)`: the tracked effect rows.
    #[napi]
    pub fn list_retry_tracked_effects<'env>(
        &self,
        env: &'env Env,
        request_row_id: String,
        parked_only: bool,
        failed_codes: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_retry_tracked_effects(&request_row_id, parked_only, &failed_codes)
        })
    }

    /// `lockEffectRow(id)`: the effect row, or `null`.
    #[napi]
    pub fn lock_effect_row<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.lock_effect_row(&id))
    }
}
