//! Source-resolution reads for the CLI: the typed members that replace raw SQL in
//! `src/core/source-resolver.ts` (store side: `gbrain_store::cli_reads::sources`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listLocalPathSources()`: `{ id, local_path, archived }[]`, archived sources included.
    #[napi]
    pub fn list_local_path_sources<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_local_path_sources())
    }

    /// `listSourceRoutingRows()`: `{ id, local_path, archived, config, default_has_pages }[]` by id.
    #[napi]
    pub fn list_source_routing_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_source_routing_rows())
    }

    /// `countDefaultSourceSplit()`: `{ defaultPages, nonDefaultPages, nonDefaultSources }`.
    #[napi]
    pub fn count_default_source_split<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_default_source_split())
    }
}
