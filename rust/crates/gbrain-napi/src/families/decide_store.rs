//! The decide store: `decide_state`, `decide_spend`, `decision_receipts` and `decide_calibrations`.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON. Timestamps travel as ISO strings both ways; the shell makes them `Date`s.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readDecideState(key)`: resolves the stored value or null.
    #[napi]
    pub fn read_decide_state<'env>(
        &self,
        env: &'env Env,
        key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_decide_state(&key))
    }

    /// `upsertDecideState(key, value)`: resolves null. A null value is refused by the store.
    #[napi]
    pub fn upsert_decide_state<'env>(
        &self,
        env: &'env Env,
        key: String,
        value: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.upsert_decide_state(&key, value.as_deref()))
    }

    /// `deleteDecideState(key)`: resolves null.
    #[napi]
    pub fn delete_decide_state<'env>(
        &self,
        env: &'env Env,
        key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_decide_state(&key))
    }

    /// `ensureDecideState(key, value)`: resolves the value stored after the insert-if-absent.
    #[napi]
    pub fn ensure_decide_state<'env>(
        &self,
        env: &'env Env,
        key: String,
        value: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.ensure_decide_state(&key, value.as_deref()))
    }

    /// `insertDecideSpend(rows)`: resolves null. `rows` is an array of spend rows; a request id
    /// already recorded keeps its first row, and a refused row records none.
    #[napi]
    pub fn insert_decide_spend<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<gbrain_store::eval_capture::decide_store::DecideSpendInput> =
                required(rows, "insertDecideSpend rows")?;
            s.insert_decide_spend(&rows)
        })
    }

    /// `dailyDecideSpend(since)`: `since` is an ISO string; resolves `{ total, remote }`.
    #[napi]
    pub fn daily_decide_spend<'env>(
        &self,
        env: &'env Env,
        since: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.daily_decide_spend(&since))
    }

    /// `listDecideSpendBySlot()`: resolves `[{ slot, input_tokens, cost_usd, requests }]`.
    #[napi]
    pub fn list_decide_spend_by_slot<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_decide_spend_by_slot())
    }

    /// `insertDecideReceipts(rows)`: resolves null. A refused row records none of its batch.
    #[napi]
    pub fn insert_decide_receipts<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<gbrain_store::eval_capture::decide_store::DecideReceiptInput> =
                required(rows, "insertDecideReceipts rows")?;
            s.insert_decide_receipts(&rows)
        })
    }

    /// `pruneDecideReceipts(retentionDays)`: resolves the number of receipts deleted.
    #[napi]
    pub fn prune_decide_receipts<'env>(
        &self,
        env: &'env Env,
        retention_days: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.prune_decide_receipts(retention_days))
    }

    /// `listDecideReceiptStats(slot, sinceHours)`: `slot` is null for every slot.
    #[napi]
    pub fn list_decide_receipt_stats<'env>(
        &self,
        env: &'env Env,
        slot: Option<String>,
        since_hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_decide_receipt_stats(slot.as_deref(), since_hours)
        })
    }

    /// `decideSlotUsage(sinceHours)`.
    #[napi]
    pub fn decide_slot_usage<'env>(
        &self,
        env: &'env Env,
        since_hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.decide_slot_usage(since_hours))
    }

    /// `decideConflictNoEntityCounts(sinceHours)`: resolves `{ receipts, skipped }`.
    #[napi]
    pub fn decide_conflict_no_entity_counts<'env>(
        &self,
        env: &'env Env,
        since_hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.decide_conflict_no_entity_counts(since_hours)
        })
    }

    /// `listDecideReplayReceipts(slot, sinceHours)`.
    #[napi]
    pub fn list_decide_replay_receipts<'env>(
        &self,
        env: &'env Env,
        slot: String,
        since_hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_decide_replay_receipts(&slot, since_hours)
        })
    }

    /// `listDecideResolvedModels(sinceHours)`: `last_at` is an ISO string.
    #[napi]
    pub fn list_decide_resolved_models<'env>(
        &self,
        env: &'env Env,
        since_hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_decide_resolved_models(since_hours))
    }

    /// `listDecideMixedModelDecisions(sinceHours)`.
    #[napi]
    pub fn list_decide_mixed_model_decisions<'env>(
        &self,
        env: &'env Env,
        since_hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_decide_mixed_model_decisions(since_hours)
        })
    }

    /// `insertDecideCalibration(row)`: resolves the new id. A column left out is a null.
    #[napi]
    pub fn insert_decide_calibration<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: gbrain_store::eval_capture::decide_store::DecideCalibrationInput =
                required(row, "insertDecideCalibration row")?;
            s.insert_decide_calibration(&row)
        })
    }

    /// `storeDecideQualification(id, q)`: resolves null, also for an id with no row.
    #[napi]
    pub fn store_decide_qualification<'env>(
        &self,
        env: &'env Env,
        id: f64,
        q: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::eval_capture::decide_store::DecideQualificationInput =
                required(q, "storeDecideQualification q")?;
            s.store_decide_qualification(id, &q)
        })
    }

    /// `listDecideCalibrations(slot, includeRetired)`: `slot` is null for every slot; the
    /// timestamps are ISO strings.
    #[napi]
    pub fn list_decide_calibrations<'env>(
        &self,
        env: &'env Env,
        slot: Option<String>,
        include_retired: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_decide_calibrations(slot.as_deref(), include_retired)
        })
    }

    /// `getDecideCalibration(id)`: resolves the row or null.
    #[napi]
    pub fn get_decide_calibration<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_decide_calibration(id))
    }

    /// `setDecideCalibrationRetired(id, retired)`: resolves whether the row exists.
    #[napi]
    pub fn set_decide_calibration_retired<'env>(
        &self,
        env: &'env Env,
        id: f64,
        retired: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_decide_calibration_retired(id, retired))
    }
}
