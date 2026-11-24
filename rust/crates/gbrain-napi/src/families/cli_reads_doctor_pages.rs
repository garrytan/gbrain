//! Doctor page reads: the typed members that replace the page-table raw SQL of `gbrain doctor` checks
//! (store side: `gbrain_store::cli_reads::doctor_pages`, docs in `rust/docs/store/cli-reads-doctor-pages.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listOversizedPages`.
    #[napi]
    pub fn list_oversized_pages<'env>(
        &self,
        env: &'env Env,
        min_bytes: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_oversized_pages(min_bytes))
    }

    /// `listScraperJunkCandidates`.
    #[napi]
    pub fn list_scraper_junk_candidates<'env>(
        &self,
        env: &'env Env,
        limit: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_scraper_junk_candidates(limit))
    }

    /// `countMarkedPages`.
    #[napi]
    pub fn count_marked_pages<'env>(
        &self,
        env: &'env Env,
        marker: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_marked_pages(&marker))
    }

    /// `countOversizedCorePages`.
    #[napi]
    pub fn count_oversized_core_pages<'env>(
        &self,
        env: &'env Env,
        max_bytes: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_oversized_core_pages(max_bytes))
    }

    /// `readRawProvenanceGaps`.
    #[napi]
    pub fn read_raw_provenance_gaps<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_raw_provenance_gaps())
    }

    /// `countUnverifiedExtractions`.
    #[napi]
    pub fn count_unverified_extractions<'env>(
        &self,
        env: &'env Env,
        days: f64,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_unverified_extractions(days, source_id.as_deref())
        })
    }

    /// `listContentHashDuplicates`.
    #[napi]
    pub fn list_content_hash_duplicates<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_content_hash_duplicates())
    }

    /// `countTranscriptImportPages`.
    #[napi]
    pub fn count_transcript_import_pages<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_transcript_import_pages())
    }

    /// `countPageRows`.
    #[napi]
    pub fn count_page_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_page_rows())
    }

    /// `countPagesBySlugPrefix`.
    #[napi]
    pub fn count_pages_by_slug_prefix<'env>(
        &self,
        env: &'env Env,
        prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_pages_by_slug_prefix(&prefix))
    }

    /// `countLivePages`.
    #[napi]
    pub fn count_live_pages<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_live_pages())
    }

    /// `readOldestPageCreatedAt`.
    #[napi]
    pub fn read_oldest_page_created_at<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_oldest_page_created_at())
    }

    /// `countPageTrustTiers`.
    #[napi]
    pub fn count_page_trust_tiers<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_page_trust_tiers())
    }

    /// `countPagesWithMentionLinks`.
    #[napi]
    pub fn count_pages_with_mention_links<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_pages_with_mention_links())
    }

    /// `readImagePageCoverage`.
    #[napi]
    pub fn read_image_page_coverage<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_image_page_coverage())
    }

    /// `listFactsPageBodies`.
    #[napi]
    pub fn list_facts_page_bodies<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_facts_page_bodies())
    }

    /// `listBracketPathPages`.
    #[napi]
    pub fn list_bracket_path_pages<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_bracket_path_pages())
    }

    /// `listSlugPathCandidates`.
    #[napi]
    pub fn list_slug_path_candidates<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_slug_path_candidates(source_ids))
    }
}
