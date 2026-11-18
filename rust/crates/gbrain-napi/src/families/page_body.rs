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

    /// Not a member: `{ lead, revision }` of page `pageId` for `sealSegmentedPage` (the stored
    /// timeline lead, `""` when none, and the page's knowledge revision), or `null` for a missing page.
    #[napi]
    pub fn read_segmented_seal_lead<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let lead =
                s.read_segmented_seal_lead(required(page_id, "readSegmentedSealLead pageId")?)?;
            Ok(lead
                .map(|(lead, revision)| serde_json::json!({ "lead": lead, "revision": revision })))
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

    /// `upsertSegmentDerivations(rows)`: resolves `null`.
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
}
