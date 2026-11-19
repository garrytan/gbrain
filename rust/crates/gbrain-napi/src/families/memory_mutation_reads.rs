//! The reads `remember` and `forget` make before admission: `readSourceWriteRow`, `readSourceLocalPath`,
//! `readFactEntitySlug`, `hasLiveFileBackedPage`, `factReadableUnder`, `readRemoteForgetTier` and `readForgetTarget`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::memory_mutation_reads` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/memory-mutation-reads.ts) refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::memory_mutation_reads::{
    FactReadableQuery, ForgetTargetQuery, RemoteForgetTierQuery,
};

#[napi]
impl Brain {
    /// `readSourceWriteRow(sourceId)`: resolves the source row a memory write admits against, or `null`.
    #[napi]
    pub fn read_source_write_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_write_row(&source_id))
    }

    /// `readSourceLocalPath(sourceId)`: resolves the source's checkout, or `null`.
    #[napi]
    pub fn read_source_local_path<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_local_path(&source_id))
    }

    /// `readFactEntitySlug(id, sourceId)`: resolves the fact's entity slug, or `null`.
    #[napi]
    pub fn read_fact_entity_slug<'env>(
        &self,
        env: &'env Env,
        id: i64,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_fact_entity_slug(id, &source_id))
    }

    /// `hasLiveFileBackedPage(sourceId, slugs)`: resolves whether a live page among the slugs has a file.
    #[napi]
    pub fn has_live_file_backed_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_live_file_backed_page(&source_id, &slugs)
        })
    }

    /// `factReadableUnder(spec)`: resolves whether the caller reads the fact.
    #[napi]
    pub fn fact_readable_under<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: FactReadableQuery = required(spec, "factReadableUnder spec")?;
            s.fact_readable_under(&q)
        })
    }

    /// `readRemoteForgetTier(spec)`: resolves the stored tier of the world fact, or `null`.
    #[napi]
    pub fn read_remote_forget_tier<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: RemoteForgetTierQuery = required(spec, "readRemoteForgetTier spec")?;
            s.read_remote_forget_tier(&q)
        })
    }

    /// `readForgetTarget(spec)`: resolves the fact row a forget names, or `null`.
    #[napi]
    pub fn read_forget_target<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: ForgetTargetQuery = required(spec, "readForgetTarget spec")?;
            s.read_forget_target(&q)
        })
    }
}
