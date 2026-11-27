//! The edge-contradiction dream phase and its proposals: listEdgeContradictionCandidates,
//! listKnownEdgeProposals, recordEdgeProposal, readEdgeProposal, edgeClosureLanded,
//! readEdgeProposalEvidence, readEdgeProposalHash, markEdgeProposalStale, setEdgeProposalStatus,
//! rejectOpenEdgeProposal, markEdgeProposalUndone and markRevertedEdgeProposals; and the six
//! members of `gbrain edge-proposals`: listEdgeProposalCliRows, deleteHeldEdgeProposalErrors,
//! listAppliedEdgeProposalIds, deleteEdgeProposalError, readEdgeProposalSourceId and
//! markEdgeProposalDated.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::edge_proposals` call on the
//! pool through `Brain::run` and resolves plain JSON
//! (src/core/rust-engine/store-members/edge-proposals.ts).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::edge_proposals::{EdgeCandidateQuery, EdgeProposalCliFilter, EdgeProposalInput};

#[napi]
impl Brain {
    /// `listEdgeContradictionCandidates(query)`: `query` also carries `nonEmployerTypes` and
    /// `nonEmployerPrefixes`. Resolves the candidate rows; `recorded_at` is an ISO string.
    #[napi]
    pub fn list_edge_contradiction_candidates<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: EdgeCandidateQuery = required(query, "listEdgeContradictionCandidates query")?;
            s.list_edge_contradiction_candidates(&q)
        })
    }

    /// `listKnownEdgeProposals(fromPageId, linkType, evidenceHashes)`: resolves
    /// `[{ a, b, status, detail, recent }]`.
    #[napi]
    pub fn list_known_edge_proposals<'env>(
        &self,
        env: &'env Env,
        from_page_id: f64,
        link_type: String,
        evidence_hashes: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_known_edge_proposals(from_page_id, &link_type, &evidence_hashes)
        })
    }

    /// `recordEdgeProposal(proposal)`: resolves the row id, `null` when the existing row stood.
    #[napi]
    pub fn record_edge_proposal<'env>(
        &self,
        env: &'env Env,
        proposal: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let p: EdgeProposalInput = required(proposal, "recordEdgeProposal proposal")?;
            s.record_edge_proposal(&p)
        })
    }

    /// `readEdgeProposal(id)`: resolves the row, `null` when none.
    #[napi]
    pub fn read_edge_proposal<'env>(&self, env: &'env Env, id: f64) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_edge_proposal(id))
    }

    /// `edgeClosureLanded(fromPageId, endingToPageId, linkType, closeDate)`: resolves a boolean.
    #[napi]
    pub fn edge_closure_landed<'env>(
        &self,
        env: &'env Env,
        from_page_id: f64,
        ending_to_page_id: Option<f64>,
        link_type: String,
        close_date: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.edge_closure_landed(
                from_page_id,
                ending_to_page_id,
                &link_type,
                close_date.as_deref(),
            )
        })
    }

    /// `readEdgeProposalEvidence(id)`: resolves `{ a, b }`, `null` when either relationship is
    /// gone.
    #[napi]
    pub fn read_edge_proposal_evidence<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_edge_proposal_evidence(id))
    }

    /// `readEdgeProposalHash(id)`: resolves `{ evidence_hash }`, `null` when none.
    #[napi]
    pub fn read_edge_proposal_hash<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_edge_proposal_hash(id))
    }

    /// `markEdgeProposalStale(id)`.
    #[napi]
    pub fn mark_edge_proposal_stale<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.mark_edge_proposal_stale(id))
    }

    /// `setEdgeProposalStatus(id, status)`.
    #[napi]
    pub fn set_edge_proposal_status<'env>(
        &self,
        env: &'env Env,
        id: f64,
        status: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_edge_proposal_status(id, &status))
    }

    /// `rejectOpenEdgeProposal(id)`: resolves whether the proposal was open.
    #[napi]
    pub fn reject_open_edge_proposal<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.reject_open_edge_proposal(id))
    }

    /// `markEdgeProposalUndone(id)`.
    #[napi]
    pub fn mark_edge_proposal_undone<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.mark_edge_proposal_undone(id))
    }

    /// `markRevertedEdgeProposals()`: resolves how many applied proposals became
    /// `reverted_by_user`.
    #[napi]
    pub fn mark_reverted_edge_proposals<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.mark_reverted_edge_proposals())
    }

    /// `listEdgeProposalCliRows(filter, limit)`: resolves the rows; `created_at` is an ISO string.
    #[napi]
    pub fn list_edge_proposal_cli_rows<'env>(
        &self,
        env: &'env Env,
        filter: Value,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let f: EdgeProposalCliFilter = required(filter, "listEdgeProposalCliRows filter")?;
            s.list_edge_proposal_cli_rows(&f, limit)
        })
    }

    /// `deleteHeldEdgeProposalErrors()`: resolves `[{ id }]`.
    #[napi]
    pub fn delete_held_edge_proposal_errors<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_held_edge_proposal_errors())
    }

    /// `listAppliedEdgeProposalIds()`: resolves `[{ id }]`.
    #[napi]
    pub fn list_applied_edge_proposal_ids<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_applied_edge_proposal_ids())
    }

    /// `deleteEdgeProposalError(id)`: resolves `[{ id }]`, `[]` when none.
    #[napi]
    pub fn delete_edge_proposal_error<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_edge_proposal_error(id))
    }

    /// `readEdgeProposalSourceId(id)`: resolves the source id, `null` when none.
    #[napi]
    pub fn read_edge_proposal_source_id<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_edge_proposal_source_id(id))
    }

    /// `markEdgeProposalDated(id)`.
    #[napi]
    pub fn mark_edge_proposal_dated<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.mark_edge_proposal_dated(id))
    }
}
