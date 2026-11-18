//! Jobs: the subagent transcript and tool ledger (rust/docs/store/jobs-subagent.md). Same shape as
//! `ops.rs`; the JSON columns arrive as JSON text and the store parses them.

use gbrain_store::error::StoreError;
use gbrain_store::jobs::{FailureFallback, MessageInsert, ToolInsert, ToolStart, ToolTarget};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use super::job_id;
use crate::store_binding::{Brain, arg, required};

/// A list of job ids from JavaScript.
fn job_ids(ids: Vec<f64>, what: &str) -> Result<Vec<i64>, StoreError> {
    ids.into_iter().map(|id| job_id(id, what)).collect()
}

#[napi]
impl Brain {
    // ---------------------------------------------------------------- messages

    /// `listSubagentMessages(jobId, { last })`: the job's messages by `message_idx`, `ended_at` as ISO text.
    #[napi]
    pub fn list_subagent_messages<'env>(
        &self,
        env: &'env Env,
        job: f64,
        last: Option<bool>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_subagent_messages(job_id(job, "listSubagentMessages")?, last.unwrap_or(false))
        })
    }

    /// `countSubagentMessages(jobId)`.
    #[napi]
    pub fn count_subagent_messages<'env>(
        &self,
        env: &'env Env,
        job: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_subagent_messages(job_id(job, "countSubagentMessages")?)
        })
    }

    /// `insertSubagentMessage(jobId, message)`: resolves null.
    #[napi]
    pub fn insert_subagent_message<'env>(
        &self,
        env: &'env Env,
        job: f64,
        message: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let message: MessageInsert = required(message, "insertSubagentMessage message")?;
            s.insert_subagent_message(job_id(job, "insertSubagentMessage")?, &message)
        })
    }

    // ---------------------------------------------------------------- tool ledger reads

    /// `listSubagentToolExecutions(jobId, 'replay' | 'id')`: the job's tool rows.
    #[napi]
    pub fn list_subagent_tool_executions<'env>(
        &self,
        env: &'env Env,
        job: f64,
        replay: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_subagent_tool_executions(job_id(job, "listSubagentToolExecutions")?, replay)
        })
    }

    /// `hasSubagentToolExecution(jobId, { status, toolUseIdPrefix })`.
    #[napi]
    pub fn has_subagent_tool_execution<'env>(
        &self,
        env: &'env Env,
        job: f64,
        status: Option<String>,
        tool_use_id_prefix: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_subagent_tool_execution(
                job_id(job, "hasSubagentToolExecution")?,
                status.as_deref(),
                tool_use_id_prefix.as_deref(),
            )
        })
    }

    /// `listSubagentWriteOutcomes(jobId, toolUseIdPrefix?)`: `{ status, error, output }` per put.
    #[napi]
    pub fn list_subagent_write_outcomes<'env>(
        &self,
        env: &'env Env,
        job: f64,
        tool_use_id_prefix: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_subagent_write_outcomes(
                job_id(job, "listSubagentWriteOutcomes")?,
                tool_use_id_prefix.as_deref(),
            )
        })
    }

    /// `listSubagentOneshotLedger(jobId, toolUseIdPrefix)`: the ledger rows with their input fields as text.
    #[napi]
    pub fn list_subagent_oneshot_ledger<'env>(
        &self,
        env: &'env Env,
        job: f64,
        tool_use_id_prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_subagent_oneshot_ledger(
                job_id(job, "listSubagentOneshotLedger")?,
                &tool_use_id_prefix,
            )
        })
    }

    /// `summarizeSubagentToolExecutions(jobIds, { toolName, status })`: `{ count, output_bytes }`.
    #[napi]
    pub fn summarize_subagent_tool_executions<'env>(
        &self,
        env: &'env Env,
        jobs: Vec<f64>,
        tool_name: String,
        status: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.summarize_subagent_tool_executions(
                &job_ids(jobs, "summarizeSubagentToolExecutions")?,
                &tool_name,
                &status,
            )
        })
    }

    // ---------------------------------------------------------------- dream provenance reads

    /// `listSubagentPutPageSlugs(jobIds)`: the distinct slugs, NULL last.
    #[napi]
    pub fn list_subagent_put_page_slugs<'env>(
        &self,
        env: &'env Env,
        jobs: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_subagent_put_page_slugs(&job_ids(jobs, "listSubagentPutPageSlugs")?)
        })
    }

    /// `listSubagentPutPageWrites(jobIds)`: `{ job_id, slug, started_at }` per completed put.
    #[napi]
    pub fn list_subagent_put_page_writes<'env>(
        &self,
        env: &'env Env,
        jobs: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_subagent_put_page_writes(&job_ids(jobs, "listSubagentPutPageWrites")?)
        })
    }

    /// `listSubagentRetainedPutPages(jobIds)`: the committed puts with their job's idempotency key.
    #[napi]
    pub fn list_subagent_retained_put_pages<'env>(
        &self,
        env: &'env Env,
        jobs: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_subagent_retained_put_pages(&job_ids(jobs, "listSubagentRetainedPutPages")?)
        })
    }

    /// `listSubagentStagedPages(jobId)`: `{ slug, content }` per staged slug.
    #[napi]
    pub fn list_subagent_staged_pages<'env>(
        &self,
        env: &'env Env,
        job: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_subagent_staged_pages(job_id(job, "listSubagentStagedPages")?)
        })
    }

    /// `listSubagentTimelineAppendCalls(jobIds, sourceId)`: `{ request_id, slug, input }` per call.
    #[napi]
    pub fn list_subagent_timeline_append_calls<'env>(
        &self,
        env: &'env Env,
        jobs: Vec<f64>,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_subagent_timeline_append_calls(
                &job_ids(jobs, "listSubagentTimelineAppendCalls")?,
                &source_id,
            )
        })
    }

    // ---------------------------------------------------------------- tool ledger writes

    /// `recordSubagentToolExecutions(jobId, rows, { legacyGuard })`: resolves null.
    #[napi]
    pub fn record_subagent_tool_executions<'env>(
        &self,
        env: &'env Env,
        job: f64,
        rows: Value,
        legacy_guard: Option<bool>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<ToolInsert> = required(rows, "recordSubagentToolExecutions rows")?;
            s.record_subagent_tool_executions(
                job_id(job, "recordSubagentToolExecutions")?,
                &rows,
                legacy_guard.unwrap_or(false),
            )
        })
    }

    /// `startSubagentToolExecution(jobId, row)`: the stable id, or null.
    #[napi]
    pub fn start_subagent_tool_execution<'env>(
        &self,
        env: &'env Env,
        job: f64,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: ToolStart = required(row, "startSubagentToolExecution row")?;
            s.start_subagent_tool_execution(job_id(job, "startSubagentToolExecution")?, &row)
        })
    }

    /// `completeSubagentToolExecution(target, output)`: how many rows were settled.
    #[napi]
    pub fn complete_subagent_tool_execution<'env>(
        &self,
        env: &'env Env,
        target: Value,
        output: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let target: ToolTarget = required(target, "completeSubagentToolExecution target")?;
            s.complete_subagent_tool_execution(&target, &output)
        })
    }

    /// `failSubagentToolExecution(target, error, fallback?)`: how many rows were changed.
    #[napi]
    pub fn fail_subagent_tool_execution<'env>(
        &self,
        env: &'env Env,
        target: Value,
        error: String,
        fallback: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let target: ToolTarget = required(target, "failSubagentToolExecution target")?;
            let fallback: Option<FailureFallback> =
                arg(fallback, "failSubagentToolExecution fallback")?;
            s.fail_subagent_tool_execution(&target, &error, fallback.as_ref())
        })
    }
}
