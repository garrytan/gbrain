//! Group 5 facts member `probePurgeDerivations`, one batch of the fact purge receipt's derivation
//! probe: one `#[napi] impl Brain` block over `gbrain_store::facts::derivation_probe`
//! (src/core/engine-sql/facts-purge.ts).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::derivation_probe::DerivationProbeQuery;

#[napi]
impl Brain {
    /// `probePurgeDerivations(sourceId, needles, pageIds, patterns, cursor, rows)`: resolves
    /// `{ scanned, normalized, swept, kept, last_page, last_pipeline, last_occurrence }`.
    #[napi]
    pub fn probe_purge_derivations<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DerivationProbeQuery = required(args, "probePurgeDerivations args")?;
            s.probe_purge_derivations(&a)
        })
    }
}
