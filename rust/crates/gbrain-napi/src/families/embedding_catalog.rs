//! Embedding catalog reads: one `#[napi] impl Brain` block over `gbrain_store::embedding_catalog`
//! and the stale-fact count of `gbrain_store::facts::doctor`
//! (src/core/rust-engine/store-members/embedding-catalog.ts).
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::doctor::CoverageQuery;

/// `readChunkVectorColumn(column)` and `hasStoredVectors(store)`: the one name each reads.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NameArgs {
    name: String,
}

#[napi]
impl Brain {
    /// `readEmbeddingColumnTypmod(table)`: resolves `[{ dim }]` or `[]`.
    #[napi]
    pub fn read_embedding_column_typmod<'env>(
        &self,
        env: &'env Env,
        table: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_embedding_column_typmod(&table))
    }

    /// `readEmbeddingSignatureCensus()`: resolves `{ signature, pages }[]`.
    #[napi]
    pub fn read_embedding_signature_census<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_embedding_signature_census())
    }

    /// `countUnembeddedLiveFacts(excludedSources)`: resolves the count.
    #[napi]
    pub fn count_unembedded_live_facts<'env>(
        &self,
        env: &'env Env,
        excluded: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_unembedded_live_facts(&excluded))
    }

    /// `countSynopsisTierPages()`: resolves the count.
    #[napi]
    pub fn count_synopsis_tier_pages<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_synopsis_tier_pages())
    }

    /// `countEmbedSkipNullChunks()`: resolves the count.
    #[napi]
    pub fn count_embed_skip_null_chunks<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_embed_skip_null_chunks())
    }

    /// `readFalseStampedChunkCounts(signature, model)`: resolves `{ pages, chunks, chars }`.
    #[napi]
    pub fn read_false_stamped_chunk_counts<'env>(
        &self,
        env: &'env Env,
        signature: String,
        model: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_false_stamped_chunk_counts(&signature, &model)
        })
    }

    /// `readChunkVectorColumn(column)`: resolves `{ exists, dims }`.
    #[napi]
    pub fn read_chunk_vector_column<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: NameArgs = required(args, "readChunkVectorColumn args")?;
            s.read_chunk_vector_column(&a.name)
        })
    }

    /// `readEmbeddingIdentity()`: resolves `{ model, dimensions }` or `null`.
    #[napi]
    pub fn read_embedding_identity<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_embedding_identity())
    }

    /// `hasStoredVectors(store)`: resolves a boolean.
    #[napi]
    pub fn has_stored_vectors<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: NameArgs = required(args, "hasStoredVectors args")?;
            s.has_stored_vectors(&a.name)
        })
    }

    /// `countStaleFactEmbeddings(opts)`: resolves `{ count, chars }`.
    #[napi]
    pub fn count_stale_fact_embeddings<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: CoverageQuery = required(args, "countStaleFactEmbeddings args")?;
            s.count_stale_fact_embeddings(&a)
        })
    }
}
