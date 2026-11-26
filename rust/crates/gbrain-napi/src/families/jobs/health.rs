//! Jobs: the queue health reads (rust/docs/store/jobs-health.md). Same shape as `ops.rs`.

use gbrain_store::jobs::{DivergenceSpec, HealthSpec};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readQueueHealthSignals(spec)`: `{ stalled, depth, rss_kills, prompt_too_long,
    /// old_embed_backfill }`.
    #[napi]
    pub fn read_queue_health_signals<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: HealthSpec = required(spec, "readQueueHealthSignals spec")?;
            s.read_queue_health_signals(&spec)
        })
    }

    /// `listWaitingByQueue()`: `{ queue, depth, oldest_age_seconds }` per queue.
    #[napi]
    pub fn list_waiting_by_queue<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_waiting_by_queue())
    }

    /// `readQueueDivergence({ windowHours, ttlReasonPrefix })`: `{ divergence, ttl_cancelled }`.
    #[napi]
    pub fn read_queue_divergence<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: DivergenceSpec = required(spec, "readQueueDivergence spec")?;
            s.read_queue_divergence(&spec)
        })
    }

    /// `listQueueWedgeCounts()`: one row per queue outside the private dream queues.
    #[napi]
    pub fn list_queue_wedge_counts<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_queue_wedge_counts())
    }

    /// `listPrivateQueueHealth()`: one row per dream-inline queue.
    #[napi]
    pub fn list_private_queue_health<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_private_queue_health())
    }

    /// `readWedgeSignals(queue, handlerNames)`: one queue's wedge signals.
    #[napi]
    pub fn read_wedge_signals<'env>(
        &self,
        env: &'env Env,
        queue: String,
        handler_names: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_wedge_signals(&queue, &handler_names))
    }

    /// `readOldestWaitingAge(queue)`: whole seconds, or null.
    #[napi]
    pub fn read_oldest_waiting_age<'env>(
        &self,
        env: &'env Env,
        queue: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_oldest_waiting_age(&queue))
    }

    /// `readUntakenWaitingJobs(name, thresholdHours)`: `{ queue, waiting, oldest_age_seconds }`,
    /// or null.
    #[napi]
    pub fn read_untaken_waiting_jobs<'env>(
        &self,
        env: &'env Env,
        name: String,
        threshold_hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_untaken_waiting_jobs(&name, threshold_hours)
        })
    }

    /// `countWaitingJobs(excludeFactsAbsorb)`: the waiting jobs.
    #[napi]
    pub fn count_waiting_jobs<'env>(
        &self,
        env: &'env Env,
        exclude_facts_absorb: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_waiting_jobs(exclude_facts_absorb))
    }

    /// `countWaitingJobsForNames(queue, names)`: the waiting jobs of the queue with one of the names.
    #[napi]
    pub fn count_waiting_jobs_for_names<'env>(
        &self,
        env: &'env Env,
        queue: String,
        names: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_waiting_jobs_for_names(&queue, &names))
    }

    /// `listStuckActiveJobsByName()`: `{ name, n }` per name.
    #[napi]
    pub fn list_stuck_active_jobs_by_name<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_stuck_active_jobs_by_name())
    }
}
