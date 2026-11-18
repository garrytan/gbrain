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
use crate::pages::{PageRecord, ReadScope, find_in_scope, read_page, write_page};
use crate::sources::DEFAULT_SOURCE;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

const NEXT_CHUNK_ID: &str = "next_chunk_id";
const STATS: &str = "chunk_stats";
/// The longest term the index keeps, in bytes.
const MAX_TERM_BYTES: usize = 64;
/// The size a chunk aims for, in characters.
pub const CHUNK_TARGET_CHARS: usize = 1500;

/// ChunkInput fields that are kept on the chunk and returned by `get_chunks`. `model` is the label
/// the caller stamps on the chunk (the embedding model PGLite would record); no vector is stored.
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

/// `ChunkInput` of `src/core/types.ts`. Vectors are not stored; any `embedding*` field is
/// ignored.
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
}

impl ChunkRecord {
    pub(crate) fn to_chunk(&self) -> Value {
        let mut v = json!({
            "id": self.id,
            "page_id": self.page_id,
            "chunk_index": self.chunk_index,
            "chunk_text": self.chunk_text,
            "chunk_source": self.chunk_source,
            "modality": self.modality,
            "embedding": Value::Null,
            "model": self.meta.get("model").cloned().unwrap_or_else(|| json!("")),
            "token_count": self.meta.get("token_count").cloned().unwrap_or(Value::Null),
            "embedded_at": Value::Null,
            "has_embedding": false,
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

pub(crate) fn read_stats(read: &dyn KvRead) -> Result<ChunkStats> {
    Ok(get_json(read, &keys::meta(STATS))?.unwrap_or_default())
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

/// Removes every chunk of a page and its postings and updates the stats; returns what it removed.
/// It does not call the chunk-delete hook: `replace_chunks` keeps some of these ids.
fn drop_chunks(tx: &mut dyn KvWrite, page_id: u64) -> Result<Vec<ChunkRecord>> {
    let old = read_chunks(&*tx, page_id)?;
    if old.is_empty() {
        return Ok(old);
    }
    let mut stats = read_stats(&*tx)?;
    for chunk in &old {
        remove_chunk_record(tx, chunk, &mut stats)?;
    }
    put_json(tx, &keys::meta(STATS), &stats)?;
    Ok(old)
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
    stats: &mut ChunkStats,
) -> Result<()> {
    put_json(tx, &keys::chunk(record.page_id, record.chunk_index), record)?;
    if record.visible_at(view_generation) {
        put_postings(tx, record)?;
    }
    stats.chunks += 1;
    stats.total_length += u64::from(record.length);
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
    stats: &mut ChunkStats,
) -> Result<()> {
    delete_postings(tx, chunk)?;
    tx.delete(&keys::chunk(chunk.page_id, chunk.chunk_index))?;
    stats.chunks = stats.chunks.saturating_sub(1);
    stats.total_length = stats.total_length.saturating_sub(u64::from(chunk.length));
    Ok(())
}

/// Replaces a page's chunks with `chunks` (an empty list removes them all). A chunk that keeps
/// its index keeps its id; the chunk-delete hook gets the ids of the indexes that are gone. When `seal` is set the page's `text_projection_revision` becomes its
/// `knowledge_revision`: the chunks now describe the current text.
pub(crate) fn replace_chunks(
    tx: &mut dyn KvWrite,
    page: &mut PageRecord,
    chunks: &[ChunkInput],
    seal: bool,
    merge: bool,
) -> Result<()> {
    let previous: HashMap<u32, ChunkRecord> = read_chunks(&*tx, page.id)?
        .into_iter()
        .map(|c| (c.chunk_index, c))
        .collect();
    drop_chunks(tx, page.id)?;
    // The last chunk given for an index wins.
    let mut by_index: BTreeMap<u32, &ChunkInput> = BTreeMap::new();
    for chunk in chunks {
        by_index.insert(chunk.chunk_index, chunk);
    }
    let mut removed: Vec<u64> = previous
        .values()
        .filter(|old| !by_index.contains_key(&old.chunk_index))
        .map(|old| old.id)
        .collect();
    removed.sort_unstable();
    if !removed.is_empty() {
        crate::cascade::remove_chunk_rows(tx, page.id, &removed)?;
    }
    let mut stats = read_stats(&*tx)?;
    let view_generation = segment_view_generation(&*tx, page.id)?;
    for (index, input) in by_index {
        let source = checked_source(input)?;
        let text = input.chunk_text.replace('\0', "");
        let length = term_frequencies(&text).1;
        let id = match previous.get(&index) {
            Some(old) => old.id,
            None => next_chunk_id(tx)?,
        };
        let mut meta = kept_meta(input);
        // PGLite's incremental write: a chunk whose text did not change keeps the metadata the
        // new write leaves null (`COALESCE(new, old)`); `token_count` and `model` are the new
        // write's. A chunk whose text changed takes the new write's metadata outright.
        if let Some(old) = previous
            .get(&index)
            .filter(|old| merge && old.chunk_text == text)
        {
            for (key, value) in &old.meta {
                if key != "token_count" && key != "model" && !meta.contains_key(key) {
                    meta.insert(key.clone(), value.clone());
                }
            }
        }
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
            segment: previous.get(&index).and_then(|old| old.segment),
        };
        write_chunk(tx, &record, view_generation, &mut stats)?;
    }
    put_json(tx, &keys::meta(STATS), &stats)?;
    if seal {
        page.text_projection_revision = Some(page.knowledge_revision.clone());
        write_page(tx, page)?;
    }
    Ok(())
}

fn next_chunk_id(tx: &mut dyn KvWrite) -> Result<u64> {
    let key = keys::meta(NEXT_CHUNK_ID);
    let current = match tx.get(&key)? {
        Some(bytes) => keys::be8(&bytes)
            .ok_or_else(|| StoreError::new(crate::error::STORE_CORRUPT, "bad chunk id counter"))?,
        None => 1,
    };
    tx.put(&key, &(current + 1).to_be_bytes())?;
    Ok(current)
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

/// The page's visible chunks in document order (see the contract above).
pub(crate) fn visible_chunks(read: &dyn KvRead, page_id: u64) -> Result<Vec<ChunkRecord>> {
    let view = read_segment_view(read, page_id)?;
    let mut chunks: Vec<ChunkRecord> = read_chunks(read, page_id)?
        .into_iter()
        .filter(|c| c.visible_at(view.generation))
        .collect();
    // ORDER BY m.byte_start, cc.local_ordinal, cc.chunk_index, NULLs last.
    chunks.sort_by_key(|c| {
        let offset = c
            .segment
            .and_then(|place| view.offsets.get(&place.occurrence_id).copied());
        let ordinal = c.segment.map(|place| place.local_ordinal);
        (
            offset.is_none(),
            offset.unwrap_or(0),
            ordinal.is_none(),
            ordinal.unwrap_or(0),
            c.chunk_index,
        )
    });
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
    let mut stats = read_stats(&*tx)?;
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
        };
        write_chunk(tx, &record, view_generation, &mut stats)?;
        indexes.push(index);
    }
    put_json(tx, &keys::meta(STATS), &stats)?;
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
    let mut stats = read_stats(&*tx)?;
    for chunk in &gone {
        remove_chunk_record(tx, chunk, &mut stats)?;
    }
    put_json(tx, &keys::meta(STATS), &stats)?;
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
            if let Some(timeline) = options.search_timeline.as_deref().filter(|_| seal) {
                // The seal keeps the page's revision, so the text is recorded at it now.
                crate::pages::record_search_timeline(
                    tx,
                    page.id,
                    &page.knowledge_revision,
                    timeline,
                )?;
            }
            if chunks.is_empty() && !seal {
                // PGLite: an empty write removes the chunks and leaves the page unsealed.
                replace_chunks(tx, &mut page, chunks, false, true)?;
                if page.text_projection_revision.is_some() {
                    page.text_projection_revision = None;
                    write_page(tx, &page)?;
                }
                return Ok(());
            }
            replace_chunks(tx, &mut page, chunks, seal, !seal)
        })
    }

    /// `getChunks(slug, opts)`: the page's visible chunks in document order (inline chunks in
    /// index order), without vectors, while they
    /// describe the page's current text. PGLite reads a page's chunks only when its
    /// `text_projection_revision` equals its `knowledge_revision` (the chunks are sealed), so a page
    /// that was never sealed, or whose revision moved since (a tag change, a soft delete), reads as
    /// no chunks.
    pub fn get_chunks(&self, slug: &str, scope: &ReadScope) -> Result<Vec<Value>> {
        let read = self.read()?;
        let scope_default =
            if scope.source_id.is_none() && scope.source_ids.as_ref().is_none_or(Vec::is_empty) {
                Some(DEFAULT_SOURCE.to_string())
            } else {
                scope.source_id.clone()
            };
        // The slug is matched as written, and a soft-deleted page is read like a live one: PGLite's
        // chunk read has neither a case fold nor a `deleted_at` filter.
        let Some(page) = find_in_scope(&*read, slug, &scope_default, &scope.source_ids, true)?
        else {
            return Ok(Vec::new());
        };
        if page.text_projection_revision.as_deref() != Some(page.knowledge_revision.as_str()) {
            return Ok(Vec::new());
        }
        Ok(visible_chunks(&*read, page.id)?
            .iter()
            .map(ChunkRecord::to_chunk)
            .collect())
    }

    /// `deleteChunks(slug, {sourceId})`: removes the page's chunks. The page stays. When it removed
    /// any, the page's text seal is cleared, as PGLite's `deleteChunks` does: the seal certified the
    /// chunks that are gone, so a later unsealed `upsertChunks` stays unread until a new seal.
    pub fn delete_chunks(&self, slug: &str, source_id: Option<&str>) -> Result<()> {
        self.write(|tx| {
            let source = source_id.unwrap_or(DEFAULT_SOURCE);
            if let Some(mut page) = read_page(&*tx, source, &slug.to_lowercase())? {
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
}
