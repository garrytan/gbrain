//! Doctor reads, health set: the typed members that replace the raw SQL of the calibration and
//! remote-report checks (store side: `gbrain_store::cli_reads::doctor_health`, docs in
//! `rust/docs/store/cli-reads-doctor-health.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `countContextualRetrievalCoverage(markdownChunkerVersion, sourceIds?)`:
    /// `{ chunker_drift, unsealed, unsealed_code, mode_null }`.
    #[napi]
    pub fn count_contextual_retrieval_coverage<'env>(
        &self,
        env: &'env Env,
        markdown_chunker_version: i64,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_contextual_retrieval_coverage(markdown_chunker_version, source_ids.as_deref())
        })
    }

    /// `countAbandonedThreads(sourceIds?)`: the count.
    #[napi]
    pub fn count_abandoned_threads<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_abandoned_threads(source_ids.as_deref())
        })
    }

    /// `countOrphanedEventProjections(sourceIds?)`: the count.
    #[napi]
    pub fn count_orphaned_event_projections<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_orphaned_event_projections(source_ids.as_deref())
        })
    }
}
