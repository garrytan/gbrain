//! The reads a page write makes before admission: the members of `engine-sql/page-mutation-reads.ts`
//! (rust/docs/store/page-mutation-reads.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readStoredPageHead(sourceId, slug)`: `{ type, trust_tier, title, frontmatter }`, or `null`.
    #[napi]
    pub fn read_stored_page_head<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_stored_page_head(&source_id, &slug))
    }

    /// `readVersionSourcePath(versionId, pageId)`: the version's `source_path` when it belongs to the page, or `null`.
    #[napi]
    pub fn read_version_source_path<'env>(
        &self,
        env: &'env Env,
        version_id: i64,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_version_source_path(version_id, page_id)
        })
    }
}
