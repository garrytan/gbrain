//! The decide proposal tables: supersede proposals, review proposals, the review queue and the
//! conflict sweep's retry rows (rust/docs/store/decide-proposals.md).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON. Row ids are numbers.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `insertDecideProposal(p)`: resolves the new id, or null when a slot is taken.
    #[napi]
    pub fn insert_decide_proposal<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::eval_capture::decide_proposals::DecideProposalInput =
                required(input, "insertDecideProposal input")?;
            s.insert_decide_proposal(&input)
        })
    }

    /// `getDecideProposal(id)`: resolves the proposal row, or null.
    #[napi]
    pub fn get_decide_proposal<'env>(&self, env: &'env Env, id: i64) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_decide_proposal(id))
    }

    /// `listDecideProposalIds(sweepId, status)`: resolves the ids by pair index.
    #[napi]
    pub fn list_decide_proposal_ids<'env>(
        &self,
        env: &'env Env,
        sweep_id: String,
        status: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_decide_proposal_ids(&sweep_id, &status))
    }

    /// `listDecideProposals({ status?, limit? }?)`: resolves the proposals with their facts' text.
    #[napi]
    pub fn list_decide_proposals<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_decide_proposals(&arg(options, "listDecideProposals options")?)
        })
    }

    /// `listPendingContradictions({ sourceId?, since? }?)`: resolves the pending proposals whose two
    /// facts are both active, with the facts' tier, entity and claim.
    #[napi]
    pub fn list_pending_contradictions<'env>(
        &self,
        env: &'env Env,
        filter: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_pending_contradictions(&arg(filter, "listPendingContradictions filter")?)
        })
    }

    /// `transitionDecideProposal({ id, from, to, before?, after? })`: resolves whether a row moved.
    #[napi]
    pub fn transition_decide_proposal<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::eval_capture::decide_proposals::DecideProposalTransition =
                required(input, "transitionDecideProposal input")?;
            s.transition_decide_proposal(&input)
        })
    }

    /// `listDecideProposedPairs(sourceId, factId)`: resolves `{ a, b }` pairs naming the fact.
    #[napi]
    pub fn list_decide_proposed_pairs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        fact_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_decide_proposed_pairs(&source_id, fact_id)
        })
    }

    /// `insertDecideReviewProposal(p)`: resolves the new id, or null when the proposal exists.
    #[napi]
    pub fn insert_decide_review_proposal<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::eval_capture::decide_proposals::DecideReviewProposalInput =
                required(input, "insertDecideReviewProposal input")?;
            s.insert_decide_review_proposal(&input)
        })
    }

    /// `listDecideReviewProposals(status)`: `all` or one status; resolves the rows by id.
    #[napi]
    pub fn list_decide_review_proposals<'env>(
        &self,
        env: &'env Env,
        status: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_decide_review_proposals(&status))
    }

    /// `getDecideReviewProposal(id)`: resolves the row, or null.
    #[napi]
    pub fn get_decide_review_proposal<'env>(
        &self,
        env: &'env Env,
        id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_decide_review_proposal(id))
    }

    /// `transitionDecideReviewProposal({ id, from, to })`: resolves whether a row moved.
    #[napi]
    pub fn transition_decide_review_proposal<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::eval_capture::decide_proposals::DecideReviewProposalTransition =
                required(input, "transitionDecideReviewProposal input")?;
            s.transition_decide_review_proposal(&input)
        })
    }

    /// `listDecideReviewProposalIds(sweepId, includeWithdrawals)`: resolves the pending ids.
    #[napi]
    pub fn list_decide_review_proposal_ids<'env>(
        &self,
        env: &'env Env,
        sweep_id: String,
        include_withdrawals: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_decide_review_proposal_ids(&sweep_id, include_withdrawals)
        })
    }

    /// `readProposalReviewRates()`: resolves the per-kind counts.
    #[napi]
    pub fn read_proposal_review_rates<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_proposal_review_rates())
    }

    /// `listDueDecideReviewQueue(kind, sourceId, limit)`: resolves the due queue rows.
    #[napi]
    pub fn list_due_decide_review_queue<'env>(
        &self,
        env: &'env Env,
        kind: String,
        source_id: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_due_decide_review_queue(&kind, &source_id, limit)
        })
    }

    /// `applyDecideReviewQueue({ op, ... })`: resolves the number of rows touched.
    #[napi]
    pub fn apply_decide_review_queue<'env>(
        &self,
        env: &'env Env,
        op: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let op: gbrain_store::eval_capture::decide_proposals::ReviewQueueOp =
                required(op, "applyDecideReviewQueue op")?;
            s.apply_decide_review_queue(&op)
        })
    }

    /// `listDueDecideSweepDeferred(sourceId, limit)`: resolves the due retry rows.
    #[napi]
    pub fn list_due_decide_sweep_deferred<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_due_decide_sweep_deferred(&source_id, limit)
        })
    }

    /// `applyDecideSweepDeferred(sourceId, { op, ... })`: resolves the number of rows touched.
    #[napi]
    pub fn apply_decide_sweep_deferred<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        op: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let op: gbrain_store::eval_capture::decide_proposals::SweepDeferredOp =
                required(op, "applyDecideSweepDeferred op")?;
            s.apply_decide_sweep_deferred(&source_id, &op)
        })
    }
}
