//! The chronicle ledger: the decision upsert, the judge slot and the rollup members of
//! `engine-sql/chronicle-ledger.ts` (rust/docs/store/chronicle-ledger.md).

use gbrain_store::chronicle_ledger::{ChronicleJudgeKey, ChronicleRowInput};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `upsertChronicleRow(w)`: resolves true when the row was written.
    #[napi]
    pub fn upsert_chronicle_row<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: ChronicleRowInput = required(row, "upsertChronicleRow row")?;
            s.upsert_chronicle_row(&row)
        })
    }

    /// `reserveChronicleJudgeSlot(limit, key)`: resolves true when a slot was taken.
    #[napi]
    pub fn reserve_chronicle_judge_slot<'env>(
        &self,
        env: &'env Env,
        limit: i64,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: ChronicleJudgeKey = required(key, "reserveChronicleJudgeSlot key")?;
            s.reserve_chronicle_judge_slot(limit, &key)
        })
    }

    /// `readChronicleLedger()`: `{ counts, reasons, calls, principals }` of the automatic rows.
    #[napi]
    pub fn read_chronicle_ledger<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_chronicle_ledger())
    }

    /// `hasChronicleSkipDecision(decision)`: whether the ledger records that skip decision.
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
}
