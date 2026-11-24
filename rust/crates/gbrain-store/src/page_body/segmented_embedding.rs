//! The vectors a replace of a page body reuses from the rows it retires (`readRetiredChunkVectors`,
//! `src/core/import-chunk-reuse.ts`), the store's answer to one statement of
//! `src/core/engine-sql/segmented-writes.ts`.
//!
//! Owner: the segmented-write lane (`rust-engine/fingerprint-v3`, commit 0aceee20e0), which holds the whole module
//! (the segmented embed's reads and vector install). The function and its row type here are copied from it unchanged.
//!
//! Visibility is Postgres's `chunkGenerationFilter`: an inline chunk only while the page is not
//! segmented; a segment chunk at or below the page's body generation whose occurrence is in that
//! generation's published manifest. The store keeps one vector column, `embedding`; the TypeScript member refuses any
//! other.

use super::{in_generation, manifest_rows, page_u64, read_body_state};
use crate::chunks::{ChunkRecord, read_chunks};
use crate::kv::KvRead;
use crate::pages::{PageRecord, read_page_by_id};
use crate::{Result, Store};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

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

fn page_by_id(read: &dyn KvRead, id: i64) -> Result<Option<PageRecord>> {
    Ok(page_u64(id)
        .map(|id| read_page_by_id(read, id))
        .transpose()?
        .flatten())
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

fn occurrence_of(chunk: &ChunkRecord) -> Option<i64> {
    chunk
        .segment
        .and_then(|place| i64::try_from(place.occurrence_id).ok())
}

impl Store {
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
    use serde_json::json;

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
        let retired = store.read_retired_chunk_vectors(id, &[1]).unwrap();
        assert_eq!(retired[0].embedding, vec![0.25f32, 0.75]);
        assert_eq!(retired[0].embedding_input_hash.as_deref(), Some("in"));

        let mut wide = chunk(2, 1, "wide");
        wide.chunk
            .rest
            .insert("embedding".into(), json!([1.0, 2.0, 3.0]));
        assert!(store.stage_segment_chunks(id, 1, &[wide]).is_err());
    }
}
