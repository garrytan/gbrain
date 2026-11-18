//! Page-write reads that belong to no other family: a source's state, and the live pages that can
//! be endpoints of a page's links (rust/docs/store/write_misc.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

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

    /// `listLinkEndpointPages(sourceId, slugs, crossSourceSlugs)`: `{ slug, source_id, type, knowledge_revision }[]`.
    #[napi]
    pub fn list_link_endpoint_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Value,
        cross_source_slugs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let slugs: Vec<String> = required(slugs, "listLinkEndpointPages slugs")?;
            let cross: Vec<String> =
                required(cross_source_slugs, "listLinkEndpointPages crossSourceSlugs")?;
            s.list_link_endpoint_pages(&source_id, &slugs, &cross)
        })
    }
}
