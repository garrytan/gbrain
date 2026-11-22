//! Jobs: `oauth_clients` spend columns and `mcp_spend_log` (rust/docs/store/spend-log.md). Same shape as `spend.rs`.

use gbrain_store::jobs::{ClientInsert, ClientReserve, GroupReserve, LogInsert};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `reserveClientSpend(spec)`: `{ outcome, ... }`.
    #[napi]
    pub fn reserve_client_spend<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: ClientReserve = required(spec, "reserveClientSpend spec")?;
            s.reserve_client_spend(&spec)
        })
    }

    /// `reserveGroupSpend(spec)`: `{ outcome, ... }`.
    #[napi]
    pub fn reserve_group_spend<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: GroupReserve = required(spec, "reserveGroupSpend spec")?;
            s.reserve_group_spend(&spec)
        })
    }

    /// `readGroupSpendTotals(budgetKey)`: `{ committed_cents, overdue_cents, live_cents }`.
    #[napi]
    pub fn read_group_spend_totals<'env>(
        &self,
        env: &'env Env,
        budget_key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_group_spend_totals(&budget_key))
    }

    /// `settleSpendWithLog(id, actualCents, operation, tokenName)`: `{ outcome }`.
    #[napi]
    pub fn settle_spend_with_log<'env>(
        &self,
        env: &'env Env,
        reservation_id: String,
        actual_cents: f64,
        operation: String,
        token_name: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.settle_spend_with_log(
                &reservation_id,
                actual_cents,
                &operation,
                token_name.as_deref(),
            )
        })
    }

    /// `insertSpendLog(row)`: null.
    #[napi]
    pub fn insert_spend_log<'env>(&self, env: &'env Env, row: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: LogInsert = required(row, "insertSpendLog row")?;
            s.insert_spend_log(&row)
        })
    }

    /// `sumClientSpendSince(clientId, since)`: the sum, in cents.
    #[napi]
    pub fn sum_client_spend_since<'env>(
        &self,
        env: &'env Env,
        client_id: String,
        since: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.sum_client_spend_since(&client_id, &since))
    }

    /// `readAgentClientSpend()`: `[{ client_id, ... }]`.
    #[napi]
    pub fn read_agent_client_spend<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_agent_client_spend())
    }

    /// `insertOauthClient(row)`: null.
    #[napi]
    pub fn insert_oauth_client<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: ClientInsert = required(row, "insertOauthClient row")?;
            s.insert_oauth_client(&row)
        })
    }

    /// `updateOauthClientBudget(clientId, usd)`: whether the client exists.
    #[napi]
    pub fn update_oauth_client_budget<'env>(
        &self,
        env: &'env Env,
        client_id: String,
        usd: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.update_oauth_client_budget(&client_id, usd))
    }

    /// `readClientBudgetUsd(clientId)`: the cap as text, or null.
    #[napi]
    pub fn read_client_budget_usd<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_client_budget_usd(&client_id))
    }
}
