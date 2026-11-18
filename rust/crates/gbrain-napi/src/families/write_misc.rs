//! Page-write reads that belong to no other family: a source's state (rust/docs/store/write_misc.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readSourceState(sourceId)`: `{ incarnation, archived, local_path, config }` or `null`.
    #[napi]
    pub fn read_source_state<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_state(&source_id))
    }
}
