//! The page statements a fact withdrawal runs: `listSegmentedPages` and `invalidateWithdrawnPages`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::withdrawal_pages` call on the pool
//! through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/withdrawal-pages.ts) number the ids.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listSegmentedPages(sourceId, slugs)`: resolves `{ id, slug }` of each segmented page among the slugs.
    #[napi]
    pub fn list_segmented_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_segmented_pages(&source_id, &slugs))
    }

    /// `invalidateWithdrawnPages(sourceId, slugs)`: resolves `{ id, slug, knowledge_revision }` of each inline
    /// page among the slugs after giving it a new revision.
    #[napi]
    pub fn invalidate_withdrawn_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.invalidate_withdrawn_pages(&source_id, &slugs)
        })
    }
}
