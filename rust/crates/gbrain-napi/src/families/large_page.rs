//! The large-page reads (`src/core/engine-sql/large-page.ts`).
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

    /// `listPageSizeRows(sourceId, inlineMaxBytes, slugs)`: the sync receipt's size-state read.
    #[napi]
    pub fn list_page_size_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        inline_max_bytes: i64,
        slugs: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_size_rows(&source_id, inline_max_bytes, slugs)
        })
    }
}
