//! The extract rollup members `upsertExtractRollup`, `readExtractRollup7d` and
//! `listRecordedHaltReasons7d`: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::extract_rollup` (src/core/engine-sql/extract-bookkeeping.ts and doctor's
//! `extract_health` reads).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::extract_rollup::{ExtractRollupEvent, ExtractRollupQuery};

#[napi]
impl Brain {
    /// `upsertExtractRollup({ ...row, form })`: adds one event to its `(kind, source, day)` row;
    /// resolves null.
    #[napi]
    pub fn upsert_extract_rollup<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExtractRollupEvent = required(args, "upsertExtractRollup args")?;
            s.upsert_extract_rollup(&a)
        })
    }

    /// `readExtractRollup7d({ withExpected })`: resolves one summary row per extract kind. The JS name is
    /// set because the default casing would give `readExtractRollup7D`.
    #[napi(js_name = "readExtractRollup7d")]
    pub fn read_extract_rollup_7d<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExtractRollupQuery = required(args, "readExtractRollup7d args")?;
            s.read_extract_rollup_7d(&a)
        })
    }

    /// `listRecordedHaltReasons7d()`: resolves `{ kind, reason, n }` rows.
    #[napi(js_name = "listRecordedHaltReasons7d")]
    pub fn list_recorded_halt_reasons_7d<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_recorded_halt_reasons_7d())
    }
}
