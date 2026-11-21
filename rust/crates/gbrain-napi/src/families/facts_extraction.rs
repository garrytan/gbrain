//! The facts backstop effect's two extraction reads (`src/core/engine-sql/facts-backstop.ts`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `hasPendingFactsExtraction(pageId, jobStates)`: a queued or running facts backstop effect of the page, or a
    /// facts-absorb job of it in one of `jobStates`.
    #[napi]
    pub fn has_pending_facts_extraction<'env>(
        &self,
        env: &'env Env,
        page_id: String,
        job_states: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_pending_facts_extraction(&page_id, &job_states)
        })
    }

    /// `hasCompletedFactsExtraction(pageId)`: a completed, not skipped facts-absorb job of the page.
    #[napi]
    pub fn has_completed_facts_extraction<'env>(
        &self,
        env: &'env Env,
        page_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_completed_facts_extraction(&page_id))
    }
}
