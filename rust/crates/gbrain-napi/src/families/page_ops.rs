//! Page operations: the marker and date reads hybrid search needs, over `gbrain_store::page_ops`
//! (rust/docs/store/page_ops.md).
//!
//! One `#[napi] impl Brain` block; each method decodes its arguments, runs one `Store` call on the
//! pool through `Brain::run` and resolves plain JSON. Maps, sets and dates are built by the
//! TypeScript members (`store-members/page-ops.ts`).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `getContentFlagsByPageIds(ids, { sourceId?, sourceIds?, live? }?)`: `[{ id, reason, detail }]`.
    #[napi]
    pub fn get_content_flags_by_page_ids<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_content_flags_by_page_ids(&ids, &arg(scope, "getContentFlagsByPageIds scope")?)
        })
    }

    /// `getUnverifiedExtractionPageIds(ids, { sourceId?, sourceIds?, live? }?)`: `[{ id, status,
    /// unverified }]`.
    #[napi]
    pub fn get_unverified_extraction_page_ids<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_unverified_extraction_page_ids(
                &ids,
                &arg(scope, "getUnverifiedExtractionPageIds scope")?,
            )
        })
    }

    /// `getEffectiveDates(refs, { sourceId?, sourceIds?, live? }?)`: `[{ slug, source_id, ts }]`.
    #[napi]
    pub fn get_effective_dates<'env>(
        &self,
        env: &'env Env,
        refs: Value,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_effective_dates(
                &required::<Vec<_>>(refs, "getEffectiveDates refs")?,
                &arg(scope, "getEffectiveDates scope")?,
            )
        })
    }
}
