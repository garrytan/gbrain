//! Pages: snapshots, writes, lists, slug resolution, soft delete, restore and delete.
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
    /// `readPageSnapshot(slug, { sourceId?, sourceIds?, includeDeleted?, excludePrivate?, resolveAlias?,
    /// requireUnambiguous?, requireLiveSource?, preserveExactIdentity? }?)`: `{ page, tags,
    /// revision, sourceIncarnation, withdrawals }` or `null`. Dates are ISO strings.
    #[napi]
    pub fn read_page_snapshot<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_snapshot(&slug, &arg(options, "readPageSnapshot options")?)
        })
    }

    /// `putPage(slug, page, { sourceId?, allowEmptyOverwrite?, expectedRevision?, force? }?)`: the
    /// stored `Page`. `expectedRevision` is absent, `null` or a revision UUID.
    #[napi]
    pub fn put_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        page: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.put_page(
                &slug,
                &required(page, "putPage page")?,
                &arg(options, "putPage options")?,
            )
        })
    }

    /// `listPages(filters?)`: `Page[]`.
    #[napi]
    pub fn list_pages<'env>(
        &self,
        env: &'env Env,
        filters: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_pages(&arg(filters, "listPages filters")?)
        })
    }

    /// `countPages({ sourceId? }?)`: the number of live pages.
    #[napi]
    pub fn count_pages<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "countPages options")?;
            s.count_pages(scope.source_id.as_deref())
        })
    }

    /// `lockPageKeys([{ sourceId, slug }])`: resolves `null`.
    #[napi]
    pub fn lock_page_keys<'env>(&self, env: &'env Env, keys: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.lock_page_keys(&required::<Vec<gbrain_store::pages::PageKey>>(
                keys,
                "lockPageKeys keys",
            )?)
        })
    }

    /// `resolveSlugs(partial, { sourceId?, sourceIds? }?)`: up to 5 slugs.
    #[napi]
    pub fn resolve_slugs<'env>(
        &self,
        env: &'env Env,
        partial: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.resolve_slugs(&partial, &arg(options, "resolveSlugs options")?)
        })
    }

    /// `softDeletePage(slug, { sourceId? }?)`: `{ slug }` or `null` when no live page matches.
    #[napi]
    pub fn soft_delete_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "softDeletePage options")?;
            Ok(s.soft_delete_page(&slug, scope.source_id.as_deref())?
                .map(|slug| serde_json::json!({ "slug": slug })))
        })
    }

    /// `restorePage(slug, { sourceId? }?)`: whether a deleted page came back.
    #[napi]
    pub fn restore_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "restorePage options")?;
            s.restore_page(&slug, scope.source_id.as_deref())
        })
    }

    /// `deletePage(slug, { sourceId? }?)`: removes the page for good. Resolves `null`.
    #[napi]
    pub fn delete_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "deletePage options")?;
            s.delete_page(&slug, scope.source_id.as_deref())
        })
    }

    /// `listSafeChunksPending(sourceIds, producer)`: resolves `[{ id, source_id, slug, page_kind,
    /// rebuildable, chars }]`, the pages `gbrain repair safe-chunks` re-seals or reports, by id.
    #[napi]
    pub fn list_safe_chunks_pending<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        producer: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_safe_chunks_pending(&source_ids, &producer)
        })
    }

    /// `listOriginTwinGroups(sourceId, limit)`: resolves `[{ source_path, ids, paths }]`.
    #[napi]
    pub fn list_origin_twin_groups<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_origin_twin_groups(&source_id, u64::from(limit))
        })
    }

    /// `listLegacyOriginPairs(sourceId, prefix, limit)`: resolves `[{ legacy_id, legacy_path,
    /// legacy_slug, origin }]`.
    #[napi]
    pub fn list_legacy_origin_pairs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        prefix: String,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_legacy_origin_pairs(&source_id, &prefix, u64::from(limit))
        })
    }

    /// `listLiveOriginPages(sourceId, paths)`: resolves `[{ id, source_path }]` by id.
    #[napi]
    pub fn list_live_origin_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        paths: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_live_origin_pages(&source_id, &paths))
    }

    /// `countLiveFileBackedPages(sourceId, nonBlank)`: resolves the number of live pages recording
    /// an origin (`nonBlank`: a non-blank one).
    #[napi]
    pub fn count_live_file_backed_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        non_blank: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_live_file_backed_pages(&source_id, non_blank)
        })
    }

    /// `listRepairScanPages(sourceId, { ids, slugs, after_id, limit, legacy })`: resolves
    /// `RepairScanPage[]` by id.
    #[napi]
    pub fn list_repair_scan_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_repair_scan_pages(&source_id, &required(query, "listRepairScanPages query")?)
        })
    }

    /// `listFileTombstones(sourceId, { before, limit })`: resolves `FileTombstone[]`, the
    /// soft-deleted pages recording a non-blank file below `before`, by id descending.
    #[napi]
    pub fn list_file_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_file_tombstones(&source_id, &required(query, "listFileTombstones query")?)
        })
    }

    /// `listTwinMergeLosers(survivorId, twinId)`: resolves `TwinMergeLosers`, what moving the twin
    /// into the survivor would land on.
    #[napi]
    pub fn list_twin_merge_losers<'env>(
        &self,
        env: &'env Env,
        survivor_id: i64,
        twin_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_twin_merge_losers(survivor_id.max(0) as u64, twin_id.max(0) as u64)
        })
    }

    /// `listContactRowPages(sourceIds, { after_id, limit, slugs })`: resolves `RepairPageRef[]`
    /// by id, the live inline pages with two or more contact rows.
    #[napi]
    pub fn list_contact_row_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_contact_row_pages(&source_ids, &required(query, "listContactRowPages query")?)
        })
    }

    /// `listSplitFactsPages(sourceIds)`: resolves `{ inline, segmented }`, the pages whose two
    /// sections each hold a facts fence.
    #[napi]
    pub fn list_split_facts_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_split_facts_pages(&source_ids))
    }

    /// `listAtomFenceCandidates(sourceIds, { atom_id, after_id, limit })`: resolves
    /// `AtomFenceCandidate[]` by id.
    #[napi]
    pub fn list_atom_fence_candidates<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_atom_fence_candidates(
                &source_ids,
                &required(query, "listAtomFenceCandidates query")?,
            )
        })
    }

    /// `listPageTruths(ids)`: resolves `[{ id, body }]` by id, each page's compiled truth.
    #[napi]
    pub fn list_page_truths<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        let ids: Vec<u64> = ids
            .into_iter()
            .filter(|id| *id > 0)
            .map(|id| id as u64)
            .collect();
        self.run(env, move |s| s.list_page_truths(&ids))
    }

    /// `listPagesByOriginPath(sourceId)`: resolves `[{ id, slug, source_path, revision, title, head }]`
    /// by slug, the live pages of the source that record an origin.
    #[napi]
    pub fn list_pages_by_origin_path<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_pages_by_origin_path(&source_id))
    }

    /// `countSegmentedOriginPages(sourceIds)`: resolves how many live file-backed pages of the
    /// sources store their body in segments.
    #[napi]
    pub fn count_segmented_origin_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_segmented_origin_pages(&source_ids))
    }

    /// `listSegmentedPageSlugs(sourceId)`: resolves the slugs of the source's live segmented
    /// pages, in byte order.
    #[napi]
    pub fn list_segmented_page_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_segmented_page_slugs(&source_id))
    }

    /// `listProvenAttributionTargets(table, sourceIds)`: resolves the ids of the `table` rows of
    /// the sources with no attribution that exactly one committed request proves, ascending.
    #[napi]
    pub fn list_proven_attribution_targets<'env>(
        &self,
        env: &'env Env,
        table: String,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_proven_attribution_targets(&table, &source_ids)
        })
    }

    /// `countUnfilledAttribution(table, sourceIds)`: resolves how many `table` rows of the sources
    /// have no attribution.
    #[napi]
    pub fn count_unfilled_attribution<'env>(
        &self,
        env: &'env Env,
        table: String,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_unfilled_attribution(&table, &source_ids)
        })
    }

    /// `listFailedWriteRequests(sourceIds, replayable, factsMovedMessages, id)`: resolves the
    /// refused requests the failed-writes preview lists, by sequence.
    #[napi]
    pub fn list_failed_write_requests<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        replayable: Vec<String>,
        facts_moved_messages: Option<Vec<String>>,
        id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_failed_write_requests(
                &source_ids,
                &replayable,
                facts_moved_messages.as_deref(),
                id.as_deref(),
            )
        })
    }

    /// `readDriftConflictBounds(sourceId)`: resolves `{ incarnation, top, bottom }` or null.
    #[napi]
    pub fn read_drift_conflict_bounds<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_drift_conflict_bounds(&source_id))
    }

    /// `listDriftConflictGroups(sourceId, query)`: resolves `{ slugs, receipts, rows }`
    /// (`DriftConflictQuery`).
    #[napi]
    pub fn list_drift_conflict_groups<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::drift_conflicts::DriftConflictQuery =
                required(query, "listDriftConflictGroups query")?;
            s.list_drift_conflict_groups(&source_id, &q)
        })
    }

    /// `readDriftConflictDetails(sourceId, slugs, paths)`: resolves `{ committed, recorded }`.
    #[napi]
    pub fn read_drift_conflict_details<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        paths: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_drift_conflict_details(&source_id, &slugs, paths)
        })
    }

    /// `listUntiledSegmentedPages(sourceIds, slugs, limit)`: resolves `[{ id, source_id, slug,
    /// revision, body_generation, body_bytes, segment_count, source_path, n, covered, gapless }]`.
    #[napi]
    pub fn list_untiled_segmented_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
        slugs: Option<Vec<String>>,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_untiled_segmented_pages(
                source_ids.as_deref(),
                slugs.as_deref(),
                u64::from(limit),
            )
        })
    }

    /// `listSourceHoldRecords(op, sourceIds, runId)`: resolves `[{ record, mirror_read_only }]`
    /// by source id then fingerprint.
    #[napi]
    pub fn list_source_hold_records<'env>(
        &self,
        env: &'env Env,
        op: String,
        source_ids: Option<Vec<String>>,
        run_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_source_hold_records(&op, source_ids.as_deref(), run_id.as_deref())
        })
    }
}
