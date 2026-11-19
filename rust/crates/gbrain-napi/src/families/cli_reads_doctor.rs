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
}
