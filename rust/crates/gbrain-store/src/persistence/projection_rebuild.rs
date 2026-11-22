//! The members a page's chunk reseal calls (`src/core/engine-sql/projection-rebuild.ts`): the
//! keep plan's read of the page's chunk vectors (`readChunkKeepState`), the clear of the vectors the
//! reseal does not keep (`clearUnkeptChunkVectors`) and the count of text chunks left without a
//! vector (`countPendingTextChunks`). The delete of the rows the plan does not keep is
//! `deleteChunksExcept` (import_members.rs family), the stamp is `setChunkerVersion`, the seal is
//! `writeTextProjectionSeal` and the queue row's delete is projection_queue.rs
//! `deleteProjectionJob`.
//!
//! The store keeps one vector column (`embedding`); the TypeScript members refuse any other column
//! before they call the store. A chunk's text hash is sha256, where PGLite keeps md5: only
//! equality is compared.

use crate::chunks::{ChunkRecord, read_chunks};
use crate::embeddings::{remove_chunk_vector, text_hash};
use crate::env::transaction_clock;
use crate::error::{Result, StoreError};
use crate::{Store, keys, put_json};
use serde_json::{Value, json};

/// `chunkModelMatchesSql('model', provenanceModel, vector_dims(col) = dims)`: the chunk's label is
/// the model (NULL matching NULL), or the model's bare tail with a vector of the column's width.
fn model_matches(chunk: &ChunkRecord, model: Option<&str>, dims: u32) -> bool {
    let label = chunk.meta.get("model").and_then(Value::as_str);
    if label == model {
        return true;
    }
    let (Some(label), Some(model)) = (label, model) else {
        return false;
    };
    let tail = model.split_once(':').map_or(model, |(_, tail)| tail);
    label == tail && chunk.embed.has_vector() && chunk.embed.dims == dims
}

/// `embedded_text_hash IS NOT DISTINCT FROM md5(chunk_text)` (the store keeps sha256).
fn text_current(chunk: &ChunkRecord) -> bool {
    chunk.embed.text_hash.as_deref() == Some(text_hash(&chunk.chunk_text).as_str())
}

fn id_of(value: f64, what: &str) -> Result<u64> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 {
        Ok(value as u64)
    } else {
        Err(StoreError::invalid(format!("{what} is not an id: {value}")))
    }
}

impl Store {
    /// `readChunkKeepState(pageId, provenanceModel, column)`: each chunk of the page with its
    /// embedding input hash and whether its vector is current (present, from the chunk's text as it
    /// is now, labelled with the model or its bare tail at the column's width `dims`).
    pub fn read_chunk_keep_state(
        &self,
        page_id: f64,
        model: Option<&str>,
        dims: u32,
    ) -> Result<Vec<Value>> {
        let page_id = id_of(page_id, "pageId")?;
        Ok(read_chunks(&*self.read()?, page_id)?
            .iter()
            .map(|c| {
                let movable = c.embed.has_vector() && text_current(c) && model_matches(c, model, dims);
                json!({ "id": c.id, "embedding_input_hash": c.embed.input_hash, "movable": movable })
            })
            .collect())
    }

    /// `clearUnkeptChunkVectors(pageId, provenanceModel, column, currentIds)`: clears the vector and
    /// the embedding record of each chunk of the page whose label does not match, whose recorded
    /// text hash is not its text's, or whose id is not in `current_ids`, and marks it pending (a
    /// chunk already pending keeps its time).
    pub fn clear_unkept_chunk_vectors(
        &self,
        page_id: f64,
        model: Option<&str>,
        dims: u32,
        current_ids: &[f64],
    ) -> Result<()> {
        let page_id = id_of(page_id, "pageId")?;
        let current: Vec<u64> = current_ids
            .iter()
            .map(|id| id_of(*id, "currentIds"))
            .collect::<Result<_>>()?;
        self.write(|tx| {
            let now = transaction_clock::transaction_now().ok_or_else(|| {
                StoreError::invalid("clearUnkeptChunkVectors ran outside a store write transaction")
            })?;
            for mut chunk in read_chunks(&*tx, page_id)? {
                let drifted = chunk.embed.text_hash.is_some() && !text_current(&chunk);
                if model_matches(&chunk, model, dims) && !drifted && current.contains(&chunk.id) {
                    continue;
                }
                chunk.embed.dims = 0;
                chunk.embed.embedded_at_us = None;
                chunk.embed.text_hash = None;
                chunk.embed.input_hash = None;
                chunk.embed.pending_since_us = chunk.embed.pending_since_us.or(Some(now));
                put_json(tx, &keys::chunk(chunk.page_id, chunk.chunk_index), &chunk)?;
                remove_chunk_vector(tx, chunk.page_id, chunk.chunk_index)?;
            }
            Ok(())
        })
    }

    /// `countPendingTextChunks(pageId, column)`: `{ chunks, chars }`, how many of the page's text
    /// chunks have no vector and their length in characters (Postgres `length`).
    pub fn count_pending_text_chunks(&self, page_id: f64) -> Result<Value> {
        let page_id = id_of(page_id, "pageId")?;
        let pending: Vec<ChunkRecord> = read_chunks(&*self.read()?, page_id)?
            .into_iter()
            .filter(|c| c.modality == "text" && !c.embed.has_vector())
            .collect();
        let chars: usize = pending.iter().map(|c| c.chunk_text.chars().count()).sum();
        Ok(json!({ "chunks": pending.len(), "chars": chars }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunks::{ChunkInput, UpsertChunksOptions};
    use crate::pages::{PageInput, PutPageOptions};

    fn put(store: &Store, slug: &str) -> f64 {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        let options = PutPageOptions {
            index: Some(false),
            ..PutPageOptions::default()
        };
        store.put_page(slug, &input, &options).unwrap()["id"]
            .as_f64()
            .unwrap()
    }

    fn chunk(index: u32, text: &str, vector: Option<&str>) -> ChunkInput {
        let mut input = ChunkInput {
            chunk_index: index,
            chunk_text: text.into(),
            ..ChunkInput::default()
        };
        if let Some(model) = vector {
            input
                .rest
                .insert("embedding".into(), json!(vec![0.5; 1536]));
            input.rest.insert("model".into(), json!(model));
        }
        input
    }

    fn stored(store: &Store, page_id: f64) -> Vec<ChunkRecord> {
        read_chunks(&*store.read().unwrap(), page_id as u64).unwrap()
    }

    #[test]
    fn the_keep_read_marks_a_vector_movable_only_when_it_is_from_its_text_under_the_model() {
        let store = crate::test_support::store();
        let page_id = put(&store, "a");
        store
            .upsert_chunks(
                "a",
                &[
                    chunk(0, "one", Some("openai:m")),
                    chunk(1, "two", None),
                    chunk(2, "three", Some("other")),
                    chunk(3, "four", Some("m")),
                ],
                &UpsertChunksOptions::default(),
            )
            .unwrap();
        let rows = store
            .read_chunk_keep_state(page_id, Some("openai:m"), 1536)
            .unwrap();
        let movable: Vec<bool> = rows
            .iter()
            .map(|r| r["movable"].as_bool().unwrap())
            .collect();
        // The full label and the bare tail at the column's width keep; another model and no vector do not.
        assert_eq!(movable, [true, false, false, true]);
        assert!(rows.iter().all(|r| r["embedding_input_hash"].is_null()));
        // Another width: the bare tail no longer matches.
        let narrow = store
            .read_chunk_keep_state(page_id, Some("openai:m"), 768)
            .unwrap();
        assert_eq!(narrow[3]["movable"], false);
        assert_eq!(narrow[0]["movable"], true);
        // No model: only a chunk with no label matches, and it has no vector.
        let none = store.read_chunk_keep_state(page_id, None, 1536).unwrap();
        assert!(none.iter().all(|r| r["movable"] == false));
        assert!(store.read_chunk_keep_state(1.5, None, 1536).is_err());
    }

    #[test]
    fn the_clear_drops_the_vectors_the_page_does_not_accept_and_marks_them_pending() {
        let store = crate::test_support::store();
        let page_id = put(&store, "a");
        store
            .upsert_chunks(
                "a",
                &[
                    chunk(0, "one", Some("m")),
                    chunk(1, "twö!", None),
                    chunk(2, "three", Some("other")),
                    chunk(3, "four", Some("m")),
                ],
                &UpsertChunksOptions::default(),
            )
            .unwrap();
        let rows = stored(&store, page_id);
        // Only the chunk with no vector is pending; chars counts characters, not bytes.
        assert_eq!(
            store.count_pending_text_chunks(page_id).unwrap(),
            json!({ "chunks": 1, "chars": 4 })
        );
        // Chunks 0 and 3 hold the model's vector and are current; chunk 3 is not in the current ids.
        let current = [rows[0].id as f64, rows[1].id as f64];
        store
            .clear_unkept_chunk_vectors(page_id, Some("m"), 1536, &current)
            .unwrap();
        let after = stored(&store, page_id);
        assert!(after[0].embed.has_vector());
        assert!(!after[1].embed.has_vector());
        assert!(!after[2].embed.has_vector());
        assert!(!after[3].embed.has_vector());
        // The cleared rows are pending; the kept one is not; the already-pending row keeps its mark.
        assert!(after[0].embed.pending_since_us.is_none());
        assert!(after[1].embed.pending_since_us.is_some());
        assert!(after[2].embed.pending_since_us.is_some());
        assert!(after[3].embed.pending_since_us.is_some());
        assert!(after[2].embed.text_hash.is_none() && after[2].embed.input_hash.is_none());
        assert_eq!(
            store.count_pending_text_chunks(page_id).unwrap(),
            json!({ "chunks": 3, "chars": 13 })
        );
        assert!(
            store
                .clear_unkept_chunk_vectors(1.5, None, 1536, &[])
                .is_err()
        );
        assert!(
            store
                .clear_unkept_chunk_vectors(page_id, None, 1536, &[-1.0])
                .is_err()
        );
        assert!(store.count_pending_text_chunks(1.5).is_err());
    }
}
