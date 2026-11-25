//! The `gbrain schema detect` page-shape reads: `pageTypeTotals`, `pagePrefixSamples` and
//! `countPagesByTypeForSource`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::schema_detect` call on the pool through
//! `Brain::run` and resolves plain JSON (src/core/rust-engine/store-members/schema-detect.ts).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::schema_detect::{
    PagePrefixSamplesArgs, PageTypeCountsArgs, PageTypeTotalsArgs, PathPrefixArgs,
    UntypedPathPrefixArgs,
};

#[napi]
impl Brain {
    /// `pageTypeTotals({ sourceId })`: resolves `{ total, typed, untyped }`.
    #[napi]
    pub fn page_type_totals<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageTypeTotalsArgs = required(args, "pageTypeTotals args")?;
            s.page_type_totals(&a)
        })
    }

    /// `pagePrefixSamples({ sourceId, minPages, limit })`: resolves `[{ prefix, cnt, sample_types }]`.
    #[napi]
    pub fn page_prefix_samples<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PagePrefixSamplesArgs = required(args, "pagePrefixSamples args")?;
            s.page_prefix_samples(&a)
        })
    }

    /// `countPagesByTypeForSource({ sourceId, limit })`: resolves `[{ type, cnt }]`.
    #[napi]
    pub fn count_pages_by_type_for_source<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageTypeCountsArgs = required(args, "countPagesByTypeForSource args")?;
            s.count_pages_by_type_for_source(&a)
        })
    }

    /// `countLivePagesAtPathPrefix({ prefix })`: resolves the count of live pages under the path prefix.
    #[napi]
    pub fn count_live_pages_at_path_prefix<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PathPrefixArgs = required(args, "countLivePagesAtPathPrefix args")?;
            s.count_live_pages_at_path_prefix(&a)
        })
    }

    /// `probeUntypedPathPrefix({ prefix, sourceId })`: resolves `{ count, sample }`.
    #[napi]
    pub fn probe_untyped_path_prefix<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UntypedPathPrefixArgs = required(args, "probeUntypedPathPrefix args")?;
            s.probe_untyped_path_prefix(&a)
        })
    }
}
