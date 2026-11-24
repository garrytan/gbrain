//! Group 5 facts members that serve the owner from the stamped trust columns and the write-gate
//! receipts: `readFactForOwnerAction`, `countDerivedFactTaint` and
//! `listStandingPreferences`. `matchSavedFacts` and `listLexicalContestCandidates` are in `facts_trust.rs`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::trust_owner` call on
//! the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/facts-trust-owner.ts) refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::trust_owner::{OwnerActionFactQuery, StandingPreferencesQuery};

#[napi]
impl Brain {
    /// `readFactForOwnerAction(args)`: resolves the owner-binding row of one fact, or null.
    #[napi]
    pub fn read_fact_for_owner_action<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: OwnerActionFactQuery = required(args, "readFactForOwnerAction args")?;
            s.read_fact_for_owner_action(&a)
        })
    }

    /// `countDerivedFactTaint()`: resolves `{ derived, external }`.
    #[napi]
    pub fn count_derived_fact_taint<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_derived_fact_taint())
    }

    /// `listStandingPreferences(args)`: resolves the flagged unconfirmed standing instructions.
    #[napi]
    pub fn list_standing_preferences<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: StandingPreferencesQuery = required(args, "listStandingPreferences args")?;
            s.list_standing_preferences(&a)
        })
    }
}
