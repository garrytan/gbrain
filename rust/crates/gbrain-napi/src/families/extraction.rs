//! Extraction state of pages: the link-extraction watermark, the attendance marker and the sweep
//! of parser-reserved frontmatter keys.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `countStalePagesForExtraction({ sourceId?, versionTs?, attendance?, held?,
    /// wantedProducers? }?)`: resolves the number of stale pages.
    #[napi]
    pub fn count_stale_pages_for_extraction<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_stale_pages_for_extraction(&arg(
                options,
                "countStalePagesForExtraction options",
            )?)
        })
    }

    /// `readExtractionLagCounts({ sourceId?, versionTs, attendance, held?, guests?,
    /// wantedProducers? })`: resolves `{ total, stale, attendance_blocked, held }`.
    #[napi]
    pub fn read_extraction_lag_counts<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_extraction_lag_counts(&arg(options, "readExtractionLagCounts options")?)
        })
    }

    /// `listStalePagesForExtraction({ batchSize, afterPageId?, sourceId?, versionTs?, held?,
    /// wantedProducers? })`: `StalePageRow`s by id, `updated_at` as an ISO string.
    #[napi]
    pub fn list_stale_pages_for_extraction<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_stale_pages_for_extraction(&arg(options, "listStalePagesForExtraction options")?)
        })
    }

    /// `markPagesExtractedBatch(refs, defaultExtractedAt)`: resolves the number of pages stamped.
    #[napi]
    pub fn mark_pages_extracted_batch<'env>(
        &self,
        env: &'env Env,
        refs: Value,
        default_extracted_at: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let refs: Vec<gbrain_store::extraction::ExtractedRef> =
                required(refs, "markPagesExtractedBatch refs")?;
            s.mark_pages_extracted_batch(&refs, &default_extracted_at)
        })
    }

    /// `readPageComparisonColumns(refs)`: resolves `{ source_id, slug, links_extracted_at,
    /// links_attendance_blocked_revision, embedding_signature }` for each page the refs name.
    /// Read only; used by the shadow write comparison, not a BrainEngine member.
    #[napi]
    pub fn read_page_comparison_columns<'env>(
        &self,
        env: &'env Env,
        refs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let refs: Vec<gbrain_store::extraction::ComparisonRef> =
                required(refs, "readPageComparisonColumns refs")?;
            s.read_page_comparison_columns(&refs)
        })
    }

    /// `markPagesAttendanceBlocked(refs)`: resolves the number of pages marked.
    #[napi]
    pub fn mark_pages_attendance_blocked<'env>(
        &self,
        env: &'env Env,
        refs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let refs: Vec<gbrain_store::extraction::AttendanceRef> =
                required(refs, "markPagesAttendanceBlocked refs")?;
            s.mark_pages_attendance_blocked(&refs)
        })
    }

    /// `countStaleFrontmatterKeyPages({ sourceIds })`: `{ source_id, n }[]` by source id.
    #[napi]
    pub fn count_stale_frontmatter_key_pages<'env>(
        &self,
        env: &'env Env,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_stale_frontmatter_key_pages(&required(
                options,
                "countStaleFrontmatterKeyPages options",
            )?)
        })
    }

    /// `listStaleFrontmatterKeyPages({ sourceId, afterId, limit })`: `{ id, slug, keys }[]` by id.
    #[napi]
    pub fn list_stale_frontmatter_key_pages<'env>(
        &self,
        env: &'env Env,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_stale_frontmatter_key_pages(&required(
                options,
                "listStaleFrontmatterKeyPages options",
            )?)
        })
    }

    /// `stripStaleFrontmatterKeys({ sourceId, ids })`: resolves the number of pages changed.
    #[napi]
    pub fn strip_stale_frontmatter_keys<'env>(
        &self,
        env: &'env Env,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.strip_stale_frontmatter_keys(&required(options, "stripStaleFrontmatterKeys options")?)
        })
    }
}
