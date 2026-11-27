//! Segmented page bodies: segment texts, manifests, stagings, the generation flip, the seal,
//! derivations and `refreshPageBody`, each a thin call over `gbrain_store::page_body`.
//!
//! Bytes cross as lowercase hex and dates as ISO strings; `store-members/page-body.ts` converts
//! them to and from `Uint8Array` and `Date`. Not bound (the TypeScript engine refuses it):
//! sweepSegments.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use gbrain_store::page_body::derivation_sweep::DerivationSweepArgs;
use gbrain_store::page_body::purge_record::{DerivationPurgeRecordArgs, DerivationPurgeStateArgs};

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `allocateBodyOccurrenceIds(count)`: ascending ids; `[]` for a count of 0 or less.
    #[napi]
    pub fn allocate_body_occurrence_ids<'env>(
        &self,
        env: &'env Env,
        count: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.allocate_body_occurrence_ids(required(count, "allocateBodyOccurrenceIds count")?)
        })
    }

    /// `stageSegmentTexts(sourceId, texts, { stagingId? }?)`: `{ inserted }`.
    #[napi]
    pub fn stage_segment_texts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        texts: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let texts: Vec<gbrain_store::page_body::SegmentTextInput> =
                required(texts, "stageSegmentTexts texts")?;
            s.stage_segment_texts(
                &source_id,
                &texts,
                &arg(options, "stageSegmentTexts options")?,
            )
        })
    }

    /// `readSegmentTexts(sourceId, sha256s)`: `[sha256, body]` hex pairs of the texts found.
    #[napi]
    pub fn read_segment_texts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        sha256s: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_segment_texts(&source_id, &sha256s))
    }

    /// `stageManifestRows(rows)`: resolves `null`.
    #[napi]
    pub fn stage_manifest_rows<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<gbrain_store::page_body::ManifestRow> =
                required(rows, "stageManifestRows rows")?;
            s.stage_manifest_rows(&rows)
        })
    }

    /// `readSegmentedEmbedPage({ id } | { sourceId, slug })`: the sealed live segmented page's embed
    /// fields, or `null`.
    #[napi]
    pub fn read_segmented_embed_page<'env>(
        &self,
        env: &'env Env,
        reference: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_segmented_embed_page(&required(reference, "readSegmentedEmbedPage ref")?)
        })
    }

    /// `readManifest(pageId, { generation?, stagingId?, region?, lastN? }?)`: rows by seq.
    #[napi]
    pub fn read_manifest<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_manifest(
                required(page_id, "readManifest pageId")?,
                &arg(options, "readManifest options")?,
            )
        })
    }

    /// `createSegmentedPageShell(slug, meta, { sourceId })`: `{ id }`.
    #[napi]
    pub fn create_segmented_page_shell<'env>(
        &self,
        env: &'env Env,
        slug: String,
        meta: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.create_segmented_page_shell(
                &slug,
                &required(meta, "createSegmentedPageShell meta")?,
                &arg(options, "createSegmentedPageShell options")?,
            )
        })
    }

    /// `flipBodyGeneration(input)`: `{ retiredChunks, retireDeferred }`.
    #[napi]
    pub fn flip_body_generation<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.flip_body_generation(&required(input, "flipBodyGeneration input")?)
        })
    }

    /// `stageSegmentChunks(pageId, generation, chunks)`: the chunk indexes, in input order.
    #[napi]
    pub fn stage_segment_chunks<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        generation: Value,
        chunks: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let chunks: Vec<gbrain_store::chunks::SegmentChunkInput> =
                required(chunks, "stageSegmentChunks chunks")?;
            s.stage_segment_chunks(
                required(page_id, "stageSegmentChunks pageId")?,
                required(generation, "stageSegmentChunks generation")?,
                &chunks,
            )
        })
    }

    /// Not a member: `{ lead, revision, slug, sourceId }` of page `pageId` for `sealSegmentedPage`
    /// (the stored timeline lead, `""` when none, the page's knowledge revision and its identity),
    /// or `null` for a missing page.
    #[napi]
    pub fn read_segmented_seal_lead<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_segmented_seal_lead(required(page_id, "readSegmentedSealLead pageId")?)
        })
    }

    /// `sealSegmentedPage(pageId, timeline, expectedRevision?)`: resolves `null`. `timeline` is the
    /// lead TypeScript sanitized; a moved `expectedRevision` refuses `revision_conflict`.
    #[napi]
    pub fn seal_segmented_page<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        timeline: String,
        expected_revision: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.seal_segmented_page(
                required(page_id, "sealSegmentedPage pageId")?,
                &timeline,
                expected_revision.as_deref(),
            )
        })
    }

    /// `openBodyStaging(input)`: resolves `null`.
    #[napi]
    pub fn open_body_staging<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.open_body_staging(&required(input, "openBodyStaging input")?)
        })
    }

    /// `setBodyStagingState(id, state, { commitRequestId? }?)`: resolves `null`.
    #[napi]
    pub fn set_body_staging_state<'env>(
        &self,
        env: &'env Env,
        id: String,
        state: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_body_staging_state(&id, &state, &arg(options, "setBodyStagingState options")?)
        })
    }

    /// `sweepSegments({ sourceId?, pageId?, graceMs?, expireStagings?, now? }?)`: the segment
    /// garbage collection, `now` as an ISO string; `{ retiredChunksDeleted, manifestRowsDeleted,
    /// textsDeleted, stagingsExpired }`.
    #[napi]
    pub fn sweep_segments<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.sweep_segments(&arg(options, "sweepSegments options")?)
        })
    }

    /// `readSegmentDerivations(pageId, { kind?, occurrenceIds? }?)`: rows by kind, occurrence.
    #[napi]
    pub fn read_segment_derivations<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_segment_derivations(
                required(page_id, "readSegmentDerivations pageId")?,
                &arg(options, "readSegmentDerivations options")?,
            )
        })
    }

    /// `upsertSegmentDerivations(rows)`: resolves how many rows a recorded fact purge sweep refused (they are not stored).
    #[napi]
    pub fn upsert_segment_derivations<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<gbrain_store::page_body::SegmentDerivationInput> =
                required(rows, "upsertSegmentDerivations rows")?;
            s.upsert_segment_derivations(&rows)
        })
    }

    /// `recordDerivationPurgeRow(args)`: resolves `null`.
    #[napi]
    pub fn record_derivation_purge_row<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DerivationPurgeRecordArgs = required(args, "recordDerivationPurgeRow args")?;
            s.record_derivation_purge_row(&a)
        })
    }

    /// `readDerivationPurgeState(args)`: resolves `{ state, reason }`, or `null` for no record.
    #[napi]
    pub fn read_derivation_purge_state<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DerivationPurgeStateArgs = required(args, "readDerivationPurgeState args")?;
            s.read_derivation_purge_state(&a)
        })
    }

    /// `continueDerivationSweep(args)`: resolves `{ deleted, work }`, the rows the first walks deleted and per page the rows read.
    #[napi]
    pub fn continue_derivation_sweep<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DerivationSweepArgs = required(args, "continueDerivationSweep args")?;
            s.continue_derivation_sweep(&a)
        })
    }

    /// `retireSegmentDerivations(pageId, liveOccurrenceIds, { kind? }?)`: rows deleted.
    #[napi]
    pub fn retire_segment_derivations<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        live_occurrence_ids: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let live: Vec<i64> = required(
                live_occurrence_ids,
                "retireSegmentDerivations liveOccurrenceIds",
            )?;
            s.retire_segment_derivations(
                required(page_id, "retireSegmentDerivations pageId")?,
                &live,
                &arg(options, "retireSegmentDerivations options")?,
            )
        })
    }

    /// `refreshPageBody(slug, sourceId, compiledTruth, timeline, contentHash)`: resolves `null`.
    #[napi]
    pub fn refresh_page_body<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
        compiled_truth: String,
        timeline: String,
        content_hash: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.refresh_page_body(&slug, &source_id, &compiled_truth, &timeline, &content_hash)
        })
    }

    /// `listChunkedOccurrences(pageId, occurrences, generation)`: the occurrences with a chunk row
    /// at or below the generation.
    #[napi]
    pub fn list_chunked_occurrences<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        occurrences: Value,
        generation: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let occurrences: Vec<i64> =
                required(occurrences, "listChunkedOccurrences occurrences")?;
            s.list_chunked_occurrences(page_id, &occurrences, generation)
        })
    }

    /// `readRetiredChunkVectors(pageId, occurrences)`: the vectors of those occurrences' rows.
    #[napi]
    pub fn read_retired_chunk_vectors<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        occurrences: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let occurrences: Vec<i64> =
                required(occurrences, "readRetiredChunkVectors occurrences")?;
            s.read_retired_chunk_vectors(page_id, &occurrences)
        })
    }

    /// `hasStaleSegmentChunks(pageId, generation, live)`.
    #[napi]
    pub fn has_stale_segment_chunks<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        generation: i64,
        live: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let live: Vec<i64> = required(live, "hasStaleSegmentChunks live")?;
            s.has_stale_segment_chunks(page_id, generation, &live)
        })
    }

    /// `retireStaleSegmentChunks(pageId, generation, live, maxRows)`: the number of rows deleted.
    #[napi]
    pub fn retire_stale_segment_chunks<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        generation: i64,
        live: Value,
        max_rows: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let live: Vec<i64> = required(live, "retireStaleSegmentChunks live")?;
            s.retire_stale_segment_chunks(page_id, generation, &live, max_rows)
        })
    }

    /// `readSegmentedProjectionPage(sourceId, slug)`: the live segmented page row or null.
    #[napi]
    pub fn read_segmented_projection_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_segmented_projection_page(&source_id, &slug)
        })
    }

    /// `lockBodyStagingState(stagingId)`: the staging's state, or `null`.
    #[napi]
    pub fn lock_body_staging_state<'env>(
        &self,
        env: &'env Env,
        staging_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.lock_body_staging_state(&staging_id))
    }

    /// `deleteUnstagedSegmentChunks(pageId, generation, keepChunkIndexes)`: resolves `null`.
    #[napi]
    pub fn delete_unstaged_segment_chunks<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        generation: Value,
        keep_chunk_indexes: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let keep: Vec<i64> = required(
                keep_chunk_indexes,
                "deleteUnstagedSegmentChunks keepChunkIndexes",
            )?;
            s.delete_unstaged_segment_chunks(
                required(page_id, "deleteUnstagedSegmentChunks pageId")?,
                required(generation, "deleteUnstagedSegmentChunks generation")?,
                &keep,
            )
        })
    }

    /// `deleteRewrittenSegmentDerivations({ pageId, touchedOccurrenceIds, linkReachOccurrenceIds,
    /// pipelines, liveOccurrenceIds })`: rows deleted.
    #[napi]
    pub fn delete_rewritten_segment_derivations<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: gbrain_store::page_body::RewrittenDerivationsDelete =
                required(spec, "deleteRewrittenSegmentDerivations spec")?;
            s.delete_rewritten_segment_derivations(&spec)
        })
    }
    /// `readSegmentedLivePage(pageId)`: `{ id, body_generation, body_storage, title, type,
    /// body_flags }` or null.
    #[napi]
    pub fn read_segmented_live_page<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_segmented_live_page(page_id))
    }

    /// `listSegmentedRechunkCandidates(chunkerVersion, { sourceId?, slug? }?)`: page ids.
    #[napi]
    pub fn list_segmented_rechunk_candidates<'env>(
        &self,
        env: &'env Env,
        chunker_version: i64,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_segmented_rechunk_candidates(
                chunker_version,
                &arg(scope, "listSegmentedRechunkCandidates scope")?,
            )
        })
    }

    /// `readSegmentedRechunkPage(pageId)`: the segmented page row a re-chunk reads, or null.
    #[napi]
    pub fn read_segmented_rechunk_page<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_segmented_rechunk_page(page_id))
    }

    /// `listOccurrenceChunks(pageId, occurrences)`: the visible chunk rows of those occurrences.
    #[napi]
    pub fn list_occurrence_chunks<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        occurrences: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let occurrences: Vec<i64> = required(occurrences, "listOccurrenceChunks occurrences")?;
            s.list_occurrence_chunks(page_id, &occurrences)
        })
    }

    /// `restorePageUpdatedAt(pageId, updatedUs)`: `updatedUs` as microseconds since the epoch.
    #[napi]
    pub fn restore_page_updated_at<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        updated_us: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.restore_page_updated_at(page_id, &updated_us)
        })
    }

    /// `readSegmentedRewritePage(pageId)`: the page a live fence rewrite reads, or null.
    #[napi]
    pub fn read_segmented_rewrite_page<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_segmented_rewrite_page(page_id))
    }

    /// `restorePageDeletedAt(pageId, deletedAt)`: `deletedAt` as an ISO string.
    #[napi]
    pub fn restore_page_deleted_at<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        deleted_at: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.restore_page_deleted_at(page_id, &deleted_at)
        })
    }

    /// `lockSegmentedGenerationPage(pageId)`: the page's body columns, or null.
    #[napi]
    pub fn lock_segmented_generation_page<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.lock_segmented_generation_page(page_id))
    }

    /// `splitManifestGeneration(pageId, generation, stagingId)`: resolves `null`.
    #[napi]
    pub fn split_manifest_generation<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        generation: i64,
        staging_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.split_manifest_generation(page_id, generation, &staging_id)
        })
    }

    /// `publishRebuiltGeneration(pageId, generation, stagingId)`: resolves `null`.
    #[napi]
    pub fn publish_rebuilt_generation<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        generation: i64,
        staging_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.publish_rebuilt_generation(page_id, generation, &staging_id)
        })
    }

    /// `setSegmentedVersionHash(pageId, generation, contentHash, bodyBytes)`: resolves `null`.
    #[napi]
    pub fn set_segmented_version_hash<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        generation: i64,
        content_hash: String,
        body_bytes: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_segmented_version_hash(page_id, generation, &content_hash, body_bytes)
        })
    }

    /// `hasLiveSegmentedPage(sourceId, slug)`: a boolean.
    #[napi]
    pub fn has_live_segmented_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_live_segmented_page(&source_id, &slug))
    }

    /// `countSegmentedEmbedRows(pageId)`: `{ total, stale }` of the `embedding` column.
    #[napi]
    pub fn count_segmented_embed_rows<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_segmented_embed_rows(page_id))
    }

    /// `listSegmentedStaleRows(pageId, opts)`: `{ chunk_index, chunk_text, chunk_source }` rows.
    #[napi]
    pub fn list_segmented_stale_rows<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: gbrain_store::page_body::SegmentedStaleRowsOpts =
                required(opts, "listSegmentedStaleRows opts")?;
            s.list_segmented_stale_rows(page_id, &opts)
        })
    }

    /// `readSegmentChunkInputHashes(pageId, chunkIndexes)`: `{ chunk_index, embedding_input_hash }` rows.
    #[napi]
    pub fn read_segment_chunk_input_hashes<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        chunk_indexes: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let indexes: Vec<i64> =
                required(chunk_indexes, "readSegmentChunkInputHashes chunkIndexes")?;
            s.read_segment_chunk_input_hashes(page_id, &indexes)
        })
    }

    /// `installSegmentedVectors(pageId, model, updates)`: how many rows took a vector.
    #[napi]
    pub fn install_segmented_vectors<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        model: Option<String>,
        updates: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let updates: Vec<gbrain_store::page_body::SegmentedVectorInput> =
                required(updates, "installSegmentedVectors updates")?;
            s.install_segmented_vectors(page_id, model.as_deref(), &updates)
        })
    }

    /// `listLiveEmbedSegments(pageId)`: `{ occurrence_id, sha256, entry_state }` rows, sha256 as hex.
    #[napi]
    pub fn list_live_embed_segments<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_live_embed_segments(page_id))
    }

    /// `listSegmentChunkRows(pageId, occurrenceId)`: the sealed page's rows of one occurrence.
    #[napi]
    pub fn list_segment_chunk_rows<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        occurrence_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_segment_chunk_rows(page_id, occurrence_id)
        })
    }
}
