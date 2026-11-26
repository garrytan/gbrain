//! Doctor-derived reads, third and fourth part: the page-state, body-tiling, ontology-fact and
//! derivation-receipt checks (store side: `gbrain_store::cli_reads::doctor_derived_health` and
//! `doctor_derived_ledgers`, docs in `rust/docs/store/cli-reads-doctor-derived.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readEmbeddingBacklogAge(column)`: `{ age_s, unaged, backfilled }`.
    #[napi]
    pub fn read_embedding_backlog_age<'env>(
        &self,
        env: &'env Env,
        column: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_embedding_backlog_age(&column))
    }

    /// `readEmbedBacklogRows(column, sourceIds)`: `{ source_id, pending, unaged, oldest }[]`.
    #[napi]
    pub fn read_embed_backlog_rows<'env>(
        &self,
        env: &'env Env,
        column: String,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_embed_backlog_rows(&column, &source_ids)
        })
    }

    /// `readAtomProvenanceCounts()`: the one aggregate row.
    #[napi]
    pub fn read_atom_provenance_counts<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_atom_provenance_counts())
    }

    /// `countCredentialProjectionPending(sourceIds?)`: `{ rebuildable, kept }`.
    #[napi]
    pub fn count_credential_projection_pending<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_credential_projection_pending(source_ids.as_deref())
        })
    }

    /// `readIgnoredPrivacyLabelCounts(sourceIds?)`: `{ key, raw, is_string, pages, scanned, groups }` rows.
    #[napi]
    pub fn read_ignored_privacy_label_counts<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_ignored_privacy_label_counts(source_ids.as_deref())
        })
    }

    /// `countDerivedVisibility(sourceIds)`: the six derived-visibility counts.
    #[napi]
    pub fn count_derived_visibility<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_derived_visibility(&source_ids))
    }

    /// `listUntiledSegmentedPageRows(sourceIds, slugs, limit)`: segmented pages whose rows do not tile the body.
    #[napi]
    pub fn list_untiled_segmented_page_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
        slugs: Option<Vec<String>>,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_untiled_segmented_page_rows(source_ids.as_deref(), slugs.as_deref(), limit)
        })
    }

    /// `listExtractionInputReceipts()`: `{ pipeline, kind, pages, samples }` rows.
    #[napi]
    pub fn list_extraction_input_receipts<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_extraction_input_receipts())
    }

    /// `listUnpricedDerivationModels()`: `{ model, pipelines, pages, samples }` rows.
    #[napi]
    pub fn list_unpriced_derivation_models<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_unpriced_derivation_models())
    }
}
