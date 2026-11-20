//! The byte-ordered page, mention and fact-pool reads (`src/core/engine-sql/collate-page-reads.ts`): one
//! `#[napi] impl Brain` block over `gbrain_store::collate_reads` (rust/docs/store/collate_reads.md).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};
use gbrain_store::facts::trust::PoolArgs;

#[napi]
impl Brain {
    /// `listPageTypePairs()`: `{ source_id, type }` rows.
    #[napi]
    pub fn list_page_type_pairs<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_type_pairs())
    }

    /// `countPagesWithMentionLinks()`: the count.
    #[napi]
    pub fn count_pages_with_mention_links<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_pages_with_mention_links())
    }

    /// `listGazetteerSourceIds()`: `{ id }` rows.
    #[napi]
    pub fn list_gazetteer_source_ids<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_gazetteer_source_ids())
    }

    /// `listGazetteerPages(types, handleKeys)`: the gazetteer's page rows.
    #[napi]
    pub fn list_gazetteer_pages<'env>(
        &self,
        env: &'env Env,
        types: Vec<String>,
        handle_keys: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_gazetteer_pages(&types, &handle_keys))
    }

    /// `listGazetteerAliasRows(types)`: the gazetteer's alias rows.
    #[napi]
    pub fn list_gazetteer_alias_rows<'env>(
        &self,
        env: &'env Env,
        types: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_gazetteer_alias_rows(&types))
    }

    /// `listStaleMentionPages(limit)`: the scanned pages with their text.
    #[napi]
    pub fn list_stale_mention_pages<'env>(
        &self,
        env: &'env Env,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_stale_mention_pages(limit as u64))
    }

    /// `listStaleMentionLinks(limit)`: the scanned pages' mention links.
    #[napi]
    pub fn list_stale_mention_links<'env>(
        &self,
        env: &'env Env,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_stale_mention_links(limit as u64))
    }

    /// `listPoolEntityPairs(pool)`: `{ source_id, entity_slug }` rows of the pool.
    #[napi]
    pub fn list_pool_entity_pairs<'env>(
        &self,
        env: &'env Env,
        pool: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let pool: PoolArgs = arg(Some(pool), "listPoolEntityPairs pool")?;
            s.list_pool_entity_pairs(&pool)
        })
    }

    /// `listPoolUnbackedKeys(pool, keys, limit)`: the unbacked `{ source_id, entity_slug }` rows.
    #[napi]
    pub fn list_pool_unbacked_keys<'env>(
        &self,
        env: &'env Env,
        pool: Value,
        keys: Vec<String>,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let pool: PoolArgs = arg(Some(pool), "listPoolUnbackedKeys pool")?;
            s.list_pool_unbacked_keys(&pool, &keys, limit as u64)
        })
    }
}
