//! The commit notifier: the host lease (claim, read, fencing check, release), the host source list, the per-source
//! state and coverage rows and the freshness status rows (rust/docs/store/persistence.md, "Commit notifier").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `claimNotifierLease({ hostId, ownerId, kind, pid, leaseMs })`: `{ owner: true, fence }`, or
    /// `{ owner: false, holder }` when another resident holds a live lease.
    #[napi]
    pub fn claim_notifier_lease<'env>(
        &self,
        env: &'env Env,
        claim: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.claim_notifier_lease(&required(claim, "claimNotifierLease claim")?)
        })
    }

    /// `readNotifierLease(hostId)`: the host's lease row, or null.
    #[napi]
    pub fn read_notifier_lease<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_notifier_lease(&host_id))
    }

    /// `holdsNotifierLease(hostId, ownerId, fence)`: the fencing check.
    #[napi]
    pub fn holds_notifier_lease<'env>(
        &self,
        env: &'env Env,
        host_id: String,
        owner_id: String,
        fence: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.holds_notifier_lease(&host_id, &owner_id, fence)
        })
    }

    /// `releaseNotifierLease(hostId, ownerId)`: expires the caller's own lease now.
    #[napi]
    pub fn release_notifier_lease<'env>(
        &self,
        env: &'env Env,
        host_id: String,
        owner_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.release_notifier_lease(&host_id, &owner_id))
    }

    /// `listNotifierHostSourceRows()`: every source that is not archived, in id order.
    #[napi]
    pub fn list_notifier_host_source_rows<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_notifier_host_source_rows())
    }

    /// `readNotifierSources(sourceIds)`: the per-source rows of `sourceIds` (every row when null).
    #[napi]
    pub fn read_notifier_sources<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Option<Vec<String>> = arg(source_ids, "readNotifierSources sourceIds")?;
            s.read_notifier_sources(ids.as_deref())
        })
    }

    /// `writeNotifierState(sourceId, patch)`: one state transition of a source.
    #[napi]
    pub fn write_notifier_state<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        patch: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_notifier_state(&source_id, &required(patch, "writeNotifierState patch")?)
        })
    }

    /// `writeNotifierCoverage(sourceId, coverage)`: the source's coverage record.
    #[napi]
    pub fn write_notifier_coverage<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        coverage: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_notifier_coverage(
                &source_id,
                &required(coverage, "writeNotifierCoverage coverage")?,
            )
        })
    }

    /// `recordNotifierSyncerHost(sourceId, hostId)`: the host that advanced a classic source.
    #[napi]
    pub fn record_notifier_syncer_host<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.record_notifier_syncer_host(&source_id, &host_id)
        })
    }

    /// `readNotifierStatusRows(sourceIds)`: the status rows of the sources that are not archived.
    #[napi]
    pub fn read_notifier_status_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Option<Vec<String>> = arg(source_ids, "readNotifierStatusRows sourceIds")?;
            s.read_notifier_status_rows(ids.as_deref())
        })
    }

    /// `hasNotifierCoverage()`: some source has a coverage record.
    #[napi]
    pub fn has_notifier_coverage<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_notifier_coverage())
    }
}
