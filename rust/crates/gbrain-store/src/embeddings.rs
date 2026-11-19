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
//! - `B 's' <page id>` -> the page's embedding signature (PGLite's `pages.embedding_signature`),
//!   UTF-8.
//! - `B 'b' <page id>` -> the page's embedding ledger row (`page_embedding_budget`).
//! - `B 'k' <take id>` -> the take's `claim_rev` when its vector was written, u64 BE. A take
//!   vector counts only while this equals the take's current `claim_rev` (PGLite compares
//!   `embedded_text_hash` with `md5(claim)`); a claim edit makes the vector stale at once.
//!
//! Vector value: version u8 (1), dims u32 BE, embedded_at µs i64 BE, model length u16 BE, the
//! model in UTF-8, then dims f32 values, little-endian.
//!
//! The rest of a chunk's embedding bookkeeping (`embedded_at`, the text hash, the input hash, the
//! pending stamp, the vector's width) lives on the chunk record (`chunks::EmbedState`), so the
//! stale and state reads never decode a vector.

use crate::chunks::{
    ChunkRecord, EmbedState, SegmentView, chunk_rows, read_chunks, read_segment_view,
};
use crate::error::{STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, all_pages, read_page};
use crate::sources::{DEFAULT_SOURCE, read_source};
use crate::takes::{TakeRecord, all_takes, read_take, write_take};
use crate::vectors::{check_query, norm_sq, served_cosine};
use crate::{Result, Store, keys, put_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

const CHUNK_VECTOR: u8 = b'c';
const TAKE_VECTOR: u8 = b't';
const GENERATION: u8 = b'g';
const PAGE_SIGNATURE: u8 = b's';
const TAKE_STATE: u8 = b'k';
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

pub(crate) fn signature_key(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::EMBEDDING_STATE, PAGE_SIGNATURE];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn take_state_key(take_id: u64) -> Vec<u8> {
    let mut key = vec![keys::EMBEDDING_STATE, TAKE_STATE];
    key.extend_from_slice(&take_id.to_be_bytes());
    key
}

/// The hash a vector's source text is stamped with: sha256, lowercase hex (PGLite keeps md5;
/// only equality is ever compared).
pub(crate) fn text_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn corrupt(what: &str) -> StoreError {
    StoreError::new(STORE_CORRUPT, format!("bad embedding record: {what}"))
}

/// The value bytes of a vector.
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

/// Every current take vector, in take id order, until `f` returns false. `chunk_index` is 0. A
/// vector written for an earlier claim of its take is skipped.
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
    let mut failure = None;
    scan_vectors(
        read,
        &[keys::EMBEDDING_STATE, TAKE_VECTOR],
        take_ids,
        &mut |stored| match take_vector_is_current(read, stored.id) {
            Ok(true) => f(stored),
            Ok(false) => true,
            Err(e) => {
                failure = Some(e);
                false
            }
        },
    )?;
    failure.map_or(Ok(()), Err)
}

/// Whether a take holds a vector written for its current claim: PGLite's `takes.embedding IS NOT
/// NULL`. `addTakesBatch` sets the column to NULL when it changes a claim; the store keeps the old
/// vector record, so only a vector at the take's claim revision counts (embedding_catalog.rs).
pub(crate) fn any_take_vector(read: &dyn KvRead) -> Result<bool> {
    let (mut found, mut failure) = (false, None);
    scan_prefix(
        read,
        &[keys::EMBEDDING_STATE, TAKE_VECTOR],
        false,
        &mut |k, _| {
            let exists = k
                .get(2..10)
                .and_then(keys::be8)
                .ok_or_else(|| corrupt("take vector key"))
                .and_then(|id| take_vector_is_current(read, id));
            match exists {
                Ok(current) => {
                    found = current;
                    !found
                }
                Err(e) => {
                    failure = Some(e);
                    false
                }
            }
        },
    )?;
    failure.map_or(Ok(found), Err)
}

/// Whether the take's stored vector was written for its current claim.
fn take_vector_is_current(read: &dyn KvRead, take_id: u64) -> Result<bool> {
    let Some(take) = read_take(read, take_id)? else {
        return Ok(false);
    };
    Ok(take_vector_rev(read, take_id)? == Some(take.claim_rev))
}

fn take_vector_rev(read: &dyn KvRead, take_id: u64) -> Result<Option<u64>> {
    read.get(&take_state_key(take_id))?
        .map(|bytes| keys::be8(&bytes).ok_or_else(|| corrupt("take vector state")))
        .transpose()
}

/// The take's vector when it was written for the take's current claim.
fn current_take_vector(read: &dyn KvRead, take: &TakeRecord) -> Result<Option<StoredVector>> {
    if take_vector_rev(read, take.id)? != Some(take.claim_rev) {
        return Ok(None);
    }
    read.get(&take_vector_key(take.id))?
        .map(|bytes| decode_vector(take.id, 0, &bytes))
        .transpose()
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

/// Writes a take vector for the take's claim revision `claim_rev` and raises the generation.
pub(crate) fn put_take_vector(
    tx: &mut dyn KvWrite,
    take_id: u64,
    claim_rev: u64,
    model: &str,
    embedded_at_us: i64,
    vector: &[f32],
) -> Result<()> {
    let value = encode_vector(model, embedded_at_us, vector)?;
    tx.put(&take_vector_key(take_id), &value)?;
    tx.put(&take_state_key(take_id), &claim_rev.to_be_bytes())?;
    bump_generation(tx)
}

/// Deletes a take's vector, if it has one, and raises the generation when it did.
pub(crate) fn remove_take_vector(tx: &mut dyn KvWrite, take_id: u64) -> Result<()> {
    tx.delete(&take_state_key(take_id))?;
    let key = take_vector_key(take_id);
    if tx.get(&key)?.is_none() {
        return Ok(());
    }
    tx.delete(&key)?;
    bump_generation(tx)
}

/// Deletes a chunk's vector, if it has one, and raises the generation when it did.
pub(crate) fn remove_chunk_vector(
    tx: &mut dyn KvWrite,
    page_id: u64,
    chunk_index: u32,
) -> Result<()> {
    let key = chunk_vector_key(page_id, chunk_index);
    if tx.get(&key)?.is_none() {
        return Ok(());
    }
    tx.delete(&key)?;
    bump_generation(tx)
}

/// Resets what a contextual retrieval tier embedded on a page (`updatePageContextualRetrievalState` to `none`): its
/// embedding signature goes, and every chunk with a vector, staged or not, loses it, its embed time and its text and
/// input hashes and is stamped pending at `now_us`. Each dropped vector raises the vector generation.
pub(crate) fn reset_page_vectors(tx: &mut dyn KvWrite, page_id: u64, now_us: i64) -> Result<()> {
    tx.delete(&signature_key(page_id))?;
    for mut chunk in read_chunks(&*tx, page_id)? {
        if !chunk.embed.has_vector() {
            continue;
        }
        let embed = EmbedState {
            dims: 0,
            embedded_at_us: None,
            text_hash: None,
            input_hash: None,
            pending_since_us: Some(now_us),
        };
        drop_vector(tx, &mut chunk, embed)?;
    }
    Ok(())
}

/// Clears a page's embedding signature (PGLite's `embedding_signature=NULL`), as a fact
/// withdrawal does for each page it invalidates (`facts::withdrawal_pages`).
pub(crate) fn clear_signature(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    tx.delete(&signature_key(page_id))
}

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    tx.delete(&signature_key(page.id))?;
    crate::page_embedding_budget::remove_page_budget(tx, page.id)?;
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

// ---------------------------------------------------------------------------------------------
// Page and chunk context shared by the stale and state reads.

const EMBED_SKIP: &str = "embed_skip";
const QUARANTINE: &str = "quarantine";
/// PGLite's partial index on vector-less chunks (`src/schema.sql`), which `ops` mode reports.
const COVERING_INDEX: &str = "content_chunks_stale_idx";
/// Report order of the embedding states (`EMBEDDING_STATES`).
const STATES: [&str; 7] = [
    "embedded",
    "pending",
    "keyword_only",
    "quarantined",
    "empty",
    "deleted_page_chunks",
    "chunkless_healable",
];

/// A page with what the embedding reads need of it.
struct PageCtx {
    page: PageRecord,
    signature: Option<String>,
    /// Every chunk record of the page, visible or not.
    chunks: Vec<ChunkRecord>,
    /// The page's segment view: its body generation and live occurrences.
    view: SegmentView,
}

impl PageCtx {
    fn live(&self) -> bool {
        self.page.deleted_at_us.is_none()
    }

    fn embed_skip(&self) -> bool {
        self.page.frontmatter.contains_key(EMBED_SKIP)
    }

    fn quarantined(&self) -> bool {
        self.page.frontmatter.contains_key(QUARANTINE)
    }

    fn sealed(&self) -> bool {
        self.page.text_projection_revision.as_deref() == Some(self.page.knowledge_revision.as_str())
    }

    /// The generation-visible chunks in chunk index order (`chunkVisibleFilter`, the served reads).
    fn visible(&self) -> impl Iterator<Item = &ChunkRecord> {
        self.chunks
            .iter()
            .filter(|c| c.visible_at(self.view.generation))
    }

    /// The live body's chunks in chunk index order (`chunkGenerationFilter`, the stale and state reads): a closed
    /// occurrence's chunk that a deferred retire left and an inline chunk left on a segmented page are not.
    fn live_body(&self) -> impl Iterator<Item = &ChunkRecord> {
        let segmented_page = crate::chunks::segmented(&self.page);
        self.chunks
            .iter()
            .filter(move |c| crate::chunks::in_live_body(c, segmented_page, &self.view))
    }

    /// PGLite's `chunklessPagesWhere` without the source filter. A segmented page's body lives in
    /// its segments, which this store does not count as page text.
    fn chunkless_healable(&self) -> bool {
        let has_text = |t: Option<&str>| t.is_some_and(|t| !t.is_empty());
        self.live()
            && (has_text(self.page.compiled_truth.as_deref())
                || has_text(self.page.timeline.as_deref()))
            && !self.quarantined()
            && (!self.sealed() || self.embed_skip())
            && self.chunks.is_empty()
    }

    /// The state of one of the page's chunks (`chunkEmbeddingState`).
    fn chunk_state(&self, chunk: &ChunkRecord) -> &'static str {
        if !self.live() {
            "deleted_page_chunks"
        } else if self.quarantined() {
            "quarantined"
        } else if chunk.embed.has_vector() {
            "embedded"
        } else if !self.embed_skip() {
            "pending"
        } else {
            "keyword_only"
        }
    }

    /// The state of a live page with no chunk record (`chunklessPageState`).
    fn chunkless_state(&self) -> &'static str {
        if self.quarantined() {
            "quarantined"
        } else if self.chunkless_healable() {
            "chunkless_healable"
        } else {
            "empty"
        }
    }

    fn overdue(&self, now_us: i64, purge_window_hours: i64) -> bool {
        self.page
            .deleted_at_us
            .is_some_and(|at| at < now_us - purge_window_hours.saturating_mul(3_600_000_000))
    }

    /// `frontmatter -> <key> ->> 'reason'`.
    fn marker_reason(&self, key: &str) -> Option<String> {
        match self.page.frontmatter.get(key)?.as_object()?.get("reason")? {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            other => Some(other.to_string()),
        }
    }

    /// `embed_skip.bytes` when it is a number, rounded as `numeric::bigint` rounds.
    fn marker_bytes(&self) -> Option<i64> {
        let n = self
            .page
            .frontmatter
            .get(EMBED_SKIP)?
            .get("bytes")?
            .as_f64()?;
        Some(n.round() as i64)
    }
}

/// Every page (soft-deleted included) in page id order, with its chunks and signature.
fn page_contexts(read: &dyn KvRead) -> Result<Vec<PageCtx>> {
    let mut pages = all_pages(read)?;
    pages.sort_by_key(|p| p.id);
    let mut out = Vec::with_capacity(pages.len());
    for page in pages {
        let chunks = read_chunks(read, page.id)?;
        let view = read_segment_view(read, page.id)?;
        let signature = read_signature(read, page.id)?;
        out.push(PageCtx {
            page,
            signature,
            chunks,
            view,
        });
    }
    Ok(out)
}

pub(crate) fn read_signature(read: &dyn KvRead, page_id: u64) -> Result<Option<String>> {
    read.get(&signature_key(page_id))?
        .map(|bytes| String::from_utf8(bytes).map_err(|_| corrupt("page signature")))
        .transpose()
}

/// Whether the source exists and is not archived.
fn source_live(
    read: &dyn KvRead,
    cache: &mut HashMap<String, bool>,
    source_id: &str,
) -> Result<bool> {
    if let Some(live) = cache.get(source_id) {
        return Ok(*live);
    }
    let live = read_source(read, source_id)?.is_some_and(|s| !s.archived);
    cache.insert(source_id.to_string(), live);
    Ok(live)
}

fn in_sources(source_ids: &Option<Vec<String>>, source_id: &str) -> bool {
    source_ids
        .as_ref()
        .is_none_or(|ids| ids.iter().any(|id| id == source_id))
}

/// `splitEmbeddingSignature`: `<model>:<dims>`, or the whole text as the model and no width.
fn split_signature(signature: &str) -> (&str, Option<u32>) {
    if let Some(at) = signature.rfind(':').filter(|at| *at > 0) {
        let suffix = &signature[at + 1..];
        if !suffix.is_empty()
            && suffix.bytes().all(|b| b.is_ascii_digit())
            && let Ok(dims) = suffix.parse::<u32>()
            && (1..=2_147_483_647).contains(&dims)
        {
            return (&signature[..at], Some(dims));
        }
    }
    (signature, None)
}

/// `currentSpaceChunkPredicate`: the chunk's vector is in the target space (its label names the
/// target model or the target's bare tail, its text is the text it was computed from, and its
/// width is the target width).
fn in_current_space(chunk: &ChunkRecord, model: &str, dims: Option<u32>) -> bool {
    let label = chunk
        .meta
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("");
    let tail = model.split_once(':').map_or(model, |(_, tail)| tail);
    chunk.embed.has_vector()
        && (label == model || label == tail)
        && chunk.embed.text_hash.as_deref() == Some(text_hash(&chunk.chunk_text).as_str())
        && dims == Some(chunk.embed.dims)
}

/// Rewrites a chunk record after its vector is gone (the postings do not change).
fn drop_vector(tx: &mut dyn KvWrite, chunk: &mut ChunkRecord, embed: EmbedState) -> Result<()> {
    chunk.embed = embed;
    put_json(tx, &keys::chunk(chunk.page_id, chunk.chunk_index), &*chunk)?;
    remove_chunk_vector(tx, chunk.page_id, chunk.chunk_index)
}

fn vector_value(vector: &[f32]) -> Value {
    json!(vector)
}

// ---------------------------------------------------------------------------------------------
// Options.

/// Options of the stale-chunk counts (`StaleChunkOpts`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StaleChunkOptions {
    pub source_id: Option<String>,
    pub signature: Option<String>,
    pub include_null_signature: bool,
}

/// Options of `listStaleChunks`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ListStaleChunksOptions {
    pub batch_size: Option<u64>,
    pub after_page_id: Option<u64>,
    pub after_chunk_index: Option<i64>,
    pub source_id: Option<String>,
    /// `page_id` (the default) or `updated_desc`.
    pub order_by: Option<String>,
    pub after_updated_at: Option<String>,
}

/// Options of `setPageEmbeddingSignature`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SignatureOptions {
    pub source_id: Option<String>,
    pub signature: String,
}

/// Options of `invalidateStaleSignatureEmbeddings` and `invalidateContentDriftEmbeddings`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InvalidateOptions {
    pub signature: Option<String>,
    pub source_id: Option<String>,
    pub include_null_signature: bool,
}

/// Options of `readEmbeddingStateCounts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StateCountOptions {
    /// `ops` or `full`.
    pub mode: String,
    pub source_ids: Option<Vec<String>>,
    pub purge_window_hours: i64,
}

/// Options of `listEmbeddingStateRows`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StateRowOptions {
    pub source_ids: Option<Vec<String>>,
    pub slugs: Option<Vec<String>>,
    pub states: Vec<String>,
    pub limit: Option<u64>,
    pub purge_window_hours: i64,
}

/// Options of `getChunksWithEmbeddings`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChunksWithEmbeddingsOptions {
    pub source_id: Option<String>,
    pub include_unsealed: bool,
}

/// One row of `updateTakeEmbeddings` (validated by the TypeScript member first).
#[derive(Debug, Clone, Deserialize)]
pub struct TakeEmbeddingInput {
    pub take_id: u64,
    pub embedding: Vec<f64>,
    pub claim: String,
    pub model: String,
}

/// Options of the stale-take reads (`StaleTakeOpts`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StaleTakeOptions {
    pub source_id: Option<String>,
    pub model: Option<String>,
    pub dims: Option<u32>,
}

impl StaleChunkOptions {
    /// `staleChunkWhere` for one chunk of `ctx` (the generation filter is the caller's).
    fn stale(&self, ctx: &PageCtx, chunk: &ChunkRecord) -> bool {
        if !ctx.live() || ctx.embed_skip() {
            return false;
        }
        if self
            .source_id
            .as_deref()
            .is_some_and(|id| id != ctx.page.source_id)
        {
            return false;
        }
        let missing = !chunk.embed.has_vector();
        match self.signature.as_deref() {
            None => missing,
            Some(target) => {
                missing
                    || match ctx.signature.as_deref() {
                        None => self.include_null_signature,
                        Some(sig) => sig != target,
                    }
            }
        }
    }
}

impl Store {
    fn stale_chunks<T>(
        &self,
        options: &StaleChunkOptions,
        mut each: impl FnMut(&ChunkRecord) -> T,
    ) -> Result<Vec<T>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for ctx in page_contexts(&*read)? {
            for chunk in ctx.live_body() {
                if options.stale(&ctx, chunk) {
                    out.push(each(chunk));
                }
            }
        }
        Ok(out)
    }

    /// `countStaleChunks(opts?)`: chunks the embed job would select (no vector; with a signature,
    /// also the vectors of pages stamped with another signature).
    pub fn count_stale_chunks(&self, options: &StaleChunkOptions) -> Result<u64> {
        Ok(self.stale_chunks(options, |_| ())?.len() as u64)
    }

    /// `sumStaleChunkChars(opts?)`: the characters of those chunks' text.
    pub fn sum_stale_chunk_chars(&self, options: &StaleChunkOptions) -> Result<u64> {
        Ok(self
            .stale_chunks(options, |c| c.chunk_text.chars().count() as u64)?
            .into_iter()
            .sum())
    }

    /// `listStaleChunks(opts?)`: vector-less chunks of live, non-embed_skip pages, keyset-paged in
    /// `(page_id, chunk_index)` order, or newest page first with `orderBy: 'updated_desc'`.
    pub fn list_stale_chunks(&self, options: &ListStaleChunksOptions) -> Result<Vec<Value>> {
        let read = self.read()?;
        let limit = usize::try_from(options.batch_size.unwrap_or(2000)).unwrap_or(usize::MAX);
        let updated_desc = options.order_by.as_deref() == Some("updated_desc");
        let after_pid = options.after_page_id.unwrap_or(0);
        let after_idx = options.after_chunk_index.unwrap_or(-1);
        let after_updated =
            match options.after_updated_at.as_deref() {
                None => None,
                Some(text) => Some(crate::env::parse_iso(text).ok_or_else(|| {
                    StoreError::invalid("afterUpdatedAt must be an ISO timestamp")
                })?),
            };
        let contexts = page_contexts(&*read)?;
        let mut rows = Vec::new();
        for ctx in &contexts {
            if !ctx.live()
                || ctx.embed_skip()
                || options
                    .source_id
                    .as_deref()
                    .is_some_and(|id| id != ctx.page.source_id)
            {
                continue;
            }
            for chunk in ctx.live_body().filter(|c| !c.embed.has_vector()) {
                let index = i64::from(chunk.chunk_index);
                let updated = ctx.page.updated_at_us;
                let after = if updated_desc {
                    match after_updated {
                        None if after_pid == 0 => true,
                        // A null cursor time with a page id: `updated_at < NULL` matches nothing.
                        None => false,
                        Some(at) => {
                            updated < at
                                || (updated == at && ctx.page.id > after_pid)
                                || (updated == at && ctx.page.id == after_pid && index > after_idx)
                        }
                    }
                } else {
                    (ctx.page.id, index) > (after_pid, after_idx)
                };
                if after {
                    rows.push((updated, ctx.page.id, chunk.chunk_index, &ctx.page, chunk));
                }
            }
        }
        if updated_desc {
            rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        }
        Ok(rows
            .into_iter()
            .take(limit)
            .map(|(updated, _, _, page, chunk)| {
                let mut row = json!({
                    "slug": page.slug,
                    "chunk_index": chunk.chunk_index,
                    "chunk_text": chunk.chunk_text,
                    "chunk_source": chunk.chunk_source,
                    "model": chunk.meta.get("model").cloned().unwrap_or_else(|| json!("")),
                    "token_count": chunk.meta.get("token_count").cloned().unwrap_or(Value::Null),
                    "source_id": page.source_id,
                    "page_id": page.id,
                });
                if updated_desc {
                    row["updated_at"] = json!(crate::env::iso(updated));
                }
                row
            })
            .collect())
    }

    /// `setPageEmbeddingSignature(slug, { signature, sourceId? })`: stamps the page (slug as
    /// written, in `sourceId` or `default`). A missing page is a no-op.
    pub fn set_page_embedding_signature(
        &self,
        slug: &str,
        options: &SignatureOptions,
    ) -> Result<()> {
        self.write(|tx| {
            let source = options.source_id.as_deref().unwrap_or(DEFAULT_SOURCE);
            if let Some(page) = read_page(&*tx, source, slug)? {
                tx.put(&signature_key(page.id), options.signature.as_bytes())?;
            }
            Ok(())
        })
    }

    /// `invalidateStaleSignatureEmbeddings({ signature, sourceId?, includeNullSignature? })`: drops
    /// the vectors of live pages in unarchived sources whose signature differs from `signature`
    /// (or is unset, with `includeNullSignature`), unless the vector is already in the target
    /// space. Returns how many it dropped.
    pub fn invalidate_stale_signature_embeddings(
        &self,
        options: &InvalidateOptions,
    ) -> Result<u64> {
        let signature = options.signature.clone().ok_or_else(|| {
            StoreError::invalid("invalidateStaleSignatureEmbeddings needs a signature")
        })?;
        let (model, dims) = split_signature(&signature);
        let now_us = self.env.now_micros();
        self.write(|tx| {
            let mut sources = HashMap::new();
            let mut count = 0;
            for ctx in page_contexts(&*tx)? {
                let sig_differs = match ctx.signature.as_deref() {
                    None => options.include_null_signature,
                    Some(sig) => sig != signature,
                };
                if !ctx.live()
                    || !sig_differs
                    || options
                        .source_id
                        .as_deref()
                        .is_some_and(|id| id != ctx.page.source_id)
                    || !source_live(&*tx, &mut sources, &ctx.page.source_id)?
                {
                    continue;
                }
                for mut chunk in ctx.chunks {
                    if !chunk.embed.has_vector() || in_current_space(&chunk, model, dims) {
                        continue;
                    }
                    let embed = EmbedState {
                        dims: 0,
                        embedded_at_us: None,
                        pending_since_us: Some(now_us),
                        ..chunk.embed.clone()
                    };
                    drop_vector(tx, &mut chunk, embed)?;
                    count += 1;
                }
            }
            Ok(count)
        })
    }

    /// `invalidateContentDriftEmbeddings({ sourceId? })`: drops the vectors whose text changed
    /// since they were computed (a stamped text hash that no longer matches), on live,
    /// non-embed_skip pages in unarchived sources. Returns how many it dropped.
    pub fn invalidate_content_drift_embeddings(&self, options: &InvalidateOptions) -> Result<u64> {
        let now_us = self.env.now_micros();
        self.write(|tx| {
            let mut sources = HashMap::new();
            let mut count = 0;
            for ctx in page_contexts(&*tx)? {
                if !ctx.live()
                    || ctx.embed_skip()
                    || options
                        .source_id
                        .as_deref()
                        .is_some_and(|id| id != ctx.page.source_id)
                    || !source_live(&*tx, &mut sources, &ctx.page.source_id)?
                {
                    continue;
                }
                for mut chunk in ctx.chunks {
                    let drifted = chunk.embed.has_vector()
                        && chunk
                            .embed
                            .text_hash
                            .as_deref()
                            .is_some_and(|h| h != text_hash(&chunk.chunk_text));
                    if !drifted {
                        continue;
                    }
                    let embed = EmbedState {
                        dims: 0,
                        embedded_at_us: None,
                        text_hash: None,
                        pending_since_us: Some(now_us),
                        ..chunk.embed.clone()
                    };
                    drop_vector(tx, &mut chunk, embed)?;
                    count += 1;
                }
            }
            Ok(count)
        })
    }

    /// `getEmbeddingsByChunkIds(ids)`: `[{ id, embedding }]` for the chunks that have a vector and
    /// are served (sealed page, visible chunk).
    pub fn get_embeddings_by_chunk_ids(&self, ids: &[u64]) -> Result<Vec<Value>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashSet<u64> = ids.iter().copied().collect();
        let read = self.read()?;
        let mut out = Vec::new();
        for ctx in page_contexts(&*read)? {
            if !ctx.sealed() {
                continue;
            }
            for chunk in ctx.visible() {
                if !wanted.contains(&chunk.id) || !chunk.embed.has_vector() {
                    continue;
                }
                if let Some(stored) = read_chunk_vector(&*read, chunk.page_id, chunk.chunk_index)? {
                    out.push(json!({ "id": chunk.id, "embedding": vector_value(&stored.vector) }));
                }
            }
        }
        Ok(out)
    }

    /// `cosinesByChunkIds(ids, query)`: `[{ id, cosine }]`, an exact scan of the chunks that
    /// `getEmbeddingsByChunkIds` reads (served, with a vector). The text-space cosine of the stored
    /// vector and `query`, as `cosineByChunkIdsStatement` computes it: 0 for another dimension
    /// count or a zero vector or query; an id that is no served chunk with a vector has no row.
    /// A query pgvector cannot parse (empty, NaN, infinite) refuses before any row is read.
    pub fn cosines_by_chunk_ids(&self, ids: &[u64], query: &[f64]) -> Result<Vec<Value>> {
        let query = check_query(query)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let query_norm_sq = norm_sq(&query);
        let wanted: HashSet<u64> = ids.iter().copied().collect();
        let read = self.read()?;
        let mut out = Vec::new();
        for ctx in page_contexts(&*read)? {
            if !ctx.sealed() {
                continue;
            }
            for chunk in ctx.visible() {
                if !wanted.contains(&chunk.id) || !chunk.embed.has_vector() {
                    continue;
                }
                if let Some(stored) = read_chunk_vector(&*read, chunk.page_id, chunk.chunk_index)? {
                    let cosine = served_cosine(&query, query_norm_sq, &stored.vector);
                    out.push(json!({ "id": chunk.id, "cosine": cosine }));
                }
            }
        }
        Ok(out)
    }

    /// `getChunksWithEmbeddings(slug, { sourceId?, includeUnsealed? })`: the chunks of every page
    /// with this exact slug (in `sourceId`, or in any source), with their vectors, ordered by
    /// chunk index (then page id). The TypeScript member refuses a result that spans two pages.
    pub fn get_chunks_with_embeddings(
        &self,
        slug: &str,
        options: &ChunksWithEmbeddingsOptions,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let sources: Vec<String> = match options.source_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => vec![id.to_string()],
            None => crate::sources::all_sources(&*read)?
                .into_iter()
                .map(|s| s.id)
                .collect(),
        };
        let mut rows = Vec::new();
        for source in sources {
            let Some(page) = read_page(&*read, &source, slug)? else {
                continue;
            };
            let sealed =
                page.text_projection_revision.as_deref() == Some(page.knowledge_revision.as_str());
            if !options.include_unsealed && !sealed {
                continue;
            }
            for row in chunk_rows(&*read, &page, true, options.include_unsealed)? {
                rows.push(row);
            }
        }
        let key = |row: &Value| {
            (
                row["chunk_index"].as_u64().unwrap_or(0),
                row["page_id"].as_u64().unwrap_or(0),
            )
        };
        rows.sort_by_key(key);
        Ok(rows)
    }

    /// `readEmbeddingStateCounts({ mode, sourceIds?, purgeWindowHours })`.
    pub fn read_embedding_state_counts(&self, options: &StateCountOptions) -> Result<Value> {
        let read = self.read()?;
        let now_us = self.env.now_micros();
        let ops = options.mode == "ops";
        let pages: Vec<PageCtx> = page_contexts(&*read)?
            .into_iter()
            .filter(|ctx| in_sources(&options.source_ids, &ctx.page.source_id))
            .collect();
        let mut counts: BTreeMap<&str, u64> = BTreeMap::new();
        let mut unstamped = 0u64;
        let mut eligible = 0u64;
        let mut overdue = 0u64;
        for ctx in &pages {
            for chunk in ctx.live_body() {
                if ops && chunk.embed.has_vector() {
                    continue;
                }
                let state = ctx.chunk_state(chunk);
                match state {
                    "pending" if chunk.embed.pending_since_us.is_none() => unstamped += 1,
                    "embedded" if !ctx.embed_skip() => eligible += 1,
                    _ => {}
                }
                if ops && (state == "quarantined" || state == "deleted_page_chunks") {
                    continue;
                }
                if state == "deleted_page_chunks" && ctx.overdue(now_us, options.purge_window_hours)
                {
                    overdue += 1;
                }
                *counts.entry(state).or_default() += 1;
            }
        }
        let skip_pages: Vec<&PageCtx> = pages
            .iter()
            .filter(|ctx| ctx.embed_skip() && ctx.live() && !ctx.quarantined())
            .collect();
        let marker_bytes: i64 = skip_pages.iter().filter_map(|ctx| ctx.marker_bytes()).sum();
        let mut out = Map::new();
        out.insert("active_column".into(), json!("embedding"));
        if ops {
            out.insert("covering_index".into(), json!(COVERING_INDEX));
            counts.insert(
                "quarantined",
                pages
                    .iter()
                    .filter(|ctx| ctx.live() && ctx.quarantined())
                    .map(|ctx| ctx.chunks.len().max(1) as u64)
                    .sum(),
            );
            let deleted: Vec<&PageCtx> = pages.iter().filter(|ctx| !ctx.live()).collect();
            counts.insert(
                "deleted_page_chunks",
                deleted.iter().map(|ctx| ctx.chunks.len() as u64).sum(),
            );
            overdue = deleted
                .iter()
                .filter(|ctx| ctx.overdue(now_us, options.purge_window_hours))
                .map(|ctx| ctx.chunks.len() as u64)
                .sum();
            // PGLite reports the planner's row estimate here; this store counts.
            counts.insert(
                "embedded",
                pages
                    .iter()
                    .filter(|ctx| ctx.live() && !ctx.quarantined())
                    .map(|ctx| ctx.chunks.iter().filter(|c| c.embed.has_vector()).count() as u64)
                    .sum(),
            );
            counts.entry("pending").or_default();
            counts.entry("keyword_only").or_default();
        } else {
            out.insert("covering_index".into(), Value::Null);
            for ctx in pages
                .iter()
                .filter(|ctx| ctx.live() && ctx.chunks.is_empty())
            {
                *counts.entry(ctx.chunkless_state()).or_default() += 1;
            }
            for state in STATES {
                counts.entry(state).or_default();
            }
        }
        out.insert("embed_skip_pages".into(), json!(skip_pages.len()));
        out.insert("embed_skip_marker_bytes".into(), json!(marker_bytes));
        out.insert("unstamped_pending".into(), json!(unstamped));
        // Chunk records keep no creation time.
        out.insert("unstamped_created_at_min".into(), Value::Null);
        let mut ordered = Map::new();
        for state in STATES {
            if let Some(n) = counts.get(state) {
                ordered.insert(state.into(), json!(n));
            }
        }
        if ops {
            out.insert("basis".into(), json!("estimated"));
            out.insert("counts".into(), Value::Object(ordered));
            out.insert("omitted".into(), json!(["empty", "chunkless_healable"]));
            out.insert("eligible_embedded".into(), Value::Null);
        } else {
            out.insert("basis".into(), json!("exact"));
            out.insert("counts".into(), Value::Object(ordered));
            out.insert("omitted".into(), json!([]));
            out.insert("eligible_embedded".into(), json!(eligible));
        }
        out.insert("deleted_overdue".into(), json!(overdue));
        Ok(Value::Object(out))
    }

    /// `listEmbeddingStateRows({ sourceIds?, slugs?, states, limit, purgeWindowHours })`: one row
    /// per (page, state) of the page's visible chunks, plus one row per live page with no chunk
    /// record, ordered by (state, source_id, slug) and cut at `limit`.
    pub fn list_embedding_state_rows(&self, options: &StateRowOptions) -> Result<Vec<Value>> {
        let read = self.read()?;
        let now_us = self.env.now_micros();
        let wanted = |state: &str| options.states.iter().any(|s| s == state);
        let mut rows: Vec<(&'static str, String, String, Value)> = Vec::new();
        let contexts = page_contexts(&*read)?;
        for ctx in &contexts {
            if !in_sources(&options.source_ids, &ctx.page.source_id)
                || options
                    .slugs
                    .as_ref()
                    .is_some_and(|slugs| !slugs.contains(&ctx.page.slug))
            {
                continue;
            }
            let row = |state: &'static str, chunks: u64, bytes: u64, deleted: bool| {
                json!({
                    "slug": ctx.page.slug,
                    "source_id": ctx.page.source_id,
                    "state": state,
                    "chunks": chunks,
                    "bytes": bytes,
                    "embed_skip_reason": ctx.marker_reason(EMBED_SKIP),
                    "marker_bytes": ctx.marker_bytes(),
                    "quarantine_reason": ctx.marker_reason(QUARANTINE),
                    "deleted_at": if deleted { ctx.page.deleted_at_us.map(crate::env::iso) } else { None },
                    "overdue": deleted && ctx.overdue(now_us, options.purge_window_hours),
                })
            };
            let mut by_state: BTreeMap<&'static str, (u64, u64)> = BTreeMap::new();
            for chunk in ctx.live_body() {
                let entry = by_state.entry(ctx.chunk_state(chunk)).or_default();
                entry.0 += 1;
                entry.1 += chunk.chunk_text.len() as u64;
            }
            for (state, (chunks, bytes)) in by_state {
                if wanted(state) {
                    rows.push((
                        state,
                        ctx.page.source_id.clone(),
                        ctx.page.slug.clone(),
                        row(state, chunks, bytes, true),
                    ));
                }
            }
            if ctx.live() && ctx.chunks.is_empty() {
                let state = ctx.chunkless_state();
                if wanted(state) {
                    let bytes = ctx.page.compiled_truth.as_deref().map_or(0, str::len)
                        + ctx.page.timeline.as_deref().map_or(0, str::len);
                    rows.push((
                        state,
                        ctx.page.source_id.clone(),
                        ctx.page.slug.clone(),
                        row(state, 0, bytes as u64, false),
                    ));
                }
            }
        }
        rows.sort_by(|a, b| {
            a.0.cmp(b.0)
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| a.2.cmp(&b.2))
        });
        let limit = options
            .limit
            .map_or(usize::MAX, |n| usize::try_from(n).unwrap_or(usize::MAX));
        Ok(rows.into_iter().take(limit).map(|r| r.3).collect())
    }

    /// `updateTakeEmbeddings(rows)`: stores each vector on its take while the take is active and
    /// its claim is still `claim` (a vector computed from an edited claim is dropped). Returns how
    /// many takes it updated.
    pub fn update_take_embeddings(&self, rows: &[TakeEmbeddingInput]) -> Result<u64> {
        if rows.is_empty() {
            return Ok(0);
        }
        let now_us = self.env.now_micros();
        self.write(|tx| {
            let dims = crate::chunks::embedding_dimensions(&*tx)?;
            let mut seen = HashSet::new();
            let mut vectors = Vec::with_capacity(rows.len());
            for row in rows {
                if !seen.insert(row.take_id) {
                    return Err(StoreError::invalid(format!(
                        "duplicate take_id in embedding batch: {}",
                        row.take_id
                    )));
                }
                let vector: Vec<f32> = row.embedding.iter().map(|v| *v as f32).collect();
                if vector.is_empty()
                    || vector.iter().any(|v| !v.is_finite())
                    || row.model.is_empty()
                {
                    return Err(StoreError::invalid(format!(
                        "invalid embedding for take_id={}",
                        row.take_id
                    )));
                }
                if vector.len() != dims {
                    return Err(StoreError::invalid(format!(
                        "expected {dims} dimensions, not {}",
                        vector.len()
                    )));
                }
                vectors.push(vector);
            }
            let mut count = 0;
            for (row, vector) in rows.iter().zip(vectors) {
                let Some(mut take) = read_take(&*tx, row.take_id)? else {
                    continue;
                };
                if !take.active || take.claim != row.claim {
                    continue;
                }
                put_take_vector(tx, take.id, take.claim_rev, &row.model, now_us, &vector)?;
                take.updated_at_us = now_us;
                write_take(tx, &take)?;
                count += 1;
            }
            Ok(count)
        })
    }

    /// `getTakeEmbeddings(ids)`: `[{ id, embedding }]` for the takes with a current vector.
    pub fn get_take_embeddings(&self, ids: &[u64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        let mut done = HashSet::new();
        for id in ids {
            if !done.insert(*id) {
                continue;
            }
            let Some(take) = read_take(&*read, *id)? else {
                continue;
            };
            if let Some(stored) = current_take_vector(&*read, &take)? {
                out.push(json!({ "id": take.id, "embedding": vector_value(&stored.vector) }));
            }
        }
        Ok(out)
    }

    fn stale_takes(&self, options: &StaleTakeOptions) -> Result<Vec<(TakeRecord, String)>> {
        let read = self.read()?;
        let mut pages: HashMap<u64, Option<PageRecord>> = HashMap::new();
        let mut sources = HashMap::new();
        let mut out = Vec::new();
        for take in all_takes(&*read)? {
            if !take.active {
                continue;
            }
            if let std::collections::hash_map::Entry::Vacant(slot) = pages.entry(take.page_id) {
                slot.insert(crate::pages::read_page_by_id(&*read, take.page_id)?);
            }
            let Some(page) = pages.get(&take.page_id).and_then(Option::as_ref) else {
                continue;
            };
            if page.deleted_at_us.is_some()
                || options
                    .source_id
                    .as_deref()
                    .is_some_and(|id| id != page.source_id)
                || !source_live(&*read, &mut sources, &page.source_id)?
            {
                continue;
            }
            let stale = match current_take_vector(&*read, &take)? {
                None => true,
                Some(stored) => {
                    options.model.as_deref().is_some_and(|m| m != stored.model)
                        || options
                            .dims
                            .is_some_and(|d| d as usize != stored.vector.len())
                }
            };
            if stale {
                out.push((take, page.slug.clone()));
            }
        }
        Ok(out)
    }

    /// `countStaleTakes(opts?)`: active takes on live pages in unarchived sources with no vector
    /// for their current claim, or (when named) one from another model or width.
    pub fn count_stale_takes(&self, options: &StaleTakeOptions) -> Result<u64> {
        Ok(self.stale_takes(options)?.len() as u64)
    }

    /// `listStaleTakes(opts?)`: those takes as `{ take_id, page_slug, row_num, claim }`, by id.
    pub fn list_stale_takes(&self, options: &StaleTakeOptions) -> Result<Vec<Value>> {
        Ok(self
            .stale_takes(options)?
            .into_iter()
            .take(100_000)
            .map(|(take, slug)| {
                json!({ "take_id": take.id, "page_slug": slug, "row_num": take.row_num, "claim": take.claim })
            })
            .collect())
    }
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
