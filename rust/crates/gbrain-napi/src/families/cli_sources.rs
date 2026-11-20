//! Source-resolution reads for the CLI: the typed members that replace raw SQL in
//! `src/core/source-resolver.ts` (store side: `gbrain_store::cli_reads::sources`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Map, Value};

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listLocalPathSources()`: `{ id, local_path, archived }[]`, archived sources included.
    #[napi]
    pub fn list_local_path_sources<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_local_path_sources())
    }

    /// `readPlainSyncSource(id)`: `{ local_path, last_commit, config }` or `null` when the source
    /// is missing or archived.
    #[napi]
    pub fn read_plain_sync_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_plain_sync_source(&source_id))
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

    /// `countSourcePages(sourceId, includeDeleted)`: the source's page count.
    #[napi]
    pub fn count_source_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        include_deleted: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_source_pages(&source_id, include_deleted)
        })
    }

    /// `insertSource(id, name, localPath, config)`: the new `SourceRow`; `constraint_violation`
    /// when the id or the name is taken.
    #[napi]
    pub fn insert_source<'env>(
        &self,
        env: &'env Env,
        id: String,
        name: String,
        local_path: Option<String>,
        config: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let config: Map<String, Value> = required(config, "insertSource config")?;
            s.insert_source(&id, &name, local_path.as_deref(), &config)
        })
    }
}
