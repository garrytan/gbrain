//! Raw source data and files attached to pages.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/docs/store/raw_files.md). JSONB values (`data`, `metadata`) arrive as
//! their `JSON.stringify` text; timestamps leave as ISO strings and the shell makes them `Date`s.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `putRawData(slug, source, dataJson, { sourceId? }?)`: resolves null.
    #[napi]
    pub fn put_raw_data<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source: Option<String>,
        data_json: Option<String>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::raw_files::RawDataScope = arg(options, "putRawData options")?;
            s.put_raw_data(
                &slug,
                source.as_deref(),
                data_json.as_deref(),
                scope.source_id.as_deref(),
            )
        })
    }

    /// `getRawData(slug, source?, { sourceId?, sourceIds?, includeDeleted?, excludePrivate? }?)`: `RawData[]`.
    #[napi]
    pub fn get_raw_data<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source: Option<String>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope = arg(options, "getRawData options")?;
            s.get_raw_data(&slug, source.as_deref(), &scope)
        })
    }

    /// `upsertFile(spec)`: resolves `{ id, created }`. `spec.metadata` is JSON text.
    #[napi]
    pub fn upsert_file<'env>(&self, env: &'env Env, spec: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: gbrain_store::raw_files::FileSpec = required(spec, "upsertFile spec")?;
            s.upsert_file(&spec)
        })
    }

    /// `getFile(sourceId, storagePath)`: the `FileRow`, or null.
    #[napi]
    pub fn get_file<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        storage_path: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_file(&source_id, &storage_path))
    }

    /// `listFilesForPage(pageId)`: `FileRow[]`, oldest first.
    #[napi]
    pub fn list_files_for_page<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_files_for_page(&page_id))
    }

    /// `listFiles({ pageSlug?, limit })`: `FileRow[]` of one page slug by filename, or of every
    /// file by page slug then filename; at most `limit`.
    #[napi]
    pub fn list_files<'env>(
        &self,
        env: &'env Env,
        page_slug: Option<String>,
        limit: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_files(page_slug.as_deref(), &limit))
    }
}
