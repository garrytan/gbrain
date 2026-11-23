//! The `gbrain embed --stale` reads and writes served from the store (`gbrain-store` `embeddings::stale_work`,
//! rust/docs/store/embed-stale-work.md), and the content-drift sweep's cursor row (`ensure_config`).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `countArchivedEmbeddingWork({ sourceId, signature, includeNullSignature, includeUnsealed, column })`: resolves a count.
    #[napi]
    pub fn count_archived_embedding_work<'env>(
        &self,
        env: &'env Env,
        options: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_archived_embedding_work(&required(
                options,
                "countArchivedEmbeddingWork options",
            )?)
        })
    }

    /// `countEmbedPendingProjections(scope)`: resolves a count.
    #[napi]
    pub fn count_embed_pending_projections<'env>(
        &self,
        env: &'env Env,
        scope: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_embed_pending_projections(&required(
                scope,
                "countEmbedPendingProjections scope",
            )?)
        })
    }

    /// `listEmbedPendingProjections(scope, limit)`: resolves `[{ source_id, slug, page_kind }]`.
    #[napi]
    pub fn list_embed_pending_projections<'env>(
        &self,
        env: &'env Env,
        scope: serde_json::Value,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_embed_pending_projections(
                &required(scope, "listEmbedPendingProjections scope")?,
                u64::try_from(limit).unwrap_or(0),
            )
        })
    }

    /// `listEmbedProjectionRepairPages(scope, afterPageId, limit)`: resolves `[{ slug, source_id, id }]`.
    #[napi]
    pub fn list_embed_projection_repair_pages<'env>(
        &self,
        env: &'env Env,
        scope: serde_json::Value,
        after_page_id: i64,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_embed_projection_repair_pages(
                &required(scope, "listEmbedProjectionRepairPages scope")?,
                u64::try_from(after_page_id).unwrap_or(0),
                u64::try_from(limit).unwrap_or(0),
            )
        })
    }

    /// `listUnembeddedChunkIndexes(slug, sourceId)`: resolves the chunk indexes, ascending.
    #[napi]
    pub fn list_unembedded_chunk_indexes<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_unembedded_chunk_indexes(&slug, &source_id)
        })
    }

    /// `sumEmbedBackfillChars(sourceId, all)`: resolves `{ chunk_chars, chunkless_chars }`.
    #[napi]
    pub fn sum_embed_backfill_chars<'env>(
        &self,
        env: &'env Env,
        source_id: Option<String>,
        all: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.sum_embed_backfill_chars(source_id.as_deref(), all)
        })
    }

    /// `readPageIsSegmented(pageId)`: resolves a boolean.
    #[napi]
    pub fn read_page_is_segmented<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(page_id) {
            Ok(id) => s.read_page_is_segmented(id),
            Err(_) => Ok(false),
        })
    }

    /// `hasEmbeddingSignatureDrift(opts)`: resolves a boolean.
    #[napi]
    pub fn has_embedding_signature_drift<'env>(
        &self,
        env: &'env Env,
        options: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_embedding_signature_drift(&required(
                options,
                "hasEmbeddingSignatureDrift options",
            )?)
        })
    }

    /// `lockContentDriftState(key, initial)`: resolves the stored value.
    #[napi]
    pub fn ensure_config<'env>(
        &self,
        env: &'env Env,
        key: String,
        initial: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.ensure_config(&key, &initial))
    }

    /// `invalidateContentDriftChunks(window)`: resolves `{ last_id, checked, drifted }`.
    #[napi]
    pub fn invalidate_content_drift_chunks<'env>(
        &self,
        env: &'env Env,
        window: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.invalidate_content_drift_chunks(&required(
                window,
                "invalidateContentDriftChunks window",
            )?)
        })
    }
}
