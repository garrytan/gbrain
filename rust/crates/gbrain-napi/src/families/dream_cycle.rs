//! The dream cycle statements (`src/core/engine-sql/dream-cycle.ts`): the job and cycle lock reads
//! (`gbrain_store::jobs`), and the page, fact, take, version and journal statements
//! (`gbrain_store::dream_reads`).
//!
//! One `#[napi] impl Brain` block; each method runs one store call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/dream-cycle.ts) check the integer binds and map the
//! timestamps onto Dates.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::dream_reads::{DreamProvenanceCountQuery, DreamProvenanceStamp};
use gbrain_store::facts::PrivacyPolicy;

#[napi]
impl Brain {
    /// `listDreamQueueCandidates()`: `[{ id, queue, status, idempotency_key, source_id }]`.
    #[napi]
    pub fn list_dream_queue_candidates<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_dream_queue_candidates())
    }

    /// `listLiveDreamCycleLocks(graceSecs)`: `[{ id, acquired_epoch_ms }]`.
    #[napi]
    pub fn list_live_dream_cycle_locks<'env>(
        &self,
        env: &'env Env,
        grace_secs: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_live_dream_cycle_locks(grace_secs))
    }

    /// `readDreamJobStatus(id)`: `{ status }` or null.
    #[napi]
    pub fn read_dream_job_status<'env>(
        &self,
        env: &'env Env,
        id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_dream_job_status(id))
    }

    /// `listDreamJobCreatedAt(ids)`: `[{ id, created_at }]`, `created_at` ISO.
    #[napi]
    pub fn list_dream_job_created_at<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "listDreamJobCreatedAt ids")?;
            s.list_dream_job_created_at(&ids)
        })
    }

    /// `listCompletedSynthJobs(key)`: `[{ id, idempotency_key }]`.
    #[napi]
    pub fn list_completed_synth_jobs<'env>(
        &self,
        env: &'env Env,
        key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_completed_synth_jobs(&key))
    }

    /// `countCoalescibleSynthJobs(keys)`: a count.
    #[napi]
    pub fn count_coalescible_synth_jobs<'env>(
        &self,
        env: &'env Env,
        keys: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_coalescible_synth_jobs(&keys))
    }

    /// `listWaitingChildJobIds(queue)`: `[{ id }]`.
    #[napi]
    pub fn list_waiting_child_job_ids<'env>(
        &self,
        env: &'env Env,
        queue: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_waiting_child_job_ids(&queue))
    }

    /// `listDreamChildJobTimings(ids)`: the timestamps (ISO) and token counts of each job.
    #[napi]
    pub fn list_dream_child_job_timings<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "listDreamChildJobTimings ids")?;
            s.list_dream_child_job_timings(&ids)
        })
    }

    /// `countRecentDreamSynthSubmissions(sourceId)`: a count.
    #[napi]
    pub fn count_recent_dream_synth_submissions<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_recent_dream_synth_submissions(&source_id)
        })
    }

    /// `stampDreamPageProvenance(stamp)`: resolves null.
    #[napi]
    pub fn stamp_dream_page_provenance<'env>(
        &self,
        env: &'env Env,
        stamp: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let stamp: DreamProvenanceStamp = required(stamp, "stampDreamPageProvenance stamp")?;
            s.stamp_dream_page_provenance(&stamp)
        })
    }

    /// `listDreamPageIds` and `findConsolidationPageIds`: `[{ id }]` of the live page.
    #[napi]
    pub fn list_dream_page_ids<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_dream_page_ids(&source_id, &slug))
    }

    /// `countDreamProvenancePages(query)`: `{ found, earlier }`.
    #[napi]
    pub fn count_dream_provenance_pages<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: DreamProvenanceCountQuery = required(query, "countDreamProvenancePages query")?;
            s.count_dream_provenance_pages(&q)
        })
    }

    /// `listRetainedDreamOutputSources(sourceId)`: `[{ raw_source }]`.
    #[napi]
    pub fn list_retained_dream_output_sources<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_retained_dream_output_sources(&source_id)
        })
    }

    /// `listDreamAtomPages(sourceId)`: `[{ slug, title, compiled_truth, frontmatter, private }]`.
    #[napi]
    pub fn list_dream_atom_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        policy: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy: PrivacyPolicy = required(policy, "listDreamAtomPages policy")?;
            s.list_dream_atom_pages(&source_id, &policy)
        })
    }

    /// `listSynthesisPageBodies(sourceId, slugs)`: `[{ slug, title, body }]`.
    #[napi]
    pub fn list_synthesis_page_bodies<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_synthesis_page_bodies(&source_id, &slugs)
        })
    }

    /// `readDreamPreRunRevision(slug, sourceId, sinceIso)`: `{ compiled_truth, timeline, frontmatter }` or null.
    #[napi]
    pub fn read_dream_pre_run_revision<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        since: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_dream_pre_run_revision(&source_id, &slug, &since)
        })
    }

    /// `readDreamVerifyEpoch()`: the store clock as ISO text.
    #[napi]
    pub fn read_dream_verify_epoch<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_dream_verify_epoch())
    }

    /// `listConsolidationClaimValues(ids)`: `[{ id, claim_value }]`.
    #[napi]
    pub fn list_consolidation_claim_values<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "listConsolidationClaimValues ids")?;
            s.list_consolidation_claim_values(&ids)
        })
    }

    /// `listConsolidationClaimShapes(ids)`: `[{ id, claim_metric, claim_unit, claim_period }]`.
    #[napi]
    pub fn list_consolidation_claim_shapes<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "listConsolidationClaimShapes ids")?;
            s.list_consolidation_claim_shapes(&ids)
        })
    }

    /// `setConsolidatedFactValidUntil(validUntil, id)`: resolves null.
    #[napi]
    pub fn set_consolidated_fact_valid_until<'env>(
        &self,
        env: &'env Env,
        valid_until: String,
        id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_consolidated_fact_valid_until(&valid_until, id)
        })
    }

    /// `listReadersSourcedFactIds(ids)`: `[{ id }]`.
    #[napi]
    pub fn list_readers_sourced_fact_ids<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "listReadersSourcedFactIds ids")?;
            s.list_readers_sourced_fact_ids(&ids)
        })
    }

    /// `readConsolidationTakesMaxRowNum(pageId)`: a row number, 0 when the page has no take.
    #[napi]
    pub fn read_consolidation_takes_max_row_num<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_consolidation_takes_max_row_num(page_id)
        })
    }

    /// `findConsolidatedTakes(pageId, claim)`: `[{ id, resolved_at }]`, `resolved_at` ISO or null.
    #[napi]
    pub fn find_consolidated_takes<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        claim: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.find_consolidated_takes(page_id, &claim))
    }

    /// `refreshConsolidatedTakeSource(source, id)`: resolves null.
    #[napi]
    pub fn refresh_consolidated_take_source<'env>(
        &self,
        env: &'env Env,
        source: String,
        id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.refresh_consolidated_take_source(&source, id)
        })
    }

    /// `findConsolidatedTakeIds(pageId, rowNum)`: `[{ id }]`.
    #[napi]
    pub fn find_consolidated_take_ids<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        row_num: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.find_consolidated_take_ids(page_id, row_num))
    }

    /// `readDreamDeferralReceipt(receiptId)`: `{ state, error_code, error_message }` or null.
    #[napi]
    pub fn read_dream_deferral_receipt<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_dream_deferral_receipt(&id))
    }
}
