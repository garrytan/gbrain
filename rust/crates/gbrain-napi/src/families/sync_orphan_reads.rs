//! The request reads of the managed-sync orphan classification
//! (src/core/engine-sql/managed-sync-orphans.ts): one `#[napi] impl Brain` block over
//! `gbrain_store::persistence` (rust/docs/store/repair-bookkeeping.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listSourceRequestRows(sourceId)`: the source's requests with the columns the
    /// classification tests, in sequence order.
    #[napi]
    pub fn list_source_request_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_source_request_rows(&source_id))
    }
}
