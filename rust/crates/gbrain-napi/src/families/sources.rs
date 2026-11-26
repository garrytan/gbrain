//! Sources: list, read, upsert, patch config, archive; and the source archive members
//! (`gbrain_store::sources` archive): `archiveSource`, `restoreArchivedSource`,
//! `listArchivedSourceRows`, `listExpiredArchivedSources`, `listUnverifiedArchivedSourceIds` and
//! `readSourceDeleteImpact`.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `listAllSources({ includeArchived?, localPathOnly? }?)`: `SourceRow[]`, `default` first.
    #[napi]
    pub fn list_all_sources<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_all_sources(&arg(options, "listAllSources options")?)
        })
    }

    /// `getSourceById(id)`: the `SourceRow` or `null`.
    #[napi]
    pub fn get_source_by_id<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_source_by_id(&id))
    }

    /// `upsertSource({ id, name?, local_path?, last_sync_at?, config? })`: the `SourceRow`.
    #[napi]
    pub fn upsert_source<'env>(&self, env: &'env Env, input: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.upsert_source(&required(input, "upsertSource input")?)
        })
    }

    /// `updateSourceConfig(id, patch)`: merges `patch` into the config; whether the source exists.
    #[napi]
    pub fn update_source_config<'env>(
        &self,
        env: &'env Env,
        id: String,
        patch: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.update_source_config(&id, &required(patch, "updateSourceConfig patch")?)
        })
    }

    /// `markSourceSynced(id, { incarnation? }?)`: whether a source was stamped.
    #[napi]
    pub fn mark_source_synced<'env>(
        &self,
        env: &'env Env,
        id: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.mark_source_synced(&id, &arg(options, "markSourceSynced options")?)
        })
    }

    /// `advanceSyncCheckpoint(input)`: `{ advanced, pinnedSlugMode }`.
    #[napi]
    pub fn advance_sync_checkpoint<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.advance_sync_checkpoint(&required(input, "advanceSyncCheckpoint input")?)
        })
    }

    /// `setSourceArchived(id, archived)`: whether the source exists.
    #[napi]
    pub fn set_source_archived<'env>(
        &self,
        env: &'env Env,
        id: String,
        archived: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_source_archived(&id, archived))
    }

    /// `getSource(id)`: the `SourceDetailRow` or `null`.
    #[napi]
    pub fn get_source<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_source(&id))
    }

    /// `advanceSourceCommit(id, commit, setNewest, newestContentAt)`: records the commit a git sync
    /// reached and stamps `last_sync_at`. `newest_content_at` changes only when `set_newest` is
    /// true; a null `newest_content_at` then clears it.
    #[napi]
    pub fn advance_source_commit<'env>(
        &self,
        env: &'env Env,
        id: String,
        commit: String,
        set_newest: bool,
        newest_content_at: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let newest = set_newest.then_some(newest_content_at.as_deref());
            s.advance_source_commit(&id, &commit, newest)
        })
    }

    /// `countRepoBoundSources()`: live sources with a non-empty local path.
    #[napi]
    pub fn count_repo_bound_sources<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.count_repo_bound_sources())
    }

    /// `readSourceLastCommit(id)`: the commit the source's last sync advanced to, or `null`.
    #[napi]
    pub fn read_source_last_commit<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_last_commit(&id))
    }

    /// `listSourceLocalPaths()`: every non-empty source local path.
    #[napi]
    pub fn list_source_local_paths<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.list_source_local_paths())
    }

    /// `getSourceStrictness(id)`: whether the source is git-canonical.
    #[napi]
    pub fn get_source_strictness<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_source_strictness(&id))
    }

    /// `archiveSource(id, ttlHours)`: `{ id, name, archived_at, archive_expires_at }` of the
    /// source it archived, or null when the source is missing or already archived.
    #[napi]
    pub fn archive_source<'env>(
        &self,
        env: &'env Env,
        id: String,
        ttl_hours: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.archive_source(&id, ttl_hours))
    }

    /// `restoreArchivedSource(id, federated)`: whether an archived source was restored.
    #[napi]
    pub fn restore_archived_source<'env>(
        &self,
        env: &'env Env,
        id: String,
        federated: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.restore_archived_source(&id, federated))
    }

    /// `listArchivedSourceRows()`: every archived source with its page count, newest first.
    #[napi]
    pub fn list_archived_source_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_archived_source_rows())
    }

    /// `listExpiredArchivedSources()`: `{ id, incarnation, config, local_path }` of each archive
    /// past its window, by id.
    #[napi]
    pub fn list_expired_archived_sources<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_expired_archived_sources())
    }

    /// `listUnverifiedArchivedSourceIds()`: the archives with missing or epoch times, by id.
    #[napi]
    pub fn list_unverified_archived_source_ids<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_unverified_archived_source_ids())
    }

    /// `readSourceDeleteImpact(id)`: `{ id, name, pages, chunks, embeddings, files, facts }`, or null.
    #[napi]
    pub fn read_source_delete_impact<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_delete_impact(&id))
    }

    /// `deleteSourceRecord(id, expiredArchiveOnly)`: whether the source was deleted with its pages
    /// and every record that names it; an OAuth client of the source refuses it.
    #[napi]
    pub fn delete_source_record<'env>(
        &self,
        env: &'env Env,
        id: String,
        expired_archive_only: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_source_record(&id, expired_archive_only)
        })
    }
}
