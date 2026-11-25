//! The statements a segmented page's write ran through `executeRaw` that this module answers, each the store's answer
//! to one statement of src/core/engine-sql/segmented-rewrite.ts: the page a live fence rewrite reads, deleted or not,
//! and the `deleted_at` it puts back on a page that was soft-deleted (`rewriteLiveSegmentedFences`,
//! page-body/segment-rewrite.ts), and the live page a segmented write diffs against (page-body/ingest.ts). The chunk
//! probes, the stale-row retirement, the retired-vector read and the projection page read are `segmented_writes.rs` and
//! `segmented_embedding.rs`. What each answers: rust/docs/store/page_body.md.
//!
//! Keys: none of its own.

use super::{page_u64, read_body_state};
use crate::Store;
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::pages::{read_page_by_id, write_page};
use serde::Serialize;
use serde_json::Value;

/// `readSegmentedRewritePage(pageId)`: the page a live fence rewrite reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentedRewritePage {
    pub id: i64,
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub page_kind: String,
    pub frontmatter: Value,
    pub body_generation: i64,
    pub body_bytes: Option<i64>,
    pub body_flags: Option<Value>,
    pub body_storage: String,
    pub deleted_at: Option<String>,
    pub contextual_retrieval_mode: Option<String>,
    pub corpus_generation: Option<String>,
    pub tags: Vec<String>,
}

/// `readSegmentedLivePage(pageId)`: the live page a segmented write diffs against.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentedLivePageRow {
    pub id: i64,
    pub body_generation: i64,
    pub body_storage: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub body_flags: Option<Value>,
}

impl Store {
    /// `readSegmentedLivePage(pageId)`: the page's storage class, generation, title, type and body
    /// flags, deleted or not; an inline page reads storage `inline` at generation 0. None for no page.
    pub fn read_segmented_live_page(&self, page_id: i64) -> Result<Option<SegmentedLivePageRow>> {
        let read = self.read()?;
        let Some(id) = page_u64(page_id) else {
            return Ok(None);
        };
        let Some(page) = read_page_by_id(&*read, id)? else {
            return Ok(None);
        };
        let state = read_body_state(&*read, page.id)?;
        let state = state.as_ref();
        Ok(Some(SegmentedLivePageRow {
            id: page_id,
            body_generation: state.map_or(0, |s| s.body_generation),
            body_storage: state.map_or_else(|| "inline".into(), |s| s.body_storage.clone()),
            title: page.title,
            page_type: page.page_type,
            body_flags: state.and_then(|s| s.body_flags.clone()),
        }))
    }

    /// `readSegmentedRewritePage(pageId)`: the page with its body columns, contextual stamp and tags
    /// in byte order, deleted or not; an inline page reads storage `inline` at generation 0. None for
    /// a missing page.
    pub fn read_segmented_rewrite_page(
        &self,
        page_id: i64,
    ) -> Result<Option<SegmentedRewritePage>> {
        let read = self.read()?;
        let Some(id) = page_u64(page_id) else {
            return Ok(None);
        };
        let Some(page) = read_page_by_id(&*read, id)? else {
            return Ok(None);
        };
        let state = read_body_state(&*read, page.id)?;
        let state = state.as_ref();
        let mut tags = page.tags.clone();
        tags.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        Ok(Some(SegmentedRewritePage {
            id: page_id,
            contextual_retrieval_mode: crate::aliases::contextual_retrieval_mode(&*read, page.id)?,
            corpus_generation: crate::aliases::corpus_generation(&*read, page.id)?,
            deleted_at: page.deleted_at_us.map(iso),
            slug: page.slug,
            source_id: page.source_id,
            title: page.title,
            page_type: page.page_type,
            page_kind: page.page_kind,
            frontmatter: Value::Object(page.frontmatter),
            body_generation: state.map_or(0, |s| s.body_generation),
            body_bytes: state.and_then(|s| s.body_bytes),
            body_flags: state.and_then(|s| s.body_flags.clone()),
            body_storage: state.map_or_else(|| "inline".into(), |s| s.body_storage.clone()),
            tags,
        }))
    }

    /// `restorePageDeletedAt(pageId, deletedAt)`: sets the page's `deleted_at` back (`deletedAt` is
    /// ISO text). A change moves the knowledge revision and drops the text projection revision, as
    /// PGLite's `pages_knowledge_revision` trigger does. A missing page is a no-op.
    ///
    /// PGLite's `pages_derivation_scope_delete` trigger also notes the page for each derivation purge
    /// request of its source when `deleted_at` goes from null to a time. The store keeps no purge
    /// requests, so that set is always empty here, as it is on PGLite with no request open.
    pub fn restore_page_deleted_at(&self, page_id: i64, deleted_at: &str) -> Result<()> {
        let micros = parse_iso(deleted_at).ok_or_else(|| {
            StoreError::invalid(format!(
                "restorePageDeletedAt deletedAt: invalid input syntax for type timestamp with time zone: {deleted_at:?}"
            ))
        })?;
        let Some(id) = page_u64(page_id) else {
            return Ok(());
        };
        self.write(|tx| {
            let Some(mut page) = read_page_by_id(&*tx, id)? else {
                return Ok(());
            };
            if page.deleted_at_us == Some(micros) {
                return Ok(());
            }
            page.deleted_at_us = Some(micros);
            page.knowledge_revision = self.env.new_uuid();
            page.text_projection_revision = None;
            write_page(tx, &page)
        })
    }
}
