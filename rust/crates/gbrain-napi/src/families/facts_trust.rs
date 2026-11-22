//! Group 5 facts members, search relevance and trust reads: one `#[napi] impl Brain` block over `gbrain_store::facts::trust`.
//!
//! The TypeScript members (src/core/rust-engine/store-members/facts-trust.ts) resolve the caller's
//! read policy and refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::trust::{RelevanceQuery, UncomparableQuery};

#[napi]
impl Brain {
    /// `listFactsForRelevance`: resolves the pool rows of one arm, each with its `similarity`.
    #[napi]
    pub fn list_facts_for_relevance<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RelevanceQuery = required(query, "listFactsForRelevance query")?;
            s.list_facts_for_relevance(&a)
        })
    }

    /// `countUncomparableFacts`: resolves `{ source_id, n }` per source, the most first.
    #[napi]
    pub fn count_uncomparable_facts<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UncomparableQuery = required(query, "countUncomparableFacts query")?;
            s.count_uncomparable_facts(&a)
        })
    }
}
