//! The facts write-path, repair and fence-cycle reads and the fence adoption write: `listLivePageTitles`,
//! `listPageAliasNames`, `listCaptureDuplicateCandidates`, `computeFactFingerprints`, `listOversizedStaleFacts`,
//! `listLivePersonTitles`, `listFenceRowClaims`, `adoptFactIntoFence`, `readSourceCheckoutPath`, `listPageStates` and
//! `countSegmentedVersionsOfPage`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::write_path` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members are src/core/rust-engine/store-members/facts-write-path.ts.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::write_path::{
    AdoptFactArgs, CaptureDuplicateArgs, OversizedStaleArgs, PageSlugArgs, SourceSlugsArgs,
};

#[napi]
impl Brain {
    /// `listLivePageTitles(args)`: resolves `[{ slug, title }]`.
    #[napi]
    pub fn list_live_page_titles<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceSlugsArgs = required(args, "listLivePageTitles args")?;
            s.list_live_page_titles(&a)
        })
    }

    /// `listPageAliasNames(args)`: resolves `[{ slug, alias_norm }]`.
    #[napi]
    pub fn list_page_alias_names<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceSlugsArgs = required(args, "listPageAliasNames args")?;
            s.list_page_alias_names(&a)
        })
    }

    /// `listCaptureDuplicateCandidates(args)`: resolves the candidate rows, newest first.
    #[napi]
    pub fn list_capture_duplicate_candidates<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: CaptureDuplicateArgs = required(args, "listCaptureDuplicateCandidates args")?;
            s.list_capture_duplicate_candidates(&a)
        })
    }

    /// `listOversizedStaleFacts(args)`: resolves `[{ id, source_id, slug, fact }]`, by id.
    #[napi]
    pub fn list_oversized_stale_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: OversizedStaleArgs = required(args, "listOversizedStaleFacts args")?;
            s.list_oversized_stale_facts(&a)
        })
    }

    /// `listLivePersonTitles(args)`: resolves `[{ slug, title }]`.
    #[napi]
    pub fn list_live_person_titles<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceSlugsArgs = required(args, "listLivePersonTitles args")?;
            s.list_live_person_titles(&a)
        })
    }

    /// `listFenceRowClaims(args)`: resolves `[{ row_num, fact, source }]`.
    #[napi]
    pub fn list_fence_row_claims<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageSlugArgs = required(args, "listFenceRowClaims args")?;
            s.list_fence_row_claims(&a)
        })
    }

    /// `adoptFactIntoFence(args)`: resolves null.
    #[napi]
    pub fn adopt_fact_into_fence<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: AdoptFactArgs = required(args, "adoptFactIntoFence args")?;
            s.adopt_fact_into_fence(&a)
        })
    }

    /// `listPageStates(args)`: resolves the page row, then its newest versions.
    #[napi]
    pub fn list_page_states<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageSlugArgs = required(args, "listPageStates args")?;
            s.list_page_states(&a)
        })
    }

    /// `countSegmentedVersionsOfPage(args)`: resolves the count.
    #[napi]
    pub fn count_segmented_versions_of_page<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageSlugArgs = required(args, "countSegmentedVersionsOfPage args")?;
            s.count_segmented_versions_of_page(&a)
        })
    }

    /// `computeFactFingerprints(texts)`: resolves the fingerprints, in order.
    #[napi]
    pub fn compute_fact_fingerprints<'env>(
        &self,
        env: &'env Env,
        texts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.compute_fact_fingerprints(&required::<Vec<String>>(
                texts,
                "computeFactFingerprints texts",
            )?)
        })
    }

    /// `readSourceCheckoutPath(sourceId)`: resolves the checkout path or null.
    #[napi]
    pub fn read_source_checkout_path<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_checkout_path(&source_id))
    }
}
