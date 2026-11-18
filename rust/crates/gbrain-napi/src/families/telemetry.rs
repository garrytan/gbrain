//! Search telemetry (rust/docs/store/telemetry.md).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `recordSearchTelemetry(bucket)`: adds the bucket to its `(date, mode, intent)` row; resolves
    /// null.
    #[napi]
    pub fn record_search_telemetry<'env>(
        &self,
        env: &'env Env,
        bucket: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let bucket: gbrain_store::telemetry::SearchTelemetryBucket =
                required(bucket, "recordSearchTelemetry bucket")?;
            s.record_search_telemetry(&bucket)
        })
    }

    /// `readSearchStats(cutoffDate)`: the sums per `(mode, intent)` of the rows dated on or after
    /// `cutoffDate`; `first_seen` / `last_seen` are timestamp text.
    #[napi]
    pub fn read_search_stats<'env>(
        &self,
        env: &'env Env,
        cutoff_date: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_search_stats(cutoff_date.as_deref()))
    }
}
