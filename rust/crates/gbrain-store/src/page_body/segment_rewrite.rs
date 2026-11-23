//! The statements a segmented page's write ran through `executeRaw`, each the store's answer to one
//! statement of src/core/engine-sql/segmented-rewrite.ts: the page a live fence rewrite reads,
//! deleted or not, and the `deleted_at` it puts back on a page that was soft-deleted
//! (`rewriteLiveSegmentedFences`, page-body/segment-rewrite.ts), and the live segmented page,
//! chunk probes and stale-row retirement of a projection (page-body/projection.ts, ingest.ts).
//! What each answers: rust/docs/store/page_body.md.
//!
//! Stale rows. Postgres's `STALE_CHUNKS_SQL` names the chunk rows generation `g` (live occurrences
//! `live`) does not hold. A segment chunk of a live occurrence is stale when its generation is
//! below the newest generation at or below `g` among that occurrence's chunks; one of any other
//! occurrence is stale when its generation is at or below `g` (a later one is a staged write's). An
//! inline chunk (no segment) is always stale, as its NULL `body_generation` is in SQL.
//!
//! Keys: none of its own.

use super::{in_generation, manifest_rows, page_u64, read_body_state};
use crate::Store;
use crate::chunks::{ChunkRecord, delete_chunks_matching, read_chunks};
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::pages::read_page;
use crate::pages::{read_page_by_id, write_page};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

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

/// `readSegmentedProjectionPage(sourceId, slug)`: the page row a projection builds from.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentedProjectionPage {
    pub id: i64,
    pub body_generation: i64,
    pub body_bytes: Option<i64>,
    pub knowledge_revision: String,
    pub text_projection_revision: Option<String>,
    pub title: String,
    pub frontmatter: Value,
    pub body_flags: Option<Value>,
    pub timeline_lead: Option<String>,
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

/// One row of `readRetiredChunkVectors(pageId, occurrences, column)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RetiredChunkVector {
    pub chunk_text: String,
    pub chunk_source: String,
    pub embedding: Vec<f32>,
    pub token_count: Option<Value>,
    pub model: Option<String>,
    pub embedding_input_hash: Option<String>,
    pub contextual_retrieval_mode: Option<String>,
    pub slug: String,
    pub source_id: String,
    pub corpus_generation: Option<String>,
}

/// The page's chunks `chunkGenerationFilter` keeps, in stored (chunk_index) order: an inline chunk
/// only while the page is not segmented; a segment chunk at or below the page's body generation
/// whose occurrence is in that generation's published manifest.
fn generation_visible_chunks(read: &dyn KvRead, page_id: u64) -> Result<Vec<ChunkRecord>> {
    let state = read_body_state(read, page_id)?;
    let segmented = state
        .as_ref()
        .is_some_and(|s| s.body_storage == "segmented");
    let generation = state.as_ref().map_or(0, |s| s.body_generation);
    let live: HashSet<i64> = manifest_rows(read, page_id)?
        .into_iter()
        .map(|(_, r)| r)
        .filter(|r| in_generation(r, generation))
        .map(|r| r.occurrence_id)
        .collect();
    let mut chunks: Vec<ChunkRecord> = read_chunks(read, page_id)?
        .into_iter()
        .filter(|c| match c.segment {
            None => !segmented,
            Some(place) => {
                i64::try_from(place.body_generation).is_ok_and(|g| g <= generation)
                    && i64::try_from(place.occurrence_id).is_ok_and(|o| live.contains(&o))
            }
        })
        .collect();
    chunks.sort_by_key(|c| c.chunk_index);
    Ok(chunks)
}

/// The ids of the page's chunk rows generation `generation` (live occurrences `live`) does not hold,
/// in Postgres's order: by occurrence, then the inline rows.
fn stale_chunk_ids(chunks: &[ChunkRecord], generation: i64, live: &[i64]) -> Vec<u64> {
    let live: HashSet<i64> = live.iter().copied().collect();
    let mut newest: BTreeMap<u64, u64> = BTreeMap::new();
    for place in chunks.iter().filter_map(|c| c.segment) {
        if i64::try_from(place.body_generation).is_ok_and(|g| g <= generation) {
            let slot = newest
                .entry(place.occurrence_id)
                .or_insert(place.body_generation);
            *slot = (*slot).max(place.body_generation);
        }
    }
    let mut by_occurrence: BTreeMap<u64, Vec<u64>> = BTreeMap::new();
    let mut inline = Vec::new();
    for chunk in chunks {
        let Some(place) = chunk.segment else {
            inline.push(chunk.id);
            continue;
        };
        let generation_of = i64::try_from(place.body_generation).unwrap_or(i64::MAX);
        let stale = if i64::try_from(place.occurrence_id).is_ok_and(|o| live.contains(&o)) {
            newest
                .get(&place.occurrence_id)
                .is_some_and(|bound| place.body_generation < *bound)
        } else {
            generation_of <= generation
        };
        if stale {
            by_occurrence
                .entry(place.occurrence_id)
                .or_default()
                .push(chunk.id);
        }
    }
    by_occurrence
        .into_values()
        .flatten()
        .chain(inline)
        .collect()
}

fn live_page(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
) -> Result<Option<crate::pages::PageRecord>> {
    Ok(read_page(read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none()))
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

    /// `readRetiredChunkVectors(pageId, occurrences)`: the page's visible chunks of those
    /// occurrences that hold a vector, in chunk_index order, with the vector, its label and recorded
    /// input, and the page fields vector reuse checks.
    pub fn read_retired_chunk_vectors(
        &self,
        page_id: i64,
        occurrences: &[i64],
    ) -> Result<Vec<RetiredChunkVector>> {
        let Some(id) = page_u64(page_id).filter(|_| !occurrences.is_empty()) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let Some(page) = read_page_by_id(&*read, id)? else {
            return Ok(Vec::new());
        };
        let wanted: HashSet<i64> = occurrences.iter().copied().collect();
        let mode = crate::aliases::contextual_retrieval_mode(&*read, page.id)?;
        let corpus = crate::aliases::corpus_generation(&*read, page.id)?;
        let mut rows = Vec::new();
        for chunk in generation_visible_chunks(&*read, page.id)? {
            let in_wanted = chunk
                .segment
                .and_then(|p| i64::try_from(p.occurrence_id).ok())
                .is_some_and(|o| wanted.contains(&o));
            if !in_wanted || !chunk.embed.has_vector() {
                continue;
            }
            let Some(stored) =
                crate::embeddings::read_chunk_vector(&*read, page.id, chunk.chunk_index)?
            else {
                continue;
            };
            rows.push(RetiredChunkVector {
                embedding: stored.vector,
                token_count: chunk.meta.get("token_count").cloned(),
                model: chunk
                    .meta
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                embedding_input_hash: chunk.embed.input_hash,
                contextual_retrieval_mode: mode.clone(),
                slug: page.slug.clone(),
                source_id: page.source_id.clone(),
                corpus_generation: corpus.clone(),
                chunk_text: chunk.chunk_text,
                chunk_source: chunk.chunk_source,
            });
        }
        Ok(rows)
    }

    /// `listChunkedOccurrences(pageId, occurrenceIds, generation)`: the members of `occurrences`, in
    /// their order, that have a segment chunk of the page at or below `generation`.
    pub fn list_chunked_occurrences(
        &self,
        page_id: i64,
        occurrences: &[i64],
        generation: i64,
    ) -> Result<Vec<i64>> {
        if occurrences.is_empty() {
            return Ok(Vec::new());
        }
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let chunked: HashSet<u64> = read_chunks(&*read, page)?
            .iter()
            .filter_map(|c| c.segment)
            .filter(|p| i64::try_from(p.body_generation).is_ok_and(|g| g <= generation))
            .map(|p| p.occurrence_id)
            .collect();
        Ok(occurrences
            .iter()
            .copied()
            .filter(|o| u64::try_from(*o).is_ok_and(|o| chunked.contains(&o)))
            .collect())
    }

    /// `hasStaleSegmentChunks(pageId, generation, live)`: the page stores a chunk row generation
    /// `generation` does not hold (module docs).
    pub fn has_stale_segment_chunks(
        &self,
        page_id: i64,
        generation: i64,
        live: &[i64],
    ) -> Result<bool> {
        let Some(page) = page_u64(page_id) else {
            return Ok(false);
        };
        let read = self.read()?;
        Ok(!stale_chunk_ids(&read_chunks(&*read, page)?, generation, live).is_empty())
    }

    /// `retireStaleSegmentChunks(pageId, generation, live, maxRows)`: deletes up to `max_rows` of
    /// the stale chunk rows (module docs) and returns how many went.
    pub fn retire_stale_segment_chunks(
        &self,
        page_id: i64,
        generation: i64,
        live: &[i64],
        max_rows: i64,
    ) -> Result<usize> {
        let Some(page) = page_u64(page_id) else {
            return Ok(0);
        };
        let max = usize::try_from(max_rows).unwrap_or(0);
        self.write(|tx| {
            let ids: HashSet<u64> = stale_chunk_ids(&read_chunks(&*tx, page)?, generation, live)
                .into_iter()
                .take(max)
                .collect();
            if ids.is_empty() {
                return Ok(0);
            }
            Ok(delete_chunks_matching(tx, page, &|c| ids.contains(&c.id))?.len())
        })
    }

    /// `readSegmentedProjectionPage(sourceId, slug)`: the live segmented page, `None` otherwise.
    pub fn read_segmented_projection_page(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Option<SegmentedProjectionPage>> {
        let read = self.read()?;
        let Some(page) = live_page(&*read, source_id, slug)? else {
            return Ok(None);
        };
        let state = read_body_state(&*read, page.id)?;
        let Some(state) = state.as_ref().filter(|s| s.body_storage == "segmented") else {
            return Ok(None);
        };
        Ok(Some(SegmentedProjectionPage {
            id: i64::try_from(page.id)
                .map_err(|_| StoreError::invalid("a page id is out of range"))?,
            body_generation: state.body_generation,
            body_bytes: state.body_bytes,
            knowledge_revision: page.knowledge_revision,
            text_projection_revision: page.text_projection_revision,
            title: page.title,
            frontmatter: Value::Object(page.frontmatter),
            body_flags: state.body_flags.clone(),
            timeline_lead: state.timeline_lead.clone(),
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
