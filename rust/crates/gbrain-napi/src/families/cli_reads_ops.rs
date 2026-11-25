//! The CLI search and graph reads (gbrain-store `cli_reads::reads`): the exact-phrase scan, the
//! next live page, exact identity candidates, the entity ranking and the extraction review queue,
//! plus the remote-caller reads around them (gbrain-store `cli_reads::remote_reads`): one source's
//! rank coverage and the stored chunks search_exact reads again.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `scanExactBatch`: the next batch of pages in scope after `after`, each with its exact-phrase
    /// matches or the reason its text could not be read; `null` for a phrase with no words.
    #[napi]
    pub fn scan_exact_batch<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.scan_exact_batch(&required(input, "scanExactBatch input")?)
        })
    }

    /// `nextLivePageAfter(afterPageId)`: the first live page with a larger id, or `null`.
    #[napi]
    pub fn next_live_page_after<'env>(
        &self,
        env: &'env Env,
        after_page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.next_live_page_after(required(after_page_id, "nextLivePageAfter afterPageId")?)
        })
    }

    /// `listExactIdentityCandidates(opts)`: live pages whose title, basename or email equals a probe.
    #[napi]
    pub fn list_exact_identity_candidates<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_exact_identity_candidates(&required(input, "listExactIdentityCandidates opts")?)
        })
    }

    /// `rankEntities(opts)`: pages ranked by distinct link degree, retired pages folded in.
    #[napi]
    pub fn rank_entities<'env>(&self, env: &'env Env, input: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.rank_entities(&required(input, "rankEntities opts")?)
        })
    }

    /// `listExtractionPendingPages(opts)`: auto-extracted pages still unverified, newest first.
    #[napi]
    pub fn list_extraction_pending_pages<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_extraction_pending_pages(&required(input, "listExtractionPendingPages opts")?)
        })
    }

    /// `readRankCoverage(opts)`: whether a page of the source the caller may read still owes link
    /// extraction or a mention pass.
    #[napi]
    pub fn read_rank_coverage<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_rank_coverage(&required(input, "readRankCoverage opts")?)
        })
    }

    /// `readExactSnippetChunks(keys, opts)`: per snippet key, its visible stored chunk when it holds
    /// the snippet.
    #[napi]
    pub fn read_exact_snippet_chunks<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_exact_snippet_chunks(&required(input, "readExactSnippetChunks input")?)
        })
    }

    /// `listExactRescanChunks(pageIds, opts)`: the visible safe-fenced chunks of the pages.
    #[napi]
    pub fn list_exact_rescan_chunks<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_exact_rescan_chunks(&required(input, "listExactRescanChunks input")?)
        })
    }
}
