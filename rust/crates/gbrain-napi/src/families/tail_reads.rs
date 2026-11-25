//! The last family-tail reads (`gbrain_store::tail_reads`): the scoped contradiction reader's
//! live chunk and take re-reads, and the page read of the version history.
//!
//! One `#[napi] impl Brain` block; each method runs one store call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/tail-reads.ts) build the wire policy and check the
//! integer binds.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::tail_reads::{LiveChunksInput, LiveTakesInput};

#[napi]
impl Brain {
    /// `listLiveChunksByIds({ ids, scope, requireSafeChunks })`:
    /// `[{ id, page_id, chunk_text, slug, source_id }]`.
    #[napi]
    pub fn list_live_chunks_by_ids<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: LiveChunksInput = required(input, "listLiveChunksByIds input")?;
            s.list_live_chunks_by_ids(&input)
        })
    }

    /// `listLiveTakesByIds({ ids, scope, holders, floor })`:
    /// `[{ id, page_id, row_num, claim, holder, slug, source_id }]`.
    #[napi]
    pub fn list_live_takes_by_ids<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: LiveTakesInput = required(input, "listLiveTakesByIds input")?;
            s.list_live_takes_by_ids(&input)
        })
    }

    /// `readPagesForVersionHistory(pageIds)`: `[{ id, slug, source_id, frontmatter }]`.
    #[napi]
    pub fn read_pages_for_version_history<'env>(
        &self,
        env: &'env Env,
        page_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(page_ids, "readPagesForVersionHistory pageIds")?;
            s.read_pages_for_version_history(&ids)
        })
    }
}
