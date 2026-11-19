//! The effect journal: the claim, queue, release, mirror-gate, completion and re-arm statements of
//! a page write's post-commit effects (rust/docs/store/effects.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Effect ids cross as strings or numbers (`PersistenceEffect.id` is `string | number`).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `selectClaimableEffect(hostId, deadOwners)`: the next claimable effect row or `null`.
    #[napi]
    pub fn select_claimable_effect<'env>(
        &self,
        env: &'env Env,
        host_id: String,
        dead_owners: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.select_claimable_effect(&host_id, &dead_owners)
        })
    }

    /// `claimEffect(id, token, claimOwnerJson)`: the claimed effect row or `null`.
    #[napi]
    pub fn claim_effect<'env>(
        &self,
        env: &'env Env,
        id: Value,
        token: String,
        claim_owner_json: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.claim_effect(&id, &token, &claim_owner_json))
    }

    /// `queueEffects({ requestId, revision, sourceId, sourceIncarnation, worktreeId, queued })`:
    /// the kinds inserted.
    #[napi]
    pub fn queue_effects<'env>(&self, env: &'env Env, queue: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.queue_effects(&required(queue, "queueEffects queue")?)
        })
    }

    /// `releaseAbandonedEffectClaims(cutoffIso)`: how many claims went back to queued.
    #[napi]
    pub fn release_abandoned_effect_claims<'env>(
        &self,
        env: &'env Env,
        cutoff: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.release_abandoned_effect_claims(&cutoff))
    }

    /// `listMirrorGates(requestIds)`: `[{ request_id, state, data }]`.
    #[napi]
    pub fn list_mirror_gates<'env>(
        &self,
        env: &'env Env,
        request_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_mirror_gates(&request_ids))
    }

    /// `completeEffect(id, token, outcome)`: `true` when the claim still held.
    #[napi]
    pub fn complete_effect<'env>(
        &self,
        env: &'env Env,
        id: Value,
        token: Option<String>,
        outcome: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.complete_effect(&id, token.as_deref(), &outcome)
        })
    }

    /// `completeEffects([{ id, token }], outcome)`: how many claims still held.
    #[napi]
    pub fn complete_effects<'env>(
        &self,
        env: &'env Env,
        rows: Value,
        outcome: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<gbrain_store::effects::EffectClaimRef> =
                required(rows, "completeEffects rows")?;
            s.complete_effects(&rows, &outcome)
        })
    }

    /// `hasRearmableEffects(requestIds)`: whether a parked target waits on a committed mirror.
    #[napi]
    pub fn has_rearmable_effects<'env>(
        &self,
        env: &'env Env,
        request_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_rearmable_effects(&request_ids))
    }
}
