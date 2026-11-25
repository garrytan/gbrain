//! The pinned-question reads the store serves (gbrain-store `question_reads`): the evidence facts of a refresh and
//! whether new facts arrived since an answer's watermark
//! (src/core/rust-engine/store-members/question-reads.ts).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listQuestionEvidenceFacts(sourceId, entitySlugs)`: `[{ id, fact, entity_slug, valid_from, hash }]`, newest first.
    #[napi]
    pub fn list_question_evidence_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        entity_slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_question_evidence_facts(&source_id, &entity_slugs)
        })
    }

    /// `hasNewQuestionFacts(sourceId, factId, entitySlug)`: whether an unexpired fact above `factId` exists.
    #[napi]
    pub fn has_new_question_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        fact_id: i64,
        entity_slug: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_new_question_facts(&source_id, fact_id, entity_slug)
        })
    }
}
