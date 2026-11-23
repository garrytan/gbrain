//! A fact purge's plan, dry run and `--match` reads.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::purge_plan` call on the
//! pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/purge-plan.ts) answer what the store keeps no rows of.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::purge_plan::{
    ClaimNeedleArgs, HoldingStagingsArgs, LivePageArgs, NeighbourArgs, PageIdsArgs, PurgeMatchArgs,
    PurgeProbeArgs, PurgeSourceArgs, ReviewCountArgs, SegmentedBodiesArgs, SourcePageIdsArgs,
    StagingNeedleArgs,
};

#[napi]
impl Brain {
    /// `hasLivePageSlug(args)`: resolves whether the source has a live page at the slug.
    #[napi]
    pub fn has_live_page_slug<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LivePageArgs = required(args, "hasLivePageSlug args")?;
            s.has_live_page_slug(&a)
        })
    }

    /// `readPurgeTakePages(args)`: resolves the pages with their revisions.
    #[napi]
    pub fn read_purge_take_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourcePageIdsArgs = required(args, "readPurgeTakePages args")?;
            s.read_purge_take_pages(&a)
        })
    }

    /// `countPurgeCarryingVersions(args)`: resolves the number of carrying versions.
    #[napi]
    pub fn count_purge_carrying_versions<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClaimNeedleArgs = required(args, "countPurgeCarryingVersions args")?;
            s.count_purge_carrying_versions(&a)
        })
    }

    /// `listStagingsHoldingClaim(args)`: resolves the staging ids.
    #[napi]
    pub fn list_stagings_holding_claim<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: StagingNeedleArgs = required(args, "listStagingsHoldingClaim args")?;
            s.list_stagings_holding_claim(&a)
        })
    }

    /// `countPurgeReviewRows(args)`: resolves `{ q, rp, dp }`.
    #[napi]
    pub fn count_purge_review_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ReviewCountArgs = required(args, "countPurgeReviewRows args")?;
            s.count_purge_review_rows(&a)
        })
    }

    /// `matchPurgeCandidates(args)`: resolves up to 25 fact rows.
    #[napi]
    pub fn match_purge_candidates<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeMatchArgs = required(args, "matchPurgeCandidates args")?;
            s.match_purge_candidates(&a)
        })
    }

    /// `listRequestsCarryingClaim(args)`: resolves the request targets.
    #[napi]
    pub fn list_requests_carrying_claim<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClaimNeedleArgs = required(args, "listRequestsCarryingClaim args")?;
            s.list_requests_carrying_claim(&a)
        })
    }

    /// `listRequestsHoldingStagings(args)`: resolves the request targets.
    #[napi]
    pub fn list_requests_holding_stagings<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HoldingStagingsArgs = required(args, "listRequestsHoldingStagings args")?;
            s.list_requests_holding_stagings(&a)
        })
    }

    /// `listSegmentedPurgeBodies(args)`: resolves the segmented bodies.
    #[napi]
    pub fn list_segmented_purge_bodies<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SegmentedBodiesArgs = required(args, "listSegmentedPurgeBodies args")?;
            s.list_segmented_purge_bodies(&a)
        })
    }

    /// `countLegacyDerivedPages(args)`: resolves the number of legacy derived pages.
    #[napi]
    pub fn count_legacy_derived_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeSourceArgs = required(args, "countLegacyDerivedPages args")?;
            s.count_legacy_derived_pages(&a)
        })
    }

    /// `listPageSourcePaths(args)`: resolves the relative source paths.
    #[napi]
    pub fn list_page_source_paths<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageIdsArgs = required(args, "listPageSourcePaths args")?;
            s.list_page_source_paths(&a)
        })
    }

    /// `listFactNeighbours(args)`: resolves the five nearest facts.
    #[napi]
    pub fn list_fact_neighbours<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: NeighbourArgs = required(args, "listFactNeighbours args")?;
            s.list_fact_neighbours(&a)
        })
    }

    /// `countPurgeProbe(args)`: resolves the bounded row count.
    #[napi]
    pub fn count_purge_probe<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeProbeArgs = required(args, "countPurgeProbe args")?;
            s.count_purge_probe(&a)
        })
    }

    /// `listPurgeProbeItems(args)`: resolves the first 20 items, or null.
    #[napi]
    pub fn list_purge_probe_items<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeProbeArgs = required(args, "listPurgeProbeItems args")?;
            s.list_purge_probe_items(&a)
        })
    }
}
