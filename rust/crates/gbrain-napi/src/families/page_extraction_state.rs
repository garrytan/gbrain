//! The extraction watermark and partial-input receipt: the watermark read, the commit of a
//! successful extraction, the receipt read, the row delete and the receipt upsert
//! (`gbrain_store::page_extraction_state`, rust/docs/store/page_extraction_state.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readPageExtractionWatermark(sourceId, slug, pipeline)`: the live page's id and stored
    /// watermark, or null when no live page has that slug.
    #[napi]
    pub fn read_page_extraction_watermark<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        pipeline: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_extraction_watermark(&source_id, &slug, &pipeline)
        })
    }

    /// `commitPageExtraction(commit)`: stores a successful extraction.
    #[napi]
    pub fn commit_page_extraction<'env>(
        &self,
        env: &'env Env,
        commit: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.commit_page_extraction(&required(commit, "commitPageExtraction commit")?)
        })
    }

    /// `readPageExtractionReceipt(pageId, pipeline)`: the row's receipt, or null.
    #[napi]
    pub fn read_page_extraction_receipt<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        pipeline: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "readPageExtractionReceipt pageId")?;
            s.read_page_extraction_receipt(page_id, &pipeline)
        })
    }

    /// `clearPageExtractionState(pageId, pipeline)`: deletes the row.
    #[napi]
    pub fn clear_page_extraction_state<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        pipeline: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "clearPageExtractionState pageId")?;
            s.clear_page_extraction_state(page_id, &pipeline)
        })
    }

    /// `writePageExtractionReceipt(pageId, pipeline, pipelineVersion, receipt)`: the receipt upsert.
    #[napi]
    pub fn write_page_extraction_receipt<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        pipeline: String,
        pipeline_version: Value,
        receipt: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "writePageExtractionReceipt pageId")?;
            let version: i64 = required(
                pipeline_version,
                "writePageExtractionReceipt pipelineVersion",
            )?;
            s.write_page_extraction_receipt(page_id, &pipeline, version, &receipt)
        })
    }
}
