//! The fence guard's read of a page's fact rows with their trust tier (`gbrain_store::facts`,
//! `list_fence_fact_rows`), its reads of held timeline rows and takes (`gbrain_store::timeline`,
//! `list_held_timeline_rows`; `gbrain_store::takes`, `list_held_take_rows`), the held fence cells of a world-only fact read
//! (`list_held_fence_cells`), the fence overlay's read of one page (`read_fence_overlay_rows`), and the fence append's
//! restore of its page's trust (`gbrain_store::pages`, `restore_page_trust`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! The method decodes its argument, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::{FenceOverlayInput, FenceRowKey, FenceTarget, HeldFenceCellsInput};
use gbrain_store::takes::HeldTakeSpec;
use gbrain_store::timeline::HeldTimelineSpec;
use gbrain_store::trust::held_rows::{GuardedTakeRowsQuery, HeldRowsQuery};

#[napi]
impl Brain {
    /// `listFenceFactRows({ sourceId, slug, incoming })`: `[{ id, row_num, fact, visibility,
    /// trust_tier, above, opened }]`. The writer's tier and the opened ids come from the store's
    /// write trust context (`applyWriteTrust`).
    #[napi]
    pub fn list_fence_fact_rows<'env>(
        &self,
        env: &'env Env,
        target: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let t: FenceTarget = required(target, "listFenceFactRows target")?;
            s.list_fence_fact_rows(&t, &s.fence_context())
        })
    }

    /// `listHeldTimelineRows({ ids, writer?, pending? })`: `[{ id, trust_tier }]`, the listed
    /// timeline rows the writer may not delete or overwrite, by id. Without `writer` the writer's
    /// tier comes from the store's write trust context (`applyWriteTrust`).
    #[napi]
    pub fn list_held_timeline_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: HeldTimelineSpec = required(spec, "listHeldTimelineRows spec")?;
            s.list_held_timeline_rows(&spec, &s.fence_context())
        })
    }

    /// `listHeldTakeRows({ ids, writer?, pending? })`: `[{ id, trust_tier }]`, the listed takes the
    /// writer may not delete or overwrite, by id. Without `writer` the writer's tier comes from the
    /// store's write trust context (`applyWriteTrust`).
    #[napi]
    pub fn list_held_take_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: HeldTakeSpec = required(spec, "listHeldTakeRows spec")?;
            s.list_held_take_rows(&spec, &s.fence_context())
        })
    }

    /// `listHeldFenceCells({ keys, member, grantSources })`: `[{ source_id, slug, row_num, claim }]`, the
    /// cells held from a caller whose fact reads are world-only; `member` is a member caller's page,
    /// principal and page policy, whose own private page facts are not held; `grantSources` are the
    /// sources of a private-facts grant, whose admitted private facts are not held.
    #[napi]
    pub fn list_held_fence_cells<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: HeldFenceCellsInput = required(input, "listHeldFenceCells input")?;
            s.list_held_fence_cells(&input)
        })
    }

    /// `readFenceOverlayRows({ sourceId, slug, incoming, hideHeld })`: `[{ row_num, page_tier,
    /// row_tier, row_flagged, purged, held, narrower }]`, one row per incoming row in incoming
    /// order, for a caller with no member page or private-facts grant when `hideHeld` is set.
    #[napi]
    pub fn read_fence_overlay_rows<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: FenceOverlayInput = required(input, "readFenceOverlayRows input")?;
            s.read_fence_overlay_rows(&input)
        })
    }

    /// `listFenceRowTrust(keys)`: `[{ source_id, slug, row_num, trust_tier, flagged, contested }]`, the newest
    /// live fact at each fence row key, in (source id, slug, row number) order.
    #[napi]
    pub fn list_fence_row_trust<'env>(
        &self,
        env: &'env Env,
        keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let keys: Vec<FenceRowKey> = required(keys, "listFenceRowTrust keys")?;
            s.list_fence_row_trust(&keys)
        })
    }

    /// `restorePageTrust({ pageId, trustTier, writeOrigin })`: sets the page's tier and origin
    /// back through the trust stamp; resolves null.
    #[napi]
    pub fn restore_page_trust<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: gbrain_store::pages::PageTrustRestore = required(spec, "restorePageTrust spec")?;
            s.restore_page_trust(&a)
        })
    }

    /// `listHeldRows({ table, pageId, ids, writer?, pending })`: `[{ id, trust_tier }]`. With no
    /// `writer`, the writer's tier comes from the store's write trust context (`applyWriteTrust`).
    #[napi]
    pub fn list_held_rows<'env>(&self, env: &'env Env, q: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: HeldRowsQuery = required(q, "listHeldRows args")?;
            s.list_held_rows(&q, &s.fence_context())
        })
    }

    /// `listGuardedTakeRows({ incoming, gone, pending? })`: `[{ id, page_id, row_num, trust_tier, change }]`.
    /// The writer's tier comes from the store's write trust context (`applyWriteTrust`).
    #[napi]
    pub fn list_guarded_take_rows<'env>(
        &self,
        env: &'env Env,
        q: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: GuardedTakeRowsQuery = required(q, "listGuardedTakeRows args")?;
            s.list_guarded_take_rows(&q, &s.fence_context())
        })
    }
}
