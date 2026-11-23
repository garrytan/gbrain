//! The commit notifier: the host lease (claim, read, fencing check, release), the host source list, the per-source
//! state and coverage rows, the freshness status rows and the wanted markers (rust/docs/store/persistence.md, "Commit
//! notifier").

use gbrain_store::StoreError;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

/// A generation or job id, bound as a Postgres bigint: a whole number.
fn whole(v: f64, what: &str) -> Result<i64, StoreError> {
    if v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0 {
        Ok(v as i64)
    } else {
        Err(StoreError::invalid(format!(
            "{what} must be a whole number"
        )))
    }
}

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

    /// `upsertWantedMarker({ sourceId, intent, wantedHead, requestedBy, jobId })`: the marker row, or null when the
    /// source does not exist.
    #[napi]
    pub fn upsert_wanted_marker<'env>(
        &self,
        env: &'env Env,
        marker: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.upsert_wanted_marker(&required(marker, "upsertWantedMarker marker")?)
        })
    }

    /// `attachWantedMarkerJob(sourceId, intent, generation, jobId)`: names the marker's job at that generation.
    #[napi]
    pub fn attach_wanted_marker_job<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        intent: String,
        generation: f64,
        job_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.attach_wanted_marker_job(
                &source_id,
                &intent,
                whole(generation, "attachWantedMarkerJob generation")?,
                whole(job_id, "attachWantedMarkerJob jobId")?,
            )
        })
    }

    /// `readWantedMarkers(sourceIds)`: the markers of `sourceIds` (every marker when null), oldest first.
    #[napi]
    pub fn read_wanted_markers<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Option<Vec<String>> = arg(source_ids, "readWantedMarkers sourceIds")?;
            s.read_wanted_markers(ids.as_deref())
        })
    }

    /// `readDueWantedMarkers(sourceIds)`: the markers that still ask for work, oldest first.
    #[napi]
    pub fn read_due_wanted_markers<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Option<Vec<String>> = arg(source_ids, "readDueWantedMarkers sourceIds")?;
            s.read_due_wanted_markers(ids.as_deref())
        })
    }

    /// `readFirstDue(sourceIds)`: per source, the notifier's observed head and first due time.
    #[napi]
    pub fn read_first_due<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(source_ids, "readFirstDue sourceIds")?;
            s.read_first_due(&ids)
        })
    }

    /// `pruneSatisfiedWantedMarkers(sourceIds)`: deletes the markers whose head the source reached.
    #[napi]
    pub fn prune_satisfied_wanted_markers<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(source_ids, "pruneSatisfiedWantedMarkers sourceIds")?;
            s.prune_satisfied_wanted_markers(&ids)
        })
    }

    /// `clearWantedMarker(sourceId, intent, generation)`: true when the marker at that generation went.
    #[napi]
    pub fn clear_wanted_marker<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        intent: String,
        generation: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.clear_wanted_marker(
                &source_id,
                &intent,
                whole(generation, "clearWantedMarker generation")?,
            )
        })
    }

    /// `settleFreshnessMarker(sourceId, generation, checkoutHead)`: deletes a satisfied freshness marker.
    #[napi]
    pub fn settle_freshness_marker<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        generation: f64,
        checkout_head: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.settle_freshness_marker(
                &source_id,
                whole(generation, "settleFreshnessMarker generation")?,
                checkout_head.as_deref(),
            )
        })
    }

    /// `listSourceWantedMarkers(sourceId)`: the source's markers as the sync status notifier block lists them.
    #[napi]
    pub fn list_source_wanted_markers<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_source_wanted_markers(&source_id))
    }

    /// `readSourceSyncShape(sourceId)`: `{ local_path, root, bound }` for a live source, or null when it is missing
    /// or archived.
    #[napi]
    pub fn read_source_sync_shape<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_sync_shape(&source_id))
    }

    /// `readNotifierFirstDue(sourceIds)`: `{ source_id, observed_head, first_due_at }` per existing source.
    #[napi]
    pub fn read_notifier_first_due<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(source_ids, "readNotifierFirstDue sourceIds")?;
            s.read_notifier_first_due(&ids)
        })
    }
}
