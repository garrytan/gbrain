//! The commit notifier: the host lease and the host source list (rust/docs/store/persistence.md,
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

    /// `listNotifierHostSourceRows()`: every source that is not archived, in id order.
    #[napi]
    pub fn list_notifier_host_source_rows<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_notifier_host_source_rows())
    }
}
