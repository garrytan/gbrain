//! The page reads and the checkpoint record `recordIdentityDowngrades` made through raw SQL
//! (rust/docs/store/collate-identity-downgrades.md), plus the checkpoint value members the
//! phantom-redirect rotation shares.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readSoftDeletedPageAtOrigin(sourceId, path, slug)`: `{ id, slug, deleted_at }` or `null`.
    #[napi]
    pub fn read_soft_deleted_page_at_origin<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        path: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_soft_deleted_page_at_origin(&source_id, &path, &slug)
        })
    }

    /// `listLivePagesAtOrigin(sourceId, sourcePath)`: `[{ id, slug }]` by slug bytes.
    #[napi]
    pub fn list_live_pages_at_origin<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        source_path: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_live_pages_at_origin(&source_id, &source_path)
        })
    }

    /// `countPageCarryRows(sourceId, slug, pageId)`: `{ facts, links, aliases }`.
    #[napi]
    pub fn count_page_carry_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        page_id: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_page_carry_rows(&source_id, &slug, u64::from(page_id))
        })
    }

    /// `writeOpCheckpointValues(op, fingerprint, values)`.
    #[napi]
    pub fn write_op_checkpoint_values<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        values: Vec<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_op_checkpoint_values(&op, &fingerprint, &values)
        })
    }

    /// `readOpCheckpointValues(op, fingerprint)`: the stored array or `null`.
    #[napi]
    pub fn read_op_checkpoint_values<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_op_checkpoint_values(&op, &fingerprint))
    }
}
