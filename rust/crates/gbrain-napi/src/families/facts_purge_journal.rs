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
use gbrain_store::facts::purge_journal::{
    DeletePageRequestQuery, PageChangeReasonsQuery, PurgeEffectsQuery, SourceSlugArgs,
};

#[napi]
impl Brain {
    /// `listPageChangeReasons(sourceId, slug, pageId)`: resolves `{ reason }` rows.
    #[napi]
    pub fn list_page_change_reasons<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageChangeReasonsQuery = required(args, "listPageChangeReasons args")?;
            s.list_page_change_reasons(&a)
        })
    }

    /// `listRequestsRecordingReasons(sourceId, slug)`: resolves `{ id, principal_kind, principal_id }` rows.
    #[napi]
    pub fn list_requests_recording_reasons<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceSlugArgs = required(args, "listRequestsRecordingReasons args")?;
            s.list_requests_recording_reasons(&a)
        })
    }

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
