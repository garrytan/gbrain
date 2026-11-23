//! The writes of the twin merge: one `#[napi] impl Brain` block over `gbrain_store::twin_merge`
//! (src/core/engine-sql/twin-merge.ts).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and resolves plain JSON
//! (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::twin_merge::TwinPageRowsArgs;

#[napi]
impl Brain {
    /// `listPageRelationshipKeys(pageIds)`: resolves `[{ from_page_id, to_page_id, link_type }]`, the link keys, then
    /// the transition keys.
    #[napi]
    pub fn list_page_relationship_keys<'env>(
        &self,
        env: &'env Env,
        page_ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<u64> = page_ids.iter().map(|id| (*id).max(0) as u64).collect();
            s.list_page_relationship_keys(&ids)
        })
    }

    /// `moveTwinRelations(twinId, survivorId)`: resolves `{ deduplicated, links_moved, transitions_moved }`.
    #[napi]
    pub fn move_twin_relations<'env>(
        &self,
        env: &'env Env,
        twin_id: i64,
        survivor_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.move_twin_relations(twin_id.max(0) as u64, survivor_id.max(0) as u64)
        })
    }

    /// `moveTwinPageRows({ sourceId, twinId, survivorId, twinSlug, survivorSlug })`: resolves the moved tags.
    #[napi]
    pub fn move_twin_page_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TwinPageRowsArgs = required(args, "moveTwinPageRows args")?;
            s.move_twin_page_rows(&a)
        })
    }

    /// `moveTwinFacts(sourceId, twinSlug, survivorSlug)`: resolves the moved fact ids.
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

    /// `recordSlugRename(sourceId, oldSlug, newSlug)`: resolves null.
    #[napi]
    pub fn record_slug_rename<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        old_slug: String,
        new_slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.record_slug_rename(&source_id, &old_slug, &new_slug)
        })
    }
}
