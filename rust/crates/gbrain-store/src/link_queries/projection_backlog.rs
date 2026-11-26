//! The projection queue by class: `readProjectionBacklog` (src/core/engine-sql/doctor-search.ts), the one
//! aggregate behind doctor's text_projection_readiness, the drain preview, the upgrade notice and the
//! resident's projection status (`projectionBacklog`, src/core/page-state/projections.ts).
//!
//! It walks the queue's jobs (`page_projection_jobs`), joins each to its source by incarnation and to the live
//! page at the job's slug, and keeps the pages in the read scope. The scope is `pageReadFilter(..., live = false)`:
//! the source filter, the private-page policy and the trust floor, but not the live test, so a job of an archived
//! source or a quarantined page counts (the class says so: `archived`). Each page falls in one class
//! (`projectionClassSql`), the same order as `retrieval_coverage::class` with its image arm split in two: an
//! image at or after the safe-chunk fence whose one chunk is the importer's own, unchanged, is `sealable`; any
//! other live image is `reimport`.
//!
//! The store keeps no image vector, so `sealable_with_visual` is 0. The jobs the store queues all carry the reason
//! `canonical_change`, so `failed` (reason `rebuild_failed`) counts none until a drain writes that reason.

use super::retrieval_coverage::{CoverageScope, ProjectionClass, Sources, class, in_scope};
use crate::Store;
use crate::chunks::SAFE_FENCE_CHUNKER_VERSION;
use crate::chunks::read_chunks;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::{PageRecord, read_page};
use crate::persistence::queued_jobs;
use serde::Serialize;

/// `BOUNDED_PREFIX_BYTES` (src/core/page-window/document.ts): the importer's chunk is compared through the
/// first this many characters of the body, and a chunk this long or longer is left to the importer.
const BOUNDED_PREFIX_CHARS: usize = 65536;
/// The reason a failed rebuild leaves on its job.
const REBUILD_FAILED: &str = "rebuild_failed";

/// `ProjectionBacklog` as the SQL aggregate returns it: `oldest` is seconds, not yet floored.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectionBacklogRow {
    pub pending: u64,
    pub failed: u64,
    pub sealable: u64,
    pub sealable_with_visual: u64,
    pub reimport: u64,
    pub ocr_required: u64,
    pub protected: u64,
    pub archived: u64,
    pub oldest: Option<f64>,
    pub as_of: String,
}

/// `importerChunkSql`: the page has exactly one current chunk, at index 0, that the importer wrote and
/// that still holds the page's text (or its title when the text is empty).
fn importer_chunk(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    // An image page counted here is not segmented, so every chunk it has is current.
    let chunks: Vec<_> = read_chunks(read, page.id)?
        .into_iter()
        .filter(|c| c.segment.is_none())
        .collect();
    let [chunk] = chunks.as_slice() else {
        return Ok(false);
    };
    let prefix: String = page
        .compiled_truth
        .as_deref()
        .unwrap_or_default()
        .chars()
        .take(BOUNDED_PREFIX_CHARS)
        .collect();
    let expected = if prefix.is_empty() {
        page.title.as_str()
    } else {
        prefix.as_str()
    };
    Ok(chunk.chunk_index == 0
        && chunk.chunk_source == "image_asset"
        && chunk.modality == "image"
        && chunk.chunk_text.chars().count() < BOUNDED_PREFIX_CHARS
        && chunk.chunk_text == expected)
}

/// `CoverageScope` as `pageReadFilter` reads it: `sourceIds` counts only when it names a source.
fn backlog_scope(scope: &CoverageScope) -> CoverageScope {
    let mut scope = scope.clone();
    if scope.source_ids.as_ref().is_some_and(Vec::is_empty) {
        scope.source_ids = None;
    }
    scope
}

impl Store {
    /// `readProjectionBacklog(scope)`: the queue's jobs in `scope` by class, the age of the oldest job that
    /// needs work, and the store clock.
    pub fn read_projection_backlog(&self, scope: &CoverageScope) -> Result<ProjectionBacklogRow> {
        let read = self.read()?;
        let read = &*read;
        let scope = backlog_scope(scope);
        let mut sources = Sources::new(read);
        let now = self.env.now_micros();
        let mut row = ProjectionBacklogRow {
            pending: 0,
            failed: 0,
            sealable: 0,
            sealable_with_visual: 0,
            reimport: 0,
            ocr_required: 0,
            protected: 0,
            archived: 0,
            oldest: None,
            as_of: timestamptz_text(now),
        };
        let mut oldest_us: Option<i64> = None;
        for job in queued_jobs(read)? {
            let Some(page) = read_page(read, &job.source_id, &job.slug)? else {
                continue;
            };
            if page.deleted_at_us.is_some() || !in_scope(read, &mut sources, &page, &scope, false)?
            {
                continue;
            }
            let needs_work = match class(&page, job.archived) {
                ProjectionClass::Archived => {
                    row.archived += 1;
                    false
                }
                ProjectionClass::Text => {
                    row.pending += 1;
                    if job.reason == REBUILD_FAILED {
                        row.failed += 1;
                    }
                    true
                }
                ProjectionClass::Protected => {
                    row.protected += 1;
                    false
                }
                ProjectionClass::Image => {
                    if page.chunker_version.unwrap_or(0) >= SAFE_FENCE_CHUNKER_VERSION
                        && importer_chunk(read, &page)?
                    {
                        row.sealable += 1;
                    } else {
                        row.reimport += 1;
                        if page.chunker_version.unwrap_or(0) < 0 {
                            row.ocr_required += 1;
                        }
                    }
                    true
                }
            };
            if needs_work {
                oldest_us = Some(oldest_us.map_or(job.updated_at_us, |o| o.min(job.updated_at_us)));
            }
        }
        row.oldest = oldest_us.map(|us| (now - us) as f64 / 1_000_000.0);
        Ok(row)
    }
}
