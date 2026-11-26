//! The provenance-drift reads served from the store (`gbrain-store` `cli_reads::doctor_drift`). The TypeScript members
//! are in `src/core/rust-engine/store-members/doctor-acc.ts` (rust/docs/store/cli-reads-doctor-acc.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listDriftLiveRows({ sourceId, after, slug })`: resolves the live page rows, with null write attribution.
    #[napi]
    pub fn list_drift_live_rows<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_drift_live_rows(&required(input, "listDriftLiveRows input")?)
        })
    }

    /// `listDriftVersionRows({ pageIds })`: resolves the version rows, with null write attribution.
    #[napi]
    pub fn list_drift_version_rows<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_drift_version_rows(&required(input, "listDriftVersionRows input")?)
        })
    }
}
