//! Chunks and the keyword index.
//!
//! A page's chunks are records `K page_id chunk_index`. Every term of a chunk has a posting
//! `T term NUL page_id chunk_index -> term frequency`, written in the same transaction as the
//! chunk, so the index can never name a chunk that is not there. Replacing a page's chunks
//! removes the old postings first. Index-wide counts (chunks, total length) live under the meta
//! key `chunk_stats`; keyword search reads them for BM25.

use crate::error::{
    INVALID_ARGUMENT, INVALID_STATE, PAGE_NOT_FOUND, REVISION_CONFLICT, Result, StoreError,
};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, ReadScope, read_page, write_page};
use crate::sources::DEFAULT_SOURCE;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

pub(crate) const NEXT_CHUNK_ID: &str = "next_chunk_id";
const STATS: &str = "chunk_stats";
const STATS_CHUNKS: &str = "chunk_stats/chunks";
const STATS_LENGTH: &str = "chunk_stats/total_length";
/// The longest term the index keeps, in bytes.
const MAX_TERM_BYTES: usize = 64;
/// The size a chunk aims for, in characters.
pub const CHUNK_TARGET_CHARS: usize = 1500;

/// ChunkInput fields that are kept on the chunk and returned by `get_chunks`. `model` is the label
/// of the chunk's vector (the embedding model PGLite records); the vector itself is a record of the
/// embeddings family (`crate::embeddings`).
const META_KEYS: &[&str] = &[
    "language",
    "symbol_name",
    "symbol_type",
    "start_line",
    "end_line",
    "parent_symbol_path",
    "doc_comment",
    "symbol_name_qualified",
    "projected_byte_start",
    "projected_byte_end",
    "token_count",
    "model",
];

/// `ChunkInput` of `src/core/types.ts`. `embedding` (an array of numbers, or null) and
/// `embedding_input_hash` arrive in `rest`; `replace_chunks_at` stores the vector. Any other
/// `embedding*` field is ignored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ChunkInput {
    pub chunk_index: u32,
    pub chunk_text: String,
    pub chunk_source: Option<String>,
    pub modality: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// What is stored for a chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ChunkRecord {
    pub id: u64,
    pub page_id: u64,
    pub chunk_index: u32,
    pub chunk_text: String,
    pub chunk_source: String,
    pub modality: String,
    /// Number of index terms in `chunk_text`.
    pub length: u32,
    #[serde(default)]
    pub meta: Map<String, Value>,
    /// Set on a chunk of a segmented body (`append_segment_chunks`); absent on an inline chunk.
    /// Records written before this field decode as inline chunks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment: Option<SegmentPlace>,
    /// The embedding bookkeeping of the chunk (PGLite's `embedded_at`, `embedded_text_hash`,
    /// `embedding_input_hash`, `embedding_pending_since` and the vector's width). Records written
    /// before this field decode as a chunk with no vector.
    #[serde(default, skip_serializing_if = "EmbedState::is_empty")]
    pub embed: EmbedState,
}

/// What a chunk record keeps about its vector. The vector itself is the embeddings family's record
/// `B 'c' page_id chunk_index`; `dims` is 0 exactly when that record is absent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct EmbedState {
    /// Width of the stored vector; 0 when the chunk has none.
    #[serde(skip_serializing_if = "is_zero")]
    pub dims: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedded_at_us: Option<i64>,
    /// sha256 hex of the chunk text the vector was computed from (PGLite keeps md5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_hash: Option<String>,
    /// When the chunk lost (or was written without) its vector.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_since_us: Option<i64>,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl EmbedState {
    fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    pub(crate) fn has_vector(&self) -> bool {
        self.dims > 0
    }
}

impl ChunkRecord {
    /// The chunk as `getChunks` returns it. `vector` is the stored vector when the caller asked for
    /// it; `embedding` is null otherwise.
    pub(crate) fn to_chunk(&self, vector: Option<&[f32]>) -> Value {
        let mut v = json!({
            "id": self.id,
            "page_id": self.page_id,
            "chunk_index": self.chunk_index,
            "chunk_text": self.chunk_text,
            "chunk_source": self.chunk_source,
            "modality": self.modality,
            "embedding": vector.map_or(Value::Null, |values| json!(values)),
            "model": self.meta.get("model").cloned().unwrap_or_else(|| json!("")),
            "token_count": self.meta.get("token_count").cloned().unwrap_or(Value::Null),
            "embedded_at": self.embed.embedded_at_us.map_or(Value::Null, |us| json!(crate::env::iso(us))),
            "embedding_is_null": !self.embed.has_vector(),
        });
        for key in META_KEYS {
            if let Some(value) = self.meta.get(*key) {
                v[*key] = value.clone();
            }
        }
        v
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct ChunkStats {
    pub chunks: u64,
    pub total_length: u64,
}

/// The chunk count and total length: two counter records (`chunk_stats/chunks`,
/// `chunk_stats/total_length`) that every write adds to without reading them, so concurrent
/// chunk writes never conflict on the stats.
pub(crate) fn read_stats(read: &dyn KvRead) -> Result<ChunkStats> {
    let chunks = crate::kv::read_i64(read, &keys::meta(STATS_CHUNKS))?;
    let total = crate::kv::read_i64(read, &keys::meta(STATS_LENGTH))?;
    Ok(ChunkStats {
        chunks: chunks.max(0) as u64,
        total_length: total.max(0) as u64,
    })
}

/// A change to the chunk stats, written with `add_stats`.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct StatsDelta {
    pub chunks: i64,
    pub total_length: i64,
}

/// Format 1 kept the chunk stats as one JSON `chunk_stats` record; the format-2 upgrade
/// (`Store::open_kv`) adds it to the counter records and deletes it.
pub(crate) fn fold_format_1_stats(tx: &mut dyn KvWrite) -> Result<()> {
    if let Some(legacy) = get_json::<ChunkStats>(&*tx, &keys::meta(STATS))? {
        add_stats(
            tx,
            &StatsDelta {
                chunks: legacy.chunks as i64,
                total_length: legacy.total_length as i64,
            },
        )?;
        tx.delete(&keys::meta(STATS))?;
    }
    Ok(())
}

fn add_stats(tx: &mut dyn KvWrite, delta: &StatsDelta) -> Result<()> {
    if delta.chunks != 0 {
        tx.add_i64(&keys::meta(STATS_CHUNKS), delta.chunks)?;
    }
    if delta.total_length != 0 {
        tx.add_i64(&keys::meta(STATS_LENGTH), delta.total_length)?;
    }
    Ok(())
}

fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'
        | '\u{ac00}'..='\u{d7af}' | '\u{f900}'..='\u{faff}')
}

/// Lower-cased alphanumeric words; each CJK character is its own term. No stemming and no
/// stop-word removal here (search drops stop words from the query only).
pub fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut Vec<String>| {
        if !word.is_empty() {
            let mut term = std::mem::take(word);
            if term.len() > MAX_TERM_BYTES {
                let mut cut = MAX_TERM_BYTES;
                while !term.is_char_boundary(cut) {
                    cut -= 1;
                }
                term.truncate(cut);
            }
            out.push(term);
        }
    };
    for c in text.chars() {
        if is_cjk(c) {
            flush(&mut word, &mut out);
            out.push(c.to_string());
        } else if c.is_alphanumeric() || c == '_' {
            word.extend(c.to_lowercase());
        } else {
            flush(&mut word, &mut out);
        }
    }
    flush(&mut word, &mut out);
    out
}

fn term_frequencies(text: &str) -> (BTreeMap<String, u32>, u32) {
    let mut tf = BTreeMap::new();
    let mut total = 0u32;
    for term in tokenize(text) {
        *tf.entry(term).or_insert(0) += 1;
        total += 1;
    }
    (tf, total)
}

/// Splits a body into chunks of about `CHUNK_TARGET_CHARS`: paragraphs are packed together, a
/// paragraph that is too long is cut at whitespace. This is simpler than the TypeScript
/// chunker; callers that need its exact chunks pass them in.
pub fn chunk_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let push_piece = |piece: &str, current: &mut String, chunks: &mut Vec<String>| {
        let joined = current.chars().count() + piece.chars().count() + 2;
        if !current.is_empty() && joined > CHUNK_TARGET_CHARS {
            chunks.push(std::mem::take(current));
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(piece);
    };
    for paragraph in text.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        if paragraph.chars().count() <= CHUNK_TARGET_CHARS {
            push_piece(paragraph, &mut current, &mut chunks);
            continue;
        }
        // A long paragraph is cut at whitespace into pieces of at most the target size.
        let mut piece = String::new();
        for word in paragraph.split_inclusive(char::is_whitespace) {
            if !piece.is_empty()
                && piece.chars().count() + word.chars().count() > CHUNK_TARGET_CHARS
            {
                push_piece(piece.trim(), &mut current, &mut chunks);
                piece.clear();
            }
            piece.push_str(word);
        }
        if !piece.trim().is_empty() {
            push_piece(piece.trim(), &mut current, &mut chunks);
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// The chunks `put_page` makes when asked for `"auto"`: the body, then the timeline.
pub(crate) fn auto_chunks(page: &PageRecord) -> Vec<ChunkInput> {
    let mut out = Vec::new();
    for (source, text) in [
        ("compiled_truth", &page.compiled_truth),
        ("timeline", &page.timeline),
    ] {
        for piece in chunk_text(text) {
            out.push(ChunkInput {
                chunk_index: out.len() as u32,
                chunk_text: piece,
                chunk_source: Some(source.into()),
                ..ChunkInput::default()
            });
        }
    }
    out
}

pub(crate) fn read_chunks(read: &dyn KvRead, page_id: u64) -> Result<Vec<ChunkRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &keys::chunk_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<ChunkRecord>(v) {
            Ok(record) => out.push(record),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// Removes every chunk of a page and its postings, updates the stats, and tells the families that
/// keep records under a chunk (`cascade::remove_chunk_rows`).
pub(crate) fn clear_chunks(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    let removed: Vec<u64> = drop_chunks(tx, page_id)?.iter().map(|c| c.id).collect();
    if removed.is_empty() {
        return Ok(());
    }
    crate::cascade::remove_chunk_rows(tx, page_id, &removed)
}

/// The shadow follow (`seed/follow.rs`): removes the chunk of `page_id` at `chunk_index` with its
/// postings and vector. `cascade` also calls the chunk-delete hook, which removes the code edges
/// that end on the chunk; a chunk that is replaced by a row of the same index keeps them. `false`
/// when there is no such chunk.
pub(crate) fn remove_chunk(
    tx: &mut dyn KvWrite,
    page_id: u64,
    chunk_index: u32,
    cascade: bool,
) -> Result<bool> {
    let Some(chunk) = get_json::<ChunkRecord>(&*tx, &keys::chunk(page_id, chunk_index))? else {
        return Ok(false);
    };
    let mut stats = StatsDelta::default();
    remove_chunk_record(tx, &chunk, &mut stats)?;
    add_stats(tx, &stats)?;
    if cascade {
        crate::cascade::remove_chunk_rows(tx, page_id, &[chunk.id])?;
    }
    Ok(true)
}

/// Removes every chunk of a page and its postings and updates the stats; returns what it removed.
/// It does not call the chunk-delete hook: `replace_chunks` keeps some of these ids.
fn drop_chunks(tx: &mut dyn KvWrite, page_id: u64) -> Result<Vec<ChunkRecord>> {
    let old = read_chunks(&*tx, page_id)?;
    drop_chunk_records(tx, &old)?;
    Ok(old)
}

/// Deletes the given chunk records (see `remove_chunk_record`) and stores the stats once.
fn drop_chunk_records(tx: &mut dyn KvWrite, records: &[ChunkRecord]) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }
    let mut stats = StatsDelta::default();
    for chunk in records {
        remove_chunk_record(tx, chunk, &mut stats)?;
    }
    add_stats(tx, &stats)
}

/// `chunk_source` of a write, `compiled_truth` when absent; any other value than the four PGLite
/// allows is refused.
fn checked_source(input: &ChunkInput) -> Result<String> {
    let source = input
        .chunk_source
        .clone()
        .unwrap_or_else(|| "compiled_truth".into());
    if !matches!(
        source.as_str(),
        "compiled_truth" | "timeline" | "fenced_code" | "image_asset"
    ) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!(
                "chunk_source \"{source}\" is not one of compiled_truth, timeline, fenced_code, image_asset"
            ),
        ));
    }
    Ok(source)
}

/// The non-null `META_KEYS` fields of a write.
fn kept_meta(input: &ChunkInput) -> Map<String, Value> {
    input
        .rest
        .iter()
        .filter(|(k, v)| META_KEYS.contains(&k.as_str()) && !v.is_null())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Writes a chunk record, its postings when the chunk is visible at `view_generation`, and its
/// share of the stats (the caller stores them).
fn write_chunk(
    tx: &mut dyn KvWrite,
    record: &ChunkRecord,
    view_generation: u64,
    stats: &mut StatsDelta,
) -> Result<()> {
    // `chunk_search_vector_trigger` builds the vector before the row is stored and its error aborts the statement.
    crate::keyword::check_chunk_vector(record)?;
    put_json(tx, &keys::chunk(record.page_id, record.chunk_index), record)?;
    if record.visible_at(view_generation) {
        put_postings(tx, record)?;
    }
    stats.chunks += 1;
    stats.total_length += i64::from(record.length);
    Ok(())
}

/// The shadow seed (`seed.rs`): stores `record`, a chunk copied from another engine with its own
/// id, as [`write_chunk`] does (its postings when the page's segment view shows it, its share of
/// the stats), then its vector when it has one (`model`, `embedded_at_us`, values). `length` is
/// computed here. The caller checked the page and that the index is free.
pub(crate) fn seed_chunk(
    tx: &mut dyn KvWrite,
    mut record: ChunkRecord,
    vector: Option<(&str, i64, &[f32])>,
) -> Result<()> {
    record.length = term_frequencies(&record.chunk_text).1;
    let view_generation = segment_view_generation(&*tx, record.page_id)?;
    let mut stats = StatsDelta::default();
    write_chunk(tx, &record, view_generation, &mut stats)?;
    add_stats(tx, &stats)?;
    if let Some((model, embedded_at_us, values)) = vector {
        crate::embeddings::put_chunk_vector(
            tx,
            record.page_id,
            record.chunk_index,
            model,
            embedded_at_us,
            values,
        )?;
    }
    Ok(())
}

fn put_postings(tx: &mut dyn KvWrite, record: &ChunkRecord) -> Result<()> {
    for (term, count) in &term_frequencies(&record.chunk_text).0 {
        tx.put(
            &keys::posting(term, record.page_id, record.chunk_index),
            &count.to_be_bytes(),
        )?;
    }
    Ok(())
}

fn delete_postings(tx: &mut dyn KvWrite, record: &ChunkRecord) -> Result<()> {
    for term in term_frequencies(&record.chunk_text).0.keys() {
        tx.delete(&keys::posting(term, record.page_id, record.chunk_index))?;
    }
    Ok(())
}

/// Deletes a chunk record and its postings (deleting a posting that was never written is a
/// no-op) and takes its share off the stats (the caller stores them). It does not call the
/// chunk-delete hook.
fn remove_chunk_record(
    tx: &mut dyn KvWrite,
    chunk: &ChunkRecord,
    stats: &mut StatsDelta,
) -> Result<()> {
    delete_postings(tx, chunk)?;
    tx.delete(&keys::chunk(chunk.page_id, chunk.chunk_index))?;
    crate::embeddings::remove_chunk_vector(tx, chunk.page_id, chunk.chunk_index)?;
    stats.chunks -= 1;
    stats.total_length -= i64::from(chunk.length);
    Ok(())
}

/// Replaces a page's chunks with `chunks` (an empty list removes them all), at the page's
/// `updated_at` (see `replace_chunks_at`). `certified` is the safe-fence flag of `replace_chunks_at`.
pub(crate) fn replace_chunks(
    tx: &mut dyn KvWrite,
    page: &mut PageRecord,
    chunks: &[ChunkInput],
    seal: bool,
    certified: bool,
    merge: bool,
) -> Result<()> {
    let now_us = page.updated_at_us;
    replace_chunks_at(tx, page, chunks, seal, certified, merge, false, now_us)
}

/// The vector a chunk write carries: `None` for an absent or null `embedding`. A vector must be
/// `dims` finite numbers wide.
fn input_vector(input: &ChunkInput, dims: usize) -> Result<Option<Vec<f32>>> {
    let values = match input.rest.get("embedding") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(values)) => values,
        Some(_) => {
            return Err(StoreError::invalid(
                "a chunk embedding must be an array of numbers",
            ));
        }
    };
    let vector: Vec<f32> = values
        .iter()
        .map(|v| v.as_f64().map(|n| n as f32).filter(|n| n.is_finite()))
        .collect::<Option<_>>()
        .ok_or_else(|| StoreError::invalid("a chunk embedding must hold finite numbers"))?;
    if vector.len() != dims {
        return Err(StoreError::invalid(format!(
            "expected {dims} dimensions, not {}",
            vector.len()
        )));
    }
    Ok(Some(vector))
}

/// The configured vector width (`embedding_dimensions`, 1536 when unset).
pub(crate) fn embedding_dimensions(read: &dyn KvRead) -> Result<usize> {
    Ok(crate::config::read_config(read, "embedding_dimensions")?
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1536))
}

/// Replaces a page's chunks with `chunks` (an empty list removes them all). A chunk that keeps
/// its index keeps its id; the chunk-delete hook gets the ids of the indexes that are gone. When
/// `seal` is set the page's `text_projection_revision` becomes its `knowledge_revision`: the
/// chunks now describe the current text. A `certified` seal (the caller sends chunks it ran
/// through the protected-fence sanitizer: `sealChunks`) also stamps the page `chunker_version`
/// at `SAFE_FENCE_CHUNKER_VERSION` (PGLite's `sealChunkerVersion`). A write that is not certified
/// (a plain upsert, or the store's own raw split of a body that no sanitizer read) stamps it -1
/// when it changes what the page holds or the page is below the fence (`chunkWriteInvalidations`),
/// so an explicit certified seal is the only thing that makes chunks safe.
///
/// Vectors follow PGLite's upsert. A chunk written fresh (`merge` false, or a new index) takes
/// the write's vector, or none and a pending stamp of `now_us`. On a merge, a chunk whose text
/// changed takes the write's vector or loses its own; a chunk whose text did not change keeps its
/// vector unless it had none or the write carries one newer than it (`now_us` after its
/// `embedded_at`). The `model` label follows the vector that wins.
///
/// With `keep_unlisted` only the indexes in `chunks` are written: every other chunk of the page
/// stays as it was (PGLite's `upsertChunks` with `sealChunkerVersion`, whose caller deleted the
/// rows it replaces and kept the rest).
#[allow(clippy::too_many_arguments)]
pub(crate) fn replace_chunks_at(
    tx: &mut dyn KvWrite,
    page: &mut PageRecord,
    chunks: &[ChunkInput],
    seal: bool,
    certified: bool,
    merge: bool,
    keep_unlisted: bool,
    now_us: i64,
) -> Result<()> {
    // The last chunk given for an index wins.
    let mut by_index: BTreeMap<u32, &ChunkInput> = BTreeMap::new();
    for chunk in chunks {
        by_index.insert(chunk.chunk_index, chunk);
    }
    let previous: HashMap<u32, ChunkRecord> = read_chunks(&*tx, page.id)?
        .into_iter()
        .filter(|c| !keep_unlisted || by_index.contains_key(&c.chunk_index))
        .map(|c| (c.chunk_index, c))
        .collect();
    let mut old_vectors = HashMap::new();
    for old in previous.values().filter(|old| old.embed.has_vector()) {
        if let Some(stored) = crate::embeddings::read_chunk_vector(&*tx, page.id, old.chunk_index)?
        {
            old_vectors.insert(old.chunk_index, stored);
        }
    }
    if keep_unlisted {
        let listed: Vec<ChunkRecord> = previous.values().cloned().collect();
        drop_chunk_records(tx, &listed)?;
    } else {
        drop_chunks(tx, page.id)?;
    }
    // `chunkWriteInvalidations` runs on the stored rows before any move: a stored index the write leaves out changes
    // the page.
    let leaves_out = previous
        .values()
        .any(|old| !by_index.contains_key(&old.chunk_index));
    // The rows the write lands on: on a merge, embedded rows first follow their exact chunk to its new index.
    let placed = if merge {
        move_displaced_chunks(&previous, &mut old_vectors, chunks, &by_index)
    } else {
        previous
            .iter()
            .filter(|(index, _)| by_index.contains_key(index))
            .map(|(index, old)| (*index, old.clone()))
            .collect()
    };
    let kept_ids: HashSet<u64> = placed.values().map(|old| old.id).collect();
    let mut removed: Vec<u64> = previous
        .values()
        .filter(|old| !kept_ids.contains(&old.id))
        .map(|old| old.id)
        .collect();
    removed.sort_unstable();
    if !removed.is_empty() {
        crate::cascade::remove_chunk_rows(tx, page.id, &removed)?;
    }
    let dims = if by_index
        .values()
        .any(|c| c.rest.get("embedding").is_some_and(|v| !v.is_null()))
    {
        embedding_dimensions(&*tx)?
    } else {
        0
    };
    let mut stats = StatsDelta::default();
    let view_generation = segment_view_generation(&*tx, page.id)?;
    // `chunkWriteInvalidations`: a stored chunk the write leaves out (or an empty write that removes any) changes the page.
    let mut changes_chunks = leaves_out;
    for (index, input) in by_index {
        let source = checked_source(input)?;
        let text = stored_text(input);
        changes_chunks |= previous
            .get(&index)
            .is_none_or(|old| chunk_differs(old, input, &text, &source));
        let length = term_frequencies(&text).1;
        let new_vector = input_vector(input, dims)?;
        let old = placed.get(&index);
        let id = match old {
            Some(old) => old.id,
            None => next_chunk_id(tx)?,
        };
        let mut meta = kept_meta(input);
        let new_model = meta
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if new_vector.is_some() && new_model.is_empty() {
            return Err(StoreError::invalid(
                "Embedding model provenance is unknown. Supply an explicit chunk model or run gbrain migrate embeddings --status before an explicit migration.",
            ));
        }
        let merged = old.filter(|_| merge);
        let text_changed = merged.is_some_and(|old| old.chunk_text != text);
        // PGLite's incremental write: a chunk whose text did not change keeps the metadata the
        // new write leaves null (`COALESCE(new, old)`); `token_count` is the new write's and
        // `model` the label of the vector that wins. A chunk whose text changed takes the new
        // write's metadata outright.
        if let Some(old) = merged.filter(|_| !text_changed) {
            for (key, value) in &old.meta {
                if key != "token_count" && key != "model" && !meta.contains_key(key) {
                    meta.insert(key.clone(), value.clone());
                }
            }
        }
        let kept = merged.filter(|old| {
            !text_changed
                && old_vectors.contains_key(&old.chunk_index)
                && (new_vector.is_none() || old.embed.embedded_at_us.is_some_and(|at| now_us <= at))
        });
        let pending_since_us = match merged {
            None => new_vector.is_none().then_some(now_us),
            Some(_) if new_vector.is_some() => None,
            Some(old) if !old_vectors.contains_key(&old.chunk_index) => {
                Some(old.embed.pending_since_us.unwrap_or(now_us))
            }
            Some(_) if text_changed => Some(now_us),
            Some(old) => old.embed.pending_since_us,
        };
        let (vector, embed) = match kept {
            Some(old) => {
                let stored = old_vectors.remove(&old.chunk_index).expect("checked above");
                meta.insert("model".into(), Value::String(stored.model.clone()));
                let embed = EmbedState {
                    pending_since_us,
                    ..old.embed.clone()
                };
                (
                    Some((stored.model, stored.embedded_at_us, stored.vector)),
                    embed,
                )
            }
            None => match new_vector {
                Some(vector) => {
                    let embed = EmbedState {
                        dims: u32::try_from(vector.len())
                            .map_err(|_| StoreError::invalid("vector too long"))?,
                        embedded_at_us: Some(now_us),
                        text_hash: Some(crate::embeddings::text_hash(&text)),
                        input_hash: input
                            .rest
                            .get("embedding_input_hash")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        pending_since_us,
                    };
                    (Some((new_model, now_us, vector)), embed)
                }
                None => (
                    None,
                    EmbedState {
                        pending_since_us,
                        ..EmbedState::default()
                    },
                ),
            },
        };
        let record = ChunkRecord {
            id,
            page_id: page.id,
            chunk_index: index,
            chunk_text: text,
            chunk_source: source,
            modality: input.modality.clone().unwrap_or_else(|| "text".into()),
            length,
            meta,
            // PGLite's upsert (`ON CONFLICT (page_id, chunk_index) DO UPDATE`) leaves a row's
            // segment columns as they were.
            segment: old.and_then(|old| old.segment),
            embed,
        };
        write_chunk(tx, &record, view_generation, &mut stats)?;
        if let Some((model, embedded_at_us, vector)) = vector {
            crate::embeddings::put_chunk_vector(
                tx,
                page.id,
                index,
                &model,
                embedded_at_us,
                &vector,
            )?;
        }
    }
    add_stats(tx, &stats)?;
    if seal {
        // PGLite's seal (`upsertChunks` with `sealChunkerVersion`) stamps the safe fence version too.
        page.text_projection_revision = Some(page.knowledge_revision.clone());
        if certified {
            page.chunker_version = Some(SAFE_FENCE_CHUNKER_VERSION);
        } else if changes_chunks
            || page
                .chunker_version
                .is_some_and(|v| v < SAFE_FENCE_CHUNKER_VERSION)
        {
            // `UPDATE pages SET chunker_version = -1 WHERE NOT (chunker_version >= 4) OR <the chunks change>`: a page
            // that holds no version is not below the fence (NULL), so it takes the stamp only when the chunks change.
            // A write that does not seal made this check before it wrote (`fragment_write_invalidates`).
            page.chunker_version = Some(-1);
        }
        write_page(tx, page)?;
    }
    Ok(())
}

/// The text a chunk write stores (NUL bytes dropped).
fn stored_text(input: &ChunkInput) -> String {
    input.chunk_text.replace('\0', "")
}

/// `moveDisplacedChunksAndPrune` (`src/core/engine-sql/chunks.ts`): a merge write matches a stored row to the new set by
/// its exact chunk (source and text), not its index. A movable row (one with a vector whose text hash is its current
/// text: `movableChunkSql`) whose chunk the new set holds at another index, where that index does not already hold it,
/// moves there with its id, vector, metadata, timestamps and input provenance; a row the write leaves out or that sits
/// on a move target is dropped. Movable rows are taken in index order and the new indexes in the order the write first
/// names them, as the SQL's queue and `Map` do. Returns the rows by the index they land on; `old_vectors` is rekeyed.
fn move_displaced_chunks(
    previous: &HashMap<u32, ChunkRecord>,
    old_vectors: &mut HashMap<u32, crate::embeddings::StoredVector>,
    chunks: &[ChunkInput],
    by_index: &BTreeMap<u32, &ChunkInput>,
) -> HashMap<u32, ChunkRecord> {
    let key = |source: &str, text: &str| (source.to_string(), crate::embeddings::text_hash(text));
    let movable = |old: &ChunkRecord| {
        old.embed.has_vector()
            && old.embed.text_hash.as_deref()
                == Some(crate::embeddings::text_hash(&old.chunk_text).as_str())
    };
    let mut targets: Vec<(u32, u32)> = Vec::new();
    if previous.values().any(movable) {
        let mut order: Vec<u32> = Vec::new();
        for chunk in chunks {
            if !order.contains(&chunk.chunk_index) {
                order.push(chunk.chunk_index);
            }
        }
        let incoming: HashMap<u32, (String, String)> = by_index
            .iter()
            .map(|(index, input)| {
                let source = input.chunk_source.as_deref().unwrap_or("compiled_truth");
                (*index, key(source, &stored_text(input)))
            })
            .collect();
        let mut stored: Vec<&ChunkRecord> = previous.values().collect();
        stored.sort_unstable_by_key(|old| old.chunk_index);
        let mut candidates: HashMap<(String, String), VecDeque<u32>> = HashMap::new();
        for old in stored.iter().filter(|old| movable(old)) {
            let own = key(&old.chunk_source, &old.chunk_text);
            if incoming.get(&old.chunk_index) == Some(&own) {
                continue;
            }
            candidates
                .entry(own)
                .or_default()
                .push_back(old.chunk_index);
        }
        for index in order {
            let wanted = &incoming[&index];
            if previous
                .get(&index)
                .is_some_and(|old| key(&old.chunk_source, &old.chunk_text) == *wanted)
            {
                continue;
            }
            if let Some(from) = candidates
                .get_mut(wanted)
                .and_then(|queue| queue.pop_front())
            {
                targets.push((from, index));
            }
        }
    }
    let target_indexes: HashSet<u32> = targets.iter().map(|(_, to)| *to).collect();
    let moved_from: HashSet<u32> = targets.iter().map(|(from, _)| *from).collect();
    let mut placed: HashMap<u32, ChunkRecord> = previous
        .iter()
        .filter(|(index, _)| {
            !moved_from.contains(index)
                && by_index.contains_key(index)
                && !target_indexes.contains(index)
        })
        .map(|(index, old)| (*index, old.clone()))
        .collect();
    let mut vectors: HashMap<u32, crate::embeddings::StoredVector> = old_vectors
        .iter()
        .filter(|(index, _)| placed.contains_key(index))
        .map(|(index, v)| (*index, v.clone()))
        .collect();
    for (from, to) in targets {
        let mut row = previous[&from].clone();
        row.chunk_index = to;
        placed.insert(to, row);
        if let Some(vector) = old_vectors.get(&from) {
            let mut vector = vector.clone();
            vector.chunk_index = to;
            vectors.insert(to, vector);
        }
    }
    *old_vectors = vectors;
    placed
}

/// `SAFE_FENCE_CHUNKER_VERSION` (`src/core/search/safe-chunks.ts`): a page sealed at this version or later holds only
/// safely fenced chunks.
pub(crate) const SAFE_FENCE_CHUNKER_VERSION: i16 = 4;

/// The metadata columns `chunkWriteInvalidations` compares: an incoming NULL keeps the stored value, so only a given value
/// that differs counts.
const COMPARED_META: [&str; 8] = [
    "language",
    "symbol_name",
    "symbol_type",
    "start_line",
    "end_line",
    "parent_symbol_path",
    "doc_comment",
    "symbol_name_qualified",
];

/// Whether writing `input` over the stored `old` chunk (same index) changes it, as `chunkWriteInvalidations` reads it:
/// text, source, modality or any compared metadata column differs. `text` and `source` are the incoming values as stored.
fn chunk_differs(old: &ChunkRecord, input: &ChunkInput, text: &str, source: &str) -> bool {
    old.chunk_text != text
        || old.chunk_source != source
        || old.modality != input.modality.as_deref().unwrap_or("text")
        || COMPARED_META.iter().any(|key| {
            input
                .rest
                .get(*key)
                .is_some_and(|new| !new.is_null() && old.meta.get(*key) != Some(new))
        })
}

fn next_chunk_id(tx: &mut dyn KvWrite) -> Result<u64> {
    tx.allocate(&keys::meta(NEXT_CHUNK_ID), 1)
}

// ---------------------------------------------------------------------------------------------
// Segment chunks
// ---------------------------------------------------------------------------------------------
//
// Contract of the segment-chunk helper (the chunk rows of a segmented page body; PGLite's
// `content_chunks.occurrence_id`, `local_ordinal`, `raw_byte_start`, `raw_byte_end` and
// `body_generation` columns). Callers are the page-body family (stageSegmentChunks and the
// generation flip); every function runs inside the caller's write transaction and checks
// nothing about the page body itself: the caller has already decided the write is allowed.
//
// - A segment chunk is a normal chunk record (`K page_id chunk_index`) whose `segment` field is
//   set. An inline chunk (`segment` absent) is what `upsert_chunks` and `put_page` write; records
//   written before the field existed decode as inline chunks, so the format version is unchanged.
// - `append_segment_chunks(tx, page_id, generation, chunks)` writes the chunks at the indexes
//   after the page's highest existing `chunk_index` (staged, live and retired rows all count, as
//   PGLite's `COALESCE(MAX(chunk_index), -1) + 1`), in input order, and returns those indexes. It validates `chunk_source` as
//   `upsert_chunks` does, strips NUL from the text and keeps no vector.
// - Visibility follows PGLite's `chunkVisibleFilter`: an inline chunk is visible, a segment chunk
//   is visible when its `body_generation` is at or below the page's body generation. This file
//   keeps its own copy of that generation, the page's segment view (`publish_segment_chunks`),
//   because the page body lives in another family; the copy is 0 until the first publish. A page
//   body hook that reads the generation could replace the copy later.
// - Keyword postings exist only for visible chunks, so staged chunks are not searchable.
//   `count_chunks` counts every chunk record, staged and retired included, as PGLite's count does.
// - `publish_segment_chunks(tx, page_id, generation, offsets)` is called by the flip, in its
//   transaction: it records the page's new generation and the manifest `byte_start` of each live
//   occurrence, and writes or removes postings for the chunks whose visibility changed.
// - `get_chunks` returns the visible chunks in PGLite's document order: segment chunks whose
//   occurrence has a live offset by (byte_start, local_ordinal, chunk_index), then the rest by
//   (local_ordinal, inline last, chunk_index). The output has no segment fields, as PGLite's
//   `getChunks` columns have none. `visible_chunks` gives other families the same list.
// - `delete_chunks_matching(tx, page_id, pred)` removes the matching chunks and their postings,
//   updates the stats, and calls `cascade::remove_chunk_rows` once with the sorted ids of the
//   removed chunks (not at all when none match). `delete_occurrence_chunks` and
//   `delete_generation_chunks` are its two named forms; `count_chunks_matching` counts first,
//   for the flip's `retireMaxRows` bound.
// - `forget_segment_view(tx, page_id)` deletes the view; the page-body family calls it when a page
//   is deleted for good. `delete_chunks` keeps the view: the page and its generation remain.

const SEGMENT_VIEW: &str = "chunk_segment_view";

/// Where a chunk of a segmented body sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SegmentPlace {
    pub occurrence_id: u64,
    /// Order of the chunk inside its occurrence.
    pub local_ordinal: u32,
    /// Span relative to the occurrence's segment.
    pub raw_byte_start: u64,
    pub raw_byte_end: u64,
    /// The body generation the chunk was staged for.
    pub body_generation: u64,
}

/// `SegmentChunkInput` of `src/core/page-body/types.ts`: a `ChunkInput` without `chunk_index`
/// (any given is ignored) plus the place of the chunk in its occurrence.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SegmentChunkInput {
    #[serde(flatten)]
    pub chunk: ChunkInput,
    pub occurrence_id: u64,
    pub local_ordinal: u32,
    pub raw_byte_start: u64,
    pub raw_byte_end: u64,
}

/// A page's segment view: the body generation chunks are visible at, and the manifest
/// `byte_start` of each live occurrence (document order).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SegmentView {
    pub generation: u64,
    #[serde(default)]
    pub offsets: BTreeMap<u64, u64>,
}

fn segment_view_key(page_id: u64) -> Vec<u8> {
    keys::meta(&format!("{SEGMENT_VIEW}/{page_id}"))
}

pub(crate) fn read_segment_view(read: &dyn KvRead, page_id: u64) -> Result<SegmentView> {
    Ok(get_json(read, &segment_view_key(page_id))?.unwrap_or_default())
}

fn segment_view_generation(read: &dyn KvRead, page_id: u64) -> Result<u64> {
    Ok(read_segment_view(read, page_id)?.generation)
}

impl ChunkRecord {
    /// PGLite's `body_generation IS NULL OR body_generation <= page.body_generation`.
    pub(crate) fn visible_at(&self, generation: u64) -> bool {
        self.segment
            .is_none_or(|place| place.body_generation <= generation)
    }
}

/// True for a segmented shell page: its body columns are NULL (PGLite's `body_storage = 'segmented'`).
pub(crate) fn segmented(page: &PageRecord) -> bool {
    page.compiled_truth.is_null() && page.timeline.is_null()
}

/// `chunkGenerationFilter`: a chunk of the page's live body. An inline chunk belongs to a page that is not segmented; a
/// segmented chunk is at or below the page's generation and its occurrence has a live manifest row (the segment view
/// keeps one offset per live occurrence). A staged chunk, one of a retired occurrence and an inline chunk left on a
/// segmented page are not. `visible_at` is the looser `chunkVisibleFilter` (generation only) of the sealed reads.
pub(crate) fn in_live_body(chunk: &ChunkRecord, segmented_page: bool, view: &SegmentView) -> bool {
    match chunk.segment {
        None => !segmented_page,
        Some(place) => {
            place.body_generation <= view.generation
                && view.offsets.contains_key(&place.occurrence_id)
        }
    }
}

/// The page's visible chunks in document order (see the contract above).
pub(crate) fn visible_chunks(read: &dyn KvRead, page_id: u64) -> Result<Vec<ChunkRecord>> {
    ordered_chunks(read, page_id, None)
}

/// A chunk's place in `chunkDocumentOrder`: `(m.byte_start, cc.local_ordinal, cc.chunk_index)`, NULLs last.
pub(crate) type DocumentKey = (bool, u64, bool, u32, u32);

/// The page's chunks in document order, filtered by `chunkVisibleFilter` (`live_body` None) or by
/// `chunkGenerationFilter` (`live_body` Some(page is segmented)).
fn ordered_chunks(
    read: &dyn KvRead,
    page_id: u64,
    live_body: Option<bool>,
) -> Result<Vec<ChunkRecord>> {
    Ok(keyed_chunks(read, page_id, live_body)?
        .into_iter()
        .map(|(_, chunk)| chunk)
        .collect())
}

/// `ordered_chunks` with each chunk's `DocumentKey`, so a read over several pages can merge them in one document order.
pub(crate) fn keyed_chunks(
    read: &dyn KvRead,
    page_id: u64,
    live_body: Option<bool>,
) -> Result<Vec<(DocumentKey, ChunkRecord)>> {
    let view = read_segment_view(read, page_id)?;
    let mut chunks: Vec<(DocumentKey, ChunkRecord)> = read_chunks(read, page_id)?
        .into_iter()
        .filter(|c| match live_body {
            None => c.visible_at(view.generation),
            Some(segmented_page) => in_live_body(c, segmented_page, &view),
        })
        .map(|c| {
            let offset = c
                .segment
                .and_then(|place| view.offsets.get(&place.occurrence_id).copied());
            let ordinal = c.segment.map(|place| place.local_ordinal);
            let key = (
                offset.is_none(),
                offset.unwrap_or(0),
                ordinal.is_none(),
                ordinal.unwrap_or(0),
                c.chunk_index,
            );
            (key, c)
        })
        .collect();
    chunks.sort_by_key(|(key, _)| *key);
    Ok(chunks)
}

/// Writes segment chunks for `generation` after the page's highest chunk index and returns their
/// indexes in input order.
// The page-body family is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn append_segment_chunks(
    tx: &mut dyn KvWrite,
    page_id: u64,
    generation: u64,
    chunks: &[SegmentChunkInput],
) -> Result<Vec<u32>> {
    if chunks.is_empty() {
        return Ok(Vec::new());
    }
    let first = read_chunks(&*tx, page_id)?
        .iter()
        .map(|c| c.chunk_index + 1)
        .max()
        .unwrap_or(0);
    let view_generation = segment_view_generation(&*tx, page_id)?;
    let mut stats = StatsDelta::default();
    let mut indexes = Vec::with_capacity(chunks.len());
    for (offset, input) in chunks.iter().enumerate() {
        let index = u32::try_from(offset)
            .ok()
            .and_then(|offset| first.checked_add(offset))
            .ok_or_else(|| StoreError::invalid("chunk_index would pass the largest index"))?;
        let chunk = &input.chunk;
        let text = chunk.chunk_text.replace('\0', "");
        let record = ChunkRecord {
            id: next_chunk_id(tx)?,
            page_id,
            chunk_index: index,
            length: term_frequencies(&text).1,
            chunk_text: text,
            chunk_source: checked_source(chunk)?,
            modality: chunk.modality.clone().unwrap_or_else(|| "text".into()),
            meta: kept_meta(chunk),
            segment: Some(SegmentPlace {
                occurrence_id: input.occurrence_id,
                local_ordinal: input.local_ordinal,
                raw_byte_start: input.raw_byte_start,
                raw_byte_end: input.raw_byte_end,
                body_generation: generation,
            }),
            // A segment chunk is written without a vector; it carries no pending stamp (the
            // page-body writer has no clock here), which `readEmbeddingStateCounts` reports as
            // `unstamped_pending`.
            embed: EmbedState::default(),
        };
        write_chunk(tx, &record, view_generation, &mut stats)?;
        indexes.push(index);
    }
    add_stats(tx, &stats)?;
    Ok(indexes)
}

/// Records the page's new body generation and live occurrence offsets, and writes or removes
/// the postings of the chunks whose visibility changed.
// The page-body family is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn publish_segment_chunks(
    tx: &mut dyn KvWrite,
    page_id: u64,
    generation: u64,
    offsets: BTreeMap<u64, u64>,
) -> Result<()> {
    let before = segment_view_generation(&*tx, page_id)?;
    if before != generation {
        for chunk in read_chunks(&*tx, page_id)? {
            match (chunk.visible_at(before), chunk.visible_at(generation)) {
                (false, true) => put_postings(tx, &chunk)?,
                (true, false) => delete_postings(tx, &chunk)?,
                _ => {}
            }
        }
    }
    put_json(
        tx,
        &segment_view_key(page_id),
        &SegmentView {
            generation,
            offsets,
        },
    )
}

/// Deletes the page's segment view (a page deleted for good).
// The page-body family is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn forget_segment_view(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    tx.delete(&segment_view_key(page_id))
}

/// Number of the page's chunks that `pred` matches.
// The page-body family is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn count_chunks_matching(
    read: &dyn KvRead,
    page_id: u64,
    pred: &dyn Fn(&ChunkRecord) -> bool,
) -> Result<usize> {
    Ok(read_chunks(read, page_id)?
        .iter()
        .filter(|c| pred(c))
        .count())
}

/// Removes the page's chunks that `pred` matches, with their postings, and calls the chunk-delete
/// hook once with their sorted ids. Returns those ids.
// The page-body family is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn delete_chunks_matching(
    tx: &mut dyn KvWrite,
    page_id: u64,
    pred: &dyn Fn(&ChunkRecord) -> bool,
) -> Result<Vec<u64>> {
    let gone: Vec<ChunkRecord> = read_chunks(&*tx, page_id)?
        .into_iter()
        .filter(|c| pred(c))
        .collect();
    if gone.is_empty() {
        return Ok(Vec::new());
    }
    let mut stats = StatsDelta::default();
    for chunk in &gone {
        remove_chunk_record(tx, chunk, &mut stats)?;
    }
    add_stats(tx, &stats)?;
    let mut ids: Vec<u64> = gone.iter().map(|c| c.id).collect();
    ids.sort_unstable();
    crate::cascade::remove_chunk_rows(tx, page_id, &ids)?;
    Ok(ids)
}

/// The segment chunks of the given occurrences, at or below `max_generation` when it is given.
// The page-body family is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn occurrence_match(
    place: Option<SegmentPlace>,
    occurrences: &BTreeSet<u64>,
    max_generation: Option<u64>,
) -> bool {
    place.is_some_and(|place| {
        occurrences.contains(&place.occurrence_id)
            && max_generation.is_none_or(|max| place.body_generation <= max)
    })
}

/// The segment chunks of `generation` whose occurrence is not in `keep`.
// The page-body family is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn generation_match(
    place: Option<SegmentPlace>,
    generation: u64,
    keep: &BTreeSet<u64>,
) -> bool {
    place.is_some_and(|place| {
        place.body_generation == generation && !keep.contains(&place.occurrence_id)
    })
}

/// Removes the segment chunks of `occurrences` (at or below `max_generation` when given).
// The page-body family is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn delete_occurrence_chunks(
    tx: &mut dyn KvWrite,
    page_id: u64,
    occurrences: &BTreeSet<u64>,
    max_generation: Option<u64>,
) -> Result<Vec<u64>> {
    delete_chunks_matching(tx, page_id, &|c| {
        occurrence_match(c.segment, occurrences, max_generation)
    })
}

/// Removes the segment chunks of `generation` whose occurrence is not in `keep`.
// The page-body family is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn delete_generation_chunks(
    tx: &mut dyn KvWrite,
    page_id: u64,
    generation: u64,
    keep: &BTreeSet<u64>,
) -> Result<Vec<u64>> {
    delete_chunks_matching(tx, page_id, &|c| {
        generation_match(c.segment, generation, keep)
    })
}

/// Options of `get_chunks_with` (PGLite's `getChunks` options).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GetChunksOptions {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    /// Kept for the shape of `ReadScope`; a chunk read never filters soft-deleted pages.
    pub include_deleted: bool,
    pub include_embedding: bool,
    pub include_unsealed: bool,
    /// `requireSafeChunks`: only a page past the chunker-version fence (`safeChunksFilter(p)`)
    /// has chunks to read.
    pub require_safe_chunks: bool,
}

/// The page's visible chunks as `getChunks` returns them, with their vectors when `with_vectors`. A sealed read takes
/// `chunkVisibleFilter`'s chunks; an `includeUnsealed` read (`unsealed`) takes `chunkGenerationFilter`'s, the live
/// body's only.
pub(crate) fn chunk_rows(
    read: &dyn KvRead,
    page: &PageRecord,
    with_vectors: bool,
    unsealed: bool,
) -> Result<Vec<Value>> {
    Ok(keyed_chunk_rows(read, page, with_vectors, unsealed)?
        .into_iter()
        .map(|(_, row)| row)
        .collect())
}

/// `chunk_rows` with each row's `DocumentKey`.
fn keyed_chunk_rows(
    read: &dyn KvRead,
    page: &PageRecord,
    with_vectors: bool,
    unsealed: bool,
) -> Result<Vec<(DocumentKey, Value)>> {
    let mut out = Vec::new();
    for (key, chunk) in keyed_chunks(read, page.id, unsealed.then(|| segmented(page)))? {
        let stored = if with_vectors && chunk.embed.has_vector() {
            crate::embeddings::read_chunk_vector(read, page.id, chunk.chunk_index)?
        } else {
            None
        };
        out.push((
            key,
            chunk.to_chunk(stored.as_ref().map(|s| s.vector.as_slice())),
        ));
    }
    Ok(out)
}

/// Options of `upsert_chunks`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpsertChunksOptions {
    pub source_id: Option<String>,
    /// When given, the page must be at this revision (`revision_conflict` otherwise). It only
    /// checks: PGLite's `upsertChunks` never seals.
    pub expected_revision: Option<String>,
    /// PGLite's `sealChunks`: replace every chunk of the page with `chunks` (no merge with what
    /// was there) and seal them to the page's current revision, even when `chunks` is empty.
    pub seal: bool,
    /// With `seal`: `sanitizeRemoteBody(timeline)` of the page, the timeline text of its keyword
    /// vector. The store keeps it at the sealed revision (`pages::record_search_timeline`). Ignored
    /// without `seal`.
    pub search_timeline: Option<String>,
    /// PGLite's `sealChunkerVersion`, as the text JavaScript binds (`String(version)`): the caller
    /// deleted the rows it replaces earlier in its transaction, so only the indexes in `chunks`
    /// are written (every other chunk stays), the text seal is left as it is, and the page's
    /// `chunker_version` becomes this value, Postgres's text-to-`smallint` cast of it (a value
    /// that is not a smallint refuses the write). Not used with `seal`.
    pub seal_chunker_version: Option<String>,
    /// With `seal_chunker_version` and chunks: the id of the page the caller wrote in this
    /// transaction. Another page's id refuses the write.
    pub page_id: Option<u64>,
    /// With `page_id` and chunks: the caller stamps the version itself, so the write leaves it.
    pub defer_seal: bool,
}

/// PGLite's `chunkWriteInvalidations` for a plain `upsertChunks`: true unless the page is above
/// the safe fence and the write repeats its stored chunks exactly (every stored index is in the
/// write, and each written chunk matches the stored one on text, source, modality and every
/// metadata field the write sets). Only a refresh of the same snapshot (new vectors) keeps the
/// page's `chunker_version`; anything else sets it to -1.
fn fragment_write_invalidates(
    read: &dyn KvRead,
    page: &PageRecord,
    chunks: &[ChunkInput],
) -> Result<bool> {
    if page.chunker_version.unwrap_or(0) < SAFE_FENCE_CHUNKER_VERSION {
        return Ok(true);
    }
    let stored: HashMap<u32, ChunkRecord> = read_chunks(read, page.id)?
        .into_iter()
        .map(|c| (c.chunk_index, c))
        .collect();
    if stored
        .keys()
        .any(|index| !chunks.iter().any(|c| c.chunk_index == *index))
    {
        return Ok(true);
    }
    Ok(chunks.iter().any(|input| {
        let Some(old) = stored.get(&input.chunk_index) else {
            return true;
        };
        old.chunk_text != input.chunk_text.replace('\0', "")
            || input.chunk_source.as_deref() != Some(old.chunk_source.as_str())
            || old.modality != input.modality.as_deref().unwrap_or("text")
            || INVALIDATING_META_KEYS.iter().any(|key| {
                input
                    .rest
                    .get(*key)
                    .filter(|v| !v.is_null())
                    .is_some_and(|v| old.meta.get(*key) != Some(v))
            })
    }))
}

/// The metadata fields `chunkWriteInvalidations` compares (a field the write leaves null keeps
/// the stored value, so it never invalidates).
const INVALIDATING_META_KEYS: &[&str] = &[
    "language",
    "symbol_name",
    "symbol_type",
    "start_line",
    "end_line",
    "parent_symbol_path",
    "doc_comment",
    "symbol_name_qualified",
];

/// `upsertChunks` with `sealChunkerVersion` (see [`UpsertChunksOptions::seal_chunker_version`]).
/// PGLite stamps the version first, so a bad version refuses before the page id is checked.
fn upsert_at_chunker_version(
    tx: &mut dyn KvWrite,
    page: &mut PageRecord,
    chunks: &[ChunkInput],
    version: &str,
    options: &UpsertChunksOptions,
    now_us: i64,
) -> Result<()> {
    let pinned = options.page_id.filter(|_| !chunks.is_empty());
    let stamp = if pinned.is_some() && options.defer_seal {
        None
    } else {
        Some(crate::import_members::smallint(version)?)
    };
    if pinned.is_some_and(|id| id != page.id) {
        return Err(StoreError::invalid(format!(
            "Page {} (source={}) is not the page this transaction wrote",
            page.slug, page.source_id
        )));
    }
    if !chunks.is_empty() {
        replace_chunks_at(tx, page, chunks, false, false, true, true, now_us)?;
    }
    match stamp {
        Some(version) if page.chunker_version != Some(version) => {
            page.chunker_version = Some(version);
            write_page(tx, page)
        }
        _ => Ok(()),
    }
}

/// The refusals of PGLite's `sealChunks` that come before any chunk is written, in its order: a page
/// in an archived source reads as missing (`readPageSnapshot` with `requireLiveSource`), and a
/// segmented page (NULL body) is refused, because its projection is built from its segments.
fn refuse_seal(read: &dyn KvRead, page: &PageRecord, slug: &str, source: &str) -> Result<()> {
    if crate::sources::read_source(read, source)?.is_some_and(|s| s.archived) {
        return Err(StoreError::new(
            PAGE_NOT_FOUND,
            format!("Page not found: {slug} (source={source})"),
        ));
    }
    if page.compiled_truth.is_null() {
        return Err(StoreError::new(
            INVALID_STATE,
            format!(
                "sealChunks refuses segmented page {slug} (source={source}): its projection is built from its segments"
            ),
        ));
    }
    Ok(())
}

impl Store {
    /// `upsertChunks(slug, chunks, opts)`: replaces the page's chunks.
    pub fn upsert_chunks(
        &self,
        slug: &str,
        chunks: &[ChunkInput],
        options: &UpsertChunksOptions,
    ) -> Result<()> {
        let now_us = self.env.now_micros();
        self.write(|tx| {
            let source = options.source_id.as_deref().unwrap_or(DEFAULT_SOURCE);
            let Some(mut page) = read_page(&*tx, source, &slug.to_lowercase())? else {
                return Err(StoreError::new(
                    PAGE_NOT_FOUND,
                    format!("upsertChunks failed: page \"{slug}\" (source={source}) not found"),
                ));
            };
            if options.seal {
                refuse_seal(&*tx, &page, slug, source)?;
            } else if segmented(&page) {
                // A plain write would replace the chunks of the page's live segments: refused before any write.
                return Err(StoreError::new(
                    INVALID_STATE,
                    format!(
                        "upsertChunks refuses segmented page {slug} (source={source}): its chunks are written through its segments"
                    ),
                ));
            }
            if let Some(expected) = &options.expected_revision {
                if !crate::env::is_uuid(expected) {
                    return Err(StoreError::invalid("expectedRevision must be a UUID revision"));
                }
                if !expected.eq_ignore_ascii_case(&page.knowledge_revision) {
                    return Err(StoreError::new(
                        REVISION_CONFLICT,
                        "The page changed after it was read. Read its current revision before retrying.",
                    ));
                }
            }
            let seal = options.seal;
            if let Some(version) = options.seal_chunker_version.as_deref() {
                if seal {
                    return Err(StoreError::invalid(
                        "sealChunks takes no sealChunkerVersion",
                    ));
                }
                return upsert_at_chunker_version(tx, &mut page, chunks, version, options, now_us);
            }
            if let Some(timeline) = options.search_timeline.as_deref().filter(|_| seal) {
                // The seal keeps the page's revision, so the text is recorded at it now.
                crate::pages::record_search_timeline(
                    tx,
                    page.id,
                    &page.knowledge_revision,
                    &page.title,
                    timeline,
                )?;
            }
            if !seal && fragment_write_invalidates(&*tx, &page, chunks)? {
                // PGLite's `chunkWriteInvalidations`: a fragment write cannot certify the
                // full-body fence boundary, so it marks the page unsafe before it writes.
                page.chunker_version = Some(-1);
                write_page(tx, &page)?;
            }
            if chunks.is_empty() && !seal {
                // PGLite: an empty write removes the chunks and leaves the page unsealed.
                replace_chunks_at(tx, &mut page, chunks, false, false, true, false, now_us)?;
                if page.text_projection_revision.is_some() {
                    page.text_projection_revision = None;
                    write_page(tx, &page)?;
                }
                return Ok(());
            }
            replace_chunks_at(tx, &mut page, chunks, seal, seal, !seal, false, now_us)
        })
    }

    /// `getChunks(slug, opts)` with the scope only (no vectors, sealed chunks only).
    pub fn get_chunks(&self, slug: &str, scope: &ReadScope) -> Result<Vec<Value>> {
        self.get_chunks_with(
            slug,
            &GetChunksOptions {
                source_id: scope.source_id.clone(),
                source_ids: scope.source_ids.clone(),
                ..GetChunksOptions::default()
            },
        )
    }

    /// `getChunks(slug, opts)`: the page's visible chunks in document order (inline chunks in
    /// index order) while they describe the page's current text. PGLite reads a page's chunks only
    /// when its `text_projection_revision` equals its `knowledge_revision` (the chunks are sealed),
    /// so a page that was never sealed, or whose revision moved since (a tag change, a soft
    /// delete), reads as no chunks unless `include_unsealed` is set. `include_embedding` returns
    /// each stored vector. `require_safe_chunks` reads no chunks of a page before the
    /// chunker-version fence (`chunker_version >= SAFE_FENCE_CHUNKER_VERSION`; none recorded fails).
    /// A scope of several sources reads the page of this slug in each, merged in document order
    /// with the source id (in byte order) breaking a tie, as the SQL engines order them.
    pub fn get_chunks_with(&self, slug: &str, options: &GetChunksOptions) -> Result<Vec<Value>> {
        let read = self.read()?;
        let scope_default = if options.source_id.is_none()
            && options.source_ids.as_ref().is_none_or(Vec::is_empty)
        {
            Some(DEFAULT_SOURCE.to_string())
        } else {
            options.source_id.clone()
        };
        let mut sources = crate::pages::scope_sources(&*read, &scope_default, &options.source_ids)?;
        let mut seen = HashSet::new();
        sources.retain(|id| seen.insert(id.clone()));
        let mut rows: Vec<(DocumentKey, String, Value)> = Vec::new();
        for source in sources {
            // The slug is matched as written, and a soft-deleted page is read like a live one: PGLite's
            // chunk read has neither a case fold nor a `deleted_at` filter.
            let Some(page) = read_page(&*read, &source, slug)? else {
                continue;
            };
            if !options.include_unsealed
                && page.text_projection_revision.as_deref()
                    != Some(page.knowledge_revision.as_str())
            {
                continue;
            }
            if options.require_safe_chunks && !crate::chunk_queries::safe_chunks(&page) {
                continue;
            }
            let rows_of_page = keyed_chunk_rows(
                &*read,
                &page,
                options.include_embedding,
                options.include_unsealed,
            )?;
            rows.extend(
                rows_of_page
                    .into_iter()
                    .map(|(key, row)| (key, page.source_id.clone(), row)),
            );
        }
        // `ORDER BY chunkDocumentOrder, p.source_id COLLATE "C"`; the sort is stable and a page's rows are in its order.
        rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        Ok(rows.into_iter().map(|(_, _, row)| row).collect())
    }

    /// `deleteChunks(slug, {sourceId})`: removes the page's chunks. The page stays. When it removed
    /// any, the page's text seal (`text_projection_revision`) is cleared, as PGLite's `deleteChunks`
    /// does: the seal certified the chunks that are gone, so a later unsealed `upsertChunks` stays
    /// unread until a new seal.
    pub fn delete_chunks(&self, slug: &str, source_id: Option<&str>) -> Result<()> {
        self.write(|tx| {
            let source = source_id.unwrap_or(DEFAULT_SOURCE);
            if let Some(mut page) = read_page(&*tx, source, &slug.to_lowercase())? {
                // PGLite: removing chunks voids the seal that certified them (#8502).
                let had_chunks = !read_chunks(&*tx, page.id)?.is_empty();
                clear_chunks(tx, page.id)?;
                if had_chunks && page.text_projection_revision.is_some() {
                    page.text_projection_revision = None;
                    write_page(tx, &page)?;
                }
            }
            Ok(())
        })
    }

    /// Number of chunks in the brain (every page, deleted or not).
    pub fn count_chunks(&self) -> Result<u64> {
        Ok(read_stats(&*self.read()?)?.chunks)
    }
}

#[cfg(test)]
mod segment_tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::search::SearchOptions;

    fn fired() -> Vec<(u64, Vec<u64>)> {
        crate::cascade::tests::FIRED.with(|fired| fired.borrow_mut().drain(..).collect())
    }

    /// A sealed page with one inline chunk ("inline body").
    fn page(store: &Store) -> u64 {
        let input = PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "inline body".into(),
            ..PageInput::default()
        };
        store
            .put_page("a", &input, &PutPageOptions::default())
            .unwrap();
        read_page(&*store.read().unwrap(), "default", "a")
            .unwrap()
            .unwrap()
            .id
    }

    fn seg(occurrence: u64, ordinal: u32, text: &str) -> SegmentChunkInput {
        SegmentChunkInput {
            chunk: ChunkInput {
                chunk_text: text.into(),
                ..ChunkInput::default()
            },
            occurrence_id: occurrence,
            local_ordinal: ordinal,
            raw_byte_start: 0,
            raw_byte_end: text.len() as u64,
        }
    }

    fn texts(store: &Store) -> Vec<String> {
        store
            .get_chunks("a", &ReadScope::default())
            .unwrap()
            .iter()
            .map(|c| c["chunk_text"].as_str().unwrap().to_string())
            .collect()
    }

    fn hits(store: &Store, term: &str) -> usize {
        store
            .search_keyword(term, &SearchOptions::default())
            .unwrap()
            .len()
    }

    fn append(
        store: &Store,
        page_id: u64,
        generation: u64,
        chunks: &[SegmentChunkInput],
    ) -> Vec<u32> {
        store
            .write(|tx| append_segment_chunks(tx, page_id, generation, chunks))
            .unwrap()
    }

    fn publish(store: &Store, page_id: u64, generation: u64, offsets: &[(u64, u64)]) {
        store
            .write(|tx| {
                publish_segment_chunks(tx, page_id, generation, offsets.iter().copied().collect())
            })
            .unwrap();
    }

    #[test]
    fn appended_chunks_take_the_indexes_after_the_highest_and_keep_their_place() {
        let store = crate::test_support::store();
        let id = page(&store);
        assert_eq!(read_chunks(&*store.read().unwrap(), id).unwrap().len(), 1);
        assert_eq!(
            append(&store, id, 1, &[seg(7, 0, "x"), seg(7, 1, "y")]),
            vec![1, 2]
        );
        assert_eq!(append(&store, id, 1, &[seg(8, 0, "z")]), vec![3]);
        assert_eq!(append(&store, id, 1, &[]), Vec::<u32>::new());
        let records = read_chunks(&*store.read().unwrap(), id).unwrap();
        assert_eq!(
            records[2].segment,
            Some(SegmentPlace {
                occurrence_id: 7,
                local_ordinal: 1,
                raw_byte_start: 0,
                raw_byte_end: 1,
                body_generation: 1,
            })
        );
        assert_eq!(records[2].chunk_source, "compiled_truth");
        assert_eq!(records[0].segment, None);
        // Every record is counted, staged ones included.
        assert_eq!(store.count_chunks().unwrap(), 4);
        // chunk_source is checked as upsertChunks checks it, and nothing is written.
        let mut bad = seg(9, 0, "w");
        bad.chunk.chunk_source = Some("nope".into());
        let err = store
            .write(|tx| append_segment_chunks(tx, id, 1, &[bad.clone()]))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        assert_eq!(store.count_chunks().unwrap(), 4);
    }

    #[test]
    fn staged_chunks_are_hidden_from_reads_and_keyword_search_until_published() {
        let store = crate::test_support::store();
        let id = page(&store);
        append(&store, id, 1, &[seg(7, 0, "zebra one")]);
        assert_eq!(texts(&store), vec!["inline body"]);
        assert_eq!(hits(&store, "zebra"), 0);

        publish(&store, id, 1, &[(7, 0)]);
        assert_eq!(texts(&store), vec!["zebra one", "inline body"]);
        assert_eq!(hits(&store, "zebra"), 1);

        // A chunk staged at the live generation is visible at once; one above it is not.
        append(&store, id, 1, &[seg(8, 0, "yak")]);
        append(&store, id, 2, &[seg(9, 0, "walrus")]);
        assert_eq!(hits(&store, "yak"), 1);
        assert_eq!(hits(&store, "walrus"), 0);
        assert_eq!(texts(&store).len(), 3);

        // Publishing back below a generation hides its chunks again.
        publish(&store, id, 2, &[(7, 0), (9, 10)]);
        assert_eq!(hits(&store, "walrus"), 1);
        publish(&store, id, 1, &[(7, 0)]);
        assert_eq!(hits(&store, "walrus"), 0);
    }

    #[test]
    fn reads_follow_document_order() {
        let store = crate::test_support::store();
        let id = page(&store);
        // Index order: b1, b0, a0, c0. Offsets put occurrence 2 (a) before 1 (b); occurrence 3
        // (c) has no live offset, so it follows the placed rows, before the inline chunk.
        append(
            &store,
            id,
            1,
            &[
                seg(1, 1, "b1"),
                seg(1, 0, "b0"),
                seg(2, 0, "a0"),
                seg(3, 0, "c0"),
            ],
        );
        publish(&store, id, 1, &[(1, 50), (2, 10)]);
        assert_eq!(texts(&store), vec!["a0", "b0", "b1", "c0", "inline body"]);
        let read = store.read().unwrap();
        let visible: Vec<u32> = visible_chunks(&*read, id)
            .unwrap()
            .iter()
            .map(|c| c.chunk_index)
            .collect();
        assert_eq!(visible, vec![3, 2, 1, 4, 0]);
        // The output carries no segment fields, as PGLite's getChunks columns.
        let chunk = &store.get_chunks("a", &ReadScope::default()).unwrap()[0];
        assert!(chunk.get("occurrence_id").is_none() && chunk.get("segment").is_none());
    }

    #[test]
    fn deletes_by_occurrence_and_by_generation_fire_the_chunk_hook_once() {
        let store = crate::test_support::store();
        let id = page(&store);
        append(&store, id, 1, &[seg(1, 0, "one"), seg(2, 0, "two")]);
        append(&store, id, 2, &[seg(1, 0, "one again"), seg(3, 0, "three")]);
        publish(&store, id, 2, &[(1, 0), (3, 5)]);
        let ids: HashMap<String, u64> = read_chunks(&*store.read().unwrap(), id)
            .unwrap()
            .into_iter()
            .map(|c| (c.chunk_text, c.id))
            .collect();
        fired();

        // Occurrence 1 at or below generation 1: only its first chunk.
        let occurrences: BTreeSet<u64> = [1].into();
        let count = count_chunks_matching(&*store.read().unwrap(), id, &|c| {
            occurrence_match(c.segment, &occurrences, Some(1))
        })
        .unwrap();
        assert_eq!(count, 1);
        let gone = store
            .write(|tx| delete_occurrence_chunks(tx, id, &occurrences, Some(1)))
            .unwrap();
        assert_eq!(gone, vec![ids["one"]]);
        assert_eq!(fired(), vec![(id, vec![ids["one"]])]);
        assert_eq!(hits(&store, "again"), 1);

        // Generation 2 except occurrence 3: occurrence 1's second chunk.
        let keep: BTreeSet<u64> = [3].into();
        let gone = store
            .write(|tx| delete_generation_chunks(tx, id, 2, &keep))
            .unwrap();
        assert_eq!(gone, vec![ids["one again"]]);
        assert_eq!(fired(), vec![(id, vec![ids["one again"]])]);
        assert_eq!(hits(&store, "again"), 0);
        assert_eq!(texts(&store), vec!["three", "two", "inline body"]);
        assert_eq!(store.count_chunks().unwrap(), 3);

        // Nothing matches: no hook call.
        assert!(
            store
                .write(|tx| delete_generation_chunks(tx, id, 9, &keep))
                .unwrap()
                .is_empty()
        );
        assert_eq!(fired(), vec![]);

        // One combined predicate, one hook call with sorted ids.
        let all: BTreeSet<u64> = [2, 3].into();
        let gone = store
            .write(|tx| {
                delete_chunks_matching(tx, id, &|c| {
                    occurrence_match(c.segment, &all, None)
                        || generation_match(c.segment, 2, &BTreeSet::new())
                })
            })
            .unwrap();
        let mut both = vec![ids["two"], ids["three"]];
        both.sort_unstable();
        assert_eq!(gone, both);
        assert_eq!(fired(), vec![(id, both)]);
        assert_eq!(texts(&store), vec!["inline body"]);
    }

    #[test]
    fn delete_chunks_keeps_the_view_and_forget_removes_it() {
        let store = crate::test_support::store();
        let id = page(&store);
        publish(&store, id, 3, &[(1, 0)]);
        store.delete_chunks("a", None).unwrap();
        let view = read_segment_view(&*store.read().unwrap(), id).unwrap();
        assert_eq!(view.generation, 3);
        store.write(|tx| forget_segment_view(tx, id)).unwrap();
        assert_eq!(
            read_segment_view(&*store.read().unwrap(), id).unwrap(),
            SegmentView::default()
        );
    }

    #[test]
    fn upsert_keeps_the_segment_place_of_an_index_it_rewrites() {
        let store = crate::test_support::store();
        let id = page(&store);
        append(&store, id, 2, &[seg(5, 0, "staged")]);
        let chunk = ChunkInput {
            chunk_index: 1,
            chunk_text: "rewritten".into(),
            ..ChunkInput::default()
        };
        store
            .upsert_chunks("a", &[chunk], &UpsertChunksOptions::default())
            .unwrap();
        let records = read_chunks(&*store.read().unwrap(), id).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].segment.map(|p| p.occurrence_id), Some(5));
        // Still staged above the view: no posting.
        assert!(
            store
                .read()
                .unwrap()
                .get(&keys::posting("rewritten", id, 1))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn records_without_a_segment_decode_and_inline_records_write_none() {
        let old = json!({
            "id": 4, "page_id": 2, "chunk_index": 0, "chunk_text": "t",
            "chunk_source": "compiled_truth", "modality": "text", "length": 1, "meta": {},
        });
        let record: ChunkRecord = serde_json::from_value(old).unwrap();
        assert_eq!(record.segment, None);
        assert!(record.visible_at(0));
        let written = serde_json::to_value(&record).unwrap();
        assert!(written.get("segment").is_none());
    }

    #[test]
    fn segment_input_reads_the_typescript_shape() {
        let input: SegmentChunkInput = serde_json::from_value(json!({
            "chunk_text": "t", "chunk_source": "timeline", "token_count": 3,
            "occurrence_id": 11, "local_ordinal": 2, "raw_byte_start": 4, "raw_byte_end": 9,
        }))
        .unwrap();
        assert_eq!(input.occurrence_id, 11);
        assert_eq!(input.local_ordinal, 2);
        assert_eq!((input.raw_byte_start, input.raw_byte_end), (4, 9));
        assert_eq!(input.chunk.chunk_source.as_deref(), Some("timeline"));
        assert_eq!(input.chunk.rest.get("token_count"), Some(&json!(3)));
        assert!(input.chunk.rest.get("occurrence_id").is_none());
    }

    fn seal_of(store: &Store) -> Option<String> {
        read_page(&*store.read().unwrap(), "default", "a")
            .unwrap()
            .unwrap()
            .text_projection_revision
    }

    /// PGLite's deleteChunks clears the seal when it removed chunks (#8502), so the page reads as
    /// chunkless again; a delete that removed nothing leaves the seal alone.
    #[test]
    fn delete_chunks_clears_the_seal_only_when_chunks_were_removed() {
        let store = crate::test_support::store();
        page(&store);
        assert!(seal_of(&store).is_some());
        store.delete_chunks("a", None).unwrap();
        assert!(texts(&store).is_empty());
        assert_eq!(seal_of(&store), None);

        let seal = UpsertChunksOptions {
            seal: true,
            ..UpsertChunksOptions::default()
        };
        store.upsert_chunks("a", &[], &seal).unwrap();
        let sealed = seal_of(&store);
        assert!(sealed.is_some());
        store.delete_chunks("a", None).unwrap();
        assert_eq!(seal_of(&store), sealed);
    }
}

#[cfg(test)]
mod chunker_version_tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};

    /// A sealed page "a" with one inline chunk at index 0 ("inline body"); its id.
    fn page(store: &Store) -> u64 {
        let input = PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "inline body".into(),
            ..PageInput::default()
        };
        store
            .put_page("a", &input, &PutPageOptions::default())
            .unwrap();
        record(store).id
    }

    fn record(store: &Store) -> PageRecord {
        read_page(&*store.read().unwrap(), "default", "a")
            .unwrap()
            .unwrap()
    }

    fn chunk(index: u32, text: &str) -> ChunkInput {
        serde_json::from_value(serde_json::json!({ "chunk_index": index, "chunk_text": text }))
            .unwrap()
    }

    fn sealed_at(version: &str) -> UpsertChunksOptions {
        UpsertChunksOptions {
            seal_chunker_version: Some(version.into()),
            ..UpsertChunksOptions::default()
        }
    }

    /// The sealed chunks of "a" as `index:text`.
    fn rows(store: &Store) -> Vec<String> {
        store
            .get_chunks("a", &ReadScope::default())
            .unwrap()
            .iter()
            .map(|c| format!("{}:{}", c["chunk_index"], c["chunk_text"].as_str().unwrap()))
            .collect()
    }

    fn code(err: StoreError) -> &'static str {
        err.code
    }

    /// The chunk texts of "a" a `requireSafeChunks` read returns.
    fn safe_rows(store: &Store) -> Vec<String> {
        let options = GetChunksOptions {
            require_safe_chunks: true,
            ..GetChunksOptions::default()
        };
        store
            .get_chunks_with("a", &options)
            .unwrap()
            .iter()
            .map(|c| c["chunk_text"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn a_safe_chunk_read_serves_only_a_page_cut_at_the_safe_chunker_version() {
        let store = crate::test_support::store();
        page(&store);
        store
            .upsert_chunks("a", &[chunk(0, "safe")], &sealed_at("4"))
            .unwrap();
        assert_eq!(safe_rows(&store), vec!["safe"]);
        store.set_chunker_version("a", "3", None).unwrap();
        assert!(safe_rows(&store).is_empty());
        // Without the option the same page still reads its chunks.
        assert_eq!(rows(&store), vec!["0:safe"]);
        store.set_chunker_version("a", "4", None).unwrap();
        assert_eq!(safe_rows(&store), vec!["safe"]);
        // An unsealed fragment write marks the page unsafe (-1).
        store
            .upsert_chunks(
                "a",
                &[chunk(0, "fragment")],
                &UpsertChunksOptions::default(),
            )
            .unwrap();
        let unsealed_safe = GetChunksOptions {
            include_unsealed: true,
            require_safe_chunks: true,
            ..GetChunksOptions::default()
        };
        assert!(
            store
                .get_chunks_with("a", &unsealed_safe)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_sealed_write_keeps_unnamed_rows_and_the_seal_and_stamps_the_version() {
        let store = crate::test_support::store();
        let id = page(&store);
        let revision = record(&store).knowledge_revision;
        store
            .upsert_chunks("a", &[chunk(2, "two")], &sealed_at("5"))
            .unwrap();
        assert_eq!(rows(&store), vec!["0:inline body", "2:two"]);
        assert_eq!(record(&store).chunker_version, Some(5));
        assert_eq!(record(&store).knowledge_revision, revision);
        // A named row is written over; no chunks stamps the version only.
        store
            .upsert_chunks("A", &[chunk(0, "zero")], &sealed_at(" 6 "))
            .unwrap();
        store.upsert_chunks("a", &[], &sealed_at("7")).unwrap();
        assert_eq!(rows(&store), vec!["0:zero", "2:two"]);
        assert_eq!(record(&store).chunker_version, Some(7));
        // The caller's own page id is checked; with deferSeal the version is the caller's to stamp.
        let own = UpsertChunksOptions {
            page_id: Some(id),
            ..sealed_at("8")
        };
        store
            .upsert_chunks("a", &[chunk(3, "three")], &own)
            .unwrap();
        assert_eq!(record(&store).chunker_version, Some(8));
        let deferred = UpsertChunksOptions {
            defer_seal: true,
            ..UpsertChunksOptions {
                page_id: Some(id),
                ..sealed_at("not a number")
            }
        };
        store
            .upsert_chunks("a", &[chunk(4, "four")], &deferred)
            .unwrap();
        assert_eq!(record(&store).chunker_version, Some(8));
        assert_eq!(rows(&store), vec!["0:zero", "2:two", "3:three", "4:four"]);
        // deferSeal without a page id still stamps; a page id with no chunks is not checked.
        let unpinned = UpsertChunksOptions {
            defer_seal: true,
            ..sealed_at("9")
        };
        store
            .upsert_chunks("a", &[chunk(5, "five")], &unpinned)
            .unwrap();
        assert_eq!(record(&store).chunker_version, Some(9));
        let empty_other = UpsertChunksOptions {
            page_id: Some(id + 1),
            ..sealed_at("10")
        };
        store.upsert_chunks("a", &[], &empty_other).unwrap();
        assert_eq!(record(&store).chunker_version, Some(10));
    }

    #[test]
    fn a_bad_version_or_another_page_id_refuses_the_whole_write() {
        let store = crate::test_support::store();
        let id = page(&store);
        for bad in ["3.5", "40000", "NaN", "5\0", "", "-"] {
            let err = store
                .upsert_chunks("a", &[chunk(1, "one")], &sealed_at(bad))
                .unwrap_err();
            assert_eq!(code(err), INVALID_ARGUMENT, "{bad:?}");
        }
        // With no chunks a bad version still refuses: PGLite always stamps then.
        let err = store.upsert_chunks("a", &[], &sealed_at("x")).unwrap_err();
        assert_eq!(code(err), INVALID_ARGUMENT);
        let other = UpsertChunksOptions {
            page_id: Some(id + 1),
            ..sealed_at("5")
        };
        let err = store
            .upsert_chunks("a", &[chunk(1, "one")], &other)
            .unwrap_err();
        assert!(
            err.message
                .contains("is not the page this transaction wrote")
        );
        let deferred_other = UpsertChunksOptions {
            defer_seal: true,
            ..other
        };
        assert!(
            store
                .upsert_chunks("a", &[chunk(1, "one")], &deferred_other)
                .is_err()
        );
        assert_eq!(rows(&store), vec!["0:inline body"]);
        assert_ne!(record(&store).chunker_version, Some(5));
        let both = UpsertChunksOptions {
            seal: true,
            ..sealed_at("5")
        };
        assert!(store.upsert_chunks("a", &[], &both).is_err());
        let err = store
            .upsert_chunks("missing", &[chunk(0, "x")], &sealed_at("5"))
            .unwrap_err();
        assert_eq!(code(err), PAGE_NOT_FOUND);
    }

    #[test]
    fn a_plain_write_marks_the_page_unsafe_unless_it_repeats_the_stored_chunks() {
        let plain = UpsertChunksOptions::default();
        let base = || {
            serde_json::json!({
                "chunk_index": 0, "chunk_text": "inline body", "chunk_source": "compiled_truth",
                "language": null, "token_count": 9,
            })
        };
        let same = || -> ChunkInput { serde_json::from_value(base()).unwrap() };
        let with = |extra: serde_json::Value| -> ChunkInput {
            let mut value = base();
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            serde_json::from_value(value).unwrap()
        };
        // `put_page`'s own raw split is not certified, so `sealChunks` makes the page safe first.
        let sealed_page = |store: &Store| {
            page(store);
            let seal = UpsertChunksOptions {
                seal: true,
                ..UpsertChunksOptions::default()
            };
            store.upsert_chunks("a", &[same()], &seal).unwrap();
        };
        // The same snapshot (a null field, a new token count) keeps the version.
        let store = crate::test_support::store();
        sealed_page(&store);
        let safe = record(&store).chunker_version;
        assert!(safe.unwrap_or(0) >= SAFE_FENCE_CHUNKER_VERSION);
        store.upsert_chunks("a", &[same()], &plain).unwrap();
        assert_eq!(record(&store).chunker_version, safe);
        let unsafe_after = |chunks: Vec<ChunkInput>| {
            let store = crate::test_support::store();
            sealed_page(&store);
            store.upsert_chunks("a", &chunks, &plain).unwrap();
            record(&store).chunker_version
        };
        for (what, chunks) in [
            (
                "new text",
                vec![with(serde_json::json!({ "chunk_text": "other" }))],
            ),
            ("no source", vec![chunk(0, "inline body")]),
            (
                "new source",
                vec![with(serde_json::json!({ "chunk_source": "timeline" }))],
            ),
            (
                "new modality",
                vec![with(serde_json::json!({ "modality": "image" }))],
            ),
            (
                "new metadata",
                vec![with(serde_json::json!({ "language": "rust" }))],
            ),
            (
                "a new index",
                vec![same(), with(serde_json::json!({ "chunk_index": 1 }))],
            ),
            ("a dropped index", vec![]),
        ] {
            assert_eq!(unsafe_after(chunks), Some(-1), "{what}");
        }
        // Below the fence even the same snapshot marks the page unsafe.
        let store = crate::test_support::store();
        page(&store);
        store.upsert_chunks("a", &[], &sealed_at("2")).unwrap();
        store.upsert_chunks("a", &[same()], &plain).unwrap();
        assert_eq!(record(&store).chunker_version, Some(-1));
    }
}

#[cfg(test)]
mod seal_guard_tests {
    use super::*;
    use crate::pages::{PageInput, PageText, PutPageOptions};

    /// A sealed page with one chunk, then turned into a segmented shell (NULL body), as
    /// `pages::tests::make_shell` does.
    fn segmented(store: &Store) -> PageRecord {
        let input = PageInput {
            page_type: "note".into(),
            title: "Big".into(),
            compiled_truth: "segment words".into(),
            ..PageInput::default()
        };
        store
            .put_page("big", &input, &PutPageOptions::default())
            .unwrap();
        store
            .write(|tx| {
                let mut page = read_page(&*tx, DEFAULT_SOURCE, "big")?.unwrap();
                page.compiled_truth = PageText::null();
                page.timeline = PageText::null();
                page.content_hash = None;
                write_page(tx, &page)?;
                Ok(page)
            })
            .unwrap()
    }

    fn stored_texts(store: &Store, page_id: u64) -> Vec<String> {
        read_chunks(&*store.read().unwrap(), page_id)
            .unwrap()
            .into_iter()
            .map(|c| c.chunk_text)
            .collect()
    }

    #[test]
    fn seal_refuses_a_segmented_page_before_it_touches_a_chunk() {
        let store = crate::test_support::store();
        let page = segmented(&store);
        let before = stored_texts(&store, page.id);
        assert!(!before.is_empty());
        for chunks in [
            Vec::new(),
            vec![ChunkInput {
                chunk_text: "inline".into(),
                ..ChunkInput::default()
            }],
        ] {
            let err = store
                .upsert_chunks(
                    "big",
                    &chunks,
                    &UpsertChunksOptions {
                        seal: true,
                        ..UpsertChunksOptions::default()
                    },
                )
                .unwrap_err();
            assert_eq!(err.code, crate::error::INVALID_STATE);
            assert_eq!(
                err.message,
                "sealChunks refuses segmented page big (source=default): its projection is built from its segments"
            );
            assert_eq!(stored_texts(&store, page.id), before);
            let after = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "big")
                .unwrap()
                .unwrap();
            assert_eq!(
                after.text_projection_revision,
                page.text_projection_revision
            );
        }
    }

    /// A plain (unsealed) `upsertChunks` on a segmented page would replace the chunks of its live segments, so it is
    /// refused before any chunk or page field is written, for a write with chunks and for the empty write that only
    /// removes them.
    #[test]
    fn plain_upsert_refuses_a_segmented_page_before_it_touches_a_chunk() {
        let store = crate::test_support::store();
        let page = segmented(&store);
        let before = stored_texts(&store, page.id);
        assert!(!before.is_empty());
        for chunks in [
            Vec::new(),
            vec![ChunkInput {
                chunk_text: "inline".into(),
                ..ChunkInput::default()
            }],
        ] {
            let err = store
                .upsert_chunks("big", &chunks, &UpsertChunksOptions::default())
                .unwrap_err();
            assert_eq!(err.code, crate::error::INVALID_STATE);
            assert_eq!(
                err.message,
                "upsertChunks refuses segmented page big (source=default): its chunks are written through its segments"
            );
            assert_eq!(stored_texts(&store, page.id), before);
            let after = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "big")
                .unwrap()
                .unwrap();
            assert_eq!(
                after.text_projection_revision,
                page.text_projection_revision
            );
            assert_eq!(after.chunker_version, page.chunker_version);
        }
    }

    fn version_of(store: &Store) -> Option<i16> {
        read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "big")
            .unwrap()
            .unwrap()
            .chunker_version
    }

    fn write_chunks(store: &Store, text: &str, seal: bool) {
        store
            .upsert_chunks(
                "big",
                // Callers always name the source (Postgres's column is NOT NULL), and a write
                // that names none differs from the stored chunk (`chunkWriteInvalidations`).
                &[ChunkInput {
                    chunk_text: text.into(),
                    chunk_source: Some("compiled_truth".into()),
                    ..ChunkInput::default()
                }],
                &UpsertChunksOptions {
                    seal,
                    ..UpsertChunksOptions::default()
                },
            )
            .unwrap();
    }

    /// `sealChunks` stamps the safe fence chunker; an `upsertChunks` that changes a chunk takes the stamp to -1 (and
    /// one that repeats the stored chunks leaves it); only another seal restores it. A page with no stamp reads as
    /// unsafe until then (`chunker_version >= 4` is NULL for it).
    #[test]
    fn seal_stamps_the_safe_version_and_a_changing_write_invalidates_it() {
        let store = crate::test_support::store();
        let input = PageInput {
            page_type: "note".into(),
            title: "Big".into(),
            compiled_truth: "segment words".into(),
            ..PageInput::default()
        };
        store
            .put_page("big", &input, &PutPageOptions::default())
            .unwrap();
        write_chunks(&store, "alpha", true);
        assert_eq!(version_of(&store), Some(SAFE_FENCE_CHUNKER_VERSION));

        write_chunks(&store, "alpha", false);
        assert_eq!(version_of(&store), Some(SAFE_FENCE_CHUNKER_VERSION));

        write_chunks(&store, "beta", false);
        assert_eq!(version_of(&store), Some(-1));

        write_chunks(&store, "beta", true);
        assert_eq!(version_of(&store), Some(SAFE_FENCE_CHUNKER_VERSION));

        // An empty seal stamps too (sealChunks([]) on SQL).
        store
            .upsert_chunks(
                "big",
                &[],
                &UpsertChunksOptions {
                    seal: true,
                    ..UpsertChunksOptions::default()
                },
            )
            .unwrap();
        assert_eq!(version_of(&store), Some(SAFE_FENCE_CHUNKER_VERSION));
    }
}
