//! Sources: list, read, upsert, patch config, archive.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `listAllSources({ includeArchived?, localPathOnly? }?)`: `SourceRow[]`, `default` first.
    #[napi]
    pub fn list_all_sources<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_all_sources(&arg(options, "listAllSources options")?)
        })
    }

    /// `getSourceById(id)`: the `SourceRow` or `null`.
    #[napi]
    pub fn get_source_by_id<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_source_by_id(&id))
    }

    /// `upsertSource({ id, name?, local_path?, last_sync_at?, config? })`: the `SourceRow`.
    #[napi]
    pub fn upsert_source<'env>(&self, env: &'env Env, input: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.upsert_source(&required(input, "upsertSource input")?)
        })
    }

    /// `updateSourceConfig(id, patch)`: merges `patch` into the config; whether the source exists.
    #[napi]
    pub fn update_source_config<'env>(
        &self,
        env: &'env Env,
        id: String,
        patch: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.update_source_config(&id, &required(patch, "updateSourceConfig patch")?)
        })
    }

    /// `setSourceArchived(id, archived)`: whether the source exists.
    #[napi]
    pub fn set_source_archived<'env>(
        &self,
        env: &'env Env,
        id: String,
        archived: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_source_archived(&id, archived))
    }

    /// `getSource(id)`: the `SourceDetailRow` or `null`.
    #[napi]
    pub fn get_source<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_source(&id))
    }

    /// `listSourceLocalPaths()`: every non-empty source local path.
    #[napi]
    pub fn list_source_local_paths<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.list_source_local_paths())
    }

    /// `getSourceStrictness(id)`: whether the source is git-canonical.
    #[napi]
    pub fn get_source_strictness<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_source_strictness(&id))
    }
}
