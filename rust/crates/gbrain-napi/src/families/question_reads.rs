//! The pinned-question reads the store serves (gbrain-store `question_reads`): the candidate pages, timeline entries,
//! takes and facts of a refresh, the question page row, the refresh clock, the new-pages and new-facts checks of an
//! answer's watermark and the rows a publication rereads
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

    /// `listQuestionCandidatePages(sourceId, slugs)`: the live inline pages with these slugs that no quarantine marks.
    #[napi]
    pub fn list_question_candidate_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_question_candidate_pages(&source_id, &slugs)
        })
    }

    /// `listQuestionEvidenceTimeline(pageIds)`: the eligible timeline entries of these pages, newest first, at most 20.
    #[napi]
    pub fn list_question_evidence_timeline<'env>(
        &self,
        env: &'env Env,
        page_ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_question_evidence_timeline(&page_ids))
    }

    /// `listQuestionEvidenceTakes(pageIds)`: the active, eligible takes of these pages, newest first, at most 20.
    #[napi]
    pub fn list_question_evidence_takes<'env>(
        &self,
        env: &'env Env,
        page_ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_question_evidence_takes(&page_ids))
    }

    /// `readQuestionPageRow(sourceId, slug)`: the live question page's row, or null.
    #[napi]
    pub fn read_question_page_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_question_page_row(&source_id, &slug))
    }

    /// `readQuestionEvidenceClock(sourceId)`: `{ generation, fact_id }`.
    #[napi]
    pub fn read_question_evidence_clock<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_question_evidence_clock(&source_id))
    }

    /// `hasNewQuestionPages(sourceId, generation, prefix)`: whether a live non-question page above `generation` exists.
    #[napi]
    pub fn has_new_question_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        generation: i64,
        prefix: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_new_question_pages(&source_id, generation, prefix)
        })
    }

    /// `lockQuestionEvidenceRows(kind, ids)`: the rows of one kind a publication rereads.
    #[napi]
    pub fn lock_question_evidence_rows<'env>(
        &self,
        env: &'env Env,
        kind: String,
        ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.lock_question_evidence_rows(&kind, &ids))
    }
}
