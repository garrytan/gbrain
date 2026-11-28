//! The queue reads the doctor checks and the dream breaker make (rust/docs/store/jobs-checks.md).
//! Same shape as the methods in `ops.rs`.

use gbrain_store::jobs::{
    BuildSkewSpec, DeadDreamSpec, DeathsSpec, KeyPrefixSpec, QueuedSpendSpec, StillDeadSpec,
};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listStalledEmbedBackfillSources()`: source ids, a missing one as null, last.
    #[napi]
    pub fn list_stalled_embed_backfill_sources<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_stalled_embed_backfill_sources())
    }

    /// `readGlobalMaintenanceDeaths({ deaths })`: `{ recent, child_timeouts }`.
    #[napi]
    pub fn read_global_maintenance_deaths<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: DeathsSpec = required(spec, "readGlobalMaintenanceDeaths spec")?;
            s.read_global_maintenance_deaths(&spec)
        })
    }

    /// `readLastFailedGlobalMaintenanceJob(since)`: the newest failed job and the count, or null.
    #[napi]
    pub fn read_last_failed_global_maintenance_job<'env>(
        &self,
        env: &'env Env,
        since: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_last_failed_global_maintenance_job(since.as_deref())
        })
    }

    /// `readLastSyncJob(sourceId, freshSince)`: the newest sync job of a source, or null.
    #[napi]
    pub fn read_last_sync_job<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        fresh_since: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_last_sync_job(&source_id, fresh_since.as_deref())
        })
    }

    /// `listFactsAbsorbJobsStillDead({ hours, limit })`: `{ total, jobs }`.
    #[napi]
    pub fn list_facts_absorb_jobs_still_dead<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: StillDeadSpec = required(spec, "listFactsAbsorbJobsStillDead spec")?;
            s.list_facts_absorb_jobs_still_dead(&spec)
        })
    }

    /// `readLegacyJobAuthority()`: `{ live, active_ids, terminal_keyed }`.
    #[napi]
    pub fn read_legacy_job_authority<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_legacy_job_authority())
    }

    /// `readQueuedSpendRows({ legacyPrefixes, waitMs })`: `{ by_basis, waiting_ids }`.
    #[napi]
    pub fn read_queued_spend_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: QueuedSpendSpec = required(spec, "readQueuedSpendRows spec")?;
            s.read_queued_spend_rows(&spec)
        })
    }

    /// `listBuildSkewStacktraceLines({ prefix, windowHours, scanJobs })`: `{ id, line }` rows.
    #[napi]
    pub fn list_build_skew_stacktrace_lines<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: BuildSkewSpec = required(spec, "listBuildSkewStacktraceLines spec")?;
            s.list_build_skew_stacktrace_lines(&spec)
        })
    }

    /// `countDeadDreamSubmissionRows(spec)`: `{ base_key, dead_submissions, last_dead_at }` rows.
    #[napi]
    pub fn count_dead_dream_submission_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: DeadDreamSpec = required(spec, "countDeadDreamSubmissionRows spec")?;
            s.count_dead_dream_submission_rows(&spec)
        })
    }

    /// `listFactsAbsorbJobsByKeyPrefix({ prefix, keys })`: facts-absorb rows with `finished_at` as ISO text.
    #[napi]
    pub fn list_facts_absorb_jobs_by_key_prefix<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: KeyPrefixSpec = required(spec, "listFactsAbsorbJobsByKeyPrefix spec")?;
            s.list_facts_absorb_jobs_by_key_prefix(&spec)
        })
    }

    /// `listDeadFactsAbsorbJobsByKeys(keys)`: dead facts-absorb rows with `finished_at` as ISO text.
    #[napi]
    pub fn list_dead_facts_absorb_jobs_by_keys<'env>(
        &self,
        env: &'env Env,
        keys: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_dead_facts_absorb_jobs_by_keys(&keys))
    }
}
