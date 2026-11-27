//! Doctor tallies: the typed counts that replace raw SQL a doctor catch hid a refusal of
//! (store side: `gbrain_store::cli_reads::doctor_tallies`, docs in `rust/docs/store/cli-reads-doctor-tallies.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `countLiveSegmentedPages({ projectionPending })`: resolves a count.
    #[napi]
    pub fn count_live_segmented_pages<'env>(
        &self,
        env: &'env Env,
        projection_pending: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_live_segmented_pages(projection_pending)
        })
    }

    /// `countValidityLapsedFacts()`: resolves a count.
    #[napi]
    pub fn count_validity_lapsed_facts<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_validity_lapsed_facts())
    }

    /// `countOrphanEventProjections(sourceIds)`: resolves a count.
    #[napi]
    pub fn count_orphan_event_projections<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_orphan_event_projections(source_ids.as_deref())
        })
    }
}
