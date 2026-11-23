//! The page-list, slug-source, access and connector-status reads that ran as raw SQL in their
//! callers (rust/docs/store/list-reads.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `readRetainedSources(sourceIds)`: the listed source ids whose worktree holds a recovery
    /// record, by id.
    #[napi]
    pub fn read_retained_sources<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_retained_sources(&source_ids))
    }

    /// `listLiveSlugSourceIds(slug)`: the sources holding a live page at `slug`, by id.
    #[napi]
    pub fn list_live_slug_source_ids<'env>(
        &self,
        env: &'env Env,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_live_slug_source_ids(&slug))
    }

    /// `resolveChainAnchorRows(slug, scope)`: `[{ id, source_id }]` of the live copies the read scope
    /// admits, by source.
    #[napi]
    pub fn resolve_chain_anchor_rows<'env>(
        &self,
        env: &'env Env,
        slug: String,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.resolve_chain_anchor_rows(&slug, &arg(scope, "scope")?)
        })
    }

    /// `probeTargetRows(slug, scope, chunkManifest)`: `[{ source_id, chunks, embedded, current,
    /// chunker_version }]` by source.
    #[napi]
    pub fn probe_target_rows<'env>(
        &self,
        env: &'env Env,
        slug: String,
        scope: Option<Value>,
        chunk_manifest: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.probe_target_rows(&slug, &arg(scope, "scope")?, chunk_manifest)
        })
    }

    /// `readCompanyBrainEvidenceRows(sourceId)`: `{ owner, decision, page }`, each a row or `null`.
    #[napi]
    pub fn read_company_brain_evidence_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_company_brain_evidence_rows(&source_id))
    }

    /// `listCardRows(query)`: `{ total, cards }` of the storage shelf.
    #[napi]
    pub fn list_card_rows<'env>(&self, env: &'env Env, query: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_card_rows(&required(query, "query")?))
    }

    /// `readShelfPageRows(sourceId)`: `[{ slug, title, type, frontmatter }]` by slug.
    #[napi]
    pub fn read_shelf_page_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_shelf_page_rows(&source_id))
    }
}
