//! Group 5 facts members of the claim-conflict, contested-proposal, live-entity-page and gone-page reads and writes: one
//! `#[napi] impl Brain` block over `gbrain_store::facts::rest_sites`.
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/facts-rest.ts) judge the privacy policies and send the arguments of their
//! BrainEngine members.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::rest_sites::{
    ClaimPairArgs, ContestedArgs, GonePagesArgs, LiveEntityPageArgs,
};

#[napi]
impl Brain {
    /// `listClaimConflictPairs(args)`: resolves the unproposed claim conflicts, at most the cap.
    #[napi]
    pub fn list_claim_conflict_pairs<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClaimPairArgs = required(args, "listClaimConflictPairs args")?;
            s.list_claim_conflict_pairs(&a)
        })
    }

    /// `countClaimConflictPairs(args)`: resolves `{ n }`.
    #[napi]
    pub fn count_claim_conflict_pairs<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClaimPairArgs = required(args, "countClaimConflictPairs args")?;
            s.count_claim_conflict_pairs(&a)
        })
    }

    /// `readLiveFactEntityPage(args)`: resolves `{ slug, type }` of the live page, or null.
    #[napi]
    pub fn read_live_fact_entity_page<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LiveEntityPageArgs = required(args, "readLiveFactEntityPage args")?;
            s.read_live_fact_entity_page(&a)
        })
    }

    /// `listContestedProposalPairs(args)`: resolves the pending proposals that name a listed fact.
    #[napi]
    pub fn list_contested_proposal_pairs<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ContestedArgs = required(args, "listContestedProposalPairs args")?;
            s.list_contested_proposal_pairs(&a)
        })
    }

    /// `expireFactsOfGonePages(args)`: resolves null once the facts are expired.
    #[napi]
    pub fn expire_facts_of_gone_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: GonePagesArgs = required(args, "expireFactsOfGonePages args")?;
            s.expire_facts_of_gone_pages(&a)
        })
    }
}
