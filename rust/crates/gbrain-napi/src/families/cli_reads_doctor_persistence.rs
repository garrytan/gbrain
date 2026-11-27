//! Doctor persistence reads: the typed members that replace the raw SQL of the persistence checks of
//! `gbrain doctor` (store side: `gbrain_store::cli_reads::doctor_persistence`, docs in
//! `rust/docs/store/cli-reads-doctor-per.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listCapacityCounters()`: the brain and principal counter rows as text.
    #[napi]
    pub fn list_capacity_counters<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.list_capacity_counters())
    }

    /// `listLifetimeCounters()`: `[{ key, lifetime_ids }]`.
    #[napi]
    pub fn list_lifetime_counters<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.list_lifetime_counters())
    }

    /// `countPersistenceRequestRows()`: `{ rows }`, exact.
    #[napi]
    pub fn count_persistence_request_rows<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.count_persistence_request_rows())
    }

    /// `readAdmissionSample(principal)`: both principal arguments null samples the whole brain.
    #[napi]
    pub fn read_admission_sample<'env>(
        &self,
        env: &'env Env,
        principal_kind: Option<String>,
        principal_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_admission_sample(principal_kind.as_deref().zip(principal_id.as_deref()))
        })
    }

    /// `listOutstandingHolders(principal)`: both principal arguments null reads the whole brain.
    #[napi]
    pub fn list_outstanding_holders<'env>(
        &self,
        env: &'env Env,
        principal_kind: Option<String>,
        principal_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_outstanding_holders(principal_kind.as_deref().zip(principal_id.as_deref()))
        })
    }

    /// `listRunningRequestStalls(maxClaimMs)`.
    #[napi]
    pub fn list_running_request_stalls<'env>(
        &self,
        env: &'env Env,
        max_claim_ms: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_running_request_stalls(max_claim_ms))
    }

    /// `readMaxRequestSequence()`: the newest sequence as text, or null.
    #[napi]
    pub fn read_max_request_sequence<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.read_max_request_sequence())
    }

    /// `listRecentDriftReceiptSlugs(sourceId, floor, message)`.
    #[napi]
    pub fn list_recent_drift_receipt_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        floor: String,
        message: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_recent_drift_receipt_slugs(&source_id, &floor, &message)
        })
    }

    /// `listOlderDriftReceiptSlugs(sourceId, floor, message)`.
    #[napi]
    pub fn list_older_drift_receipt_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        floor: String,
        message: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_older_drift_receipt_slugs(&source_id, &floor, &message)
        })
    }

    /// `listRefusalBreakerRows(sourceId, windowHours, threshold, limit)`.
    #[napi]
    pub fn list_refusal_breaker_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        window_hours: f64,
        threshold: i64,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_refusal_breaker_rows(&source_id, window_hours, threshold, limit)
        })
    }

    /// `readCounterDrift(clampedKey)`.
    #[napi]
    pub fn read_counter_drift<'env>(
        &self,
        env: &'env Env,
        clamped_key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_counter_drift(&clamped_key))
    }

    /// `readPublicationRefusals()`: `{ guard, trigger, opaque }`.
    #[napi]
    pub fn read_publication_refusals<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.read_publication_refusals())
    }

    /// `listRunningClaimOwners(hostId)`; a null host answers the claims on no worktree only (managed mode held back).
    #[napi]
    pub fn list_running_claim_owners<'env>(
        &self,
        env: &'env Env,
        host_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_running_claim_owners(host_id.as_deref())
        })
    }

    /// `listLocalEditAdoptions()`.
    #[napi]
    pub fn list_local_edit_adoptions<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.list_local_edit_adoptions())
    }

    /// `listCallerRefusalRows(sourceIds, operations)`.
    #[napi]
    pub fn list_caller_refusal_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        operations: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_caller_refusal_rows(&source_ids, &operations)
        })
    }

    /// `countCompactedCallerRefusals(sourceIds, operations)`: a count.
    #[napi]
    pub fn count_compacted_caller_refusals<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        operations: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_compacted_caller_refusals(&source_ids, &operations)
        })
    }

    /// `listRecentWriterVersions(days)`.
    #[napi]
    pub fn list_recent_writer_versions<'env>(
        &self,
        env: &'env Env,
        days: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_recent_writer_versions(days))
    }
}
