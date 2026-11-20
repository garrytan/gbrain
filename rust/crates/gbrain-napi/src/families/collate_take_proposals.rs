//! The failure tombstones of `take_proposals` (rust/docs/store/collate-take-proposals.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::take_proposals::FailureTombstoneInput;

#[napi]
impl Brain {
    /// `recordFailureTombstone(input)`: resolves true when it inserted, false when the claim is
    /// already recorded for the page, content hash and prompt version.
    #[napi]
    pub fn record_failure_tombstone<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: FailureTombstoneInput = required(input, "recordFailureTombstone input")?;
            s.record_failure_tombstone(&input)
        })
    }

    /// `listFailureTombstones(sourceId, claimPrefix)`: `[{ page_slug, claim_text, prompt_version,
    /// proposed_at }]` by page slug bytes.
    #[napi]
    pub fn list_failure_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        claim_prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_failure_tombstones(&source_id, &claim_prefix)
        })
    }
}
