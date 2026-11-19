//! The large-page write guard's read (`src/core/engine-sql/large-page.ts`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readStoredBodyBytes(slug, sourceId)`: the live page's stored body size, or null.
    #[napi]
    pub fn read_stored_body_bytes<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_stored_body_bytes(&slug, &source_id))
    }

    /// `readPageBodySizes(pageId)`: `{ bytes, truth }` of the page, or null.
    #[napi]
    pub fn read_page_body_sizes<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_body_sizes(page_id))
    }
}
