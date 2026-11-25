//! The page batch of `chronicle-backfill`: `readChronicleBackfillBatch` of
//! `engine-sql/chronicle-reads.ts` (rust/docs/store/chronicle-reads.md).

use gbrain_store::chronicle_reads::ChronicleBackfillBatchQuery;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readChronicleBackfillBatch(q)`: the page rows (`effective_date` as ISO text), each with `done`.
    #[napi]
    pub fn read_chronicle_backfill_batch<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: ChronicleBackfillBatchQuery =
                required(query, "readChronicleBackfillBatch query")?;
            s.read_chronicle_backfill_batch(&query)
        })
    }
}
