//! The reads `gbrain export` makes (gbrain-store `cli_reads::export`): the page-key batches, the
//! withdrawal ledger, the page rows, the fence normalization and the segmented-body reads.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use gbrain_store::cli_reads::export::ExportPageKeyQuery;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listExportPageKeys(q)`: the next 256 live pages after `q.afterId`, in id order, with each
    /// one's segmented flag, raw-row count and payload bytes.
    #[napi]
    pub fn list_export_page_keys<'env>(
        &self,
        env: &'env Env,
        q: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_export_page_keys(&required::<ExportPageKeyQuery>(q, "listExportPageKeys q")?)
        })
    }
}
