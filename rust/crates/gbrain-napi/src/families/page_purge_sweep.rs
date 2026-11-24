//! The deletes and reads of a page purge's sweep, its segment storage and its slug stores (src/core/engine-sql/page-purge-sweep.ts,
//! facts-purge.ts and purge-slug-stores.ts): the decide, trust, write-gate, fact and file rows that name a page, the page's
//! timeline receipts and change reasons, the page's stagings and texts, and the claim sweep.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through `Brain::run` and resolves plain
//! JSON (src/core/rust-engine/store-members/page-purge-sweep.ts).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `deletePurgedPageTrustProposals`: deletes the source's trust proposals naming the page, its facts or its takes; resolves how many.
    #[napi]
    pub fn delete_purged_page_trust_proposals<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_id: i64,
        fact_ids: Vec<i64>,
        take_ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_purged_page_trust_proposals(&source_id, page_id, &fact_ids, &take_ids)
        })
    }

    /// `deletePurgedPageHolds`: deletes every hold of the slug in the source; resolves their ids as text.
    #[napi]
    pub fn delete_purged_page_holds<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_purged_page_holds(&source_id, &slug))
    }

    /// `deletePurgedPageGateReceipts`: deletes the gate receipts naming the page, its facts, its takes or its holds; resolves how many.
    #[napi]
    pub fn delete_purged_page_gate_receipts<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        fact_ids: Vec<i64>,
        take_ids: Vec<i64>,
        hold_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_purged_page_gate_receipts(page_id, &fact_ids, &take_ids, &hold_ids)
        })
    }

    /// `deletePurgedPageFacts`: deletes the facts filed on or extracted from the page; resolves how many.
    #[napi]
    pub fn delete_purged_page_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_purged_page_facts(&source_id, &slug))
    }

    /// `deletePurgedPageFiles`: deletes the page's file records; resolves their storage paths.
    #[napi]
    pub fn delete_purged_page_files<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_purged_page_files(&source_id, &slug, page_id)
        })
    }

    /// `listPageTimelineReceipts`: resolves the add_timeline_entry (and, with diffs, edit_page) receipts of the slugs after a sequence.
    #[napi]
    pub fn list_page_timeline_receipts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        limit: i64,
        after: String,
        with_diffs: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_timeline_receipts(&source_id, &slugs, limit, &after, with_diffs)
        })
    }

    /// `listPageSegmentShas`: resolves the sha256 (hex) of the texts the page's manifest and stagings name.
    #[napi]
    pub fn list_page_segment_shas<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_segment_shas(&source_id, &slug, page_id)
        })
    }

    /// `countPageManifestRows`: resolves how many manifest rows the page has.
    #[napi]
    pub fn count_page_manifest_rows<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_page_manifest_rows(page_id))
    }

    /// `deletePageStagings`: deletes the source's stagings of the slug or page; resolves how many.
    #[napi]
    pub fn delete_page_stagings<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_page_stagings(&source_id, &slug, page_id)
        })
    }

    /// `deletePageSegmentTexts`: deletes the unreferenced, unrecorded texts among the shas; resolves how many.
    #[napi]
    pub fn delete_page_segment_texts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        shas: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_page_segment_texts(&source_id, &shas))
    }

    /// `sweepPageTextsForClaims`: runs one claim-sweep statement; resolves `{ last, deleted }`.
    #[napi]
    pub fn sweep_page_texts_for_claims<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        cursor: String,
        forms: Vec<String>,
        chunk_bytes: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.sweep_page_texts_for_claims(&source_id, &cursor, &forms, chunk_bytes)
        })
    }

    /// `deletePurgedSlugStoreRows`: scrubs the stores keyed to the slugs; resolves `{ removed, secretStore }`.
    #[napi]
    pub fn delete_purged_slug_store_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_purged_slug_store_rows(&source_id, &slugs)
        })
    }

    /// `listPageChangeReasons`: resolves `{ reason }` for each distinct reason the page's versions and requests recorded.
    #[napi]
    pub fn list_page_change_reasons<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_change_reasons(&source_id, &slug, page_id)
        })
    }

    /// `listRequestsRecordingReasons`: resolves the slug's requests that recorded a reason.
    #[napi]
    pub fn list_requests_recording_reasons<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_requests_recording_reasons(&source_id, &slug)
        })
    }
}
