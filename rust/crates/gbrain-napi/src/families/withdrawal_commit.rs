//! The statements a forget's withdrawal commits and the `fact_withdrawn` refusal reads:
//! `lockFactForWithdrawal`, `queueWithdrawalReview`, `listSegmentedPagesBySlug`,
//! `bumpWithdrawnPageRevisions`, `readPageRevisions`, `appendFactForgetReason`,
//! `readFactWithdrawnRow` and `readFactWithdrawnBacking`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::trust::withdrawal_commit`
//! call on the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/withdrawal-commit.ts) refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::memory_mutation_reads::WithdrawalClaimQuery;
use gbrain_store::trust::withdrawal_commit::WithdrawnClaimQuery;

#[napi]
impl Brain {
    /// `lockFactForWithdrawal(spec)`: resolves `{ visibility, fact, subject }` of the fact a
    /// withdrawal admits, or null.
    #[napi]
    pub fn lock_fact_for_withdrawal<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: WithdrawalClaimQuery = required(spec, "lockFactForWithdrawal spec")?;
            s.lock_fact_for_withdrawal(&q)
        })
    }

    /// `queueWithdrawalReview(sourceId, factRef)`: queues the fact's overnight review once.
    #[napi]
    pub fn queue_withdrawal_review<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        fact_ref: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.queue_withdrawal_review(&source_id, &fact_ref)
        })
    }

    /// `listSegmentedPagesBySlug(sourceId, slugs)`: resolves `[{ id, slug }]`.
    #[napi]
    pub fn list_segmented_pages_by_slug<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_segmented_pages_by_slug(&source_id, &slugs)
        })
    }

    /// `bumpWithdrawnPageRevisions(sourceId, slugs)`: resolves `[{ id, slug, knowledge_revision }]`.
    #[napi]
    pub fn bump_withdrawn_page_revisions<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.bump_withdrawn_page_revisions(&source_id, &slugs)
        })
    }

    /// `readPageRevisions(ids)`: resolves `[{ id, slug, knowledge_revision }]`.
    #[napi]
    pub fn read_page_revisions<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "readPageRevisions ids")?;
            s.read_page_revisions(&ids)
        })
    }

    /// `appendFactForgetReason(id, sourceId, note)`: appends the note to the fact's context.
    #[napi]
    pub fn append_fact_forget_reason<'env>(
        &self,
        env: &'env Env,
        id: i64,
        source_id: String,
        note: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.append_fact_forget_reason(id, &source_id, &note)
        })
    }

    /// `readFactWithdrawnRow(spec)`: resolves `{ subject, visibility, withdrawn_at }`, or null.
    #[napi]
    pub fn read_fact_withdrawn_row<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: WithdrawnClaimQuery = required(spec, "readFactWithdrawnRow spec")?;
            s.read_fact_withdrawn_row(&q)
        })
    }

    /// `readFactWithdrawnBacking(spec)`: resolves `{ visible, hidden }`.
    #[napi]
    pub fn read_fact_withdrawn_backing<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: WithdrawnClaimQuery = required(spec, "readFactWithdrawnBacking spec")?;
            s.read_fact_withdrawn_backing(&q)
        })
    }
}
