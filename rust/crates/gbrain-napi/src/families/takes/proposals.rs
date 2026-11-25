//! Takes: the take proposal queue of the propose_takes cycle step and `gbrain takes propose`
//! (rust/docs/store/takes-reads.md, "Take proposals"), with the op checkpoint document of its
//! failure ledger and the write requests an accept admitted under one request id.
//! Same shape as `../takes.rs`.

use gbrain_store::takes::{
    ProposeTakesCandidateScope, TakeProposalInput, TakeProposalListSpec, TakeProposalPageKey,
};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use super::whole;
use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listPendingTakeProposals({ sourceId?, limit })`: the queue rows, newest first.
    #[napi]
    pub fn list_pending_take_proposals<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: TakeProposalListSpec = required(spec, "listPendingTakeProposals spec")?;
            s.list_pending_take_proposals(&spec)
        })
    }

    /// `readTakeProposal(id, sourceId?)`: the queue row or null.
    #[napi]
    pub fn read_take_proposal<'env>(
        &self,
        env: &'env Env,
        id: f64,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_take_proposal(whole(id, "id")?, source_id.as_deref())
        })
    }

    /// `claimTakeProposal(id, actedBy)`: `{ id, acted_at }` or null.
    #[napi]
    pub fn claim_take_proposal<'env>(
        &self,
        env: &'env Env,
        id: f64,
        acted_by: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.claim_take_proposal(whole(id, "id")?, &acted_by)
        })
    }

    /// `readStrandedTakeProposalClaim(id)`: `{ id, acted_at }` or null.
    #[napi]
    pub fn read_stranded_take_proposal_claim<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_stranded_take_proposal_claim(whole(id, "id")?)
        })
    }

    /// `releaseTakeProposalClaim(id, claimedAt)`.
    #[napi]
    pub fn release_take_proposal_claim<'env>(
        &self,
        env: &'env Env,
        id: f64,
        claimed_at: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.release_take_proposal_claim(whole(id, "id")?, claimed_at.as_deref())
        })
    }

    /// `setTakeProposalPromotedRow(id, rowNum)`.
    #[napi]
    pub fn set_take_proposal_promoted_row<'env>(
        &self,
        env: &'env Env,
        id: f64,
        row_num: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_take_proposal_promoted_row(whole(id, "id")?, whole(row_num, "rowNum")?)
        })
    }

    /// `rejectTakeProposal(id, actedBy)`: whether it was pending.
    #[napi]
    pub fn reject_take_proposal<'env>(
        &self,
        env: &'env Env,
        id: f64,
        acted_by: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.reject_take_proposal(whole(id, "id")?, &acted_by)
        })
    }

    /// `takeProposalCached({ sourceId, pageSlug, contentHash, promptVersion })`: a boolean.
    #[napi]
    pub fn take_proposal_cached<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: TakeProposalPageKey = required(key, "takeProposalCached key")?;
            s.take_proposal_cached(&key)
        })
    }

    /// `listRejectedTakeProposalClaims(sourceId, pageSlug)`: the claim texts.
    #[napi]
    pub fn list_rejected_take_proposal_claims<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_rejected_take_proposal_claims(&source_id, &page_slug)
        })
    }

    /// `insertTakeProposal(p)`: the new id, or null when the claim is already under its page key.
    #[napi]
    pub fn insert_take_proposal<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let p: TakeProposalInput = required(input, "insertTakeProposal input")?;
            s.insert_take_proposal(&p)
        })
    }

    /// `listTakeProposalTombstones(sourceId, prefix)`: `[{ id, slug, claim_text, prompt_version, proposed_at }]`.
    #[napi]
    pub fn list_take_proposal_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_take_proposal_tombstones(&source_id, &prefix)
        })
    }

    /// `deleteTakeProposalTombstones(sourceId, prefix, slug?)`: the pages released.
    #[napi]
    pub fn delete_take_proposal_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        prefix: String,
        slug: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_take_proposal_tombstones(&source_id, &prefix, slug.as_deref())
        })
    }

    /// `listProposeTakesCandidatePages({ sourceIds?, sourceId?, types, limit })`: `[{ slug, source_id, compiled_truth }]`.
    #[napi]
    pub fn list_propose_takes_candidate_pages<'env>(
        &self,
        env: &'env Env,
        scope: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: ProposeTakesCandidateScope =
                required(scope, "listProposeTakesCandidatePages scope")?;
            s.list_propose_takes_candidate_pages(&scope)
        })
    }

    /// `readOpCheckpointDoc(op, fingerprint)`: the document or null.
    #[napi]
    pub fn read_op_checkpoint_doc<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_op_checkpoint_doc(&op, &fingerprint))
    }

    /// `writeOpCheckpointDoc(op, fingerprint, doc)`.
    #[napi]
    pub fn write_op_checkpoint_doc<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        doc: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_op_checkpoint_doc(&op, &fingerprint, &doc)
        })
    }

    /// `listWriteRequestsByRequestId(requestId)`: the request rows.
    #[napi]
    pub fn list_write_requests_by_request_id<'env>(
        &self,
        env: &'env Env,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_write_requests_by_request_id(&request_id)
        })
    }
}
