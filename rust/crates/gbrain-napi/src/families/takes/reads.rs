//! Takes: the reads behind the doctor, onboarding, purge, fence import, scorecard and supersession
//! repair sites, and the reads and the delete of `gbrain extract takes` (rust/docs/store/takes-reads.md).
//! Same shape as `../takes.rs`.

use gbrain_store::takes::{IncomingTake, McpResolvedInput, PurgeTakesInput, TakesLeavingFence};
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

    /// `listTakePointers(pageId)`: `[{ row_num, superseded_by }]`.
    #[napi]
    pub fn list_take_pointers<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.list_take_pointers(page),
            Err(_) => Ok(Vec::new()),
        })
    }

    /// `listTakeSupersedeReceipts(sourceId, pageId, slug)`: `[{ old_row, new_row }]`.
    #[napi]
    pub fn list_take_supersede_receipts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_id: i64,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.list_take_supersede_receipts(&source_id, page, &slug),
            Err(_) => Ok(Vec::new()),
        })
    }

    /// `readTakeRowTier(pageId, rowNum)`: resolves `{ id, trust_tier }` of the take in that row, or null.
    #[napi]
    pub fn read_take_row_tier<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        row_num: i32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.read_take_row_tier(page, row_num),
            Err(_) => Ok(None),
        })
    }

    /// `setTakeSupersededBy(pageId, rowNum, supersededBy)`: resolves when the row is written.
    #[napi]
    pub fn set_take_superseded_by<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        row_num: i32,
        superseded_by: Option<i32>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(page) => s.set_take_superseded_by(page, row_num, superseded_by),
            Err(_) => Ok(()),
        })
    }

    /// `readLivePageIdBySlug(slug, sourceId)`: the id, or null.
    #[napi]
    pub fn read_live_page_id_by_slug<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_live_page_id_by_slug(&slug, &source_id))
    }

    /// `readPageTierRef(pageId)`: `{ source_id, slug, trust_tier }`, or null.
    #[napi]
    pub fn read_page_tier_ref<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_tier_ref(page_id as i64))
    }

    /// `readPageTierRows(ids)`: `[{ id, source_id, slug, trust_tier }]`.
    #[napi]
    pub fn read_page_tier_rows<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "readPageTierRows ids")?;
            s.read_page_tier_rows(&ids)
        })
    }

    /// `pageHasFrontmatterKey(pageId, key)`: resolves a boolean.
    #[napi]
    pub fn page_has_frontmatter_key<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.page_has_frontmatter_key(page_id as i64, &key)
        })
    }

    /// `listTakeIdsLeavingFence(pageId, fence)`: the take ids.
    #[napi]
    pub fn list_take_ids_leaving_fence<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        fence: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: TakesLeavingFence = required(fence, "listTakeIdsLeavingFence fence")?;
            s.list_take_ids_leaving_fence(page_id as i64, &fence)
        })
    }

    /// `listTakePreimages(pageId, ids, incoming)`: `[{ preimage, gone }]`.
    #[napi]
    pub fn list_take_preimages<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        ids: Value,
        incoming: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "listTakePreimages ids")?;
            let incoming: Vec<IncomingTake> = required(incoming, "listTakePreimages incoming")?;
            s.list_take_preimages(page_id as i64, &ids, &incoming)
        })
    }

    /// `deleteTakesByIds(ids)`: resolves when the takes are deleted.
    #[napi]
    pub fn delete_takes_by_ids<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "deleteTakesByIds ids")?;
            s.delete_takes_by_ids(&ids)
        })
    }

    /// `findTakeId(pageId, rowNum)`: the id, or null.
    #[napi]
    pub fn find_take_id<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        row_num: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.find_take_id(page_id as i64, row_num as i64))
    }
}
