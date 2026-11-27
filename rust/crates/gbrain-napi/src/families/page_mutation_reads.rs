//! The reads a page write makes before admission: the members of `engine-sql/page-mutation-reads.ts`
//! (rust/docs/store/page-mutation-reads.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

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

    /// `readStoredPageLabels(sourceId, slug)`: `{ type, frontmatter, compiled_truth, timeline, body_storage, body_bytes }` as
    /// stored (a soft-deleted page too), or `null`.
    #[napi]
    pub fn read_stored_page_labels<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_stored_page_labels(&source_id, &slug))
    }

    /// `readMemberPageReadable(sourceId, slug, policy)`: `null` for no row at the slug, else whether `policy` admits it.
    #[napi]
    pub fn read_member_page_readable<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        policy: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_member_page_readable(
                &source_id,
                &slug,
                &required(policy, "readMemberPageReadable policy")?,
            )
        })
    }

    /// `readSlugFolderRules(sourceId, slug)`: the `<source>:<rule id>` of every rule covering the slug, or `null`.
    #[napi]
    pub fn read_slug_folder_rules<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_slug_folder_rules(&source_id, &slug))
    }

    /// `readHiddenPageSlugs(slugs, hiddenSources, policy)`: the slugs that name a page and no page the policy admits.
    #[napi]
    pub fn read_hidden_page_slugs<'env>(
        &self,
        env: &'env Env,
        slugs: Vec<String>,
        hidden_sources: Vec<String>,
        policy: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_hidden_page_slugs(
                &slugs,
                &hidden_sources,
                &required(policy, "readHiddenPageSlugs policy")?,
            )
        })
    }
}
