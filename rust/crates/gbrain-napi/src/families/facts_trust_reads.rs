//! Group 5 facts members that read the stamped trust columns: `listSingleFactMetadata`,
//! `listUnpreviewedTrustFacts` and `listRestatedPrivateCopies`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::trust_reads` call on
//! the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/facts-trust-reads.ts) refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::trust_reads::{
    RestatedPrivateCopiesQuery, SingleFactMetadataQuery, UnpreviewedTrustQuery,
};

#[napi]
impl Brain {
    /// `listSingleFactMetadata(args)`: resolves the metadata rows of the named facts, by id.
    #[napi]
    pub fn list_single_fact_metadata<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SingleFactMetadataQuery = required(args, "listSingleFactMetadata args")?;
            s.list_single_fact_metadata(&a)
        })
    }

    /// `listUnpreviewedTrustFacts(args)`: resolves the trust-release facts with no field preview.
    #[napi]
    pub fn list_unpreviewed_trust_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UnpreviewedTrustQuery = required(args, "listUnpreviewedTrustFacts args")?;
            s.list_unpreviewed_trust_facts(&a)
        })
    }

    /// `listRestatedPrivateCopies(args)`: resolves the private copy of a claim a world copy does not lift.
    #[napi]
    pub fn list_restated_private_copies<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RestatedPrivateCopiesQuery = required(args, "listRestatedPrivateCopies args")?;
            s.list_restated_private_copies(&a)
        })
    }
}
