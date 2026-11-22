//! Chunk reads beyond the core chunks family.
//!
//! Store methods for getChunkPage, getChunkWindows, countChunklessPagesWithContent and
//! listChunklessPagesWithContent.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `getChunkPage(slug, { sourceId, fromIndex, limit })`: `{ chunks, total_chunks,
    /// max_chunk_index }`.
    #[napi]
    pub fn get_chunk_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_chunk_page(&slug, &arg(options, "getChunkPage options")?)
        })
    }

    /// `getChunkWindows(requests, { sourceId?, sourceIds?, chunkSources, maxRows })`: the flat
    /// page and chunk rows `mapChunkWindowRows` groups.
    #[napi]
    pub fn get_chunk_windows<'env>(
        &self,
        env: &'env Env,
        requests: Option<Value>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let requests: Vec<gbrain_store::chunk_queries::ChunkWindowRequest> =
                arg(requests, "getChunkWindows requests")?;
            s.get_chunk_windows(&requests, &arg(options, "getChunkWindows options")?)
        })
    }

    /// `countChunklessPagesWithContent({ sourceId? }?)`: a count.
    #[napi]
    pub fn count_chunkless_pages_with_content<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_chunkless_pages_with_content(&arg(
                options,
                "countChunklessPagesWithContent options",
            )?)
        })
    }

    /// `listChunklessPagesWithContent({ sourceId?, batchSize?, afterPageId? }?)`:
    /// `ChunklessPageRow[]` in page-id order.
    #[napi]
    pub fn list_chunkless_pages_with_content<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_chunkless_pages_with_content(&arg(
                options,
                "listChunklessPagesWithContent options",
            )?)
        })
    }
}
