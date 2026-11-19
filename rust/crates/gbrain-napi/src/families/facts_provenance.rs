//! `listFactProvenance`: the stored provenance of the named facts of one source.
//!
//! One `#[napi] impl Brain` block; the method runs one `gbrain_store::facts::provenance` call on the
//! pool through `Brain::run` and resolves plain JSON. The TypeScript member
//! (src/core/rust-engine/store-members/facts-provenance.ts) refuses what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::provenance::FactProvenanceQuery;

#[napi]
impl Brain {
    /// `listFactProvenance(args)`: resolves the `{ id, source }` rows of the named facts, by id.
    #[napi]
    pub fn list_fact_provenance<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactProvenanceQuery = required(args, "listFactProvenance args")?;
            s.list_fact_provenance(&a)
        })
    }
}
