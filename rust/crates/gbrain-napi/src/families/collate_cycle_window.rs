//! The two reads of a per-source cycle's changed-page window, which ran raw SQL
//! (rust/docs/store/collate-cycle-window.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readCycleListingInstant()`: UTC ISO text with microseconds.
    #[napi]
    pub fn read_cycle_listing_instant<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_cycle_listing_instant())
    }

    /// `listSourceChangedPagesAfter(sourceId, since, slug, limit)`: `[{ slug, updated_at }]`.
    #[napi]
    pub fn list_source_changed_pages_after<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        since: Option<String>,
        slug: String,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_source_changed_pages_after(&source_id, since.as_deref(), &slug, limit as usize)
        })
    }
}
