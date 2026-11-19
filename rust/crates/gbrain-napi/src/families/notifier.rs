//! The commit notifier: the host lease (claim, read, fencing check, release) and the host source list (rust/docs/store/persistence.md,
//! "Commit notifier").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

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
}
