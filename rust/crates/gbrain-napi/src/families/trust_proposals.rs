//! Trust decisions: the `trust_proposals` queue (`gbrain_store::trust::proposals`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/README.md, "The brain store"). Rows keep the `SELECT *` column
//! names; the times are ISO text.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::trust::proposals::{Decider, NewProposal, ProposalFilter};

#[napi]
impl Brain {
    /// `insertTrustProposal(input)`: resolves `{ id, created }`; `created` is false when a pending
    /// proposal of the same action, target and related row already exists (its id).
    #[napi]
    pub fn insert_trust_proposal<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: NewProposal = required(input, "insertTrustProposal input")?;
            s.insert_trust_proposal(&input)
        })
    }

    /// `getTrustProposal(id)`: resolves the proposal row or null.
    #[napi]
    pub fn get_trust_proposal<'env>(&self, env: &'env Env, id: i64) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_trust_proposal(id))
    }

    /// `listTrustProposals(filter)`: resolves the rows, oldest first. `since` is ISO text and
    /// `limit` is already clamped by the caller.
    #[napi]
    pub fn list_trust_proposals<'env>(
        &self,
        env: &'env Env,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: ProposalFilter = required(filter, "listTrustProposals filter")?;
            s.list_trust_proposals(&filter)
        })
    }

    /// `pendingTrustProposalsFor(table, id)`: resolves the pending rows naming the row, by id.
    #[napi]
    pub fn pending_trust_proposals_for<'env>(
        &self,
        env: &'env Env,
        table: String,
        id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.pending_trust_proposals_for(&table, id))
    }

    /// `updatePendingTrustProposalAfter(id, after)`: resolves when done.
    #[napi]
    pub fn update_pending_trust_proposal_after<'env>(
        &self,
        env: &'env Env,
        id: i64,
        after: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.update_pending_trust_proposal_after(id, &after)
        })
    }

    /// `transitionTrustProposal(id, from, to, after, decidedBy)`: resolves true when the proposal
    /// was in `from`. `after` and `decidedBy` are null when not given.
    #[napi]
    pub fn transition_trust_proposal<'env>(
        &self,
        env: &'env Env,
        id: i64,
        from: String,
        to: String,
        after: Option<Value>,
        decided_by: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let after = after.filter(|v| !v.is_null());
            let decided_by: Option<Decider> = match decided_by.filter(|v| !v.is_null()) {
                None => None,
                Some(v) => Some(required(v, "transitionTrustProposal decidedBy")?),
            };
            s.transition_trust_proposal(id, &from, &to, after.as_ref(), decided_by.as_ref())
        })
    }
}
