//! Chunks of a page.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `upsertChunks(slug, chunks, { sourceId?, expectedRevision?, seal?, searchTimeline? }?)`:
    /// writes the page's chunks as PGLite's `upsertChunks` does (a repeated chunk keeps the
    /// metadata it had; the page is not sealed). With `seal` the chunks replace the old ones and
    /// are sealed, and `searchTimeline` (the sanitized timeline) is kept for the page's keyword
    /// vector.
    #[napi]
    pub fn upsert_chunks<'env>(
        &self,
        env: &'env Env,
        slug: String,
        chunks: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let chunks: Vec<gbrain_store::chunks::ChunkInput> =
                required(chunks, "upsertChunks chunks")?;
            s.upsert_chunks(&slug, &chunks, &arg(options, "upsertChunks options")?)
        })
    }

    /// `getChunks(slug, { sourceId?, sourceIds?, includeEmbedding?, includeUnsealed?, requireSafeChunks? }?)`: `Chunk[]`.
    #[napi]
    pub fn get_chunks<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_chunks_with(&slug, &arg(options, "getChunks options")?)
        })
    }

    /// `deleteChunks(slug, { sourceId? }?)`: removes the page's chunks; the page stays.
    #[napi]
    pub fn delete_chunks<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "deleteChunks options")?;
            s.delete_chunks(&slug, scope.source_id.as_deref())
        })
    }

    /// `countChunks()`: chunks in the brain.
    #[napi]
    pub fn count_chunks<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_chunks())
    }
}
