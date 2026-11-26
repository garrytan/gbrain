//! The Git-gap census reads of `engine-sql/git-gap-census.ts` (rust/docs/store/git-gap-census.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readGitGapSourceRow(sourceId)`: `{ local_path, incarnation }` or null.
    #[napi]
    pub fn read_git_gap_source_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_git_gap_source_row(&source_id))
    }

    /// `countGitGapLivePages(sourceId)`.
    #[napi]
    pub fn count_git_gap_live_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_git_gap_live_pages(&source_id))
    }

    /// `listGitGapNewestPages(sourceId, limit)`.
    #[napi]
    pub fn list_git_gap_newest_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_git_gap_newest_pages(&source_id, limit))
    }

    /// `countGitGapUnreadFacts(sourceId, pageIds)`.
    #[napi]
    pub fn count_git_gap_unread_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_git_gap_unread_facts(&source_id, &page_ids)
        })
    }

    /// `readGitGapPageBatch(sourceId, after, ids, honorAliases)`.
    #[napi]
    pub fn read_git_gap_page_batch<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        after: Option<String>,
        ids: Option<Vec<String>>,
        honor_aliases: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_git_gap_page_batch(&source_id, after.as_deref(), ids.as_deref(), honor_aliases)
        })
    }

    /// `countGitGapFactsOnPages(sourceId, slugs)`.
    #[napi]
    pub fn count_git_gap_facts_on_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_git_gap_facts_on_pages(&source_id, &slugs)
        })
    }

    /// `countGitGapTimelineOnPages(pageIds)`.
    #[napi]
    pub fn count_git_gap_timeline_on_pages<'env>(
        &self,
        env: &'env Env,
        page_ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_git_gap_timeline_on_pages(&page_ids))
    }

    /// `readGitGapSourceRows(sourceId, derivedLinkSources, holdOp)`.
    #[napi]
    pub fn read_git_gap_source_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        derived: Vec<String>,
        hold_op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_git_gap_source_rows(&source_id, &derived, &hold_op)
        })
    }
}
