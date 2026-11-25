//! Import members: the page and chunk statements a page import runs around its chunk write
//! (`gbrain_store::import_members`).
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
    /// `getPageSealState(pageId)`: the page's chunker version, or `null` for a gone, soft-deleted
    /// or segmented page.
    #[napi]
    pub fn get_page_seal_state<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "getPageSealState pageId")?;
            s.get_page_seal_state(page_id)
        })
    }

    /// `refreshPageOrigin(slug, { sourceId, sourcePath, sourceUri? })`.
    #[napi]
    pub fn refresh_page_origin<'env>(
        &self,
        env: &'env Env,
        slug: String,
        refresh: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.refresh_page_origin(&slug, &required(refresh, "refreshPageOrigin refresh")?)
        })
    }

    /// `setChunkerVersion(slug, version, { sourceId })`: `version` is the bound text,
    /// `String(version)`.
    #[napi]
    pub fn set_chunker_version<'env>(
        &self,
        env: &'env Env,
        slug: String,
        version: String,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_chunker_version(&slug, &version, source_id.as_deref())
        })
    }

    /// `readSourceChunkerVersion(sourceId)`: the source's stamped chunker version, or `null`.
    #[napi]
    pub fn read_source_chunker_version<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_chunker_version(&source_id))
    }

    /// `setSourceChunkerVersion(sourceId, version)`: whether the source exists.
    #[napi]
    pub fn set_source_chunker_version<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        version: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_source_chunker_version(&source_id, &version)
        })
    }

    /// `writeTextProjectionSeal(slug, { sourceId, revision, timelineText })`.
    #[napi]
    pub fn write_text_projection_seal<'env>(
        &self,
        env: &'env Env,
        slug: String,
        seal: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_text_projection_seal(&slug, &required(seal, "writeTextProjectionSeal seal")?)
        })
    }

    /// `moveChunkIndexes(pageId, waves)`: each wave a list of `{ id, to, projectedByteStart?,
    /// projectedByteEnd? }`.
    #[napi]
    pub fn move_chunk_indexes<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        waves: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "moveChunkIndexes pageId")?;
            let waves: Vec<Vec<gbrain_store::import_members::ChunkMove>> =
                required(waves, "moveChunkIndexes waves")?;
            s.move_chunk_indexes(page_id, &waves)
        })
    }

    /// `getChunkReuseRows(slug, { sourceId })`: `[{ chunk_index, embedding_input_hash,
    /// contextual_retrieval_mode, text_only, unembedded }]` by chunk index.
    #[napi]
    pub fn get_chunk_reuse_rows<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_chunk_reuse_rows(&slug, source_id.as_deref())
        })
    }
}
