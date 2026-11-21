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
    DeletePageRequestQuery, EffectDataUpdate, GitEffectsReasonQuery, PageChangeReasonsQuery,
    PurgeEffectsQuery, ReasonTombstonesInsert, SourceSlugArgs,
};

#[napi]
impl Brain {
    /// `insertReasonPurgeTombstones(sourceId, commits, paths)`: resolves the number of pairs added.
    #[napi]
    pub fn insert_reason_purge_tombstones<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ReasonTombstonesInsert = required(args, "insertReasonPurgeTombstones args")?;
            s.insert_reason_purge_tombstones(&a)
        })
    }

    /// `listGitEffectsCarryingReason(sourceId, needle, escaped, foldedJson)`: resolves `{ id, state, request_id, data }` rows.
    #[napi]
    pub fn list_git_effects_carrying_reason<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: GitEffectsReasonQuery = required(args, "listGitEffectsCarryingReason args")?;
            s.list_git_effects_carrying_reason(&a)
        })
    }

    /// `listPageGitEffectsForStrip(sourceId, slug)`: resolves `{ id, state, request_id, data }` rows.
    #[napi]
    pub fn list_page_git_effects_for_strip<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceSlugArgs = required(args, "listPageGitEffectsForStrip args")?;
            s.list_page_git_effects_for_strip(&a)
        })
    }

    /// `setPurgeEffectData(effectId, data)`: resolves null.
    #[napi]
    pub fn set_purge_effect_data<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: EffectDataUpdate = required(args, "setPurgeEffectData args")?;
            s.set_purge_effect_data(&a)
        })
    }

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

    /// `countPagePurgeTombstones(sourceId, slug)`: resolves the count.
    #[napi]
    pub fn count_page_purge_tombstones<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceSlugArgs = required(args, "countPagePurgeTombstones args")?;
            s.count_page_purge_tombstones(&a)
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
