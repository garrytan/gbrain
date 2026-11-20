//! The phantom-redirect pass's root-page walk, which ran raw SQL
//! (rust/docs/store/collate-phantom-redirect.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listRootPageSlugsAfter(sourceId, after, exclude, limit)`: the slugs, in byte order.
    #[napi]
    pub fn list_root_page_slugs_after<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        after: String,
        exclude: Vec<String>,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_root_page_slugs_after(&source_id, &after, &exclude, limit as usize)
        })
    }
}
