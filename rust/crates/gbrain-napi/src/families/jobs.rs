//! The minion queue: job admission, claim, lease, finish and reclaim, and the cycle locks.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON. Job rows carry timestamps as ISO strings; the shell makes them `Date`s
//! (rust/docs/store/jobs.md).

mod checks;
mod health;
mod insight;
mod ops;
mod spend;
mod spend_log;
mod status;
mod subagent;
mod wake;

use gbrain_store::error::StoreError;
use gbrain_store::jobs::{AdmitSpec, ClaimSpec, ListFilter, LockAcquire, LockFilter, LockHolder};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

/// A job id from JavaScript: a whole number, as the `bigint` column takes.
pub(super) fn job_id(id: f64, what: &str) -> Result<i64, StoreError> {
    if id.fract() != 0.0 || !id.is_finite() || id.abs() > 9_007_199_254_740_991.0 {
        return Err(StoreError::invalid(format!(
            "{what}: id {id} is not a whole number"
        )));
    }
    Ok(id as i64)
}

#[napi]
impl Brain {
    /// `admitJob(spec)`: resolves `{ outcome: 'inserted'|'coalesced'|'conflict', row, audit }`.
    #[napi]
    pub fn admit_job<'env>(&self, env: &'env Env, spec: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: AdmitSpec = required(spec, "admitJob spec")?;
            s.admit_job(&spec)
        })
    }

    /// `getJob(id)`: the row, or null.
    #[napi]
    pub fn get_job<'env>(&self, env: &'env Env, id: f64) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_job(job_id(id, "getJob")?))
    }

    /// `listJobs(filter?)`: newest first.
    #[napi]
    pub fn list_jobs<'env>(
        &self,
        env: &'env Env,
        filter: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: ListFilter = arg(filter, "listJobs filter")?;
            s.list_jobs(&filter)
        })
    }

    /// `claimNextJob(spec)`: the claimed row, or null.
    #[napi]
    pub fn claim_next_job<'env>(&self, env: &'env Env, spec: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: ClaimSpec = required(spec, "claimNextJob spec")?;
            s.claim_next_job(&spec)
        })
    }

    /// `renewJobLease(id, lockToken, lockDurationMs)`: whether the lease moved.
    #[napi]
    pub fn renew_job_lease<'env>(
        &self,
        env: &'env Env,
        id: f64,
        lock_token: String,
        lock_duration_ms: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.renew_job_lease(job_id(id, "renewJobLease")?, &lock_token, lock_duration_ms)
        })
    }

    /// `completeJob(id, lockToken, result?)`: the completed row, or null.
    #[napi]
    pub fn complete_job<'env>(
        &self,
        env: &'env Env,
        id: f64,
        lock_token: String,
        result: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.complete_job(job_id(id, "completeJob")?, &lock_token, result.as_ref())
        })
    }

    /// `failJob(id, lockToken, errorText, newStatus, backoffMs?, result?)`: the failed row, or null.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn fail_job<'env>(
        &self,
        env: &'env Env,
        id: f64,
        lock_token: String,
        error_text: String,
        new_status: String,
        backoff_ms: Option<f64>,
        result: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.fail_job(
                job_id(id, "failJob")?,
                &lock_token,
                &error_text,
                &new_status,
                backoff_ms,
                result.as_ref(),
            )
        })
    }

    /// `reclaimStalledJobs(graceMs, suspectMark)`: `{ requeued, dead }`.
    #[napi]
    pub fn reclaim_stalled_jobs<'env>(
        &self,
        env: &'env Env,
        grace_ms: f64,
        suspect_mark: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.reclaim_stalled_jobs(grace_ms, &suspect_mark)
        })
    }

    /// `acquireCycleLock(lockId, opts)`: `{ id, fence }`, or null while the lease is held.
    #[napi]
    pub fn acquire_cycle_lock<'env>(
        &self,
        env: &'env Env,
        lock_id: String,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: LockAcquire = required(opts, "acquireCycleLock opts")?;
            s.acquire_cycle_lock(&lock_id, &opts)
        })
    }

    /// `refreshCycleLock(lockId, opts)`: whether this holder still had the lease.
    #[napi]
    pub fn refresh_cycle_lock<'env>(
        &self,
        env: &'env Env,
        lock_id: String,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: LockHolder = required(opts, "refreshCycleLock opts")?;
            s.refresh_cycle_lock(&lock_id, &opts)
        })
    }

    /// `releaseCycleLock(lockId, opts)` and `deleteCycleLock`: whether a row was deleted.
    #[napi]
    pub fn release_cycle_lock<'env>(
        &self,
        env: &'env Env,
        lock_id: String,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: LockHolder = required(opts, "releaseCycleLock opts")?;
            s.release_cycle_lock(&lock_id, &opts)
        })
    }

    /// `deleteCycleLockIfStale(lockId, opts)`: `{ deleted, lastRefreshedAt }`.
    #[napi]
    pub fn delete_cycle_lock_if_stale<'env>(
        &self,
        env: &'env Env,
        lock_id: String,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: LockHolder = required(opts, "deleteCycleLockIfStale opts")?;
            s.delete_cycle_lock_if_stale(&lock_id, &opts)
        })
    }

    /// `readCycleLocks(filter)`: the lease rows.
    #[napi]
    pub fn read_cycle_locks<'env>(
        &self,
        env: &'env Env,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: LockFilter = required(filter, "readCycleLocks filter")?;
            s.read_cycle_locks(&filter)
        })
    }

    /// `assertCycleLease(lockId, acquisitionToken)`: whether the lease is held and unexpired.
    #[napi]
    pub fn assert_cycle_lease<'env>(
        &self,
        env: &'env Env,
        lock_id: String,
        acquisition_token: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.assert_cycle_lease(&lock_id, &acquisition_token)
        })
    }
}
