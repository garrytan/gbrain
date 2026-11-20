//! `readSegmentRegions(hits)`: where each search hit on a segmented page starts in that page's
//! body, so search dedup can keep far-apart passages of one large page (`segmentRegions`,
//! `src/core/search/dedup.ts`).
//!
//! The SQL engines answer the same rows with one statement under the keyword statement bound:
//! `content_chunks` joined to a `body_storage = 'segmented'` page and its live
//! `page_body_manifest` row, filtered by `chunkVisibleFilter` (the served text projection and the
//! chunk's body generation at or below the page's). Here the page's segment view is the live
//! manifest: it keeps the `byte_start` of each live occurrence at the page's body generation.
//!
//! Each hit names the page the search returned the chunk on, so the read opens only those pages
//! instead of every chunk in the brain. A chunk id that is not on its named page, an inline chunk,
//! a chunk of a page that is not segmented or not served, and a chunk of an occurrence with no
//! live offset have no row; the caller then keeps that hit under the inline rule.

use super::sealed;
use crate::Store;
use crate::chunks::{read_chunks, read_segment_view, segmented};
use crate::error::Result;
use crate::pages::{PageRecord, read_page_by_id};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// `ACTIVATION_SERVED_REVISION` (`src/core/search/safe-chunks.ts`).
const ACTIVATION_SERVED_REVISION: &str = "00000000-0000-0000-0000-000000000153";

/// One search hit: the page the search returned it on and its chunk.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SegmentHit {
    pub page_id: u64,
    pub chunk_id: u64,
}

/// `servedTextProjectionFilter`: the current projection, or the v153 activation marker.
fn served(page: &PageRecord) -> bool {
    sealed(page) || page.text_projection_revision.as_deref() == Some(ACTIVATION_SERVED_REVISION)
}

impl Store {
    /// `readSegmentRegions(hits)`: `[{ chunk_id, byte_start }]` in chunk id order, one row per hit
    /// chunk of a served segmented page whose occurrence has a live offset.
    pub fn read_segment_regions(&self, hits: &[SegmentHit]) -> Result<Vec<Value>> {
        let mut by_page: BTreeMap<u64, BTreeSet<u64>> = BTreeMap::new();
        for hit in hits {
            by_page.entry(hit.page_id).or_default().insert(hit.chunk_id);
        }
        if by_page.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut rows: BTreeMap<u64, u64> = BTreeMap::new();
        for (page_id, wanted) in by_page {
            let Some(page) = read_page_by_id(&*read, page_id)? else {
                continue;
            };
            if !segmented(&page) || !served(&page) {
                continue;
            }
            let view = read_segment_view(&*read, page_id)?;
            for chunk in read_chunks(&*read, page_id)? {
                if !wanted.contains(&chunk.id) || !chunk.visible_at(view.generation) {
                    continue;
                }
                let Some(place) = chunk.segment else {
                    continue;
                };
                if let Some(&byte_start) = view.offsets.get(&place.occurrence_id) {
                    rows.insert(chunk.id, byte_start);
                }
            }
        }
        Ok(rows
            .into_iter()
            .map(|(chunk_id, byte_start)| json!({ "chunk_id": chunk_id, "byte_start": byte_start }))
            .collect())
    }
}
