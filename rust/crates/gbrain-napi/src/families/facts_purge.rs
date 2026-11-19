//! Group 5 facts members, purge, withdrawal, relink and fence repair.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::purge` call on the
//! pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/facts-purge.ts) apply the defaults and refuse what the
//! store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::purge::{
    FactScopeArgs, HeldFenceQuery, PurgeTargetArgs, RelinkQuery, SimilarQuery, SingleFactQuery,
    SourceArgs, UnfencedQuery, WithdrawalExpiry,
};
use gbrain_store::facts::reconcile::{BacklogArgs, DrainArgs, LockArgs, SettleArgs};

#[napi]
impl Brain {
    /// `countFactFingerprintLeftovers(args)`: resolves the number of rows left.
    #[napi]
    pub fn count_fact_fingerprint_leftovers<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactScopeArgs = required(args, "countFactFingerprintLeftovers args")?;
            s.count_fact_fingerprint_leftovers(&a)
        })
    }

    /// `loadPurgeTarget(args)`: resolves the target row or null.
    #[napi]
    pub fn load_purge_target<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeTargetArgs = required(args, "loadPurgeTarget args")?;
            s.load_purge_target(&a)
        })
    }

    /// `planFactPurgeIds(args)`: resolves `{ id }` rows by id.
    #[napi]
    pub fn plan_fact_purge_ids<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactScopeArgs = required(args, "planFactPurgeIds args")?;
            s.plan_fact_purge_ids(&a)
        })
    }

    /// `listRelinkCandidateRows(args)`: resolves the loose active rows after an id.
    #[napi]
    pub fn list_relink_candidate_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RelinkQuery = required(args, "listRelinkCandidateRows args")?;
            s.list_relink_candidate_rows(&a)
        })
    }

    /// `countRelinkCandidates(args)`: resolves the number of rows a fence or page owns.
    #[napi]
    pub fn count_relink_candidates<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceArgs = required(args, "countRelinkCandidates args")?;
            s.count_relink_candidates(&a)
        })
    }

    /// `listSimilarActiveFacts(args)`: resolves `{ anchor, rows }`.
    #[napi]
    pub fn list_similar_active_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SimilarQuery = required(args, "listSimilarActiveFacts args")?;
            s.list_similar_active_facts(&a)
        })
    }

    /// `findActiveSingleFact(args)`: resolves the `SELECT *` row or null.
    #[napi]
    pub fn find_active_single_fact<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SingleFactQuery = required(args, "findActiveSingleFact args")?;
            s.find_active_single_fact(&a)
        })
    }

    /// `listUnfencedFactRows(args)`: resolves the unfenced active rows.
    #[napi]
    pub fn list_unfenced_fact_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UnfencedQuery = required(args, "listUnfencedFactRows args")?;
            s.list_unfenced_fact_rows(&a)
        })
    }

    /// `listHeldFenceFactRows(args)`: resolves the live fence rows of a page.
    #[napi]
    pub fn list_held_fence_fact_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HeldFenceQuery = required(args, "listHeldFenceFactRows args")?;
            s.list_held_fence_fact_rows(&a)
        })
    }

    /// `listWithdrawalSlugs(args)`: resolves `{ slug }` rows, sorted.
    #[napi]
    pub fn list_withdrawal_slugs<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactScopeArgs = required(args, "listWithdrawalSlugs args")?;
            s.list_withdrawal_slugs(&a)
        })
    }

    /// `expireFactsByWithdrawal(args)`: resolves `{ id }` of the rows it expired.
    #[napi]
    pub fn expire_facts_by_withdrawal<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: WithdrawalExpiry = required(args, "expireFactsByWithdrawal args")?;
            s.expire_facts_by_withdrawal(&a)
        })
    }

    /// `listFactsReconcileBacklog({ marker })`: resolves `{ rows, segmented }`.
    #[napi]
    pub fn list_facts_reconcile_backlog<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: BacklogArgs = required(args, "listFactsReconcileBacklog args")?;
            s.list_facts_reconcile_backlog(&a)
        })
    }

    /// `settleFactsReconcile(args)`: records one page's reconcile outcome; resolves null.
    #[napi]
    pub fn settle_facts_reconcile<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SettleArgs = required(args, "settleFactsReconcile args")?;
            s.settle_facts_reconcile(&a)
        })
    }

    /// `lockReconcileRevision(args)`: resolves whether the live page is still at `revision`.
    #[napi]
    pub fn lock_reconcile_revision<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LockArgs = required(args, "lockReconcileRevision args")?;
            s.lock_reconcile_revision(&a)
        })
    }

    /// `selectFactsReconcileDrain(args)`: settles the fenceless due pages; resolves the slugs to drain.
    #[napi]
    pub fn select_facts_reconcile_drain<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DrainArgs = required(args, "selectFactsReconcileDrain args")?;
            s.select_facts_reconcile_drain(&a)
        })
    }
}
