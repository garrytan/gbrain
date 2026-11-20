//! Slug reads that order by byte (rust/docs/store/slug_reads.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `Store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};
use gbrain_store::slug_reads::{TypeOrphanQuery, TypeScope};
use serde_json::Value;

#[napi]
impl Brain {
    /// `resolveLiveSlugByPath(path)`: resolves the slug of the live page that records the path as
    /// its origin (lowest source, then slug), or null.
    #[napi]
    pub fn resolve_live_slug_by_path<'env>(
        &self,
        env: &'env Env,
        path: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.resolve_live_slug_by_path(&path))
    }

    /// `listUnarchivedSlugSources(slug)`: resolves the ids of the unarchived sources that hold a
    /// live page at the slug, in byte order.
    #[napi]
    pub fn list_unarchived_slug_sources<'env>(
        &self,
        env: &'env Env,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_unarchived_slug_sources(&slug))
    }

    /// `countLivePageTypes(scope)`: resolves `{ type, n }` for each type of the live pages in the
    /// scope.
    #[napi]
    pub fn count_live_page_types<'env>(
        &self,
        env: &'env Env,
        scope: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: TypeScope = required(scope, "countLivePageTypes scope")?;
            s.count_live_page_types(&scope)
        })
    }

    /// `listTypeOrphanPages(query)`: resolves `{ slug, source_id, type }` rows by source, then slug.
    #[napi]
    pub fn list_type_orphan_pages<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: TypeOrphanQuery = required(query, "listTypeOrphanPages query")?;
            s.list_type_orphan_pages(&q)
        })
    }

    /// `readExportPageRows(ids)`: resolves `{ page, tags }` for each live page of the ids.
    #[napi]
    pub fn read_export_page_rows<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<u64> = required(ids, "readExportPageRows ids")?;
            s.read_export_page_rows(&ids)
        })
    }
}
