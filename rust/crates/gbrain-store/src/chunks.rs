//! Chunks and the keyword index.
//!
//! A page's chunks are records `K page_id chunk_index`. Every term of a chunk has a posting
//! `T term NUL page_id chunk_index -> term frequency`, written in the same transaction as the
//! chunk, so the index can never name a chunk that is not there. Replacing a page's chunks
//! removes the old postings first. Index-wide counts (chunks, total length) live under the meta
//! key `chunk_stats`; keyword search reads them for BM25.

use crate::error::{INVALID_ARGUMENT, PAGE_NOT_FOUND, REVISION_CONFLICT, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, ReadScope, find_in_scope, read_page, write_page};
use crate::sources::DEFAULT_SOURCE;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};

const NEXT_CHUNK_ID: &str = "next_chunk_id";
const STATS: &str = "chunk_stats";
/// The longest term the index keeps, in bytes.
const MAX_TERM_BYTES: usize = 64;
/// The size a chunk aims for, in characters.
pub const CHUNK_TARGET_CHARS: usize = 1500;

/// ChunkInput fields that are kept on the chunk and returned by `get_chunks`.
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
            "model": "",
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

/// Removes every chunk of a page and its postings; returns nothing and updates the stats.
pub(crate) fn clear_chunks(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    let old = read_chunks(&*tx, page_id)?;
    if old.is_empty() {
        return Ok(());
    }
    let mut stats = read_stats(&*tx)?;
    for chunk in &old {
        let (tf, _) = term_frequencies(&chunk.chunk_text);
        for term in tf.keys() {
            tx.delete(&keys::posting(term, page_id, chunk.chunk_index))?;
        }
        tx.delete(&keys::chunk(page_id, chunk.chunk_index))?;
        stats.chunks = stats.chunks.saturating_sub(1);
        stats.total_length = stats.total_length.saturating_sub(u64::from(chunk.length));
    }
    put_json(tx, &keys::meta(STATS), &stats)
}

/// Replaces a page's chunks with `chunks` (an empty list removes them all). A chunk that keeps
/// its index keeps its id. When `seal` is set the page's `text_projection_revision` becomes its
/// `knowledge_revision`: the chunks now describe the current text.
pub(crate) fn replace_chunks(
    tx: &mut dyn KvWrite,
    page: &mut PageRecord,
    chunks: &[ChunkInput],
    seal: bool,
) -> Result<()> {
    let previous: HashMap<u32, u64> = read_chunks(&*tx, page.id)?
        .into_iter()
        .map(|c| (c.chunk_index, c.id))
        .collect();
    clear_chunks(tx, page.id)?;
    // The last chunk given for an index wins.
    let mut by_index: BTreeMap<u32, &ChunkInput> = BTreeMap::new();
    for chunk in chunks {
        by_index.insert(chunk.chunk_index, chunk);
    }
    let mut stats = read_stats(&*tx)?;
    for (index, input) in by_index {
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
        let text = input.chunk_text.replace('\0', "");
        let (tf, length) = term_frequencies(&text);
        let id = match previous.get(&index) {
            Some(id) => *id,
            None => next_chunk_id(tx)?,
        };
        let meta: Map<String, Value> = input
            .rest
            .iter()
            .filter(|(k, v)| META_KEYS.contains(&k.as_str()) && !v.is_null())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let record = ChunkRecord {
            id,
            page_id: page.id,
            chunk_index: index,
            chunk_text: text,
            chunk_source: source,
            modality: input.modality.clone().unwrap_or_else(|| "text".into()),
            length,
            meta,
        };
        put_json(tx, &keys::chunk(page.id, index), &record)?;
        for (term, count) in &tf {
            tx.put(&keys::posting(term, page.id, index), &count.to_be_bytes())?;
        }
        stats.chunks += 1;
        stats.total_length += u64::from(length);
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

/// Options of `upsert_chunks`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpsertChunksOptions {
    pub source_id: Option<String>,
    /// When given, the page must be at this revision (`revision_conflict` otherwise) and the
    /// chunks are sealed to it.
    pub expected_revision: Option<String>,
    /// Do not seal even with `expected_revision`.
    pub defer_seal: bool,
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
            let seal = options.expected_revision.is_some() && !options.defer_seal;
            replace_chunks(tx, &mut page, chunks, seal)
        })
    }

    /// `getChunks(slug, opts)`: the page's chunks in index order, without vectors.
    pub fn get_chunks(&self, slug: &str, scope: &ReadScope) -> Result<Vec<Value>> {
        let read = self.read()?;
        let scope_default =
            if scope.source_id.is_none() && scope.source_ids.as_ref().is_none_or(Vec::is_empty) {
                Some(DEFAULT_SOURCE.to_string())
            } else {
                scope.source_id.clone()
            };
        let Some(page) = find_in_scope(
            &*read,
            &slug.to_lowercase(),
            &scope_default,
            &scope.source_ids,
            scope.include_deleted,
        )?
        else {
            return Ok(Vec::new());
        };
        Ok(read_chunks(&*read, page.id)?
            .iter()
            .map(ChunkRecord::to_chunk)
            .collect())
    }

    /// `deleteChunks(slug, {sourceId})`: removes the page's chunks. The page stays.
    pub fn delete_chunks(&self, slug: &str, source_id: Option<&str>) -> Result<()> {
        self.write(|tx| {
            let source = source_id.unwrap_or(DEFAULT_SOURCE);
            if let Some(page) = read_page(&*tx, source, &slug.to_lowercase())? {
                clear_chunks(tx, page.id)?;
            }
            Ok(())
        })
    }

    /// Number of chunks in the brain (every page, deleted or not).
    pub fn count_chunks(&self) -> Result<u64> {
        Ok(read_stats(&*self.read()?)?.chunks)
    }
}
