//! The belief ledger's write path (rust/docs/store/collate-belief-writes.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::belief_events::EventRow;

#[napi]
impl Brain {
    /// `readBeliefCoverage(sourceId, coverageKey)`: `{ event_type, run, recorded_at, id }` or null.
    #[napi]
    pub fn read_belief_coverage<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        coverage_key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_belief_coverage(&source_id, &coverage_key)
        })
    }

    /// `hasBaselineEvent(sourceId, slug, runId)`.
    #[napi]
    pub fn has_baseline_event<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        run_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_baseline_event(&source_id, &slug, &run_id)
        })
    }

    /// `countBaselinedSlugs(sourceId, runId)`.
    #[napi]
    pub fn count_baselined_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        run_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_baselined_slugs(&source_id, &run_id))
    }

    /// `listPendingBaselineSlugs(sourceId, runId, after, skip, limit)`: slugs in byte order.
    #[napi]
    pub fn list_pending_baseline_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        run_id: String,
        after: String,
        skip: Vec<String>,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_pending_baseline_slugs(&source_id, &run_id, &after, &skip, limit as usize)
        })
    }

    /// `listPurgedFingerprints(sourceId, factFps, takeFps)`.
    #[napi]
    pub fn list_purged_fingerprints<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        fact_fps: Vec<String>,
        take_fps: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_purged_fingerprints(&source_id, &fact_fps, &take_fps)
        })
    }

    /// `readBeliefRedactions(sourceId, subjectKeys, fieldHashes)`.
    #[napi]
    pub fn read_belief_redactions<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        subject_keys: Vec<String>,
        field_hashes: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_belief_redactions(&source_id, &subject_keys, &field_hashes)
        })
    }

    /// `insertBeliefRedaction(sourceId, subjectKey, field, purgeRequest, fieldHash)`: the new id.
    #[napi]
    pub fn insert_belief_redaction<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        subject_key: String,
        field: String,
        purge_request: String,
        field_hash: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_belief_redaction(
                &source_id,
                &subject_key,
                &field,
                &purge_request,
                &field_hash,
            )
        })
    }

    /// `releaseBeliefRedactions(ids, publicationId, releasedHash)`.
    #[napi]
    pub fn release_belief_redactions<'env>(
        &self,
        env: &'env Env,
        ids: Vec<u32>,
        publication_id: String,
        released_hash: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<u64> = ids.into_iter().map(u64::from).collect();
            s.release_belief_redactions(&ids, &publication_id, &released_hash)
        })
    }

    /// `insertBeliefEvents(rows)`: how many rows it inserted.
    #[napi]
    pub fn insert_belief_events<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<EventRow> = required(rows, "insertBeliefEvents rows")?;
            s.insert_belief_events(rows)
        })
    }

    /// `recordBeliefCommitMarks(publicationIds)`.
    #[napi]
    pub fn record_belief_commit_marks<'env>(
        &self,
        env: &'env Env,
        publication_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.record_belief_commit_marks(&publication_ids))
    }
}
