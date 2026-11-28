//! Doctor reads: the typed members that replace the raw SQL of `gbrain doctor` checks
//! (store side: `gbrain_store::cli_reads::doctor`, docs in `rust/docs/store/cli-reads-doctor.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `countPageChildOrphans(target)`: a count.
    #[napi]
    pub fn count_page_child_orphans<'env>(
        &self,
        env: &'env Env,
        target: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_page_child_orphans(&target))
    }

    /// `countContextualCoverage(chunkerVersion, sourceIds?)`: `{ chunker_drift, unsealed, unsealed_code, mode_null }`.
    #[napi]
    pub fn count_contextual_coverage<'env>(
        &self,
        env: &'env Env,
        chunker_version: i64,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_contextual_coverage(chunker_version, source_ids.as_deref())
        })
    }

    /// `countAbandonedTakes(sourceIds?)`: a count.
    #[napi]
    pub fn count_abandoned_takes<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_abandoned_takes(source_ids.as_deref()))
    }

    /// `countAppliedTakeGrades(sourceIds?)`: a count.
    #[napi]
    pub fn count_applied_take_grades<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_applied_take_grades(source_ids.as_deref())
        })
    }
}
