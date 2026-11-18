//! The Wakeshift report-back tables (rust/docs/store/jobs-wake.md): watches, crons and their runs, terms
//! acceptances and forgets. Same shape as the methods in `ops.rs`.

use gbrain_store::jobs::{
    CronRunInput, EndSpec, ForgetClaimSpec, ForgetSettle, WatchFilter, WatchInsert, WatchSettle,
};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `openWakeWatch`.
    #[napi]
    pub fn open_wake_watch<'env>(&self, env: &'env Env, spec: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: WatchInsert = required(spec, "openWakeWatch spec")?;
            s.open_wake_watch(&spec)
        })
    }

    /// `listWakeWatches`.
    #[napi]
    pub fn list_wake_watches<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: WatchFilter = required(spec, "listWakeWatches spec")?;
            s.list_wake_watches(&spec)
        })
    }

    /// `endWakeWatches`.
    #[napi]
    pub fn end_wake_watches<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: EndSpec = required(spec, "endWakeWatches spec")?;
            s.end_wake_watches(&spec)
        })
    }

    /// `countWakeWatches()`.
    #[napi]
    pub fn count_wake_watches<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_wake_watches())
    }

    /// `readWakeDoctor()`.
    #[napi]
    pub fn read_wake_doctor<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_wake_doctor())
    }

    /// `countPendingWakeForgets()`.
    #[napi]
    pub fn count_pending_wake_forgets<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_pending_wake_forgets())
    }

    /// `listWakeCrons()`.
    #[napi]
    pub fn list_wake_crons<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_wake_crons())
    }

    /// `addWakeCron(name)`.
    #[napi]
    pub fn add_wake_cron<'env>(&self, env: &'env Env, name: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.add_wake_cron(&name))
    }

    /// `removeWakeCron(name)`: the watches it ended.
    #[napi]
    pub fn remove_wake_cron<'env>(
        &self,
        env: &'env Env,
        name: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.remove_wake_cron(&name))
    }

    /// `hasWakeCron(name)`.
    #[napi]
    pub fn has_wake_cron<'env>(&self, env: &'env Env, name: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_wake_cron(&name))
    }

    /// `recordWakeCronRun`.
    #[napi]
    pub fn record_wake_cron_run<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: CronRunInput = required(spec, "recordWakeCronRun spec")?;
            s.record_wake_cron_run(&spec)
        })
    }

    /// `hasWakeTermsAcceptance(principalKey, termsVersion)`.
    #[napi]
    pub fn has_wake_terms_acceptance<'env>(
        &self,
        env: &'env Env,
        principal_key: String,
        terms_version: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_wake_terms_acceptance(&principal_key, &terms_version)
        })
    }

    /// `recordWakeTermsAcceptance(principalKey, termsVersion)`.
    #[napi]
    pub fn record_wake_terms_acceptance<'env>(
        &self,
        env: &'env Env,
        principal_key: String,
        terms_version: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.record_wake_terms_acceptance(&principal_key, &terms_version)
        })
    }

    /// `listDueWakeWatches({ ids })`: `ids` null is every due watch.
    #[napi]
    pub fn list_due_wake_watches<'env>(
        &self,
        env: &'env Env,
        ids: Option<Vec<i64>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_due_wake_watches(ids.as_deref()))
    }

    /// `claimWakeWatch(id, leaseSeconds)`: `{ lease, attempts }` or null.
    #[napi]
    pub fn claim_wake_watch<'env>(
        &self,
        env: &'env Env,
        id: i64,
        lease_seconds: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.claim_wake_watch(id, lease_seconds))
    }

    /// `settleWakeWatch`.
    #[napi]
    pub fn settle_wake_watch<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: WatchSettle = required(spec, "settleWakeWatch spec")?;
            s.settle_wake_watch(&spec)
        })
    }

    /// `queueWakeForget(wakeUser, memberId)`.
    #[napi]
    pub fn queue_wake_forget<'env>(
        &self,
        env: &'env Env,
        wake_user: String,
        member_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.queue_wake_forget(&wake_user, member_id.as_deref())
        })
    }

    /// `claimWakeForgets`.
    #[napi]
    pub fn claim_wake_forgets<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: ForgetClaimSpec = required(spec, "claimWakeForgets spec")?;
            s.claim_wake_forgets(&spec)
        })
    }

    /// `settleWakeForget`.
    #[napi]
    pub fn settle_wake_forget<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: ForgetSettle = required(spec, "settleWakeForget spec")?;
            s.settle_wake_forget(&spec)
        })
    }
}
