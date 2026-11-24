//! Group 5 facts members, the captured-facts and facts-rehome repair statements: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::captured` (src/core/engine-sql/facts-repair.ts).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and resolves plain JSON
//! (rust/README.md, "The brain store"). `readRepairBrainId` has no method: the TypeScript member reads
//! `getBrainIdentity`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::captured::{
    ExpireCapturedArgs, NamedFactsArgs, RehomeArgs, SourceIdsArgs,
};

#[napi]
impl Brain {
    /// `listActiveSourceIds()`: resolves `[{ id }]`, the unarchived sources by id.
    #[napi]
    pub fn list_active_source_ids<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_active_source_ids())
    }

    /// `listFenceRewriteRows({ sourceId, ids })`: resolves `[{ id, fact, row_num }]`.
    #[napi]
    pub fn list_fence_rewrite_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: NamedFactsArgs = required(args, "listFenceRewriteRows args")?;
            s.list_fence_rewrite_rows(&a)
        })
    }

    /// `expireCapturedFacts({ sourceId, ids, context })`: resolves `[{ id }]`, the facts it expired.
    #[napi]
    pub fn expire_captured_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExpireCapturedArgs = required(args, "expireCapturedFacts args")?;
            s.expire_captured_facts(&a)
        })
    }

    /// `listExpiredFactIds({ sourceId, ids })`: resolves `[{ id }]`.
    #[napi]
    pub fn list_expired_fact_ids<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: NamedFactsArgs = required(args, "listExpiredFactIds args")?;
            s.list_expired_fact_ids(&a)
        })
    }

    /// `listSourceIncarnations({ sourceIds })`: resolves `[{ id, incarnation }]`.
    #[napi]
    pub fn list_source_incarnations<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceIdsArgs = required(args, "listSourceIncarnations args")?;
            s.list_source_incarnations(&a)
        })
    }

    /// `readEntityRehomeState({ sourceId, from, to })`: resolves `{ from_live, to_live, ids }`.
    #[napi]
    pub fn read_entity_rehome_state<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RehomeArgs = required(args, "readEntityRehomeState args")?;
            s.read_entity_rehome_state(&a)
        })
    }

    /// `rehomeEntityFacts({ sourceId, from, to })`: resolves null.
    #[napi]
    pub fn rehome_entity_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RehomeArgs = required(args, "rehomeEntityFacts args")?;
            s.rehome_entity_facts(&a)
        })
    }
}
