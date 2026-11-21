//! Page write guards: the origin read and claims, the origin bind, the ingest stamp, the import
//! seal, the valid-time body read and the segment storage probe (`gbrain_store::write_guards`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readPageOrigin({ sourceId, pageId?, slug? })`: `{ id, slug, source_path, deleted_at }` or `null`.
    #[napi]
    pub fn read_page_origin<'env>(
        &self,
        env: &'env Env,
        target: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_origin(&required(target, "readPageOrigin target")?)
        })
    }

    /// `listOriginClaims(sourceId, spellings, { lockKeys, excludePageId? })`: `[{ slug, source_path }]`.
    #[napi]
    pub fn list_origin_claims<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        spellings: Vec<String>,
        opts: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts = match opts {
                None | Some(Value::Null) => Default::default(),
                Some(v) => required(v, "listOriginClaims opts")?,
            };
            s.list_origin_claims(&source_id, &spellings, &opts)
        })
    }

    /// `bindPageOrigin({ sourceId, pageId?, slug?, sourcePath, onlyIfUnset?, liveOnly? })`: pages changed.
    #[napi]
    pub fn bind_page_origin<'env>(
        &self,
        env: &'env Env,
        bind: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.bind_page_origin(&required(bind, "bindPageOrigin bind")?)
        })
    }

    /// `stampPageIngest(slug, { sourceId, sourceKind, ingestedVia, ingestedAt })`.
    #[napi]
    pub fn stamp_page_ingest<'env>(
        &self,
        env: &'env Env,
        slug: String,
        stamp: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.stamp_page_ingest(&slug, &required(stamp, "stampPageIngest stamp")?)
        })
    }

    /// `sealImportedPage(slug, { sourceId, revision, timelineText, chunkerVersion })`: `{ id }` or `null`.
    #[napi]
    pub fn seal_imported_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        seal: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.seal_imported_page(&slug, &required(seal, "sealImportedPage seal")?)
        })
    }

    /// `readLivePageBody(slug, sourceId)`: the live page's body columns or `null`.
    #[napi]
    pub fn read_live_page_body<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_live_page_body(&slug, &source_id))
    }

    /// `readPageIndexingState(pageId)`: `{ chunker_version, corpus_generation, page_kind }` or `null`.
    #[napi]
    pub fn read_page_indexing_state<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "readPageIndexingState pageId")?;
            s.read_page_indexing_state(page_id)
        })
    }

    /// `readInlinePageRegions(pageId)`: `{ compiled_truth, timeline }` of the page, or `null`.
    #[napi]
    pub fn read_inline_page_regions<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "readInlinePageRegions pageId")?;
            s.read_inline_page_regions(page_id)
        })
    }

    /// `readStoredPageTier(sourceId, slug)`: the page's stored `trust_tier`, or `null`.
    #[napi]
    pub fn read_stored_page_tier<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_stored_page_tier(&source_id, &slug))
    }

    /// `hasSegmentStorage()`: whether any segment text or body staging is stored.
    #[napi]
    pub fn has_segment_storage<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_segment_storage())
    }
}
