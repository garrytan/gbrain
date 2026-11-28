//! The embedding effect's install path: the completion read (which of a page's chunks already
//! carry a current vector) and the vector install (PGLite's batch `UPDATE content_chunks ... FROM
//! jsonb_to_recordset`). src/core/engine-sql/embedding-install.ts is the SQL copy.
//!
//! The store has one vector column, `embedding`; the TypeScript members refuse any other column and
//! any image vector before they reach the store. The chunk view is the one the page shows now
//! (`chunks::visible_chunks`, PGLite's `chunkGenerationFilter`). The text hash is sha256 where PGLite
//! keeps md5; both answer "the text has not changed since the vector was computed".

use crate::chunks::{embedding_dimensions, read_chunks, visible_chunks};
use crate::embeddings::{put_chunk_vector, read_signature, text_hash};
use crate::error::StoreError;
use crate::pages::read_page_by_id;
use crate::{Result, Store, keys, put_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// `readEmbeddingCompletion`'s options.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionOptions {
    pub signature: String,
    /// The model a complete chunk's vector must carry; null matches a vector with no model.
    pub model: Option<String>,
}

/// One row of `installChunkEmbeddings`.
#[derive(Debug, Clone, Deserialize)]
pub struct InstallRow {
    pub id: u64,
    pub chunk_text: String,
    /// Read as 64-bit floats, so a component outside the 32-bit range is seen and refused, not rounded.
    pub embedding: Vec<f64>,
    pub model: Option<String>,
    pub input_hash: Option<String>,
}

/// The chunk's `model` column: its label, or none.
fn model_label(meta: &Map<String, Value>) -> Option<&str> {
    meta.get("model").and_then(Value::as_str)
}

impl Store {
    /// `readEmbeddingCompletion(pageId, { signature, model })`: one row per visible chunk of the
    /// page, `{ id, chunk_text, chunk_source, embedding_input_hash, embedded, stamped }`. `embedded`
    /// is a vector computed from the current text under `model`; `stamped` is the page's signature
    /// equal to `signature`, null when the page has none.
    pub fn read_embedding_completion(
        &self,
        page_id: u64,
        options: &CompletionOptions,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        if read_page_by_id(&*read, page_id)?.is_none() {
            return Ok(Vec::new());
        }
        let stamped = read_signature(&*read, page_id)?.map(|s| s == options.signature);
        let mut rows = Vec::new();
        for chunk in visible_chunks(&*read, page_id)? {
            let embedded = chunk.embed.has_vector()
                && chunk.embed.embedded_at_us.is_some()
                && chunk.embed.text_hash.as_deref() == Some(text_hash(&chunk.chunk_text).as_str())
                && model_label(&chunk.meta) == options.model.as_deref();
            rows.push(json!({
                "id": chunk.id,
                "chunk_text": chunk.chunk_text,
                "chunk_source": chunk.chunk_source,
                "embedding_input_hash": chunk.embed.input_hash,
                "embedded": embedded,
                "stamped": stamped,
            }));
        }
        Ok(rows)
    }

    /// `installChunkEmbeddings(pageId, rows)`: stores each row's vector on the page's chunk with
    /// that id, only while the chunk still holds the row's text; any other row is skipped. The
    /// chunk is stamped embedded now, from its current text, with the row's input hash; a row with
    /// no model keeps the chunk's old one. Every row's vector must have the width upsertChunks takes
    /// (`embedding_dimensions`, 1536 when unset), skipped rows too, as PGLite casts the whole batch:
    /// one of another width refuses the batch before anything is written, so the store never holds
    /// two widths that vector search cannot compare. A component that is not a finite 32-bit float
    /// (1e40) refuses the batch the same way: it is never stored as another value.
    pub fn install_chunk_embeddings(&self, page_id: u64, rows: &[InstallRow]) -> Result<()> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let width = embedding_dimensions(&*tx)?;
            if let Some(row) = rows.iter().find(|row| row.embedding.len() != width) {
                return Err(StoreError::invalid(format!(
                    "expected {width} dimensions, not {}",
                    row.embedding.len()
                )));
            }
            // PGLite refuses such a batch with 22003 (`... is out of range for type vector`).
            let vectors = rows
                .iter()
                .map(|row| {
                    row.embedding
                        .iter()
                        .map(|&v| Some(v as f32).filter(|n| n.is_finite()).ok_or(v))
                        .collect::<std::result::Result<Vec<f32>, f64>>()
                })
                .collect::<std::result::Result<Vec<_>, f64>>()
                .map_err(|v| {
                    StoreError::invalid(format!(
                        "a chunk embedding must hold finite numbers: {v:e} is out of range for a 32-bit float vector"
                    ))
                })?;
            let mut chunks = read_chunks(&*tx, page_id)?;
            for (row, vector) in rows.iter().zip(&vectors) {
                let Some(chunk) = chunks
                    .iter_mut()
                    .find(|c| c.id == row.id && c.chunk_text == row.chunk_text)
                else {
                    continue;
                };
                let dims = u32::try_from(row.embedding.len())
                    .map_err(|_| StoreError::invalid("vector too long"))?;
                if let Some(model) = &row.model {
                    chunk
                        .meta
                        .insert("model".into(), Value::String(model.clone()));
                }
                let model = model_label(&chunk.meta).unwrap_or_default().to_string();
                chunk.embed.dims = dims;
                chunk.embed.embedded_at_us = Some(now);
                chunk.embed.text_hash = Some(text_hash(&chunk.chunk_text));
                chunk.embed.input_hash = row.input_hash.clone();
                chunk.embed.pending_since_us = None;
                put_json(tx, &keys::chunk(page_id, chunk.chunk_index), &*chunk)?;
                put_chunk_vector(tx, page_id, chunk.chunk_index, &model, now, vector)?;
            }
            Ok(())
        })
    }
}
