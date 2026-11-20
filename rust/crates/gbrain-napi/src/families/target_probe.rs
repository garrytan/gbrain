//! The copies of one slug under a read policy: explain_target's probe rows and the relational chain's anchors
//! (rust/docs/store/page_ops.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `Store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `probeTargetRows(slug, { sourceId?, sourceIds?, excludePrivate?, minTrust?, suppressFlagged? },
    /// chunkManifest)`: `[{ source_id, chunks, embedded, current, chunker_version }]` by source id in byte order.
    #[napi]
    pub fn probe_target_rows<'env>(
        &self,
        env: &'env Env,
        slug: String,
        scope: Value,
        chunk_manifest: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.probe_target_rows(
                &slug,
                &required(scope, "probeTargetRows scope")?,
                chunk_manifest,
            )
        })
    }

    /// `listChainAnchors(slug, scope)`: `[{ page_id, source_id }]` by source id in byte order.
    #[napi]
    pub fn list_chain_anchors<'env>(
        &self,
        env: &'env Env,
        slug: String,
        scope: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_chain_anchors(&slug, &required(scope, "listChainAnchors scope")?)
        })
    }
}
