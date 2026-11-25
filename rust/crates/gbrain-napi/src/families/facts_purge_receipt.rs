//! Group 5 facts members, the plain reads of a purge's scan and receipt: one `#[napi] impl Brain`
//! block over `gbrain_store::facts::purge_receipt` (src/core/engine-sql/facts-purge.ts).
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON.
//! `readPurgeSourceLocalPath` and `readPurgeReceiptSourcePath` run `readSourceLocalPath`
//! (memory_mutation_reads.rs).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::purge_receipt::{
    FactContextsQuery, NearestPurgeQuery, PageSourcePathsQuery, ProseHitsQuery, ResidueQuery,
    SegmentedBodiesQuery,
};

#[napi]
impl Brain {
    /// `listSegmentedPageBodies(sourceId, limit)`: resolves `{ page_id, slug, generation, version_id }` rows.
    #[napi]
    pub fn list_segmented_page_bodies<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SegmentedBodiesQuery = required(args, "listSegmentedPageBodies args")?;
            s.list_segmented_page_bodies(&a)
        })
    }

    /// `listSegmentedVersionBodies(sourceId, limit)`: resolves `{ page_id, slug, generation, version_id }` rows.
    #[napi]
    pub fn list_segmented_version_bodies<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SegmentedBodiesQuery = required(args, "listSegmentedVersionBodies args")?;
            s.list_segmented_version_bodies(&a)
        })
    }

    /// `listFactContextsForPurgeProbe(sourceId, after)`: resolves `{ id, context }` rows.
    #[napi]
    pub fn list_fact_contexts_for_purge_probe<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactContextsQuery = required(args, "listFactContextsForPurgeProbe args")?;
            s.list_fact_contexts_for_purge_probe(&a)
        })
    }

    /// `listNearestFactsForPurge({ embedding, sourceId, model, fact })`: resolves the five nearest
    /// `{ id, similarity, contains_claim }` rows (`similarity` is the text `NaN` for a NaN).
    #[napi]
    pub fn list_nearest_facts_for_purge<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: NearestPurgeQuery = required(args, "listNearestFactsForPurge args")?;
            s.list_nearest_facts_for_purge(&a)
        })
    }

    /// `listPageSourcePathsForPurge(pageIds)`: resolves `{ source_path }` rows.
    #[napi]
    pub fn list_page_source_paths_for_purge<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageSourcePathsQuery = required(args, "listPageSourcePathsForPurge args")?;
            s.list_page_source_paths_for_purge(&a)
        })
    }

    /// `vacuumPurgedTables(withQueryCache)`: resolves null once the store is open.
    #[napi]
    pub fn vacuum_purged_tables<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.vacuum_purged_tables())
    }

    /// `listPageProseHits(store, sourceId, loweredNeedles)`: resolves `{ slug }` rows.
    #[napi]
    pub fn list_page_prose_hits<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ProseHitsQuery = required(args, "listPageProseHits args")?;
            s.list_page_prose_hits(&a)
        })
    }

    /// `countPurgeFingerprintResidue(sourceId, factHash, subject)`: resolves `{ facts, takes }`.
    #[napi]
    pub fn count_purge_fingerprint_residue<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ResidueQuery = required(args, "countPurgeFingerprintResidue args")?;
            s.count_purge_fingerprint_residue(&a)
        })
    }
}
