//! The derivation edges (`derivation_inputs`, rust/docs/store/derivation-inputs.md): the deriver's write and the
//! legacy-page count of a fact purge's verification.

use gbrain_store::derivation_inputs::DerivationEdges;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `recordDerivationEdges({ derived, sourceId, edges })`: records the edges not recorded yet.
    #[napi]
    pub fn record_derivation_edges<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: DerivationEdges = required(spec, "recordDerivationEdges spec")?;
            s.record_derivation_edges(&spec)
        })
    }

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
