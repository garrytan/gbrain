//! The request reads of the managed-sync orphan classification
//! (src/core/engine-sql/managed-sync-orphans.ts): one `#[napi] impl Brain` block over
//! `gbrain_store::persistence` (rust/docs/store/repair-bookkeeping.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listSourceRequestRows(sourceId)`: the source's requests with the columns the
    /// classification tests, in sequence order.
    #[napi]
    pub fn list_source_request_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_source_request_rows(&source_id))
    }

    /// `listFreshnessTargets(worktreeId, incarnation, windowHours, limit)`: the commit targets of
    /// the worktree's freshness samples, newest first.
    #[napi]
    pub fn list_freshness_targets<'env>(
        &self,
        env: &'env Env,
        worktree_id: String,
        incarnation: String,
        window_hours: f64,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_freshness_targets(
                &worktree_id,
                &incarnation,
                window_hours.floor() as i64,
                limit.max(1.0).floor() as usize,
            )
        })
    }
}
