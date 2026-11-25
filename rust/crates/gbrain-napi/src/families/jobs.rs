//! The minion queue: job admission, claim, lease, finish and reclaim, and the cycle locks.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON. Job rows carry timestamps as ISO strings; the shell makes them `Date`s
//! (rust/docs/store/jobs.md).

mod access_tokens;
mod checks;
mod credential_binding;
mod credentials;
mod grants;
mod health;
mod insight;
mod ops;
mod pinned_questions;
mod revocation;
mod spend;
mod spend_log;
mod status;
mod subagent;
mod wake;

use gbrain_store::error::StoreError;
use gbrain_store::jobs::{
    AdmitSpec, ClaimSpec, ListFilter, LockAcquire, LockFilter, LockHolder, PageLeaseHolder,
    PageLeaseTake,
};
use gbrain_store::leases::LeaseToken;
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

    /// `readLiveJobIds(ids)`: the given ids whose job is still live, ascending.
    #[napi]
    pub fn read_live_job_ids<'env>(
        &self,
        env: &'env Env,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids = ids
                .into_iter()
                .map(|id| job_id(id, "readLiveJobIds"))
                .collect::<Result<Vec<_>, _>>()?;
            s.read_live_job_ids(&ids)
        })
    }

    /// `readDrainLeaseBeacon(lockToken)`: the holder record's beacon, or null.
    #[napi]
    pub fn read_drain_lease_beacon<'env>(
        &self,
        env: &'env Env,
        lock_token: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_drain_lease_beacon(&lock_token))
    }

    /// `writeDrainLeaseHolder(sourceId, lockToken, data, ttlMinutes)`: the new holder record's id.
    #[napi]
    pub fn write_drain_lease_holder<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        lock_token: String,
        data: Value,
        ttl_minutes: f64,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "writeDrainLeaseHolder fence")?;
            s.write_drain_lease_holder_fenced(
                &source_id,
                &lock_token,
                data,
                ttl_minutes,
                fence.as_ref(),
            )
        })
    }

    /// `refreshDrainLeaseHolder(lockToken, ttlMinutes)`: how many holder records it renewed.
    #[napi]
    pub fn refresh_drain_lease_holder<'env>(
        &self,
        env: &'env Env,
        lock_token: String,
        ttl_minutes: f64,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "refreshDrainLeaseHolder fence")?;
            s.refresh_drain_lease_holder_fenced(&lock_token, ttl_minutes, fence.as_ref())
        })
    }

    /// `releaseDrainLeaseHolder(lockToken)`: how many holder records it deleted.
    #[napi]
    pub fn release_drain_lease_holder<'env>(
        &self,
        env: &'env Env,
        lock_token: String,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "releaseDrainLeaseHolder fence")?;
            s.release_drain_lease_holder_fenced(&lock_token, fence.as_ref())
        })
    }

    /// `getJob(id)`: the row, or null.
    #[napi]
    pub fn get_job<'env>(&self, env: &'env Env, id: f64) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_job(job_id(id, "getJob")?))
    }

    /// `readJobDataByIdempotencyKey(key)`: `{ data }` of the row holding the key, or null.
    #[napi]
    pub fn read_job_data_by_idempotency_key<'env>(
        &self,
        env: &'env Env,
        key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.job_data_by_idempotency_key(&key))
    }

    /// `coalesceOnIdempotencyKey(key, authority)`: resolves `{ outcome: 'none'|'coalesced'|'released'|'conflict', row? }`.
    #[napi]
    pub fn coalesce_on_idempotency_key<'env>(
        &self,
        env: &'env Env,
        key: String,
        authority: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.coalesce_on_idempotency_key(&key, Some(&authority))
        })
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
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "renewJobLease fence")?;
            s.renew_job_lease_fenced(
                job_id(id, "renewJobLease")?,
                &lock_token,
                lock_duration_ms,
                fence.as_ref(),
            )
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
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "completeJob fence")?;
            s.complete_job_fenced(
                job_id(id, "completeJob")?,
                &lock_token,
                result.as_ref(),
                fence.as_ref(),
            )
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
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "failJob fence")?;
            s.fail_job_fenced(
                job_id(id, "failJob")?,
                &lock_token,
                &error_text,
                &new_status,
                backoff_ms,
                result.as_ref(),
                fence.as_ref(),
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
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "reclaimStalledJobs fence")?;
            s.reclaim_stalled_jobs_fenced(grace_ms, &suspect_mark, fence.as_ref())
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

    /// `takePageEmbeddingLease(leaseId, opts)`: whether the lease was free or expired and is now this holder's.
    #[napi]
    pub fn take_page_embedding_lease<'env>(
        &self,
        env: &'env Env,
        lease_id: String,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: PageLeaseTake = required(opts, "takePageEmbeddingLease opts")?;
            s.take_page_embedding_lease(&lease_id, &opts)
        })
    }

    /// `renewPageEmbeddingLease(leaseId, opts)`: whether the row still carried this token.
    #[napi]
    pub fn renew_page_embedding_lease<'env>(
        &self,
        env: &'env Env,
        lease_id: String,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: PageLeaseHolder = required(opts, "renewPageEmbeddingLease opts")?;
            s.renew_page_embedding_lease(&lease_id, &opts)
        })
    }

    /// `releasePageEmbeddingLease(leaseId, opts)`: this holder's row and every expired `embed-page:` row go.
    #[napi]
    pub fn release_page_embedding_lease<'env>(
        &self,
        env: &'env Env,
        lease_id: String,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: PageLeaseHolder = required(opts, "releasePageEmbeddingLease opts")?;
            s.release_page_embedding_lease(&lease_id, &opts)
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
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "assertCycleLease fence")?;
            s.assert_cycle_lease_fenced(&lock_id, &acquisition_token, fence.as_ref())
        })
    }
}
