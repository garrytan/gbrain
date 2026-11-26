//! Group 5 facts members, search relevance and trust reads: one `#[napi] impl Brain` block over `gbrain_store::facts::trust`
//! and `gbrain_store::facts::saved_match`.
//!
//! The TypeScript members (src/core/rust-engine/store-members/facts-trust.ts) resolve the caller's
//! read policy and refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::contest::LexicalContestQuery;
use gbrain_store::facts::quote::{OwnerTierQuery, QuotedPagesQuery};
use gbrain_store::facts::saved_match::{EntityNewestFactsQuery, SavedFactsMatchQuery};
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

    /// `matchSavedFacts`: resolves the matched rows, most matched terms first, then newest.
    #[napi]
    pub fn match_saved_facts<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SavedFactsMatchQuery = required(query, "matchSavedFacts query")?;
            s.match_saved_facts(&a)
        })
    }

    /// `listLexicalContestCandidates(query)`: resolves `{ id, fact, trust_tier }` rows, highest id first.
    #[napi]
    pub fn list_lexical_contest_candidates<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LexicalContestQuery = required(query, "listLexicalContestCandidates query")?;
            s.list_lexical_contest_candidates(&a)
        })
    }

    /// `listFactsFromQuotedPages(query)`: resolves the fact ids from a quoted page, ascending.
    #[napi]
    pub fn list_facts_from_quoted_pages<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: QuotedPagesQuery = required(query, "listFactsFromQuotedPages query")?;
            s.list_facts_from_quoted_pages(&a)
        })
    }

    /// `listOwnerTierFacts(query)`: resolves the fact ids at or above the floor, ascending.
    #[napi]
    pub fn list_owner_tier_facts<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: OwnerTierQuery = required(query, "listOwnerTierFacts query")?;
            s.list_owner_tier_facts(&a)
        })
    }

    /// `readEntityNewestFacts`: resolves the entity's newest facts, at most 50, newest first.
    #[napi]
    pub fn read_entity_newest_facts<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: EntityNewestFactsQuery = required(query, "readEntityNewestFacts query")?;
            s.read_entity_newest_facts(&a)
        })
    }

    /// `matchHeadStems`: resolves `{ h, i }` per head, in `heads` order.
    #[napi]
    pub fn match_head_stems<'env>(
        &self,
        env: &'env Env,
        heads: Vec<String>,
        terms: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.match_head_stems(&heads, &terms))
    }
}
