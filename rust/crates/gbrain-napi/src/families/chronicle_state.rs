//! The write-time reads of the chronicle ledger: `readChronicleRow`, the add_link pending read, `hasExtractedEvents`,
//! the daily judge count and the segmented truth lead of `engine-sql/chronicle-ledger.ts`
//! (rust/docs/store/chronicle-ledger.md).

use gbrain_store::chronicle_ledger::ChronicleRowInput;
use gbrain_store::chronicle_state::ChronicleRowKey;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `upsertChronicleRow(w)` with the SQL engines' foreign keys: refuses `source_not_found` / `page_not_found` and
    /// writes nothing when the row's source or page is missing; otherwise resolves true when the row was written.
    #[napi]
    pub fn upsert_chronicle_row_checked<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: ChronicleRowInput = required(row, "upsertChronicleRow row")?;
            s.upsert_chronicle_row_checked(&row)
        })
    }

    /// `readChronicleRow(key)`: the row (`SELECT *` columns, `decided_at` and `updated_at` as ISO text) or `null`.
    #[napi]
    pub fn read_chronicle_row<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: ChronicleRowKey = required(key, "readChronicleRow key")?;
            s.read_chronicle_row(&key)
        })
    }

    /// `hasPendingAutoChronicleRow(sourceId, pageId, extractorVersion)`: a boolean.
    #[napi]
    pub fn has_pending_auto_chronicle_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_id: i64,
        extractor_version: i32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_pending_auto_chronicle_row(&source_id, page_id, extractor_version)
        })
    }

    /// `hasExtractedEvents(sourceId, pageId)`: a boolean.
    #[napi]
    pub fn has_extracted_events<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_extracted_events(&source_id, page_id))
    }

    /// `hasChronicleSkipDecision(sourceId, pageId, contentHash, extractorVersion, reason)`: a boolean.
    #[napi]
    pub fn has_chronicle_skip_decision<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_id: i64,
        content_hash: String,
        extractor_version: i32,
        reason: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_chronicle_skip_decision(
                &source_id,
                page_id,
                &content_hash,
                extractor_version,
                &reason,
            )
        })
    }

    /// `countRecentChronicleReservations()`: the judge reservations of the last 24 hours.
    #[napi]
    pub fn count_recent_chronicle_reservations<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_recent_chronicle_reservations())
    }

    /// `readPageTruthLead(pageId)`: the segmented page's truth lead, or `null`.
    #[napi]
    pub fn read_page_truth_lead<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_truth_lead(page_id))
    }
}
