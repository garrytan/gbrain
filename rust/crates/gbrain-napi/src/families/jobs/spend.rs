//! Jobs: the spend reservations and the lease-pressure log (rust/docs/store/jobs-spend.md). Same shape as `insight.rs`.

use gbrain_store::jobs::{ExpireScope, LeaseFilter, LeaseInsert, SpendInsert, SpendTreeSpec};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readJobSpendTree({ jobIds, owner })`: `[{ root, self, settled_cents, priced, unsettled }]`.
    #[napi]
    pub fn read_job_spend_tree<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: SpendTreeSpec = required(spec, "readJobSpendTree spec")?;
            s.read_job_spend_tree(&spec)
        })
    }

    /// `insertSpendReservation(row)`: null.
    #[napi]
    pub fn insert_spend_reservation<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: SpendInsert = required(row, "insertSpendReservation row")?;
            s.insert_spend_reservation(&row)
        })
    }

    /// `expireSpendReservations({ clientId, budgetKey })`: how many holds were marked expired.
    #[napi]
    pub fn expire_spend_reservations<'env>(
        &self,
        env: &'env Env,
        scope: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: ExpireScope = required(scope, "expireSpendReservations scope")?;
            s.expire_spend_reservations(&scope)
        })
    }

    /// `settleSpendReservation(id, actualCents)`: `{ outcome, ... }`.
    #[napi]
    pub fn settle_spend_reservation<'env>(
        &self,
        env: &'env Env,
        reservation_id: String,
        actual_cents: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.settle_spend_reservation(&reservation_id, actual_cents)
        })
    }

    /// `markSpendUsageUnknown(id, reason)`: whether a hold took the reason.
    #[napi]
    pub fn mark_spend_usage_unknown<'env>(
        &self,
        env: &'env Env,
        reservation_id: String,
        reason: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.mark_spend_usage_unknown(&reservation_id, &reason)
        })
    }

    /// `insertLeasePressure(row)`: null.
    #[napi]
    pub fn insert_lease_pressure<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: LeaseInsert = required(row, "insertLeasePressure row")?;
            s.insert_lease_pressure(&row)
        })
    }

    /// `countLeasePressure({ windowMs, jobId, leaseKey })`: a count.
    #[napi]
    pub fn count_lease_pressure<'env>(
        &self,
        env: &'env Env,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: LeaseFilter = required(filter, "countLeasePressure filter")?;
            s.count_lease_pressure(&filter)
        })
    }

    /// `listRecentLeasePressure(windowMs, limit)`: rows, newest first.
    #[napi]
    pub fn list_recent_lease_pressure<'env>(
        &self,
        env: &'env Env,
        window_ms: f64,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            if limit.fract() != 0.0 || !limit.is_finite() || limit.abs() > 9_007_199_254_740_991.0 {
                return Err(gbrain_store::error::StoreError::invalid(format!(
                    "listRecentLeasePressure: limit {limit} is not a whole number"
                )));
            }
            s.list_recent_lease_pressure(window_ms, limit as i64)
        })
    }
}
