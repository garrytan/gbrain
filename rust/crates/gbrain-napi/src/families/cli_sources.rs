//! Source-resolution reads for the CLI: the typed members that replace raw SQL in
//! `src/core/source-resolver.ts` (store side: `gbrain_store::cli_reads::sources`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Map, Value};

use gbrain_store::reason_tombstones::ReasonTombstone;

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

    /// `readPageSizeRows(sourceId, maxBytes, slugs)`: the source's live pages a sync size-state
    /// read reports; `slugs` null reads every such page.
    #[napi]
    pub fn read_page_size_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        max_bytes: i64,
        slugs: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_size_rows(&source_id, max_bytes, slugs.as_deref())
        })
    }

    /// `holdPageEmbedding(pageId, reason)`: sets the page's ledger row to held (an upsert that keeps
    /// its spend columns); resolves null.
    #[napi]
    pub fn hold_page_embedding<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        reason: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.hold_page_embedding(page_id as u64, &reason))
    }

    /// `readReasonPurgeTombstones(sourceId, pair)`: `{ commit_sha, path }[]`, every pair of the
    /// source, or only `pair` when it is given and stored.
    #[napi]
    pub fn read_reason_purge_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        pair: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let only: Option<ReasonTombstone> = if pair.is_null() {
                None
            } else {
                Some(required(pair, "readReasonPurgeTombstones pair")?)
            };
            s.read_reason_purge_tombstones(&source_id, only.as_ref())
        })
    }

    /// `writeReasonPurgeTombstones(sourceId, pairs)`: the number of pairs it added.
    #[napi]
    pub fn write_reason_purge_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        pairs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let pairs: Vec<ReasonTombstone> = required(pairs, "writeReasonPurgeTombstones pairs")?;
            s.write_reason_purge_tombstones(&source_id, &pairs)
        })
    }

    /// `advanceSourcePurgeEpoch(sourceId)`: the source's new purge epoch, or null for an unknown
    /// source.
    #[napi]
    pub fn advance_source_purge_epoch<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.advance_source_purge_epoch(&source_id))
    }

    /// `readSourcePurgeEpoch(sourceId)`: the source's purge epoch, or null for an unknown source.
    #[napi]
    pub fn read_source_purge_epoch<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_purge_epoch(&source_id))
    }

    /// `listSourcePathPages(sourceId)`: the source's live pages that have a `source_path`.
    #[napi]
    pub fn list_source_path_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_source_path_pages(&source_id))
    }

    /// `listQuarantinedSlugs(sourceId)`: the slugs of the source's live quarantined pages.
    #[napi]
    pub fn list_quarantined_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_quarantined_slugs(&source_id))
    }

    /// `readRenameIdentityRows(sourceId, paths, slugs)`: the source's live pages a rename's
    /// identity check compares.
    #[napi]
    pub fn read_rename_identity_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        paths: Vec<String>,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_rename_identity_rows(&source_id, &paths, &slugs)
        })
    }

    /// `readLiveIdentityHolders(sourceId, ids, titles)`: the source's live pages that hold one of
    /// the frontmatter ids or titles.
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
