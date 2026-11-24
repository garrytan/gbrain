//! The facts members a remember, a proposal review, a page retire and a recall by id use: `readFactEntitySlugById`,
//! `readSupersessionReplacement`, `linkSupersededFact`, `listFactsToRetireFromPage`, `listFactProvenance`,
//! `listFactRowsByIds`, `readFactVisibility`, `readFactActivity`, `readReviewAcceptedMark`, `readPairFactRow`,
//! `expireSupersededFact`, `restoreSupersededFact`, `readReplacementTarget`, `readMemberPageWithdrawal` and
//! `readClaimWithdrawal`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::remember_reads` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/facts-remember.ts) refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::remember_reads::{
    AcceptedMarkArgs, ClaimWithdrawalArgs, ExpireSupersededFactArgs, FactIdArgs, LinkArgs,
    MemberWithdrawalArgs, PairFactArgs, ReplacementPairArgs, ReplacementTargetArgs,
    RestoreSupersededFactArgs, RetireArgs, RowsByIdsArgs, SourcedFactArgs,
};

#[napi]
impl Brain {
    /// `readFactEntitySlugById(args)`: resolves the slug or null.
    #[napi]
    pub fn read_fact_entity_slug_by_id<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactIdArgs = required(args, "readFactEntitySlugById args")?;
            s.read_fact_entity_slug_by_id(&a)
        })
    }

    /// `readSupersessionReplacement(args)`: resolves the pair row or null.
    #[napi]
    pub fn read_supersession_replacement<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ReplacementPairArgs = required(args, "readSupersessionReplacement args")?;
            s.read_supersession_replacement(&a)
        })
    }

    /// `linkSupersededFact(args)`: links the old fact to the new one; resolves null.
    #[napi]
    pub fn link_superseded_fact<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LinkArgs = required(args, "linkSupersededFact args")?;
            s.link_superseded_fact(&a)
        })
    }

    /// `listFactsToRetireFromPage(args)`: resolves the facts to retire.
    #[napi]
    pub fn list_facts_to_retire_from_page<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RetireArgs = required(args, "listFactsToRetireFromPage args")?;
            s.list_facts_to_retire_from_page(&a)
        })
    }

    /// `listFactRowsByIds(args)`: resolves the whole rows.
    #[napi]
    pub fn list_fact_rows_by_ids<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RowsByIdsArgs = required(args, "listFactRowsByIds args")?;
            s.list_fact_rows_by_ids(&a)
        })
    }

    /// `readFactVisibility(args)`: resolves the visibility or null.
    #[napi]
    pub fn read_fact_visibility<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourcedFactArgs = required(args, "readFactVisibility args")?;
            s.read_fact_visibility(&a)
        })
    }

    /// `readFactActivity(args)`: resolves whether the fact is active, with its text hash, or null.
    #[napi]
    pub fn read_fact_activity<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourcedFactArgs = required(args, "readFactActivity args")?;
            s.read_fact_activity(&a)
        })
    }

    /// `readReviewAcceptedMark(args)`: resolves the fact id or null.
    #[napi]
    pub fn read_review_accepted_mark<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: AcceptedMarkArgs = required(args, "readReviewAcceptedMark args")?;
            s.read_review_accepted_mark(&a)
        })
    }

    /// `readPairFactRow(args)`: resolves the pair columns or null.
    #[napi]
    pub fn read_pair_fact_row<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PairFactArgs = required(args, "readPairFactRow args")?;
            s.read_pair_fact_row(&a)
        })
    }

    /// `expireSupersededFact(args)`: ends and links the old fact; resolves the row count.
    #[napi]
    pub fn expire_superseded_fact<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExpireSupersededFactArgs = required(args, "expireSupersededFact args")?;
            s.expire_superseded_fact(&a)
        })
    }

    /// `retireSupersededFact(args)`: the remember consumer's supersede; resolves the row count.
    #[napi]
    pub fn retire_superseded_fact<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExpireSupersededFactArgs = required(args, "retireSupersededFact args")?;
            s.retire_superseded_fact(&a)
        })
    }

    /// `restoreSupersededFact(args)`: puts the old fact back; resolves the row count.
    #[napi]
    pub fn restore_superseded_fact<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RestoreSupersededFactArgs = required(args, "restoreSupersededFact args")?;
            s.restore_superseded_fact(&a)
        })
    }

    /// `readReplacementTarget(args)`: resolves the target row with `withdrawn`, or null.
    #[napi]
    pub fn read_replacement_target<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ReplacementTargetArgs = required(args, "readReplacementTarget args")?;
            s.read_replacement_target(&a)
        })
    }

    /// `readMemberPageWithdrawal(args)`: resolves the withdrawal a member-page save meets, or null.
    #[napi]
    pub fn read_member_page_withdrawal<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: MemberWithdrawalArgs = required(args, "readMemberPageWithdrawal args")?;
            s.read_member_page_withdrawal(&a)
        })
    }

    /// `readClaimWithdrawal(args)`: resolves `{ hidden, row }` for a save of a forgotten claim.
    #[napi]
    pub fn read_claim_withdrawal<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClaimWithdrawalArgs = required(args, "readClaimWithdrawal args")?;
            s.read_claim_withdrawal(&a)
        })
    }
}
