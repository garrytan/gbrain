//! Group 5 facts members, doctor checks: one `#[napi] impl Brain` block over `gbrain_store::facts::doctor`.
//! Group 5 facts reads, doctor checks (src/core/engine-sql/facts-doctor.ts).
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON.
//! `countFactRelinkOutcomes`, a read of the `fact_relink_attempts` table, is in `fact_relink.rs`.
//! `countSegmentedCensusPages`, `listFactsPageBodies` and `readFactTableCatalog` run `facts::doctor_pages`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::doctor::{
    ConversationRowsQuery, CoverageQuery, RedactedQuery, UnlinkedQuery,
};
use gbrain_store::facts::doctor_pages::SegmentedCensusQuery;

#[napi]
impl Brain {
    /// `listConversationFactRows(sourceIds, limit)`: resolves `{ source_id, slug, context }` rows.
    #[napi]
    pub fn list_conversation_fact_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ConversationRowsQuery = required(args, "listConversationFactRows args")?;
            s.list_conversation_fact_rows(&a)
        })
    }

    /// `countRedactedFacts(sourceIds?)`: resolves the count.
    #[napi]
    pub fn count_redacted_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RedactedQuery = required(args, "countRedactedFacts args")?;
            s.count_redacted_facts(&a)
        })
    }

    /// `listOutsideContentFenceCounts()`: resolves the per-page fence row counts.
    #[napi]
    pub fn list_outside_content_fence_counts<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_outside_content_fence_counts())
    }

    /// `countAtomFacts()`: resolves the count.
    #[napi]
    pub fn count_atom_facts<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_atom_facts())
    }

    /// `countUnlinkedFactsByOrigin(opts)`: resolves the per-source, per-origin counts.
    #[napi]
    pub fn count_unlinked_facts_by_origin<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UnlinkedQuery = required(args, "countUnlinkedFactsByOrigin args")?;
            s.count_unlinked_facts_by_origin(&a)
        })
    }

    /// `countUnlinkedFactStats(opts)`: resolves the 7-day counts.
    #[napi]
    pub fn count_unlinked_fact_stats<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UnlinkedQuery = required(args, "countUnlinkedFactStats args")?;
            s.count_unlinked_fact_stats(&a)
        })
    }

    /// `listUnlinkedConversationSlugs(opts)`: resolves `{ slug }` rows.
    #[napi]
    pub fn list_unlinked_conversation_slugs<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UnlinkedQuery = required(args, "listUnlinkedConversationSlugs args")?;
            s.list_unlinked_conversation_slugs(&a)
        })
    }

    /// `countFactEmbeddingCoverage(opts)`: resolves `{ source_id, missing, stale, partial }` rows.
    #[napi]
    pub fn count_fact_embedding_coverage<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: CoverageQuery = required(args, "countFactEmbeddingCoverage args")?;
            s.count_fact_embedding_coverage(&a)
        })
    }

    /// `countSegmentedCensusPages(sourceIds, checkedOutSourceIds)`: resolves `{ n }`.
    #[napi]
    pub fn count_segmented_census_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SegmentedCensusQuery = required(args, "countSegmentedCensusPages args")?;
            s.count_segmented_census_pages(&a)
        })
    }

    /// `readFactTableCatalog()`: resolves `{ facts, attempts }`.
    #[napi]
    pub fn read_fact_table_catalog<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_fact_table_catalog())
    }
}
