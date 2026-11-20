//! Repair scans that order by byte (rust/docs/store/repair_reads.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `Store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};
use serde_json::Value;

#[napi]
impl Brain {
    /// `countOrphanedAliasRows()`: resolves `{ source_id, slug_redirects, page_aliases }` per source.
    #[napi]
    pub fn count_orphaned_alias_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_orphaned_alias_rows())
    }

    /// `listOrphanedAliasTargets(sourceIds)`: resolves the orphaned alias counts per source and slug.
    #[napi]
    pub fn list_orphaned_alias_targets<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(source_ids, "listOrphanedAliasTargets sourceIds")?;
            s.list_orphaned_alias_targets(&ids)
        })
    }

    /// `countSoftDeletedAliasTargets(sourceIds)`: resolves how many alias rows name a soft-deleted page.
    #[napi]
    pub fn count_soft_deleted_alias_targets<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(source_ids, "countSoftDeletedAliasTargets sourceIds")?;
            s.count_soft_deleted_alias_targets(&ids)
        })
    }

    /// `listDuplicateFactRows(sourceIds, auditSources)`: resolves the active facts that share a fingerprint.
    #[napi]
    pub fn list_duplicate_fact_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
        audit_sources: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(source_ids, "listDuplicateFactRows sourceIds")?;
            let audit: Vec<String> = required(audit_sources, "listDuplicateFactRows auditSources")?;
            s.list_duplicate_fact_rows(&ids, &audit)
        })
    }

    /// `listPagelessEntityFacts(sourceIds)`: resolves the page-less entity slugs with their fact ids.
    #[napi]
    pub fn list_pageless_entity_facts<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(source_ids, "listPagelessEntityFacts sourceIds")?;
            s.list_pageless_entity_facts(&ids)
        })
    }

    /// `listSourceIncarnations(sourceIds)`: resolves the id and incarnation of each named source.
    #[napi]
    pub fn list_source_incarnations<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(source_ids, "listSourceIncarnations sourceIds")?;
            s.list_source_incarnations(&ids)
        })
    }

    /// `listClosedConsolidationTies(sourceIds)`: resolves the facts closed at their own instant, with their partners.
    #[napi]
    pub fn list_closed_consolidation_ties<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(source_ids, "listClosedConsolidationTies sourceIds")?;
            s.list_closed_consolidation_ties(&ids)
        })
    }
}
