//! Doctor reads, second set: the request-log members of `gbrain doctor` checks
//! (store side: `gbrain_store::cli_reads::doctor_acc`, docs in `rust/docs/store/cli-reads-doctor-acc.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readMcpRequestLogBytes()`: a byte count.
    #[napi]
    pub fn read_mcp_request_log_bytes<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_mcp_request_log_bytes())
    }

    /// `countMcpRequestLogRows(limit)`: a count bounded by `limit`.
    #[napi]
    pub fn count_mcp_request_log_rows<'env>(
        &self,
        env: &'env Env,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_mcp_request_log_rows(limit))
    }

    /// `hasMcpLogRowsPastWindow(days, keepOperations)`: a boolean.
    #[napi]
    pub fn has_mcp_log_rows_past_window<'env>(
        &self,
        env: &'env Env,
        days: f64,
        keep_operations: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_mcp_log_rows_past_window(days, &keep_operations)
        })
    }

    /// `listReaderPages(updatedWithinDays)`: resolves the live pages that name readers (the member-access checks' read);
    /// a `null` day count keeps every page, a number only the pages written in that many days.
    #[napi]
    pub fn list_reader_pages<'env>(
        &self,
        env: &'env Env,
        updated_within_days: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_reader_pages(updated_within_days))
    }

    /// `listChatChannelCensus(sourceIds, chatTypes, dmTypes, policy)`: resolves `{ source_id, chat_pages, channels }`
    /// per source; a `null` policy hides nothing.
    #[napi]
    pub fn list_chat_channel_census<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        chat_types: Vec<String>,
        dm_types: Vec<String>,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(
                        v,
                        "listChatChannelCensus policy",
                    )
                })
                .transpose()?;
            s.list_chat_channel_census(&source_ids, &chat_types, &dm_types, policy.as_ref())
        })
    }
}
