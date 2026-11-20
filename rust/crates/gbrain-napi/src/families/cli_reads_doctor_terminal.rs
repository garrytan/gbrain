//! The doctor terminal write failure reads served from the store (`gbrain-store` `cli_reads::doctor_terminal`).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readTerminalFailureGroups(query)`: resolves the aggregate rows of the terminal failure summary.
    #[napi]
    pub fn read_terminal_failure_groups<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_terminal_failure_groups(&required(input, "readTerminalFailureGroups input")?)
        })
    }

    /// `listTerminalFailureBatch(query)`: resolves one source's receipts, newest first, with their superseding request.
    #[napi]
    pub fn list_terminal_failure_batch<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_terminal_failure_batch(&required(input, "listTerminalFailureBatch input")?)
        })
    }
}
