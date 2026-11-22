//! The legacy-page count of a fact purge's verification (`countLegacyDerivedPages`), read from the store's
//! `derivation_inputs` rows (`generations/derivation_inputs.rs`). The deriver's write is `recordDerivationInputs`
//! (facts_purge.rs).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `countLegacyDerivedPages(sourceId)`: resolves the count of live atom and dream pages no edge explains.
    #[napi]
    pub fn count_legacy_derived_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_legacy_derived_pages(&source_id))
    }
}
