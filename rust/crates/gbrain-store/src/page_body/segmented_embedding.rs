//! The reads and the install a segmented embed makes (`src/core/page-body/segmented-embedding.ts`)
//! and the vectors a replace reuses from the rows it retires (`readRetiredChunkVectors`,
//! `src/core/import-chunk-reuse.ts`), each the store's answer to one statement of
//! `src/core/engine-sql/segmented-writes.ts`: the page an embed reads and the unsealed probe, the
//! dry-run counts, the keyset listing of rows without a vector, the recorded inputs, the vector
//! install, the live segments and one segment's rows. The install is one `Store::write`.
//!
//! Visibility is Postgres's `chunkGenerationFilter`: an inline chunk only while the page is not
//! segmented; a segment chunk at or below the page's body generation whose occurrence is in that
//! generation's published manifest. `currentTextProjectionFilter` is the page's seal: its
//! `text_projection_revision` equals its `knowledge_revision`. The store keeps one vector column,
//! `embedding`; the TypeScript members refuse any other.

use super::{in_generation, manifest_rows, page_u64, read_body_state};
use crate::chunks::{ChunkRecord, EmbedState, embedding_dimensions, read_chunks};
use crate::kv::KvRead;
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::{Result, Store, StoreError, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

/// `countSegmentedEmbedRows(pageId, column)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SegmentedEmbedCounts {
    pub total: i64,
    pub stale: i64,
}

/// The options of `listSegmentedStaleRows(pageId, column, opts)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SegmentedStaleRowsOpts {
    /// Only rows below this chunk index; none: from the newest.
    pub before_chunk_index: Option<i64>,
    pub limit: i64,
    /// Only rows of these occurrences; none: every occurrence.
    pub occurrence_ids: Option<Vec<i64>>,
    /// Rows that hold a vector too.
    pub include_embedded: bool,
}

/// One row of `listSegmentedStaleRows`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentedStaleRow {
    pub chunk_index: u32,
    pub chunk_text: String,
    pub chunk_source: String,
}

/// One row of `readSegmentChunkInputHashes(pageId, chunkIndexes)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentChunkInputHash {
    pub chunk_index: u32,
    pub embedding_input_hash: Option<String>,
}

/// One vector of `installSegmentedVectors(pageId, column, model, updates)`.
#[derive(Debug, Clone, Deserialize)]
pub struct SegmentedVectorInput {
    pub chunk_index: i64,
    pub chunk_text: String,
    pub vector: Vec<f64>,
    pub hash: String,
    #[serde(default)]
    pub expected: Option<String>,
}

/// One row of `listLiveEmbedSegments(pageId)`; `sha256` is lowercase hex.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveEmbedSegment {
    pub occurrence_id: i64,
    pub sha256: String,
    pub entry_state: Value,
}

/// One row of `listSegmentChunkRows(pageId, occurrenceId)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentChunkRow {
    pub chunk_index: u32,
    pub chunk_text: String,
    pub chunk_source: String,
    pub embedding_input_hash: Option<String>,
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

fn sealed(page: &PageRecord) -> bool {
    page.text_projection_revision.as_deref() == Some(page.knowledge_revision.as_str())
}

fn page_by_id(read: &dyn KvRead, id: i64) -> Result<Option<PageRecord>> {
    Ok(page_u64(id)
        .map(|id| read_page_by_id(read, id))
        .transpose()?
        .flatten())
}

/// The page's source exists and is not archived (`JOIN sources s ... AND NOT s.archived`).
fn in_live_source(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    Ok(crate::sources::read_source(read, &page.source_id)?.is_some_and(|s| !s.archived))
}

/// The page is segmented, not deleted and in a live source.
fn live_segmented(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    Ok(page.deleted_at_us.is_none()
        && read_body_state(read, page.id)?.is_some_and(|s| s.body_storage == "segmented")
        && in_live_source(read, page)?)
}

/// The page's chunks `chunkGenerationFilter` keeps, in stored (chunk_index) order.
pub(super) fn visible_chunks(read: &dyn KvRead, page_id: u64) -> Result<Vec<ChunkRecord>> {
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

/// The visible chunks of a sealed page (`currentTextProjectionFilter` and `chunkGenerationFilter`);
/// none for a missing or unsealed page.
fn sealed_visible_chunks(read: &dyn KvRead, page_id: i64) -> Result<Vec<ChunkRecord>> {
    match page_by_id(read, page_id)? {
        Some(page) if sealed(&page) => visible_chunks(read, page.id),
        _ => Ok(Vec::new()),
    }
}

fn occurrence_of(chunk: &ChunkRecord) -> Option<i64> {
    chunk
        .segment
        .and_then(|place| i64::try_from(place.occurrence_id).ok())
}

impl Store {
    /// `hasLiveSegmentedPage(sourceId, slug)`: whether the page at the source and slug is
    /// segmented, not deleted and in a live source, sealed or not.
    pub fn has_live_segmented_page(&self, source_id: &str, slug: &str) -> Result<bool> {
        let read = self.read()?;
        match read_page(&*read, source_id, slug)? {
            Some(page) => live_segmented(&*read, &page),
            None => Ok(false),
        }
    }

    /// `countSegmentedEmbedRows(pageId, column)`: the sealed page's visible rows and those
    /// without a vector.
    pub fn count_segmented_embed_rows(&self, page_id: i64) -> Result<SegmentedEmbedCounts> {
        let read = self.read()?;
        let chunks = sealed_visible_chunks(&*read, page_id)?;
        let stale = chunks.iter().filter(|c| !c.embed.has_vector()).count();
        Ok(SegmentedEmbedCounts {
            total: i64::try_from(chunks.len()).unwrap_or(i64::MAX),
            stale: i64::try_from(stale).unwrap_or(i64::MAX),
        })
    }

    /// `listSegmentedStaleRows(pageId, column, opts)`: the sealed page's visible rows without a
    /// vector (any row with `includeEmbedded`) below `beforeChunkIndex`, of `occurrenceIds` when
    /// given, newest first, at most `limit`.
    pub fn list_segmented_stale_rows(
        &self,
        page_id: i64,
        opts: &SegmentedStaleRowsOpts,
    ) -> Result<Vec<SegmentedStaleRow>> {
        let read = self.read()?;
        let wanted: Option<HashSet<i64>> = opts
            .occurrence_ids
            .as_ref()
            .map(|ids| ids.iter().copied().collect());
        let limit = usize::try_from(opts.limit.max(0)).unwrap_or(usize::MAX);
        Ok(sealed_visible_chunks(&*read, page_id)?
            .into_iter()
            .rev()
            .filter(|c| opts.include_embedded || !c.embed.has_vector())
            .filter(|c| {
                opts.before_chunk_index
                    .is_none_or(|b| i64::from(c.chunk_index) < b)
            })
            .filter(|c| {
                wanted
                    .as_ref()
                    .is_none_or(|w| occurrence_of(c).is_some_and(|o| w.contains(&o)))
            })
            .take(limit)
            .map(|c| SegmentedStaleRow {
                chunk_index: c.chunk_index,
                chunk_text: c.chunk_text,
                chunk_source: c.chunk_source,
            })
            .collect())
    }

    /// `readSegmentChunkInputHashes(pageId, chunkIndexes)`: the recorded embedding input of the
    /// page's visible rows at those indexes (sealed or not).
    pub fn read_segment_chunk_input_hashes(
        &self,
        page_id: i64,
        chunk_indexes: &[i64],
    ) -> Result<Vec<SegmentChunkInputHash>> {
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        if read_page_by_id(&*read, page)?.is_none() {
            return Ok(Vec::new());
        }
        let wanted: HashSet<i64> = chunk_indexes.iter().copied().collect();
        Ok(visible_chunks(&*read, page)?
            .into_iter()
            .filter(|c| wanted.contains(&i64::from(c.chunk_index)))
            .map(|c| SegmentChunkInputHash {
                chunk_index: c.chunk_index,
                embedding_input_hash: c.embed.input_hash,
            })
            .collect())
    }

    /// `installSegmentedVectors(pageId, column, model, updates)`: puts each vector, with its
    /// recorded input, on the page's visible row with the same chunk_index and text whose recorded
    /// input is still `expected`, embedded now, labelled `model` (the row's own label when none).
    /// A row that matches no update is left as it is. Returns how many rows took a vector.
    pub fn install_segmented_vectors(
        &self,
        page_id: i64,
        model: Option<&str>,
        updates: &[SegmentedVectorInput],
    ) -> Result<i64> {
        let Some(page) = page_u64(page_id) else {
            return Ok(0);
        };
        if updates.is_empty() {
            return Ok(0);
        }
        let now_us = self.env.now_micros();
        self.write(|tx| {
            if read_page_by_id(&*tx, page)?.is_none() {
                return Ok(0);
            }
            let dims = embedding_dimensions(&*tx)?;
            let mut chunks: std::collections::HashMap<u32, ChunkRecord> = visible_chunks(&*tx, page)?
                .into_iter()
                .map(|c| (c.chunk_index, c))
                .collect();
            let mut installed = 0i64;
            for update in updates {
                let Some(chunk) = u32::try_from(update.chunk_index)
                    .ok()
                    .and_then(|index| chunks.get_mut(&index))
                else {
                    continue;
                };
                if chunk.chunk_text != update.chunk_text || chunk.embed.input_hash != update.expected {
                    continue;
                }
                if update.vector.len() != dims {
                    return Err(StoreError::invalid(format!(
                        "expected {dims} dimensions, not {}",
                        update.vector.len()
                    )));
                }
                let vector: Vec<f32> = update
                    .vector
                    .iter()
                    .map(|n| *n as f32)
                    .filter(|n| n.is_finite())
                    .collect();
                if vector.len() != dims {
                    return Err(StoreError::invalid("a chunk embedding must hold finite numbers"));
                }
                let label = model
                    .filter(|m| !m.is_empty())
                    .map(str::to_string)
                    .or_else(|| chunk.meta.get("model").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_default();
                if label.is_empty() {
                    return Err(StoreError::invalid(
                        "Embedding model provenance is unknown. Supply an explicit chunk model or run gbrain migrate embeddings --status before an explicit migration.",
                    ));
                }
                chunk.embed = EmbedState {
                    dims: u32::try_from(dims).map_err(|_| StoreError::invalid("vector too long"))?,
                    embedded_at_us: Some(now_us),
                    text_hash: Some(crate::embeddings::text_hash(&chunk.chunk_text)),
                    input_hash: Some(update.hash.clone()),
                    pending_since_us: None,
                };
                chunk.meta.insert("model".into(), Value::String(label.clone()));
                // The text is unchanged, so the postings and stats stay as they are.
                put_json(tx, &keys::chunk(page, chunk.chunk_index), &*chunk)?;
                crate::embeddings::put_chunk_vector(tx, page, chunk.chunk_index, &label, now_us, &vector)?;
                installed += 1;
            }
            Ok(installed)
        })
    }

    /// `listLiveEmbedSegments(pageId)`: the page's published manifest rows of its body
    /// generation, newest (highest seq) first.
    pub fn list_live_embed_segments(&self, page_id: i64) -> Result<Vec<LiveEmbedSegment>> {
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        if read_page_by_id(&*read, page)?.is_none() {
            return Ok(Vec::new());
        }
        let generation = read_body_state(&*read, page)?.map_or(0, |s| s.body_generation);
        let mut rows: Vec<_> = manifest_rows(&*read, page)?
            .into_iter()
            .map(|(_, r)| r)
            .filter(|r| in_generation(r, generation))
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.seq));
        Ok(rows
            .into_iter()
            .map(|r| LiveEmbedSegment {
                occurrence_id: r.occurrence_id,
                sha256: r.sha256,
                entry_state: r.entry_state,
            })
            .collect())
    }

    /// `listSegmentChunkRows(pageId, occurrenceId)`: the sealed page's visible rows of one
    /// occurrence, in chunk_index order, with their recorded inputs.
    pub fn list_segment_chunk_rows(
        &self,
        page_id: i64,
        occurrence_id: i64,
    ) -> Result<Vec<SegmentChunkRow>> {
        let read = self.read()?;
        Ok(sealed_visible_chunks(&*read, page_id)?
            .into_iter()
            .filter(|c| occurrence_of(c) == Some(occurrence_id))
            .map(|c| SegmentChunkRow {
                chunk_index: c.chunk_index,
                chunk_text: c.chunk_text,
                chunk_source: c.chunk_source,
                embedding_input_hash: c.embed.input_hash,
            })
            .collect())
    }

    /// `readRetiredChunkVectors(pageId, occurrences, column)`: the page's visible rows of those
    /// occurrences that hold a vector, in chunk_index order, with the vector, its label and
    /// recorded input, and the page fields vector reuse checks.
    pub fn read_retired_chunk_vectors(
        &self,
        page_id: i64,
        occurrences: &[i64],
    ) -> Result<Vec<RetiredChunkVector>> {
        if occurrences.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let Some(page) = page_by_id(&*read, page_id)? else {
            return Ok(Vec::new());
        };
        let wanted: HashSet<i64> = occurrences.iter().copied().collect();
        let mode = crate::aliases::contextual_retrieval_mode(&*read, page.id)?;
        let corpus = crate::aliases::corpus_generation(&*read, page.id)?;
        let mut rows = Vec::new();
        for chunk in visible_chunks(&*read, page.id)? {
            if !occurrence_of(&chunk).is_some_and(|o| wanted.contains(&o))
                || !chunk.embed.has_vector()
            {
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
}

#[cfg(test)]
mod tests {
    use super::super::segment_chunk_tests::{chunk, published};
    use super::*;
    use serde_json::json;

    /// `published` with one chunk per occurrence ("one" at index 0, "two" at index 1), sealed.
    fn sealed_page(store: &Store) -> i64 {
        store.set_config("embedding_dimensions", "2").unwrap();
        let id = published(store);
        store
            .stage_segment_chunks(id, 1, &[chunk(1, 0, "one"), chunk(2, 0, "two")])
            .unwrap();
        store.seal_segmented_page(id, "", None).unwrap();
        id
    }

    fn update(index: i64, text: &str, hash: &str, expected: Option<&str>) -> SegmentedVectorInput {
        SegmentedVectorInput {
            chunk_index: index,
            chunk_text: text.into(),
            vector: vec![0.5, 1.0],
            hash: hash.into(),
            expected: expected.map(str::to_string),
        }
    }

    fn all(limit: i64) -> SegmentedStaleRowsOpts {
        serde_json::from_value(json!({ "beforeChunkIndex": null, "limit": limit })).unwrap()
    }

    #[test]
    fn the_live_segmented_probe_reads_only_a_live_segmented_page() {
        let store = crate::test_support::store();
        let id = sealed_page(&store);
        let _ = id;
        assert!(store.has_live_segmented_page("default", "notes/a").unwrap());
        assert!(
            !store
                .has_live_segmented_page("default", "notes/none")
                .unwrap()
        );
    }

    #[test]
    fn stale_rows_list_newest_first_and_an_install_needs_the_expected_input() {
        let store = crate::test_support::store();
        let id = sealed_page(&store);
        let counts = store.count_segmented_embed_rows(id).unwrap();
        assert_eq!((counts.total, counts.stale), (2, 2));
        let rows = store.list_segmented_stale_rows(id, &all(10)).unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| (r.chunk_index, r.chunk_text.as_str()))
                .collect::<Vec<_>>(),
            vec![(1, "two"), (0, "one")]
        );
        let before: SegmentedStaleRowsOpts =
            serde_json::from_value(json!({ "beforeChunkIndex": 1, "limit": 10 })).unwrap();
        assert_eq!(
            store.list_segmented_stale_rows(id, &before).unwrap().len(),
            1
        );
        let only: SegmentedStaleRowsOpts = serde_json::from_value(
            json!({ "beforeChunkIndex": null, "limit": 10, "occurrenceIds": [1] }),
        )
        .unwrap();
        assert_eq!(
            store.list_segmented_stale_rows(id, &only).unwrap()[0].chunk_text,
            "one"
        );

        // A row whose text or recorded input moved takes nothing.
        assert_eq!(
            store
                .install_segmented_vectors(
                    id,
                    Some("m2"),
                    &[
                        update(0, "one!", "h", None),
                        update(1, "two", "h", Some("x"))
                    ]
                )
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .install_segmented_vectors(id, Some("m2"), &[update(0, "one", "h0", None)])
                .unwrap(),
            1
        );
        // The same install again: the recorded input is now h0, not None.
        assert_eq!(
            store
                .install_segmented_vectors(id, Some("m2"), &[update(0, "one", "h0", None)])
                .unwrap(),
            0
        );
        let counts = store.count_segmented_embed_rows(id).unwrap();
        assert_eq!((counts.total, counts.stale), (2, 1));
        assert_eq!(
            store.list_segmented_stale_rows(id, &all(10)).unwrap().len(),
            1
        );
        let mut with = all(10);
        with.include_embedded = true;
        assert_eq!(store.list_segmented_stale_rows(id, &with).unwrap().len(), 2);
        let hashes = store.read_segment_chunk_input_hashes(id, &[0, 1]).unwrap();
        assert_eq!(
            hashes
                .iter()
                .map(|h| (h.chunk_index, h.embedding_input_hash.clone()))
                .collect::<Vec<_>>(),
            vec![(0, Some("h0".to_string())), (1, None)]
        );
        // A wrong width refuses.
        let mut wide = update(1, "two", "h1", None);
        wide.vector = vec![1.0; 3];
        assert!(store.install_segmented_vectors(id, None, &[wide]).is_err());
    }

    #[test]
    fn segments_list_newest_first_and_retired_vectors_read_back() {
        let store = crate::test_support::store();
        let id = sealed_page(&store);
        let segments = store.list_live_embed_segments(id).unwrap();
        assert_eq!(
            segments.iter().map(|s| s.occurrence_id).collect::<Vec<_>>(),
            vec![2, 1]
        );
        let rows = store.list_segment_chunk_rows(id, 1).unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| r.chunk_text.as_str())
                .collect::<Vec<_>>(),
            vec!["one"]
        );
        assert!(
            store
                .read_retired_chunk_vectors(id, &[1, 2])
                .unwrap()
                .is_empty()
        );
        store
            .install_segmented_vectors(id, None, &[update(0, "one", "h0", None)])
            .unwrap();
        let retired = store.read_retired_chunk_vectors(id, &[1, 2]).unwrap();
        assert_eq!(retired.len(), 1);
        assert_eq!(
            (
                retired[0].chunk_text.as_str(),
                retired[0].embedding.clone(),
                retired[0].model.as_deref()
            ),
            ("one", vec![0.5f32, 1.0], Some("m"))
        );
        assert_eq!(retired[0].embedding_input_hash.as_deref(), Some("h0"));
        assert!(
            store
                .read_retired_chunk_vectors(id, &[])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_staged_chunk_that_carries_a_vector_is_stored_embedded() {
        let store = crate::test_support::store();
        store.set_config("embedding_dimensions", "2").unwrap();
        let id = published(&store);
        let mut with_vector = chunk(1, 0, "one");
        with_vector
            .chunk
            .rest
            .insert("embedding".into(), json!([0.25, 0.75]));
        with_vector
            .chunk
            .rest
            .insert("embedding_input_hash".into(), json!("in"));
        store
            .stage_segment_chunks(id, 1, &[with_vector, chunk(2, 0, "two")])
            .unwrap();
        store.seal_segmented_page(id, "", None).unwrap();
        let counts = store.count_segmented_embed_rows(id).unwrap();
        assert_eq!((counts.total, counts.stale), (2, 1));
        let retired = store.read_retired_chunk_vectors(id, &[1]).unwrap();
        assert_eq!(retired[0].embedding, vec![0.25f32, 0.75]);
        assert_eq!(retired[0].embedding_input_hash.as_deref(), Some("in"));

        let mut wide = chunk(2, 1, "wide");
        wide.chunk
            .rest
            .insert("embedding".into(), json!([1.0, 2.0, 3.0]));
        assert!(store.stage_segment_chunks(id, 1, &[wide]).is_err());
    }

    #[test]
    fn rows_without_a_stored_vector_are_not_retired_vectors() {
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .stage_segment_chunks(id, 1, &[chunk(1, 0, "one"), chunk(2, 0, "two")])
            .unwrap();
        store.seal_segmented_page(id, "", None).unwrap();
        assert!(
            store
                .read_retired_chunk_vectors(id, &[1, 2])
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .read_retired_chunk_vectors(id, &[])
                .unwrap()
                .is_empty()
        );
    }
}
