//! The reads of `get_write_attribution` (rust/docs/store/write_attribution.md): one `#[napi] impl
//! Brain` block over `gbrain_store::write_attribution`.
//!
//! The TypeScript members (src/core/rust-engine/store-members/write-attribution.ts) refuse the
//! OAuth client and legacy token name reads, which name tables the store does not keep.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::write_attribution::RowAttributionTarget;

#[napi]
impl Brain {
    /// `readWriteRequestAttributions(ids)`: `[{ id, operation, completed_at, agent_label }]`.
    #[napi]
    pub fn read_write_request_attributions<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(ids, "readWriteRequestAttributions ids")?;
            s.read_write_request_attributions(&ids)
        })
    }

    /// `readLocalWriterLanes(ids)`: `[{ id, lane }]`, revoked writers included.
    #[napi]
    pub fn read_local_writer_lanes<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(ids, "readLocalWriterLanes ids")?;
            s.read_local_writer_lanes(&ids)
        })
    }

    /// `readPageRevisionAttribution(pageId)`: `{ revision, req, kind, pid, trust_tier,
    /// write_origin }` or `null`.
    #[napi]
    pub fn read_page_revision_attribution<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "readPageRevisionAttribution pageId")?;
            s.read_page_revision_attribution(page_id)
        })
    }

    /// `readVersionAttributions(versions)`: versions as `[pageId, id]` pairs; `[{ id, w_req,
    /// w_kind, w_id, a_req, a_kind, a_id, trust_tier }]`.
    #[napi]
    pub fn read_version_attributions<'env>(
        &self,
        env: &'env Env,
        versions: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let versions: Vec<(u64, u64)> = required(versions, "readVersionAttributions versions")?;
            s.read_version_attributions(&versions)
        })
    }

    /// `readOldestVersionAttribution(pageId)`: `{ req, kind, pid }` or `null`.
    #[napi]
    pub fn read_oldest_version_attribution<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "readOldestVersionAttribution pageId")?;
            s.read_oldest_version_attribution(page_id)
        })
    }

    /// `readRowAttribution(target)`: the fact, take or timeline row with its receipts, or `null`.
    #[napi]
    pub fn read_row_attribution<'env>(
        &self,
        env: &'env Env,
        target: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let target: RowAttributionTarget = required(target, "readRowAttribution target")?;
            s.read_row_attribution(&target)
        })
    }
}
