//! Embedding catalog reads (src/core/engine-sql/embedding-catalog.ts): what Postgres reads from
//! its catalog about the vector columns, answered from the store's per-vector records.
//!
//! Members: readChunkVectorColumn, readEmbeddingIdentity, hasStoredVectors. `listEmbeddingStores`
//! is a constant on the TypeScript side, and `countStaleFactEmbeddings` is in facts/doctor.rs.
//!
//! Postgres declares a width on the `content_chunks.embedding` column (`vector(N)`). The store has
//! no column type: each vector carries its own width and model (embeddings.rs). So the width a
//! read reports is the width of the first stored chunk vector; with no chunk vector it is the
//! config `embedding_dimensions`, when one is set; with neither, the store has no width yet and
//! the column reads as absent, as on a PGLite brain before its schema is created. The model is the
//! model of the first chunk vector, else the config `embedding_model`.
//!
//! A first vector cannot show a brain that mixes models or widths. Postgres has the same blind
//! spot: it reads the model from config and the width from the column type, never from the rows.

use crate::config::read_config;
use crate::embeddings::{StoredVector, any_take_vector, scan_chunk_vectors};
use crate::error::StoreError;
use crate::facts::source_rows;
use crate::kv::KvRead;
use crate::sources::all_sources;
use crate::{Result, Store};
use serde_json::{Value, json};

/// The one vector column the store keeps.
const VECTOR_COLUMN: &str = "embedding";

/// The first chunk vector in key order, if any.
fn first_chunk_vector(read: &dyn KvRead) -> Result<Option<StoredVector>> {
    let mut first = None;
    scan_chunk_vectors(read, &mut |v| {
        first = Some(v.clone());
        false
    })?;
    Ok(first)
}

/// The config `embedding_dimensions` when it is a positive integer.
fn configured_width(read: &dyn KvRead) -> Result<Option<u64>> {
    Ok(read_config(read, "embedding_dimensions")?
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| *n > 0))
}

/// The width of the vector column, or `None` when the store has none yet.
fn known_width(read: &dyn KvRead, first: Option<&StoredVector>) -> Result<Option<u64>> {
    match first {
        Some(v) => Ok(Some(v.vector.len() as u64)),
        None => configured_width(read),
    }
}

impl Store {
    /// `readChunkVectorColumn(column)`: `{ exists, dims }` of a `content_chunks` vector column.
    /// Only `embedding` can exist, and only once the store has a width.
    pub fn read_chunk_vector_column(&self, column: &str) -> Result<Value> {
        if column.contains('\0') {
            return Err(StoreError::invalid(
                "readChunkVectorColumn: a column name may not hold a NUL byte",
            ));
        }
        if column != VECTOR_COLUMN {
            return Ok(json!({ "exists": false, "dims": null }));
        }
        let read = self.read()?;
        let first = first_chunk_vector(&*read)?;
        Ok(match known_width(&*read, first.as_ref())? {
            Some(dims) => json!({ "exists": true, "dims": dims }),
            None => json!({ "exists": false, "dims": null }),
        })
    }

    /// `readEmbeddingIdentity()`: `{ model, dimensions }` of the stored vectors, or `null` when the
    /// store has no width yet.
    pub fn read_embedding_identity(&self) -> Result<Value> {
        let read = self.read()?;
        let first = first_chunk_vector(&*read)?;
        let Some(dimensions) = known_width(&*read, first.as_ref())? else {
            return Ok(Value::Null);
        };
        let model = match first {
            Some(v) if !v.model.trim().is_empty() => Some(v.model.trim().to_string()),
            _ => read_config(&*read, "embedding_model")?
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty()),
        };
        Ok(json!({ "model": model, "dimensions": dimensions }))
    }

    /// `hasStoredVectors(store)`: whether any row of that store holds a vector (Postgres's
    /// `EXISTS (SELECT 1 FROM <store> WHERE embedding IS NOT NULL)`). The store keeps no query
    /// cache, so `query_cache` holds none.
    pub fn has_stored_vectors(&self, store: &str) -> Result<bool> {
        let read = self.read()?;
        match store {
            "content_chunks" => Ok(first_chunk_vector(&*read)?.is_some()),
            "takes" => any_take_vector(&*read),
            "facts" => {
                for source in all_sources(&*read)? {
                    if source_rows(&*read, &source.id)?
                        .iter()
                        .any(|row| row.embedding.is_some())
                    {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            "query_cache" => Ok(false),
            other => Err(StoreError::invalid(format!(
                "hasStoredVectors: '{}' is not an embedding store",
                other.replace('\0', "")
            ))),
        }
    }
}
