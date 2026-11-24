//! Alias fan-out reads: the exact-title lookup, the case-sensitive alias read, a page's title and
//! the alias rows of a set of pages (rust/docs/store/alias_fanout_reads.md).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `findPagesByTitles(query)`: resolves `{ slug, source_id, t }` rows by source then slug
    /// (`TitleQuery`).
    #[napi]
    pub fn find_pages_by_titles<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::alias_fanout_reads::TitleQuery =
                required(query, "findPagesByTitles query")?;
            s.find_pages_by_titles(&q)
        })
    }

    /// `resolveCaseSensitiveAliases(aliasNorms, sourceIds)`: resolves the case-sensitive alias rows
    /// (none: the store keeps no case-sensitive row).
    #[napi]
    pub fn resolve_case_sensitive_aliases<'env>(
        &self,
        env: &'env Env,
        alias_norms: Value,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let alias_norms: Vec<String> =
                required(alias_norms, "resolveCaseSensitiveAliases aliasNorms")?;
            let source_ids: Vec<String> =
                required(source_ids, "resolveCaseSensitiveAliases sourceIds")?;
            s.resolve_case_sensitive_aliases(&alias_norms, &source_ids)
        })
    }

    /// `readPageTitle(sourceId, slug)`: resolves the page's title, or null with no page.
    #[napi]
    pub fn read_page_title<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_title(&source_id, &slug))
    }

    /// `readPageAliasRows(sourceIds, slugs)`: resolves `{ slug, source_id, alias_norm, alias_text,
    /// origin }` rows by source, slug, alias, then origin.
    #[napi]
    pub fn read_page_alias_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
        slugs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let source_ids: Vec<String> = required(source_ids, "readPageAliasRows sourceIds")?;
            let slugs: Vec<String> = required(slugs, "readPageAliasRows slugs")?;
            s.read_page_alias_rows(&source_ids, &slugs)
        })
    }
}
