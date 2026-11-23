//! Page operations: batch snapshots, duplicate lookup, batch soft and hard deletes, the purge,
//! find and count, the domain-bank samplers, frontmatter marker reads, date reads and
//! `revertToVersion`, over `gbrain_store::page_ops` (rust/docs/store/page_ops.md).
//!
//! One `#[napi] impl Brain` block; each method decodes its arguments, runs one `Store` call on the
//! pool through `Brain::run` and resolves plain JSON. Maps, sets and dates are built by the
//! TypeScript members (`store-members/page-ops.ts`).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `readPageSnapshotsBatch(refs, { maxBytes?, includeDeleted? }?)`: `{ covered, snapshots }`,
    /// one snapshot or `null` per covered ref.
    #[napi]
    pub fn read_page_snapshots_batch<'env>(
        &self,
        env: &'env Env,
        refs: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_snapshots_batch(
                &required::<Vec<_>>(refs, "readPageSnapshotsBatch refs")?,
                &arg(options, "readPageSnapshotsBatch options")?,
            )
        })
    }

    /// `findDuplicatePage(sourceId, { hash, frontmatterId?, excludeSlug? })`: `{ slug, id }` or
    /// `null`.
    #[napi]
    pub fn find_duplicate_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_duplicate_page(&source_id, &required(query, "findDuplicatePage query")?)
        })
    }

    /// `findDuplicatePages(sourceId, inputs)`: one `{ slug, id }` or `null` per input.
    #[napi]
    pub fn find_duplicate_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        inputs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_duplicate_pages(
                &source_id,
                &required::<Vec<_>>(inputs, "findDuplicatePages inputs")?,
            )
        })
    }

    /// `deletePages(slugs, { sourceId })`: the slugs removed.
    #[napi]
    pub fn delete_pages<'env>(
        &self,
        env: &'env Env,
        slugs: Vec<String>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_pages(&slugs, &arg(options, "deletePages options")?)
        })
    }

    /// `softDeletePages(slugs, { sourceId })`: the slugs hidden.
    #[napi]
    pub fn soft_delete_pages<'env>(
        &self,
        env: &'env Env,
        slugs: Vec<String>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.soft_delete_pages(&slugs, &arg(options, "softDeletePages options")?)
        })
    }

    /// `purgeDeletedPages(olderThanHours, { dryRun?, excludeIds? }?)`: `{ slugs, count, pages? }`.
    #[napi]
    pub fn purge_deleted_pages<'env>(
        &self,
        env: &'env Env,
        older_than_hours: f64,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.purge_deleted_pages(
                older_than_hours,
                &arg(options, "purgeDeletedPages options")?,
            )
        })
    }

    /// `resolveSlugsByPaths(paths, { sourceId })`, store half: `[{ slug, source_path, live }]`.
    #[napi]
    pub fn resolve_slugs_by_paths<'env>(
        &self,
        env: &'env Env,
        paths: Vec<String>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.resolve_slugs_by_paths(&paths, &arg(options, "resolveSlugsByPaths options")?)
        })
    }

    /// `findPages(query)`: `{ rows, total }`.
    #[napi]
    pub fn find_pages<'env>(&self, env: &'env Env, query: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_pages(&required(query, "findPages query")?)
        })
    }

    /// `countPagesBy({ sourceId?, sourceIds?, since?, typeGroups? })`: `{ bySourceType,
    /// byTypeGroup, total }`.
    #[napi]
    pub fn count_pages_by<'env>(
        &self,
        env: &'env Env,
        query: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_pages_by(&arg(query, "countPagesBy query")?)
        })
    }

    /// `getAllSlugs({ sourceId? }?)`: sorted distinct slugs, soft-deleted pages included.
    #[napi]
    pub fn get_all_slugs<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_all_slugs(&arg(options, "getAllSlugs options")?)
        })
    }

    /// `listAllPageRefs()`: `[{ slug, source_id, updated_at }]`.
    #[napi]
    pub fn list_all_page_refs<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_all_page_refs())
    }

    /// `listPrefixSampledPages(opts)`: `DomainBankRow[]`.
    #[napi]
    pub fn list_prefix_sampled_pages<'env>(
        &self,
        env: &'env Env,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_prefix_sampled_pages(&required(options, "listPrefixSampledPages options")?)
        })
    }

    /// `listCorpusSample(opts)`: `DomainBankRow[]`.
    #[napi]
    pub fn list_corpus_sample<'env>(
        &self,
        env: &'env Env,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_corpus_sample(&required(options, "listCorpusSample options")?)
        })
    }

    /// `bumpPageRetrievals(ids)`: resolves the number of retrieval records written.
    #[napi]
    pub fn bump_page_retrievals<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.bump_page_retrievals(&ids))
    }

    /// `getContentFlagsByPageIds(ids, { sourceId?, sourceIds?, live? }?)`: `[{ id, reason, detail }]`.
    #[napi]
    pub fn get_content_flags_by_page_ids<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_content_flags_by_page_ids(&ids, &arg(scope, "getContentFlagsByPageIds scope")?)
        })
    }

    /// `getUnverifiedExtractionPageIds(ids, { sourceId?, sourceIds?, live? }?)`: `[{ id, status,
    /// unverified }]`.
    #[napi]
    pub fn get_unverified_extraction_page_ids<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_unverified_extraction_page_ids(
                &ids,
                &arg(scope, "getUnverifiedExtractionPageIds scope")?,
            )
        })
    }

    /// `getPageTimestamps(slugs)`: `[{ slug, ts }]` in page id order.
    #[napi]
    pub fn get_page_timestamps<'env>(
        &self,
        env: &'env Env,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_page_timestamps(&slugs))
    }

    /// `getEffectiveDates(refs, { sourceId?, sourceIds?, live? }?)`: `[{ slug, source_id, ts }]`.
    #[napi]
    pub fn get_effective_dates<'env>(
        &self,
        env: &'env Env,
        refs: Value,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_effective_dates(
                &required::<Vec<_>>(refs, "getEffectiveDates refs")?,
                &arg(scope, "getEffectiveDates scope")?,
            )
        })
    }

    /// `readAdmittedPageRefs(refs, { sourceId?, sourceIds?, excludePrivate?, minTrust?, suppressFlagged? })`:
    /// `[{ source_id, slug }]`.
    #[napi]
    pub fn read_admitted_page_refs<'env>(
        &self,
        env: &'env Env,
        refs: Value,
        scope: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_admitted_page_refs(
                &required::<Vec<_>>(refs, "readAdmittedPageRefs refs")?,
                &required(scope, "readAdmittedPageRefs scope")?,
            )
        })
    }

    /// `readPageSynopses(refs, { sourceId?, sourceIds?, excludePrivate?, minTrust?, suppressFlagged? })`:
    /// `[{ page_id, slug, source_id, title, type, synopsis }]`.
    #[napi]
    pub fn read_page_synopses<'env>(
        &self,
        env: &'env Env,
        refs: Value,
        scope: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_synopses(
                &required::<Vec<_>>(refs, "readPageSynopses refs")?,
                &required(scope, "readPageSynopses scope")?,
            )
        })
    }

    /// `readSeedTitleSlugs(sourceId, types, title)`: at most two slugs.
    #[napi]
    pub fn read_seed_title_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        types: Vec<String>,
        title: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_seed_title_slugs(&source_id, &types, &title)
        })
    }

    /// `revertToVersion(slug, versionId, { sourceId? }?)`: `null`.
    #[napi]
    pub fn revert_to_version<'env>(
        &self,
        env: &'env Env,
        slug: String,
        version_id: i64,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.revert_to_version(&slug, version_id, &arg(options, "revertToVersion options")?)
        })
    }

    /// `listRestorableAtoms(sourceIds, atomId)`: resolves the restorable re-extraction retirements of the sources (or
    /// the one atom), by id (`gbrain repair atoms-restore`).
    #[napi]
    pub fn list_restorable_atoms<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        atom_id: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_restorable_atoms(&source_ids, atom_id))
    }

    /// `countKeptAtomRetirements(sourceIds)`: resolves `{ origin_gone, replaced, older_generation }`.
    #[napi]
    pub fn count_kept_atom_retirements<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_kept_atom_retirements(&source_ids))
    }

    /// `listStaleAtoms(sourceIds, atomId)`: resolves the stale atoms of the sources (or the one atom), origin-gone
    /// first, then by id (`gbrain repair stale-atoms`).
    #[napi]
    pub fn list_stale_atoms<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        atom_id: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_stale_atoms(&source_ids, atom_id))
    }
}
