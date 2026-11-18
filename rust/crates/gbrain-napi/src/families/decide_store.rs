//! The decide store: `decide_state`, `decide_spend`, `decision_receipts` and `decide_calibrations`.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON. Timestamps travel as ISO strings both ways; the shell makes them `Date`s.

use napi::bindgen_prelude::Object;
use napi::Env;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{required, Brain};

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
}
