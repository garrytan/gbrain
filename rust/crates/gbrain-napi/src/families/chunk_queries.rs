//! Chunk reads beyond the core chunks family.
//!
//! Store methods for getChunkPage, getChunkWindows, countChunklessPagesWithContent,
//! listChunklessPagesWithContent, hasUnsealedPages, readSegmentRegions and the chunk reads and deletes of
//! `src/core/engine-sql/chunk-reads.ts`.
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

    /// `findCodeDefinitions(input)`: the definition rows.
    #[napi]
    pub fn find_code_definitions<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::CodeSymbolInput =
                arg(input, "findCodeDefinitions input")?;
            s.find_code_definitions(&input)
        })
    }

    /// `listSymbolTypesForName(input)`: the distinct symbol types.
    #[napi]
    pub fn list_symbol_types_for_name<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::CodeSymbolInput =
                arg(input, "listSymbolTypesForName input")?;
            s.list_symbol_types_for_name(&input)
        })
    }

    /// `findCodeRefChunks(input)`: the reference rows.
    #[napi]
    pub fn find_code_ref_chunks<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::CodeSymbolInput =
                arg(input, "findCodeRefChunks input")?;
            s.find_code_ref_chunks(&input)
        })
    }

    /// `countOversizedEmbedSkips(input)`: `{ marked, chunkless }`.
    #[napi]
    pub fn count_oversized_embed_skips<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: f64 = arg(input, "countOversizedEmbedSkips input")?;
            s.count_oversized_embed_skips(input)
        })
    }

    /// `codeChunksExist(input)`: a boolean.
    #[napi]
    pub fn code_chunks_exist<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::CodeChunksExistInput =
                arg(input, "codeChunksExist input")?;
            s.code_chunks_exist(&input)
        })
    }

    /// `hasUnsealedPages(input)`: a boolean.
    #[napi]
    pub fn has_unsealed_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::UnsealedPagesInput =
                arg(input, "hasUnsealedPages input")?;
            s.has_unsealed_pages(&input)
        })
    }

    /// `listQualifiedSymbolNames(input)`: the names.
    #[napi]
    pub fn list_qualified_symbol_names<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::QualifiedNamesInput =
                arg(input, "listQualifiedSymbolNames input")?;
            s.list_qualified_symbol_names(&input)
        })
    }

    /// `listSymbolLanguages(input)`: the languages.
    #[napi]
    pub fn list_symbol_languages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::SymbolLanguagesInput =
                arg(input, "listSymbolLanguages input")?;
            s.list_symbol_languages(&input)
        })
    }

    /// `listSupportedChunkIds(input)`: the chunk ids.
    #[napi]
    pub fn list_supported_chunk_ids<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::SupportedChunkIdsInput =
                arg(input, "listSupportedChunkIds input")?;
            s.list_supported_chunk_ids(&input)
        })
    }

    /// `listSymbolChunkIds(input)`: the chunk ids.
    #[napi]
    pub fn list_symbol_chunk_ids<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::SymbolChunkIdsInput =
                arg(input, "listSymbolChunkIds input")?;
            s.list_symbol_chunk_ids(&input)
        })
    }

    /// `listWalkChunkRows(input)`: the hydrated walk chunks.
    #[napi]
    pub fn list_walk_chunk_rows<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::WalkChunkRowsInput =
                arg(input, "listWalkChunkRows input")?;
            s.list_walk_chunk_rows(&input)
        })
    }

    /// `readReindexSpendInputs(input)`: `{ pages, chars }`.
    #[napi]
    pub fn read_reindex_spend_inputs<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::ReindexSpendInput =
                arg(input, "readReindexSpendInputs input")?;
            s.read_reindex_spend_inputs(&input)
        })
    }

    /// `listWithdrawalChunks(input)`: the chunk rows.
    #[napi]
    pub fn list_withdrawal_chunks<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::WithdrawalChunksInput =
                arg(input, "listWithdrawalChunks input")?;
            s.list_withdrawal_chunks(&input)
        })
    }

    /// `deleteChunksForPages(input)`: null.
    #[napi]
    pub fn delete_chunks_for_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: Vec<i64> = arg(input, "deleteChunksForPages input")?;
            s.delete_chunks_for_pages(&input)
        })
    }

    /// `deleteChunksExcept(input)`: null.
    #[napi]
    pub fn delete_chunks_except<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::DeleteChunksExceptInput =
                arg(input, "deleteChunksExcept input")?;
            s.delete_chunks_except(&input)
        })
    }

    /// `listContextualModeCandidates(input)`: the candidate rows.
    #[napi]
    pub fn list_contextual_mode_candidates<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: Vec<String> = arg(input, "listContextualModeCandidates input")?;
            s.list_contextual_mode_candidates(&input)
        })
    }

    /// `resolveFrozenHits(input)`: the hit rows.
    #[napi]
    pub fn resolve_frozen_hits<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::chunk_queries::FrozenHitsInput =
                arg(input, "resolveFrozenHits input")?;
            s.resolve_frozen_hits(&input)
        })
    }

    /// `readSegmentRegions(hits)`: `[{ chunk_id, byte_start }]` for the hits on served segmented
    /// pages.
    #[napi]
    pub fn read_segment_regions<'env>(
        &self,
        env: &'env Env,
        hits: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let hits: Vec<gbrain_store::chunk_queries::SegmentHit> =
                arg(hits, "readSegmentRegions hits")?;
            s.read_segment_regions(&hits)
        })
    }

    /// `countOrphanChunks()`: a count.
    #[napi]
    pub fn count_orphan_chunks<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_orphan_chunks())
    }

    /// `countCodeChunkPages()`: `{ chunks, pages }`.
    #[napi]
    pub fn count_code_chunk_pages<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_code_chunk_pages())
    }
}
