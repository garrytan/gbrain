//! Extract bookkeeping: the receipt write's two page reads and the `extract_rollup_7d` day
//! upsert (rust/docs/store/extract-bookkeeping.md). Same shape as `extraction.rs`.

use gbrain_store::extract_bookkeeping::RollupDelta;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readExtractReceiptSlot(sourceId, slug)`: `{ type, source_path, source_uri,
    /// withheld_source_path }` or null.
    #[napi]
    pub fn read_extract_receipt_slot<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_extract_receipt_slot(&source_id, &slug))
    }

    /// `readExtractReceiptSeal(sourceId, slug, safeVersion)`: true, false or null.
    #[napi]
    pub fn read_extract_receipt_seal<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        safe_version: i32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let v = i16::try_from(safe_version).unwrap_or(i16::MAX);
            s.read_extract_receipt_seal(&source_id, &slug, v)
        })
    }

    /// `upsertExtractRollupDay(delta)`: adds the deltas to the `(kind, sourceId, day)` row.
    #[napi]
    pub fn upsert_extract_rollup_day<'env>(
        &self,
        env: &'env Env,
        delta: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let d: RollupDelta = required(delta, "upsertExtractRollupDay delta")?;
            s.upsert_extract_rollup_day(&d)
        })
    }

    /// The stored rollup rows of days on or after `since`, in key order (the 7-day extract rollup readers aggregate them).
    #[napi]
    pub fn list_extract_rollup_days<'env>(
        &self,
        env: &'env Env,
        since: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_extract_rollup_days(&since))
    }
}
