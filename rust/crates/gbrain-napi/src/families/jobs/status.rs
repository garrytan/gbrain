//! The job status reads (`readLastAutopilotCycles` and the rest of `src/core/engine-sql/jobs-status.ts`).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool and resolves plain JSON.
//! Timestamps are ISO strings (the shell revives them); counts are numbers.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use super::job_id;
use crate::store_binding::{Brain, arg, required};
use gbrain_store::jobs::StatusFilter;

#[napi]
impl Brain {
    /// `readLastAutopilotCycles()`: `{ full, targeted }`, each a row or null.
    #[napi]
    pub fn read_last_autopilot_cycles<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_last_autopilot_cycles())
    }

    /// `countJobsByStatus(filter?)`: `{ status, count }` rows.
    #[napi]
    pub fn count_jobs_by_status<'env>(
        &self,
        env: &'env Env,
        filter: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: StatusFilter = arg(filter, "countJobsByStatus filter")?;
            s.count_jobs_by_status(&filter)
        })
    }

    /// `readWaitingQueueDepths()`: `{ queue, depth, oldest_waiting_age_seconds }` rows.
    #[napi]
    pub fn read_waiting_queue_depths<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_waiting_queue_depths())
    }

    /// `readLastFinishedJobAt(name)`: UTC ISO seconds or null.
    #[napi]
    pub fn read_last_finished_job_at<'env>(
        &self,
        env: &'env Env,
        name: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_last_finished_job_at(&name))
    }

    /// `listRecentSourceCycleFailures(cutoff, sourceId)`: `{ source_id, fail_count, last_failed_at }` rows by source id.
    #[napi]
    pub fn list_recent_source_cycle_failures<'env>(
        &self,
        env: &'env Env,
        cutoff: String,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_recent_source_cycle_failures(&cutoff, source_id.as_deref())
        })
    }

    /// `readLastCompletedJobAt()`: an ISO string or null.
    #[napi]
    pub fn read_last_completed_job_at<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_last_completed_job_at())
    }

    /// `countTtlCancelledByName(reasonLike, withinSeconds)`: `{ name, count }` rows.
    #[napi]
    pub fn count_ttl_cancelled_by_name<'env>(
        &self,
        env: &'env Env,
        reason_like: String,
        within_seconds: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_ttl_cancelled_by_name(&reason_like, within_seconds)
        })
    }

    /// `readWaitingScopeState({ name, queue, jobId })`: `{ waiting, live_id, age_min }`.
    #[napi]
    pub fn read_waiting_scope_state<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let name: String = required(spec["name"].clone(), "readWaitingScopeState name")?;
            let queue: String = required(spec["queue"].clone(), "readWaitingScopeState queue")?;
            let id: f64 = required(spec["jobId"].clone(), "readWaitingScopeState jobId")?;
            s.read_waiting_scope_state(&name, &queue, job_id(id, "readWaitingScopeState")?)
        })
    }

    /// `countRecentCompletedJobs(name, withinSeconds)`: a number.
    #[napi]
    pub fn count_recent_completed_jobs<'env>(
        &self,
        env: &'env Env,
        name: String,
        within_seconds: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_recent_completed_jobs(&name, within_seconds)
        })
    }

    /// `listRecentFailedJobErrors(withinSeconds)`: `{ id, last_error }` rows.
    #[napi]
    pub fn list_recent_failed_job_errors<'env>(
        &self,
        env: &'env Env,
        within_seconds: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_recent_failed_job_errors(within_seconds)
        })
    }

    /// `listBudgetOwnerJobs()`: `{ owner_id, remaining_cents }` of the newest five live budget owners.
    #[napi]
    pub fn list_budget_owner_jobs<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_budget_owner_jobs())
    }

    /// `readQueuedPageChars({ name, queue, maxChars })`: a number or null.
    #[napi]
    pub fn read_queued_page_chars<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let name: String = required(spec["name"].clone(), "readQueuedPageChars name")?;
            let queue: String = required(spec["queue"].clone(), "readQueuedPageChars queue")?;
            let max: f64 = required(spec["maxChars"].clone(), "readQueuedPageChars maxChars")?;
            s.read_queued_page_chars(&name, &queue, max.floor() as i64)
        })
    }

    /// `readSourceJobCounts(failedWithinSeconds)`: one row per source.
    #[napi]
    pub fn read_source_job_counts<'env>(
        &self,
        env: &'env Env,
        failed_within_seconds: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_source_job_counts(failed_within_seconds)
        })
    }

    /// `readEmbedBackfillBySource(sourceIds)`: one row per source with an embed-backfill job.
    #[napi]
    pub fn read_embed_backfill_by_source<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_embed_backfill_by_source(&source_ids))
    }
}
