//! Doctor-derived reads: the typed members that replace the raw SQL of the second set of doctor
//! checks (store side: `gbrain_store::cli_reads::doctor_derived`, docs in
//! `rust/docs/store/cli-reads-doctor-derived.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `countSafeIndexPending(sourceIds?)`: `{ rebuildable, kept }`.
    #[napi]
    pub fn count_safe_index_pending<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_safe_index_pending(source_ids.as_deref())
        })
    }

    /// `countPagesByTypeAndOwner(sourceIds?)`: `{ src, type, own, n }` rows.
    #[napi]
    pub fn count_pages_by_type_and_owner<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_pages_by_type_and_owner(source_ids.as_deref())
        })
    }

    /// `listImageAssetFiles()`: image file rows with their source root and page source path.
    #[napi]
    pub fn list_image_asset_files<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_image_asset_files())
    }

    /// `listRestorableAtomRetirements(sourceIds)`: one row per source.
    #[napi]
    pub fn list_restorable_atom_retirements<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_restorable_atom_retirements(&source_ids)
        })
    }

    /// `listTimelineHistoryBatch(sourceIds, afterId)`: the next 200 pages carrying own timeline rows.
    #[napi]
    pub fn list_timeline_history_batch<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        after_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_timeline_history_batch(&source_ids, after_id)
        })
    }

    /// `readPageCompiledTruths(ids)`: `{ id, body }` rows.
    #[napi]
    pub fn read_page_compiled_truths<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_compiled_truths(&ids))
    }
}
