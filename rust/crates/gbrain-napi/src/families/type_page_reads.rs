//! Page reads of the schema-pack conversions (rust/docs/store/type_page_reads.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `Store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};
use gbrain_store::type_page_reads::{RetypeProbe, TypePageQuery};
use serde_json::Value;

#[napi]
impl Brain {
    /// `listTypePageBodies(query)`: resolves `{ slug, compiled_truth, frontmatter }` for the live
    /// pages of one type, by slug then id.
    #[napi]
    pub fn list_type_page_bodies<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: TypePageQuery = required(query, "listTypePageBodies query")?;
            s.list_type_page_bodies(&query)
        })
    }

    /// `listSourceTypePageBodies(query)`: resolves the same rows for one source, by slug.
    #[napi]
    pub fn list_source_type_page_bodies<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: TypePageQuery = required(query, "listSourceTypePageBodies query")?;
            s.list_source_type_page_bodies(&query)
        })
    }

    /// `countRetypeCandidates(probe)`: resolves how many live pages of the rule's type match.
    #[napi]
    pub fn count_retype_candidates<'env>(
        &self,
        env: &'env Env,
        probe: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let probe: RetypeProbe = required(probe, "countRetypeCandidates probe")?;
            s.count_retype_candidates(&probe)
        })
    }

    /// `listRetypeSampleSlugs(probe)`: resolves the first ten matching slugs in byte order.
    #[napi]
    pub fn list_retype_sample_slugs<'env>(
        &self,
        env: &'env Env,
        probe: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let probe: RetypeProbe = required(probe, "listRetypeSampleSlugs probe")?;
            s.list_retype_sample_slugs(&probe)
        })
    }
}
