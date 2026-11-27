//! The reads `gbrain export` makes (gbrain-store `cli_reads::export`): the page-key batches, the
//! withdrawal ledger, the page rows, the fence normalization and the segmented-body reads.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use gbrain_store::cli_reads::export::ExportPageKeyQuery;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listExportPageKeys(q)`: the next 256 live pages after `q.afterId`, in id order, with each
    /// one's segmented flag, raw-row count and payload bytes.
    #[napi]
    pub fn list_export_page_keys<'env>(
        &self,
        env: &'env Env,
        q: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_export_page_keys(&required::<ExportPageKeyQuery>(q, "listExportPageKeys q")?)
        })
    }

    /// `readExportWithdrawalLedgerBytes(sourceId)`: the withdrawal ledger's size in bytes.
    #[napi]
    pub fn read_export_withdrawal_ledger_bytes<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_export_withdrawal_ledger_bytes(&source_id)
        })
    }

    /// `listExportWithdrawals(sourceId)`: the source's withdrawals, each with `purged` false.
    #[napi]
    pub fn list_export_withdrawals<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_export_withdrawals(&source_id))
    }

    /// `listPurgeTombstones(sourceId)`: `{ facts, takes }`, the source's purge tombstones with request, actor and reason.
    #[napi]
    pub fn list_purge_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_purge_tombstones(&source_id))
    }

    /// `readExportPageRows(ids)`: the live pages among `ids`, each `{ page, tags }`.
    #[napi]
    pub fn read_export_page_rows<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_export_page_rows(&required::<Vec<String>>(ids, "readExportPageRows ids")?)
        })
    }

    /// `normalizeFenceLines(bodies, timelines)`: each pair lower-cased and whitespace-folded per line.
    #[napi]
    pub fn normalize_fence_lines<'env>(
        &self,
        env: &'env Env,
        bodies: Value,
        timelines: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.normalize_fence_lines(
                &required::<Vec<String>>(bodies, "normalizeFenceLines bodies")?,
                &required::<Vec<String>>(timelines, "normalizeFenceLines timelines")?,
            )
        })
    }

    /// `readSegmentedPageHead(pageId)`: the page's segmented-body columns and revision, or null.
    #[napi]
    pub fn read_segmented_page_head<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_segmented_page_head(page_id))
    }

    /// `readBodyManifestRows(pageId, generation)`: a generation's published manifest rows in seq
    /// order; `generation` null reads the page's live one. `sha256` crosses as hex.
    #[napi]
    pub fn read_body_manifest_rows<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        generation: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_body_manifest_rows(page_id, generation))
    }

    /// `readBodyManifestMeta(pageId, occurrenceIds, generation)`: the entry state and protected
    /// regions of the named occurrences in one published generation.
    #[napi]
    pub fn read_body_manifest_meta<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        occurrence_ids: Vec<i64>,
        generation: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_body_manifest_meta(page_id, &occurrence_ids, generation)
        })
    }

    /// `listForcedCutSeqs(pageId, generation)`: the seqs of one published generation's rows that
    /// end at a forced cut, in seq order.
    #[napi]
    pub fn list_forced_cut_seqs<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        generation: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_forced_cut_seqs(page_id, generation))
    }

    /// `readManifestSeqAt(pageId, generation, byteOffset)`: the seq of the published row holding
    /// stored byte `byteOffset`, or null.
    #[napi]
    pub fn read_manifest_seq_at<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        generation: i64,
        byte_offset: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_manifest_seq_at(page_id, generation, byte_offset)
        })
    }

    /// `readSegmentedVersionBodyBytes(pageId, generation)`: the size the newest segmented version
    /// of the generation records, or null.
    #[napi]
    pub fn read_segmented_version_body_bytes<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        generation: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_segmented_version_body_bytes(page_id, generation)
        })
    }

    /// `readBodyManifestOutline(pageId, occurrenceIds, generation)`: the facts slots and stored
    /// outline of the named occurrences in one published generation.
    #[napi]
    pub fn read_body_manifest_outline<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        occurrence_ids: Vec<i64>,
        generation: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_body_manifest_outline(page_id, &occurrence_ids, generation)
        })
    }

    /// `listAccessPolicySourceIds()`: the sources, archived ones too, that hold access state, by id.
    #[napi]
    pub fn list_access_policy_source_ids<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_access_policy_source_ids())
    }
}
