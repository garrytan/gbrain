//! The belief ledger's page lifetime writes (rust/docs/store/collate-belief-lifetimes.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readOpenLifetimes(sourceId, incarnations, slugs)`: `[{ page_lifetime, source_incarnation, slug, page_id }]`.
    #[napi]
    pub fn read_open_lifetimes<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnations: Vec<String>,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_open_lifetimes(&source_id, &incarnations, &slugs)
        })
    }

    /// `endLifetime(lifetime)`.
    #[napi]
    pub fn end_lifetime<'env>(
        &self,
        env: &'env Env,
        page_lifetime: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.end_lifetime(&page_lifetime))
    }

    /// `mintLifetime(sourceId, incarnation, slug, pageId)`: the open lifetime's uuid.
    #[napi]
    pub fn mint_lifetime<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
        slug: String,
        page_id: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.mint_lifetime(&source_id, &incarnation, &slug, u64::from(page_id))
        })
    }

    /// `renameLifetime(lifetime, slug, pageId)`.
    #[napi]
    pub fn rename_lifetime<'env>(
        &self,
        env: &'env Env,
        page_lifetime: String,
        slug: String,
        page_id: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.rename_lifetime(&page_lifetime, &slug, u64::from(page_id))
        })
    }

    /// `readMovedLifetimes(pageIds)`: `[{ page_id, source_incarnation, page_lifetime }]`.
    #[napi]
    pub fn read_moved_lifetimes<'env>(
        &self,
        env: &'env Env,
        page_ids: Vec<u32>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<u64> = page_ids.into_iter().map(u64::from).collect();
            s.read_moved_lifetimes(&ids)
        })
    }
}
