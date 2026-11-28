//! The keyword index's doctor check and rebuild (store side: `gbrain_store::keyword` `index_health.rs`,
//! docs in `rust/docs/store/keyword.md`, "Doctor").
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `checkDerivedIndexes(maxPages)`: the keyword index's health (`KeywordIndexHealth`); `maxPages`
    /// bounds the posting comparison (null: every page). Writes nothing.
    #[napi]
    pub fn check_derived_indexes<'env>(
        &self,
        env: &'env Env,
        max_pages: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        let max_pages = max_pages.map(|n| n.max(0) as u64);
        self.run(env, move |s| s.derived_index_check(max_pages))
    }

    /// `rebuildDerivedIndexes()`: rebuilds the keyword index from the records to a complete state
    /// and returns the receipt (`KeywordIndexRebuild`). Writes only keyword index records.
    #[napi]
    pub fn rebuild_derived_indexes<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.derived_index_rebuild())
    }
}
