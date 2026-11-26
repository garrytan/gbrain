//! The files commands and file operations (`gbrain files`, file_list, file_upload, file_url, file_register, file_verify):
//! one `#[napi] impl Brain` block over `gbrain_store::raw_files` (src/core/engine-sql/files-ops.ts).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and resolves plain JSON
//! (rust/docs/store/raw_files.md). A file spec carries its metadata as the `JSON.stringify` text; a read that hides a
//! private page carries the caller's page policy, or null for none.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::raw_files::FileSpec;

#[napi]
impl Brain {
    /// `listFileRows(kind, slug?)`: `kind` is `slug`, `all` or `verify`; resolves `FileRow[]`.
    #[napi]
    pub fn list_file_rows<'env>(
        &self,
        env: &'env Env,
        kind: String,
        slug: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_file_rows(&kind, slug.as_deref()))
    }

    /// `hasFileWithHash(contentHash, storagePath)`: resolves a boolean.
    #[napi]
    pub fn has_file_with_hash<'env>(
        &self,
        env: &'env Env,
        content_hash: String,
        storage_path: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_file_with_hash(&content_hash, &storage_path)
        })
    }

    /// `upsertFileRow(lane, spec)`: `lane` is `command` or `operation`; resolves null.
    #[napi]
    pub fn upsert_file_row<'env>(
        &self,
        env: &'env Env,
        lane: String,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: FileSpec = required(spec, "upsertFileRow spec")?;
            s.upsert_file_row(&lane, &spec)
        })
    }

    /// `registerFileRow(spec)`: resolves whether a row was written.
    #[napi]
    pub fn register_file_row<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: FileSpec = required(spec, "registerFileRow spec")?;
            s.register_file_row(&spec)
        })
    }

    /// `readFileOwner(storagePath)`: `{ source_id, page_id, content_hash }` or null.
    #[napi]
    pub fn read_file_owner<'env>(
        &self,
        env: &'env Env,
        storage_path: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_file_owner(&storage_path))
    }

    /// `claimFilePage(storagePath, sourceId, pageId)`: resolves null.
    #[napi]
    pub fn claim_file_page<'env>(
        &self,
        env: &'env Env,
        storage_path: String,
        source_id: String,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.claim_file_page(&storage_path, &source_id, &page_id)
        })
    }

    /// `countFilesRegisteredElsewhere(identity)`: resolves a count.
    #[napi]
    pub fn count_files_registered_elsewhere<'env>(
        &self,
        env: &'env Env,
        identity: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: FileSpec = required(identity, "countFilesRegisteredElsewhere identity")?;
            s.count_files_registered_elsewhere(&spec)
        })
    }

    /// `readPageIdInSource(slug, sourceId)`: the page id or null.
    #[napi]
    pub fn read_page_id_in_source<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_id_in_source(&slug, &source_id))
    }

    /// `listReadableFiles(columns, slug?, policy?)`: `columns` is `rows` or `paths`; resolves the rows.
    #[napi]
    pub fn list_readable_files<'env>(
        &self,
        env: &'env Env,
        columns: String,
        slug: Option<String>,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy: Option<PrivacyPolicy> = arg(policy, "listReadableFiles policy")?;
            s.list_readable_files(&columns, slug.as_deref(), policy.as_ref())
        })
    }

    /// `readReadableFile(columns, storagePath, policy?)`: `columns` is `url` or `verify`; the row or null.
    #[napi]
    pub fn read_readable_file<'env>(
        &self,
        env: &'env Env,
        columns: String,
        storage_path: String,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy: Option<PrivacyPolicy> = arg(policy, "readReadableFile policy")?;
            s.read_readable_file(&columns, &storage_path, policy.as_ref())
        })
    }

    /// `readReadablePageId(slug, sourceId, policy?)`: the page id or null.
    #[napi]
    pub fn read_readable_page_id<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy: Option<PrivacyPolicy> = arg(policy, "readReadablePageId policy")?;
            s.read_readable_page_id(&slug, &source_id, policy.as_ref())
        })
    }

    /// `countUnreadableFilesAt(storagePath, policy?)`: resolves 0 or 1.
    #[napi]
    pub fn count_unreadable_files_at<'env>(
        &self,
        env: &'env Env,
        storage_path: String,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy: Option<PrivacyPolicy> = arg(policy, "countUnreadableFilesAt policy")?;
            s.count_unreadable_files_at(&storage_path, policy.as_ref())
        })
    }
}
