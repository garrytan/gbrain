//! The quote and slot-history reads: `listFactsFromQuotedPages`, `listFactIdsAtTrustFloor`, `readPageTypesByIds` and
//! `listReadablePageSlugs`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::quoted` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members (src/core/rust-engine/store-members/facts-quoted.ts)
//! resolve the caller's read policy.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::quoted::{QuotedFactsQuery, ReadablePageSlugsQuery, TrustFloorQuery};

#[napi]
impl Brain {
    /// `listFactsFromQuotedPages({ ids, pageTypes, backstopSessions })`: resolves the fact ids, ascending.
    #[napi]
    pub fn list_facts_from_quoted_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: QuotedFactsQuery = required(args, "listFactsFromQuotedPages args")?;
            s.list_facts_from_quoted_pages(&a)
        })
    }

    /// `listFactIdsAtTrustFloor({ ids, floor })`: resolves the fact ids, ascending.
    #[napi]
    pub fn list_fact_ids_at_trust_floor<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TrustFloorQuery = required(args, "listFactIdsAtTrustFloor args")?;
            s.list_fact_ids_at_trust_floor(&a)
        })
    }

    /// `readPageTypesByIds(ids)`: resolves `[{ id, type }]`.
    #[napi]
    pub fn read_page_types_by_ids<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_types_by_ids(&required::<Vec<i64>>(ids, "readPageTypesByIds ids")?)
        })
    }

    /// `listReadablePageSlugs({ sourceId, slugs, scope, limit })`: resolves the admitted slugs.
    #[napi]
    pub fn list_readable_page_slugs<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ReadablePageSlugsQuery = required(args, "listReadablePageSlugs args")?;
            s.list_readable_page_slugs(&a)
        })
    }
}
