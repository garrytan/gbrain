//! Doctor reads of the checks from the rust-engine/main join: the page scans of `access_pages_read_by_nobody`
//! (store side: `gbrain_store::cli_reads::doctor_join`, docs in `rust/docs/store/cli-reads-doctor-join.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listPagesReadByNobody(live)`: `{ source_id, slug, readers }` rows by source and slug.
    #[napi]
    pub fn list_pages_read_by_nobody<'env>(
        &self,
        env: &'env Env,
        live: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_pages_read_by_nobody(&live))
    }

    /// `listRulePagesReadByNobody(sourceId, prefix, admittedCount, admitted)`: `{ source_id, slug, readers }` rows by
    /// source and slug.
    #[napi]
    pub fn list_rule_pages_read_by_nobody<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        prefix: String,
        admitted_count: i64,
        admitted: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_rule_pages_read_by_nobody(&source_id, &prefix, admitted_count, &admitted)
        })
    }
}
