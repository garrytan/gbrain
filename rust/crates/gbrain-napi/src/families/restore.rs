//! Restore safety: the census of a restored brain and the one transaction that makes it safe to
//! publish (`gbrain-store/src/restore.rs`). Run only by `gbrain backup restore`, on a store the
//! restore opened itself; neither is a `BrainEngine` member.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `restoreCensus(purgeRequestIds)`: the `Census` (store identity, unfinished work, authority,
    /// sources, settings, purges, unclassified records and the named `blockers`).
    #[napi]
    pub fn restore_census<'env>(
        &self,
        env: &'env Env,
        purge_request_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.restore_census(&required::<Vec<String>>(
                purge_request_ids,
                "restoreCensus purgeRequestIds",
            )?)
        })
    }

    /// `restoreQuarantine(plan)`: the `QuarantineReport` of one write transaction. Rejects
    /// `restore_refused` (a blocker stands), `invalid_argument` (the plan does not match the store)
    /// or `invalid_state` (that restore id was already applied); each leaves the store as it was.
    #[napi]
    pub fn restore_quarantine<'env>(
        &self,
        env: &'env Env,
        plan: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.restore_quarantine(&required(plan, "restoreQuarantine plan")?)
        })
    }
}
