//! The agent-session repair statements: `listAgentSessionTakeCandidates`, `listSettledSessionFacts`,
//! `reattributeSessionFacts`, `retireSessionTakes`, `listOtherAttributedFactIds` and `listInactiveTakeIds`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::session_takes` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members are in src/core/rust-engine/store-members/facts-repair.ts.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::captured::NamedFactsArgs;
use gbrain_store::facts::session_takes::{
    ReattributeArgs, RetireTakesArgs, SessionTakeCandidatesArgs, TakeIdsArgs,
};

#[napi]
impl Brain {
    /// `listAgentSessionTakeCandidates(args)`: resolves `[{ id, source_id, slug, row_num, claim, fact_ids, user_fact_ids, noted }]`.
    #[napi]
    pub fn list_agent_session_take_candidates<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SessionTakeCandidatesArgs =
                required(args, "listAgentSessionTakeCandidates args")?;
            s.list_agent_session_take_candidates(&a)
        })
    }

    /// `listSettledSessionFacts(args)`: resolves `[{ id, context }]`.
    #[napi]
    pub fn list_settled_session_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: NamedFactsArgs = required(args, "listSettledSessionFacts args")?;
            s.list_settled_session_facts(&a)
        })
    }

    /// `reattributeSessionFacts(args)`: resolves the changed `[{ id }]`.
    #[napi]
    pub fn reattribute_session_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ReattributeArgs = required(args, "reattributeSessionFacts args")?;
            s.reattribute_session_facts(&a)
        })
    }

    /// `retireSessionTakes(args)`: resolves the retired `[{ id }]`.
    #[napi]
    pub fn retire_session_takes<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RetireTakesArgs = required(args, "retireSessionTakes args")?;
            s.retire_session_takes(&a)
        })
    }

    /// `listOtherAttributedFactIds(args)`: resolves `[{ id }]`.
    #[napi]
    pub fn list_other_attributed_fact_ids<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: NamedFactsArgs = required(args, "listOtherAttributedFactIds args")?;
            s.list_other_attributed_fact_ids(&a)
        })
    }

    /// `listInactiveTakeIds(args)`: resolves `[{ id }]`.
    #[napi]
    pub fn list_inactive_take_ids<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TakeIdsArgs = required(args, "listInactiveTakeIds args")?;
            s.list_inactive_take_ids(&a)
        })
    }
}
