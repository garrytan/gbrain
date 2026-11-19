//! Source-resolution reads for the CLI: the typed members that replace raw SQL in
//! `src/core/source-resolver.ts` (store side: `gbrain_store::cli_reads::sources`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Map, Value};

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listLocalPathSources()`: `{ id, local_path, archived }[]`, archived sources included.
    #[napi]
    pub fn list_local_path_sources<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_local_path_sources())
    }

    /// `readPlainSyncSource(id)`: `{ local_path, last_commit, config }` or `null` when the source
    /// is missing or archived.
    #[napi]
    pub fn read_plain_sync_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_plain_sync_source(&source_id))
    }

    /// `listSourceRoutingRows()`: `{ id, local_path, archived, config, default_has_pages }[]` by id.
    #[napi]
    pub fn list_source_routing_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_source_routing_rows())
    }

    /// `countDefaultSourceSplit()`: `{ defaultPages, nonDefaultPages, nonDefaultSources }`.
    #[napi]
    pub fn count_default_source_split<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_default_source_split())
    }

    /// `countSourcePages(sourceId, includeDeleted)`: the source's page count.
    #[napi]
    pub fn count_source_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        include_deleted: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_source_pages(&source_id, include_deleted)
        })
    }

    /// `listSourcePagePaths(sourceId)`: the source's live, file-backed pages in slug byte order.
    #[napi]
    pub fn list_source_page_paths<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_source_page_paths(&source_id))
    }

    /// `readRenameStoredTitles(sourceId, paths, slugs)`: the live pages a rename confirmation
    /// compares by source path or slug, in slug byte order.
    #[napi]
    pub fn read_rename_stored_titles<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        paths: Vec<String>,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_rename_stored_titles(&source_id, &paths, &slugs)
        })
    }

    /// `readLiveIdentityHolders(sourceId, ids, titles)`: the live pages holding a frontmatter id
    /// or title, in slug byte order.
    #[napi]
    pub fn read_live_identity_holders<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        ids: Vec<String>,
        titles: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_live_identity_holders(&source_id, &ids, &titles)
        })
    }

    /// `readPageIdentity(pageId)`: `{ fm_id, title }` of a live page, or `null`.
    #[napi]
    pub fn read_page_identity<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "readPageIdentity pageId")?;
            s.read_page_identity(page_id)
        })
    }

    /// `writeSourceCommitAnchor(sourceId, commit, stampNewest, newestContentAt)`: the sync anchor
    /// advance; `newestContentAt` counts only with `stampNewest`.
    #[napi]
    pub fn write_source_commit_anchor<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        commit: String,
        stamp_newest: bool,
        newest_content_at: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let newest = stamp_newest.then_some(newest_content_at.as_deref());
            s.write_source_commit_anchor(&source_id, &commit, newest)
        })
    }

    /// `writeSourceLocalPath(sourceId, localPath)`: the sync anchor's directory repoint.
    #[napi]
    pub fn write_source_local_path<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        local_path: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_source_local_path(&source_id, &local_path)
        })
    }

    /// `writeSourceSyncHeartbeat(sourceId)`: the 0-change sync heartbeat (`last_sync_at` only).
    #[napi]
    pub fn write_source_sync_heartbeat<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.write_source_sync_heartbeat(&source_id))
    }

    /// `writeSourceUpstreamObservation(sourceId, checkedAt, commit, behind)`: the sync's upstream
    /// observation of the source's checkout.
    #[napi]
    pub fn write_source_upstream_observation<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        checked_at: String,
        commit: String,
        behind: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_source_upstream_observation(&source_id, &checked_at, &commit, behind)
        })
    }

    /// `insertSource(id, name, localPath, config)`: the new `SourceRow`; `constraint_violation`
    /// when the id or the name is taken.
    #[napi]
    pub fn insert_source<'env>(
        &self,
        env: &'env Env,
        id: String,
        name: String,
        local_path: Option<String>,
        config: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let config: Map<String, Value> = required(config, "insertSource config")?;
            s.insert_source(&id, &name, local_path.as_deref(), &config)
        })
    }
}
