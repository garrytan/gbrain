//! The page reads three commands made through raw SQL: the member-disable pages check, the
//! who-can-read page rows and the reconcile-links markdown walk (rust/docs/store/collate-command-reads.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listLivePagesNamingReader(principal, limit)`: `[{ source_id, slug }]` by (source id, slug).
    #[napi]
    pub fn list_live_pages_naming_reader<'env>(
        &self,
        env: &'env Env,
        principal: String,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_live_pages_naming_reader(&principal, limit)
        })
    }

    /// `readPageAccessRows(slug, sourceId)`: `[{ slug, source_id, type, frontmatter, folder_rule_ids }]`.
    #[napi]
    pub fn read_page_access_rows<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_access_rows(&slug, source_id.as_deref())
        })
    }

    /// `listMarkdownPageSlugs(sourceId)`: the slugs, by byte.
    #[napi]
    pub fn list_markdown_page_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_markdown_page_slugs(&source_id))
    }
}
