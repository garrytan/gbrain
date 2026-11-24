//! The maintenance sweep's page reads served from the store (`gbrain-store` `cli_reads::sweep_reads`). The TypeScript
//! members are in `src/core/rust-engine/store-members/sweep-reads.ts` (rust/docs/store/sweep-reads.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listFactsFencePages({ sourceId, since, scanCap, limit })`: resolves the slugs of the fenced recent pages.
    #[napi]
    pub fn list_facts_fence_pages<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_facts_fence_pages(&required(input, "listFactsFencePages input")?)
        })
    }

    /// `listSweepStalePages({ sourceId, since, limit, exclude })`: resolves the link-stale recent page rows.
    #[napi]
    pub fn list_sweep_stale_pages<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_sweep_stale_pages(&required(input, "listSweepStalePages input")?)
        })
    }

    /// `listSweepDeferredPages({ sourceId, since, slugs })`: resolves the deferred pages that are still stale.
    #[napi]
    pub fn list_sweep_deferred_pages<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_sweep_deferred_pages(&required(input, "listSweepDeferredPages input")?)
        })
    }

    /// `listPageRefsForSlugs({ slugs })`: resolves the live pages of any source with those slugs.
    #[napi]
    pub fn list_page_refs_for_slugs<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_refs_for_slugs(&required(input, "listPageRefsForSlugs input")?)
        })
    }
}
