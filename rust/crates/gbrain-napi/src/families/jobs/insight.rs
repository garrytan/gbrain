//! Jobs: the reads behind `describeJobs` (rust/docs/store/jobs-insight.md). Same shape as `ops.rs`.

use gbrain_store::jobs::InsightSpec;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readJobInsight({ jobIds, waitingIds, waitingQueues, parentIds, lockIds, holderQueue,
    /// holderLimit, owner })`: `{ meta, ahead, holders, children, locks, foreign_tokens }`.
    #[napi]
    pub fn read_job_insight<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: InsightSpec = required(spec, "readJobInsight spec")?;
            s.read_job_insight(&spec)
        })
    }
}
