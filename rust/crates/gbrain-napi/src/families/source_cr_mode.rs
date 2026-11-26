//! A source's own contextual-retrieval mode (src/core/engine-sql/source-cr-mode.ts): one
//! `#[napi] impl Brain` block over `gbrain_store::source_cr_mode`; rust/docs/store/source-cr-mode.md.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `setSourceContextualMode(id, mode)`: sets the source's mode, or clears it for `null`;
    /// whether the source exists.
    #[napi]
    pub fn set_source_contextual_mode<'env>(
        &self,
        env: &'env Env,
        id: String,
        mode: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_source_contextual_mode(&id, mode.as_deref())
        })
    }

    /// `readSourceContextualMode(id)`: the source's mode, or `null` when none is set.
    #[napi]
    pub fn read_source_contextual_mode<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.source_contextual_mode(&id))
    }
}
