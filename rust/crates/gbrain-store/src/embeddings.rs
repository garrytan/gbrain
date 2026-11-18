//! Embedding state of chunks, pages and takes (core).
//!
//! Members: getEmbeddingsByChunkIds, countStaleChunks, sumStaleChunkChars,
//! setPageEmbeddingSignature, invalidateStaleSignatureEmbeddings, invalidateContentDriftEmbeddings,
//! listStaleChunks, readEmbeddingStateCounts, listEmbeddingStateRows, getChunksWithEmbeddings,
//! updateTakeEmbeddings, getTakeEmbeddings, countStaleTakes, listStaleTakes.
//!
//! Keys: every record of this family starts with `keys::EMBEDDING_STATE` (`B`); ids are u64 BE and
//! chunk indexes u32 BE (rust/docs/store/embeddings.md):
//! - `B 'c' <page id> <chunk index>` -> a chunk vector (the vector value below).
//! - `B 't' <take id>` -> a take vector (the vector value below).
//! - `B 'g'` -> the vector generation, u64 BE. It goes up by one in the transaction of every
//!   vector write or delete, so a reader can tell that its cached vectors are out of date.
//!
//! Vector value: version u8 (1), dims u32 BE, embedded_at µs i64 BE, model length u16 BE, the
//! model in UTF-8, then dims f32 values, little-endian.

use crate::error::{STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::PageRecord;
use crate::{Result, keys};

const CHUNK_VECTOR: u8 = b'c';
const TAKE_VECTOR: u8 = b't';
const GENERATION: u8 = b'g';
const VECTOR_VERSION: u8 = 1;
/// version + dims + embedded_at + model length.
const HEADER_BYTES: usize = 1 + 4 + 8 + 2;

/// One stored vector. `id` is the page id of a chunk vector or the take id of a take vector;
/// `chunk_index` is 0 for a take vector.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredVector {
    pub id: u64,
    pub chunk_index: u32,
    pub model: String,
    pub embedded_at_us: i64,
    pub vector: Vec<f32>,
}

fn chunk_vector_key(page_id: u64, chunk_index: u32) -> Vec<u8> {
    let mut key = vec![keys::EMBEDDING_STATE, CHUNK_VECTOR];
    key.extend_from_slice(&page_id.to_be_bytes());
    key.extend_from_slice(&chunk_index.to_be_bytes());
    key
}

fn take_vector_key(take_id: u64) -> Vec<u8> {
    let mut key = vec![keys::EMBEDDING_STATE, TAKE_VECTOR];
    key.extend_from_slice(&take_id.to_be_bytes());
    key
}

fn generation_key() -> [u8; 2] {
    [keys::EMBEDDING_STATE, GENERATION]
}

fn corrupt(what: &str) -> StoreError {
    StoreError::new(STORE_CORRUPT, format!("bad embedding record: {what}"))
}

/// The value bytes of a vector.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn encode_vector(model: &str, embedded_at_us: i64, vector: &[f32]) -> Result<Vec<u8>> {
    let dims = u32::try_from(vector.len()).map_err(|_| StoreError::invalid("vector too long"))?;
    let model_len = u16::try_from(model.len())
        .map_err(|_| StoreError::invalid("embedding model name too long"))?;
    let mut out = Vec::with_capacity(HEADER_BYTES + model.len() + vector.len() * 4);
    out.push(VECTOR_VERSION);
    out.extend_from_slice(&dims.to_be_bytes());
    out.extend_from_slice(&embedded_at_us.to_be_bytes());
    out.extend_from_slice(&model_len.to_be_bytes());
    out.extend_from_slice(model.as_bytes());
    for v in vector {
        out.extend_from_slice(&v.to_le_bytes());
    }
    Ok(out)
}

fn decode_vector(id: u64, chunk_index: u32, bytes: &[u8]) -> Result<StoredVector> {
    if bytes.len() < HEADER_BYTES || bytes[0] != VECTOR_VERSION {
        return Err(corrupt("vector header"));
    }
    let dims = u32::from_be_bytes(bytes[1..5].try_into().map_err(|_| corrupt("dims"))?) as usize;
    let embedded_at_us = i64::from_be_bytes(
        bytes[5..13]
            .try_into()
            .map_err(|_| corrupt("embedded_at"))?,
    );
    let model_len = u16::from_be_bytes(
        bytes[13..15]
            .try_into()
            .map_err(|_| corrupt("model length"))?,
    ) as usize;
    let body = &bytes[HEADER_BYTES..];
    if body.len() != model_len + dims * 4 {
        return Err(corrupt("vector length"));
    }
    let model = std::str::from_utf8(&body[..model_len])
        .map_err(|_| corrupt("model"))?
        .to_owned();
    let vector = body[model_len..]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect();
    Ok(StoredVector {
        id,
        chunk_index,
        model,
        embedded_at_us,
        vector,
    })
}

fn chunk_ids_of(key: &[u8]) -> Result<(u64, u32)> {
    if key.len() != 2 + 8 + 4 {
        return Err(corrupt("chunk vector key"));
    }
    let page_id = keys::be8(&key[2..10]).ok_or_else(|| corrupt("chunk vector key"))?;
    let index = u32::from_be_bytes(key[10..14].try_into().map_err(|_| corrupt("chunk index"))?);
    Ok((page_id, index))
}

/// Scans the vectors under `prefix`, decoding each with `ids`, until `f` returns false.
fn scan_vectors(
    read: &dyn KvRead,
    prefix: &[u8],
    ids: fn(&[u8]) -> Result<(u64, u32)>,
    f: &mut dyn FnMut(&StoredVector) -> bool,
) -> Result<()> {
    let mut failure = None;
    scan_prefix(read, prefix, false, &mut |k, v| match ids(k)
        .and_then(|(id, index)| decode_vector(id, index, v))
    {
        Ok(stored) => f(&stored),
        Err(e) => {
            failure = Some(e);
            false
        }
    })?;
    failure.map_or(Ok(()), Err)
}

/// Every chunk vector, in key order (page id, then chunk index), until `f` returns false.
/// Source, type, soft-delete, quarantine and visibility filters are the caller's.
pub fn scan_chunk_vectors(
    read: &dyn KvRead,
    f: &mut dyn FnMut(&StoredVector) -> bool,
) -> Result<()> {
    scan_vectors(
        read,
        &[keys::EMBEDDING_STATE, CHUNK_VECTOR],
        chunk_ids_of,
        f,
    )
}

/// Every take vector, in take id order, until `f` returns false. `chunk_index` is 0.
pub fn scan_take_vectors(
    read: &dyn KvRead,
    f: &mut dyn FnMut(&StoredVector) -> bool,
) -> Result<()> {
    fn take_ids(key: &[u8]) -> Result<(u64, u32)> {
        if key.len() != 2 + 8 {
            return Err(corrupt("take vector key"));
        }
        let id = keys::be8(&key[2..10]).ok_or_else(|| corrupt("take vector key"))?;
        Ok((id, 0))
    }
    scan_vectors(read, &[keys::EMBEDDING_STATE, TAKE_VECTOR], take_ids, f)
}

/// The vector of one chunk, or `None`.
pub fn read_chunk_vector(
    read: &dyn KvRead,
    page_id: u64,
    chunk_index: u32,
) -> Result<Option<StoredVector>> {
    read.get(&chunk_vector_key(page_id, chunk_index))?
        .map(|bytes| decode_vector(page_id, chunk_index, &bytes))
        .transpose()
}

/// The vector generation: 0 on a store that never held a vector, then one more for every vector
/// write or delete.
pub fn vector_generation(read: &dyn KvRead) -> Result<u64> {
    match read.get(&generation_key())? {
        None => Ok(0),
        Some(bytes) => keys::be8(&bytes).ok_or_else(|| corrupt("generation")),
    }
}

/// Raises the vector generation by one, in `tx`.
fn bump_generation(tx: &mut dyn KvWrite) -> Result<()> {
    let next = vector_generation(&*tx)? + 1;
    tx.put(&generation_key(), &next.to_be_bytes())
}

/// Writes a chunk vector and raises the generation.
#[allow(dead_code)] // chunks.rs and the take members call these next.
pub(crate) fn put_chunk_vector(
    tx: &mut dyn KvWrite,
    page_id: u64,
    chunk_index: u32,
    model: &str,
    embedded_at_us: i64,
    vector: &[f32],
) -> Result<()> {
    let value = encode_vector(model, embedded_at_us, vector)?;
    tx.put(&chunk_vector_key(page_id, chunk_index), &value)?;
    bump_generation(tx)
}

/// Writes a take vector and raises the generation.
#[allow(dead_code)]
pub(crate) fn put_take_vector(
    tx: &mut dyn KvWrite,
    take_id: u64,
    model: &str,
    embedded_at_us: i64,
    vector: &[f32],
) -> Result<()> {
    let value = encode_vector(model, embedded_at_us, vector)?;
    tx.put(&take_vector_key(take_id), &value)?;
    bump_generation(tx)
}

/// Deletes a take's vector, if it has one, and raises the generation when it did.
pub(crate) fn remove_take_vector(tx: &mut dyn KvWrite, take_id: u64) -> Result<()> {
    let key = take_vector_key(take_id);
    if tx.get(&key)?.is_none() {
        return Ok(());
    }
    tx.delete(&key)?;
    bump_generation(tx)
}

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    let mut prefix = vec![keys::EMBEDDING_STATE, CHUNK_VECTOR];
    prefix.extend_from_slice(&page.id.to_be_bytes());
    let mut doomed = Vec::new();
    scan_prefix(&*tx, &prefix, false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    if doomed.is_empty() {
        return Ok(());
    }
    for key in doomed {
        tx.delete(&key)?;
    }
    bump_generation(tx)
}

/// Deletes this family's records of chunks that are gone (`cascade::remove_chunk_rows`).
/// Nothing to delete: chunks.rs removes a chunk's vector by index before the chunk record goes.
pub(crate) fn remove_chunk_rows(
    _tx: &mut dyn KvWrite,
    _page_id: u64,
    _chunk_ids: &[u64],
) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vector_round_trips_through_its_bytes() {
        let bytes = encode_vector("embed-m1", -5, &[1.0, -0.5, 0.25]).unwrap();
        let back = decode_vector(7, 3, &bytes).unwrap();
        assert_eq!(
            back,
            StoredVector {
                id: 7,
                chunk_index: 3,
                model: "embed-m1".into(),
                embedded_at_us: -5,
                vector: vec![1.0, -0.5, 0.25],
            }
        );
        assert!(decode_vector(7, 3, &bytes[..bytes.len() - 1]).is_err());
        assert_eq!(take_vector_key(1).len(), 10);
    }
}
