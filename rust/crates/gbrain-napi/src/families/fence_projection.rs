//! The statements of a page publication's fence projection and fence guard
//! (`gbrain_store::facts` `facts/fence_projection.rs`, `gbrain_store::takes`
//! `takes/fence_projection.rs`, `gbrain_store::generations` `has_fence_absent_hold`), a tier-only
//! row change (`gbrain_store::trust` `trust/row_tier.rs`), and the unwithdrawn-facts repair's page
//! body read (`facts/unwithdrawn_restore.rs`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/README.md, "The brain store"). The fact writes and reads that compare
//! with the writer take the writer's tier and opened ids from the store's write trust context
//! (`applyWriteTrust`).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::generations::GenerationKey;

#[napi]
impl Brain {
    /// `listQuotedTakeRows(pageId, rowNums)`: `[{ row_num, claim }]` by row number.
    #[napi]
    pub fn list_quoted_take_rows<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        row_nums: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_quoted_take_rows(page_id, &row_nums))
    }

    /// `listPageFenceFactCells(sourceId, slug)`: `[{ row_num, fact, visibility }]`.
    #[napi]
    pub fn list_page_fence_fact_cells<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_fence_fact_cells(&source_id, &slug)
        })
    }

    /// `hasPositionedPageFacts(sourceId, slug)`: a boolean.
    #[napi]
    pub fn has_positioned_page_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_positioned_page_facts(&source_id, &slug))
    }

    /// `hasFenceAbsentHold({ sourceId, kind, ownerKey })`: a boolean.
    #[napi]
    pub fn has_fence_absent_hold<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "hasFenceAbsentHold key")?;
            s.has_fence_absent_hold(&key)
        })
    }

    /// `listPageTakeRowNums(pageId)`: the row numbers, ascending.
    #[napi]
    pub fn list_page_take_row_nums<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_take_row_nums(page_id))
    }

    /// `expireFenceFacts(sourceId, slug, incoming, ids)`: resolves once the rows are expired.
    #[napi]
    pub fn expire_fence_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        incoming: String,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.expire_fence_facts(&source_id, &slug, &incoming, &ids, &s.fence_context())
        })
    }

    /// `refreshFenceFactFields(sourceId, slug, fieldRows)`: resolves once the cells are written.
    #[napi]
    pub fn refresh_fence_fact_fields<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        field_rows: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.refresh_fence_fact_fields(&source_id, &slug, &field_rows)
        })
    }

    /// `clearChangedTakeResolutions(pageId, claims)`: resolves once the resolutions are cleared.
    #[napi]
    pub fn clear_changed_take_resolutions<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        claims: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.clear_changed_take_resolutions(page_id, &claims)
        })
    }

    /// `writeFenceTakeResolutions(pageId, resolutions)`: resolves once the resolutions are written.
    #[napi]
    pub fn write_fence_take_resolutions<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        resolutions: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_fence_take_resolutions(page_id, &resolutions)
        })
    }

    /// `detachFenceFactRows(ids)`: resolves once the rows are detached.
    #[napi]
    pub fn detach_fence_fact_rows<'env>(
        &self,
        env: &'env Env,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.detach_fence_fact_rows(&ids))
    }

    /// `listOccupiedFenceRowNums(sourceId, slug)`: the row numbers.
    #[napi]
    pub fn list_occupied_fence_row_nums<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_occupied_fence_row_nums(&source_id, &slug)
        })
    }

    /// `moveGuardedFenceRows(moves)`: `moves` is the JSON text of `[{ id, row_num, visibility }]`.
    #[napi]
    pub fn move_guarded_fence_rows<'env>(
        &self,
        env: &'env Env,
        moves: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.move_guarded_fence_rows(&moves))
    }

    /// `listTrustedPrivateCopies(sourceId, slug, restated)`: `restated` is the JSON text of
    /// `[{ row_num, fact, entity }]`; resolves `[{ row_num, id, visibility, trust_tier }]`.
    #[napi]
    pub fn list_trusted_private_copies<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        restated: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_trusted_private_copies(&source_id, &slug, &restated, &s.fence_context())
        })
    }

    /// `readLiveFenceFactAt(sourceId, slug, rowNum)`: `{ id, trust_tier }`, or null.
    #[napi]
    pub fn read_live_fence_fact_at<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        row_num: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_live_fence_fact_at(&source_id, &slug, row_num)
        })
    }

    /// `listFactsAboveWriter(sourceId, slug)`: `[{ id, trust_tier }]`.
    #[napi]
    pub fn list_facts_above_writer<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_facts_above_writer(&source_id, &slug, &s.fence_context())
        })
    }

    /// `readRowTrustTier(table, id)`: `{ trust_tier }`, or null.
    #[napi]
    pub fn read_row_trust_tier<'env>(
        &self,
        env: &'env Env,
        table: String,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_row_trust_tier(&table, id))
    }

    /// `setRowTrustTier(table, id, tier, decision)`: the ids it changed.
    #[napi]
    pub fn set_row_trust_tier<'env>(
        &self,
        env: &'env Env,
        table: String,
        id: f64,
        tier: String,
        decision: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_row_trust_tier(&table, id, &tier, &decision)
        })
    }

    /// `readTierProjectionPage(table, id)`: `{ source_id, slug }`, or null.
    #[napi]
    pub fn read_tier_projection_page<'env>(
        &self,
        env: &'env Env,
        table: String,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_tier_projection_page(&table, id))
    }

    /// `readPageInlineBody(pageId)`: `{ id, compiled_truth, timeline, body_storage }`, or null.
    #[napi]
    pub fn read_page_inline_body<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_inline_body(page_id))
    }
}
