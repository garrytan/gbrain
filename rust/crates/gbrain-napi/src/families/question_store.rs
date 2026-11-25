//! The pinned-question members beyond main's insert, read and listing: the locked read, the state change, the refresh lease,
//! spend, the blocked record and the answer publish (on the pin records of gbrain-store `jobs/pinned_questions.rs`), and the
//! evidence rows with the two reads that join them (gbrain-store `questions`)
//! (src/core/rust-engine/store-members/question-store.ts, rust/docs/store/questions.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readPinnedQuestionForUpdate(sourceId, slug)`: resolves the pin's row or null.
    #[napi]
    pub fn read_pinned_question_for_update<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_pinned_question_for_update(&source_id, &slug)
        })
    }

    /// `updatePinRowState(id, patch)`: resolves the changed row, or null for an unknown id.
    #[napi]
    pub fn update_pin_row_state<'env>(
        &self,
        env: &'env Env,
        id: i64,
        patch: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let patch: gbrain_store::questions::PinStatePatch =
                required(patch, "updatePinRowState patch")?;
            s.update_pin_row_state(id, &patch)
        })
    }

    /// `acquirePinLease(id, token, owner, ttlMs)`: resolves the leased row, or null.
    #[napi]
    pub fn acquire_pin_lease<'env>(
        &self,
        env: &'env Env,
        id: i64,
        token: String,
        owner: String,
        ttl_ms: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ttl: gbrain_store::questions::Float8 = required(ttl_ms, "acquirePinLease ttlMs")?;
            s.acquire_pin_lease(id, &token, &owner, ttl)
        })
    }

    /// `releasePinLease(id, token, error, spendUsd)`: resolves null.
    #[napi]
    pub fn release_pin_lease<'env>(
        &self,
        env: &'env Env,
        id: i64,
        token: String,
        error: Option<String>,
        spend_usd: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spend: gbrain_store::questions::Float8 =
                required(spend_usd, "releasePinLease spendUsd")?;
            s.release_pin_lease(id, &token, error, spend)
        })
    }

    /// `addPinSpend(id, usd)`: resolves null.
    #[napi]
    pub fn add_pin_spend<'env>(
        &self,
        env: &'env Env,
        id: i64,
        usd: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let usd: gbrain_store::questions::Float8 = required(usd, "addPinSpend usd")?;
            s.add_pin_spend(id, usd)
        })
    }

    /// `recordPinBlocked(id, code)`: resolves null.
    #[napi]
    pub fn record_pin_blocked<'env>(
        &self,
        env: &'env Env,
        id: i64,
        code: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.record_pin_blocked(id, &code))
    }

    /// `lockPinRowForPublish(id)`: resolves `{ revision, lease_token, state }` or null.
    #[napi]
    pub fn lock_pin_row_for_publish<'env>(
        &self,
        env: &'env Env,
        id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.lock_pin_row_for_publish(id))
    }

    /// `publishPinAnswer(id, publish)`: resolves null.
    #[napi]
    pub fn publish_pin_answer<'env>(
        &self,
        env: &'env Env,
        id: i64,
        publish: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let publish: gbrain_store::questions::PinAnswerPublish =
                required(publish, "publishPinAnswer publish")?;
            s.publish_pin_answer(id, &publish)
        })
    }

    /// `deleteQuestionEvidence(questionId)`: resolves null.
    #[napi]
    pub fn delete_question_evidence<'env>(
        &self,
        env: &'env Env,
        question_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_question_evidence(question_id))
    }

    /// `insertQuestionEvidence(rows)`: resolves null.
    #[napi]
    pub fn insert_question_evidence<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<gbrain_store::questions::EvidenceInsert> =
                required(rows, "insertQuestionEvidence rows")?;
            s.insert_question_evidence(&rows)
        })
    }

    /// `listQuestionEvidenceJoin(questionId, answerRevision)`: resolves one row per evidence row of that revision.
    #[napi]
    pub fn list_question_evidence_join<'env>(
        &self,
        env: &'env Env,
        question_id: i64,
        answer_revision: i32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_question_evidence_join(question_id, answer_revision)
        })
    }

    /// `listPublishedQuestionAnswers(sourceId)`: resolves `[{ answer, published_at, cited }]`.
    #[napi]
    pub fn list_published_question_answers<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_published_question_answers(&source_id))
    }
}
