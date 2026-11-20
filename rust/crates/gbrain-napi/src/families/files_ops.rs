//! The readable file list (`listReadableFileRows`) and the verify walk (`listFilesByStoragePath`): one `#[napi] impl Brain` block over `gbrain_store::raw_files`
//! (src/core/engine-sql/collate-page-reads.ts).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and resolves plain JSON
//! (rust/docs/store/raw_files.md). A read that hides a private page carries the caller's page policy, or null for none.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};
use gbrain_store::facts::PrivacyPolicy;

#[napi]
impl Brain {
    /// `listReadableFiles(slug?, policy?)`: resolves the rows.
    #[napi]
    pub fn list_readable_files<'env>(
        &self,
        env: &'env Env,
        slug: Option<String>,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy: Option<PrivacyPolicy> = arg(policy, "listReadableFiles policy")?;
            s.list_readable_files(slug.as_deref(), policy.as_ref())
        })
    }

    /// `listFilesByPath(limit)`: the `FileRow`s by `storage_path` bytes, at most `limit`.
    #[napi]
    pub fn list_files_by_path<'env>(
        &self,
        env: &'env Env,
        limit: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_files_by_storage_path(&limit))
    }
}
