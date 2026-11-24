//! The page embedding reads around a page's lease (`gbrain_store::page_body::page_spend`).
//!
//! The name and argument list are the ones the segment-embed lane typed (origin/rust-engine/segment-embed); that lane's
//! file of this name also serves the lease, the per-page spend ledgers and the hold reads, which this branch does not move.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listVectorlessChunkIndexes(pageId)`: the chunk indexes of the page's live rows with no vector.
    #[napi]
    pub fn list_vectorless_chunk_indexes<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_vectorless_chunk_indexes(page_id))
    }
}
