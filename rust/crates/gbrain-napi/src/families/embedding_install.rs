//! The embedding effect's install path: the completion read, the effect claim check and the vector
//! install (`gbrain_store::embedding_install`, `lock_effect_claim_row`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use gbrain_store::embedding_install::{CompletionOptions, InstallRow};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readEmbeddingCompletion(pageId, options)`: one row per visible chunk of the page.
    #[napi]
    pub fn read_embedding_completion<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "readEmbeddingCompletion pageId")?;
            let options: CompletionOptions = required(options, "readEmbeddingCompletion options")?;
            s.read_embedding_completion(page_id, &options)
        })
    }

    /// `installChunkEmbeddings(pageId, rows)`: stores each row's vector on its unchanged chunk.
    #[napi]
    pub fn install_chunk_embeddings<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "installChunkEmbeddings pageId")?;
            let rows: Vec<InstallRow> = required(rows, "installChunkEmbeddings rows")?;
            s.install_chunk_embeddings(page_id, &rows)
        })
    }

    /// `lockEffectClaimRow(effectId)`: the effect's state and execution token, or null.
    #[napi]
    pub fn lock_effect_claim_row<'env>(
        &self,
        env: &'env Env,
        effect_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.lock_effect_claim_row(required(effect_id, "lockEffectClaimRow effectId")?)
        })
    }
}
