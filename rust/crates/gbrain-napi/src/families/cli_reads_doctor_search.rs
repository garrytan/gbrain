//! Doctor search-and-knowledge reads: the typed members that replace the raw SQL of the `gbrain doctor` checks
//! dangling_aliases, type_proliferation, person_title_duplicates, markdown_body_completeness,
//! link_resolution_opportunity, hidden_by_search_policy, image_embedding_coverage, text_projection_readiness and
//! extract_atoms_backlog (store side: `gbrain_store::cli_reads::doctor_search`, docs in
//! `rust/docs/store/cli-reads-doctor-search.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `listOrphanedAliasCounts`.
    #[napi]
    pub fn list_orphaned_alias_counts<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_orphaned_alias_counts())
    }

    /// `readSoftDeletedAliasCounts`.
    #[napi]
    pub fn read_soft_deleted_alias_counts<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_soft_deleted_alias_counts())
    }

    /// `listPageTypePairs`.
    #[napi]
    pub fn list_page_type_pairs<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_type_pairs())
    }

    /// `listTruncatedMarkdownBodies`.
    #[napi]
    pub fn list_truncated_markdown_bodies<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_truncated_markdown_bodies())
    }

    /// `countSegmentedMarkdownBodies`.
    #[napi]
    pub fn count_segmented_markdown_bodies<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_segmented_markdown_bodies())
    }

    /// `listRecentPageBodies`.
    #[napi]
    pub fn list_recent_page_bodies<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_recent_page_bodies(source_ids))
    }

    /// `countSegmentedRecentPages`.
    #[napi]
    pub fn count_segmented_recent_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_segmented_recent_pages(source_ids))
    }

    /// `countPagesHiddenByPrefix`.
    #[napi]
    pub fn count_pages_hidden_by_prefix<'env>(
        &self,
        env: &'env Env,
        pattern: String,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_pages_hidden_by_prefix(pattern, source_ids)
        })
    }

    /// `listGitImageHoldCounts`.
    #[napi]
    pub fn list_git_image_hold_counts<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_git_image_hold_counts(source_ids))
    }

    /// `countAtomExtractionBacklog`: the pages awaiting atom extraction.
    #[napi]
    pub fn count_atom_extraction_backlog<'env>(
        &self,
        env: &'env Env,
        query: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: gbrain_store::link_queries::AtomBacklogQuery =
                arg(query, "countAtomExtractionBacklog query")?;
            s.count_atom_extraction_backlog(&query)
        })
    }

    /// `readProjectionBacklog`: a coverage scope: the projection queue by class.
    #[napi]
    pub fn read_projection_backlog<'env>(
        &self,
        env: &'env Env,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::link_queries::CoverageScope =
                arg(scope, "readProjectionBacklog scope")?;
            s.read_projection_backlog(&scope)
        })
    }
}
