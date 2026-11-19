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
}
