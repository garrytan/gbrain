//! Search telemetry, the MCP request log and the chat usage ledger (rust/docs/store/telemetry.md).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `recordSearchTelemetry(bucket)`: adds the bucket to its `(date, mode, intent)` row; resolves
    /// null.
    #[napi]
    pub fn record_search_telemetry<'env>(
        &self,
        env: &'env Env,
        bucket: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let bucket: gbrain_store::telemetry::SearchTelemetryBucket =
                required(bucket, "recordSearchTelemetry bucket")?;
            s.record_search_telemetry(&bucket)
        })
    }

    /// `readSearchStats(cutoffDate)`: the sums per `(mode, intent)` of the rows dated on or after
    /// `cutoffDate`; `first_seen` / `last_seen` are timestamp text.
    #[napi]
    pub fn read_search_stats<'env>(
        &self,
        env: &'env Env,
        cutoff_date: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_search_stats(cutoff_date.as_deref()))
    }

    /// `logMcpRequest(row)`: appends one request log row (`created_at` ISO text or null for now);
    /// resolves null.
    #[napi]
    pub fn log_mcp_request<'env>(&self, env: &'env Env, row: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: gbrain_store::telemetry::McpRequestLogInput =
                required(row, "logMcpRequest row")?;
            s.log_mcp_request(&row)
        })
    }

    /// `readMcpLogPruneCutoff(days)`: `{ rollup_present, cutoff }`, the cutoff as ISO text.
    #[napi]
    pub fn read_mcp_log_prune_cutoff<'env>(
        &self,
        env: &'env Env,
        days: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_mcp_log_prune_cutoff(days))
    }

    /// `pruneMcpRequestLogBatch(cutoff, keepOperations, limit)`: `{ deleted, newest }`, `newest` as
    /// ISO text or null.
    #[napi]
    pub fn prune_mcp_request_log_batch<'env>(
        &self,
        env: &'env Env,
        cutoff: Option<String>,
        keep_operations: Option<Vec<Option<String>>>,
        limit: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.prune_mcp_request_log_batch(cutoff.as_deref(), keep_operations.as_deref(), limit)
        })
    }

    /// `readClientOpUsage(days)`: `{ token_name, operation, n, last_seen }` rows, `last_seen` as ISO
    /// text.
    #[napi]
    pub fn read_client_op_usage<'env>(
        &self,
        env: &'env Env,
        days: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_client_op_usage(days))
    }

    /// `readMcpRollupPrunedBefore()`: `{ pruned_before, now }` as ISO text (`pruned_before` null
    /// when nothing was pruned).
    #[napi]
    pub fn read_mcp_rollup_pruned_before<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_mcp_rollup_pruned_before())
    }

    /// `countMcpRequestsLastDay(kind)`: the count of the last 24 hours.
    #[napi]
    pub fn count_mcp_requests_last_day<'env>(
        &self,
        env: &'env Env,
        kind: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_mcp_requests_last_day(&kind))
    }

    /// `readPendingWriteHealth()`: the in-flight writes, the oldest one's age, and the pending writes that later failed.
    #[napi]
    pub fn read_pending_write_health<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_pending_write_health())
    }

    /// `countMcpRequestsLastDayByToken(tokenNames)`: `{ token_name, requests }` rows.
    #[napi]
    pub fn count_mcp_requests_last_day_by_token<'env>(
        &self,
        env: &'env Env,
        token_names: Option<Vec<Option<String>>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_mcp_requests_last_day_by_token(token_names.as_deref())
        })
    }

    /// `readMcpLifetimeUsage(tokenNames)`: `{ token_name, requests, last_used_at }` rows,
    /// `last_used_at` as ISO text.
    #[napi]
    pub fn read_mcp_lifetime_usage<'env>(
        &self,
        env: &'env Env,
        token_names: Option<Vec<Option<String>>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_mcp_lifetime_usage(token_names.as_deref())
        })
    }

    /// `logChatUsage(row)`: appends one chat usage ledger row (`created_at` ISO text or null for
    /// now); resolves null.
    #[napi]
    pub fn log_chat_usage<'env>(&self, env: &'env Env, row: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: gbrain_store::chat_usage::ChatUsageInput = required(row, "logChatUsage row")?;
            s.log_chat_usage(&row)
        })
    }

    /// `readChatUsage(days)`: `{ rows, logged_since }`, the window sums per `(model, phase)` in cost
    /// order and the first logged time as timestamp text.
    #[napi]
    pub fn read_chat_usage<'env>(
        &self,
        env: &'env Env,
        days: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_chat_usage(days))
    }

    /// `readMcpRequestLogPage(spec)`: `{ rows, total }`, one page of the request log.
    #[napi]
    pub fn read_mcp_request_log_page<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::telemetry::McpRequestLogPageInput =
                required(input, "readMcpRequestLogPage input")?;
            s.read_mcp_request_log_page(&input)
        })
    }
}
