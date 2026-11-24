//! The moves of the twin merge (`gbrain_store::repair_twin_merge`): the twin's relationships, page children and facts
//! move to the page that replaces it.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `moveTwinRelationships({ twinId, survivorId })`: resolves `{ before, after, linksMoved, transitionsMoved,
    /// deduplicated }`.
    #[napi]
    pub fn move_twin_relationships<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: gbrain_store::repair_twin_merge::TwinMergeIds =
                required(ids, "moveTwinRelationships ids")?;
            s.move_twin_relationships(&ids)
        })
    }

    /// `moveTwinPageChildren({ twinId, survivorId, sourceId, twinSlug, survivorSlug })`: resolves the moved tags.
    #[napi]
    pub fn move_twin_page_children<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::repair_twin_merge::TwinPageChildrenMove =
                required(input, "moveTwinPageChildren input")?;
            s.move_twin_page_children(&input)
        })
    }

    /// `moveTwinFacts(sourceId, twinSlug, survivorSlug)`: resolves the moved fact ids in id order.
    #[napi]
    pub fn move_twin_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        twin_slug: String,
        survivor_slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.move_twin_facts(&source_id, &twin_slug, &survivor_slug)
        })
    }
}
