//! Takes: the reads behind the doctor, onboarding, purge, fence import, scorecard and supersession
//! repair sites (rust/docs/store/takes-reads.md). Same shape as `../takes.rs`.

use gbrain_store::takes::{McpResolvedInput, PurgeTakesInput};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `countOffGridTakeWeights()`: `{ off_grid, total }`.
    #[napi]
    pub fn count_off_grid_take_weights<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_off_grid_take_weights())
    }

    /// `countTakes()`: resolves the number of takes.
    #[napi]
    pub fn count_takes<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_takes())
    }

    /// `planFactPurgeTakes({ sourceId, factIds, factHash, subject })`: `[{ id, page_id }]`.
    #[napi]
    pub fn plan_fact_purge_takes<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: PurgeTakesInput = required(input, "planFactPurgeTakes input")?;
            s.plan_fact_purge_takes(&input)
        })
    }

    /// `listTakeRowsForPage(pageId)`: `[{ row_num, claim }]`.
    #[napi]
    pub fn list_take_rows_for_page<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_take_rows_for_page(page_id as i64))
    }

    /// `countMcpResolvedTakes({ sourceIds, holders, excludePrivate })`: resolves the count.
    #[napi]
    pub fn count_mcp_resolved_takes<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: McpResolvedInput = required(input, "countMcpResolvedTakes input")?;
            s.count_mcp_resolved_takes(&input)
        })
    }

    /// `listTakeSupersessionCandidates(sourceIds)`: `[{ id, source_id, slug }]`.
    #[napi]
    pub fn list_take_supersession_candidates<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_take_supersession_candidates(&source_ids)
        })
    }
}
