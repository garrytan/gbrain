//! The fence census reads and writes served from the store (`gbrain-store` `cli_reads::doctor_fence`). The TypeScript
//! members are in `src/core/rust-engine/store-members/fence-census.ts` (rust/docs/store/cli-reads-doctor-fence.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listFenceCensusSources({ sourceIds })`: resolves `[{ id, incarnation, local_path }]`.
    #[napi]
    pub fn list_fence_census_sources<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_fence_census_sources(&required(input, "listFenceCensusSources input")?)
        })
    }

    /// `readFencePassHorizon({ graceMs })`: resolves the timestamp text.
    #[napi]
    pub fn read_fence_pass_horizon<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_fence_pass_horizon(&required(input, "readFencePassHorizon input")?)
        })
    }

    /// `listFenceCensusPages({ sourceId, mode, afterId, lower, after, limit })`: resolves the census page rows.
    #[napi]
    pub fn list_fence_census_pages<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_fence_census_pages(&required(input, "listFenceCensusPages input")?)
        })
    }

    /// `listLiveFencePageIds({ pageIds })`: resolves the ids of the pages that are not soft-deleted.
    #[napi]
    pub fn list_live_fence_page_ids<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_live_fence_page_ids(&required(input, "listLiveFencePageIds input")?)
        })
    }

    /// `readFenceCheckpointRecord({ op, fingerprint })`: resolves the stored record, or null.
    #[napi]
    pub fn read_fence_checkpoint_record<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_fence_checkpoint_record(&required(input, "readFenceCheckpointRecord input")?)
        })
    }

    /// `writeFenceScanRecord({ op, fingerprint, record })`: resolves nothing.
    #[napi]
    pub fn write_fence_scan_record<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_fence_scan_record(&required(input, "writeFenceScanRecord input")?)
        })
    }

    /// `upsertFenceCandidatePart({ op, fingerprint, sourceId, incarnation, key, part, finding })`: resolves nothing.
    #[napi]
    pub fn upsert_fence_candidate_part<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.upsert_fence_candidate_part(&required(input, "upsertFenceCandidatePart input")?)
        })
    }

    /// `clearFenceCandidateParts({ op, fingerprints, part })`: resolves nothing.
    #[napi]
    pub fn clear_fence_candidate_parts<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.clear_fence_candidate_parts(&required(input, "clearFenceCandidateParts input")?)
        })
    }

    /// `listFenceCandidateRecords({ op, sourceIds })`: resolves the candidate records of live incarnations.
    #[napi]
    pub fn list_fence_candidate_records<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_fence_candidate_records(&required(input, "listFenceCandidateRecords input")?)
        })
    }

    /// `countSegmentedFencePages({ sourceIds, walkedSourceIds })`: resolves the count.
    #[napi]
    pub fn count_segmented_fence_pages<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_segmented_fence_pages(&required(input, "countSegmentedFencePages input")?)
        })
    }
}
