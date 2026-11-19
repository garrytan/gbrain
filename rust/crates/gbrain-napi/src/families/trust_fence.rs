//! The fence guard's read of a page's fact rows with their trust tier (`gbrain_store::facts`,
//! `list_fence_fact_rows`), and the held fence cells of a world-only fact read (`list_held_fence_cells`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! The method decodes its argument, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::{FenceTarget, HeldFenceCellsInput};

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

    /// `listHeldFenceCells({ keys })`: `[{ source_id, slug, row_num, claim }]`, the cells held from a
    /// caller whose fact reads are world-only and who has no member page or private-facts grant.
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
}
