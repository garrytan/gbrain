//! The fence guard's read of a page's fact rows with their trust tier (`gbrain_store::facts`,
//! `list_fence_fact_rows`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! The method decodes its argument, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::FenceTarget;
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
