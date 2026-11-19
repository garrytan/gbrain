//! Vector search (core): an exact flat scan over the stored chunk and take vectors.
//!
//! Members: searchVector, searchTakesVector. `cosinesByChunkIds` is served beside the chunk
//! vector reads (`embeddings.rs`), with the scoring rule of this file (`served_cosine`).
//!
//! Keys: this family writes no records, so nothing lives under `keys::VECTOR` (`X`). The vectors
//! are the embeddings family's records (`B 'c'` chunk vectors, `B 't'` take vectors and the
//! `B 'g'` vector generation, `embeddings.rs`); this file only reads them, through
//! `scan_chunk_vectors`, `scan_take_vectors` and `vector_generation`.
//!
//! The contract is PGLite's (`src/core/search/vector-statement.ts`, `engine-sql/takes.ts`), with
//! the differences listed in `rust/docs/store/vectors.md`:
//! - Every stored vector is scored, so there is no candidate pool, no HNSW index and no pool
//!   escalation; every filter applies inside the scan, before ranking.
//! - The score is the cosine of the stored float32 vectors, summed in float64 and kept in
//!   [-1, 1] as pgvector keeps it. A zero vector on either side gives NaN, which ranks above every
//!   number (Postgres orders NaN as the largest value).
//! - A query vector PGLite cannot parse, and an offset its LIMIT/OFFSET cannot take, refuse with
//!   `invalid_argument` and the PostgreSQL message.
//!
//! The decoded vectors and their norms are kept in a [`VectorIndex`]. A [`VectorCache`] holds one
//! per store (`Store::vectors`), keyed by the vector generation, so a search after a vector write
//! rebuilds it and a search with no write between reuses the decoded vectors.

use crate::chunks::{ChunkRecord, visible_chunks};
use crate::config::read_config;
use crate::embeddings::{
    StoredVector, scan_chunk_vectors, scan_take_vectors, text_hash, vector_generation,
};
use crate::error::{Result, StoreError};
use crate::facts::{OwnerOnlyCache, PrivacyPolicy};
use crate::kv::{KvRead, KvWrite};
use crate::pages::{PageRecord, read_page_by_id};
use crate::sources::read_source;
use crate::takes::{TakeRecord, all_takes, real_out};
use crate::{Store, env::iso};
use serde::Deserialize;
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// `limit` default of `searchVector` (`clampSearchLimit(opts.limit, 20, cap)`).
const DEFAULT_VECTOR_LIMIT: u64 = 20;
/// `limit` default of `searchTakesVector` (`clampSearchLimit(opts.limit, 30, 100)`).
const DEFAULT_TAKES_LIMIT: u64 = 30;
/// The hard-exclude prefixes `resolveHardExcludes` starts from, for a caller that sends none.
const DEFAULT_HARD_EXCLUDES: &[&str] = &["test/", "attachments/", ".raw/"];
/// Frontmatter keys that hide a page whatever their value is (`buildVisibilityClause`).
const HIDING_FRONTMATTER_KEYS: &[&str] = &["quarantine", "pinned_question"];
/// `text_projection_revision` of a page whose pre-activation index is still served
/// (`ACTIVATION_SERVED_REVISION`, src/core/search/safe-chunks.ts).
const ACTIVATION_SERVED_REVISION: &str = "00000000-0000-0000-0000-000000000153";
/// `SAFE_FENCE_CHUNKER_VERSION` (src/core/search/safe-chunks.ts).
const SAFE_FENCE_CHUNKER_VERSION: i16 = 4;
/// A config row that, while present, hides every vector when no model is named.
const MIGRATION_STATE_KEY: &str = "embedding_migration.state";

/// `searchVector(embedding, opts)`, resolved by the TypeScript member: the limit is clamped,
/// the hard excludes, source scope and source factors are resolved, and the options this engine
/// cannot answer exactly have already refused.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct VectorSearchOptions {
    /// The clamped limit (default 20).
    pub limit: Option<u64>,
    /// `opts.offset || 0`: a number, or the text `Infinity` / `-Infinity` (JSON has no
    /// infinities).
    pub offset: Option<Value>,
    #[serde(rename = "type")]
    pub page_type: Option<String>,
    pub types: Option<Vec<String>>,
    pub exclude_slugs: Option<Vec<String>>,
    /// `resolveHardExcludes(exclude_slug_prefixes, include_slug_prefixes)`. Absent: the defaults.
    pub hard_excludes: Option<Vec<String>>,
    pub detail: Option<String>,
    pub language: Option<String>,
    #[serde(rename = "symbolKind")]
    pub symbol_kind: Option<String>,
    /// The source scope: `None` reads every source.
    pub source_ids: Option<Vec<String>>,
    /// The embedding model the guard requires. `None` is PGLite's NULL model: every vector, unless
    /// an embedding migration is running.
    pub model: Option<String>,
    /// Source factors as `[prefix, factor]`, already filtered and sorted longest prefix first.
    /// Empty when `detail` is high or no prefix applies.
    pub source_factors: Vec<(String, f64)>,
    /// `requiresSafeChunks(opts)`: only pages chunked by the safe fence chunker.
    pub require_safe_chunks: bool,
    /// `excludePrivate`: the page policy `buildVisibilityClause` adds (`privatePagesFilterForCaller('p')`), as
    /// `facts/privacy.rs` `page_hidden` reads it. `None` hides nothing.
    pub exclude_private: Option<PrivacyPolicy>,
}

/// `searchTakesVector(embedding, opts)`, resolved: `limit` is clamped by the TypeScript member.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TakesVectorOptions {
    pub limit: Option<u64>,
    pub allow_list: Option<Vec<Option<String>>>,
    pub source_ids: Option<Vec<Option<String>>>,
    /// A read-eligibility policy was given: hide takes of soft-deleted and quarantined pages.
    pub eligible_only: bool,
}

// ---------------------------------------------------------------------------------------------
// The index and its cache.

/// One decoded vector and its squared norm.
#[derive(Debug, Clone)]
struct IndexedVector {
    /// The page id of a chunk vector, the take id of a take vector.
    id: u64,
    chunk_index: u32,
    norm_sq: f64,
    vector: Box<[f32]>,
}

impl IndexedVector {
    fn new(stored: &StoredVector) -> Self {
        IndexedVector {
            id: stored.id,
            chunk_index: stored.chunk_index,
            norm_sq: dot(&stored.vector, &stored.vector),
            vector: stored.vector.clone().into_boxed_slice(),
        }
    }
}

/// Every stored vector of one snapshot: chunk vectors in (page id, chunk index) order, take
/// vectors in take id order.
#[derive(Debug, Default)]
pub(crate) struct VectorIndex {
    generation: u64,
    chunks: Vec<IndexedVector>,
    takes: Vec<IndexedVector>,
}

impl VectorIndex {
    fn build(read: &dyn KvRead, generation: u64) -> Result<Self> {
        let mut chunks = Vec::new();
        scan_chunk_vectors(read, &mut |v| {
            chunks.push(IndexedVector::new(v));
            true
        })?;
        let mut takes = Vec::new();
        scan_take_vectors(read, &mut |v| {
            takes.push(IndexedVector::new(v));
            true
        })?;
        Ok(VectorIndex {
            generation,
            chunks,
            takes,
        })
    }
}

/// One [`VectorIndex`] per store, rebuilt when the vector generation moves. Reads only committed
/// snapshots (`Store::read`), so a rolled-back write never reaches it. An older snapshot never
/// replaces a newer index.
#[derive(Debug, Default)]
pub(crate) struct VectorCache {
    slot: Mutex<Option<Arc<VectorIndex>>>,
}

impl VectorCache {
    /// The index of `read`'s snapshot, from the cache when its generation matches.
    pub(crate) fn index(&self, read: &dyn KvRead) -> Result<Arc<VectorIndex>> {
        let generation = vector_generation(read)?;
        {
            let slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(index) = slot.as_ref().filter(|i| i.generation == generation) {
                return Ok(Arc::clone(index));
            }
        }
        let built = Arc::new(VectorIndex::build(read, generation)?);
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_none_or(|i| i.generation < generation) {
            *slot = Some(Arc::clone(&built));
        }
        Ok(built)
    }
}

/// The index for one read: from `cache` when given, built from the snapshot otherwise.
fn load_index(read: &dyn KvRead, cache: Option<&VectorCache>) -> Result<Arc<VectorIndex>> {
    match cache {
        Some(cache) => cache.index(read),
        None => Ok(Arc::new(VectorIndex::build(
            read,
            vector_generation(read)?,
        )?)),
    }
}

// ---------------------------------------------------------------------------------------------
// Scoring.

/// The float64 dot product of two float32 vectors of one length. Eight independent lanes let the
/// compiler use SIMD registers; the lanes are added in a fixed order, so a result never depends on
/// the machine.
fn dot(a: &[f32], b: &[f32]) -> f64 {
    const LANES: usize = 8;
    let mut acc = [0f64; LANES];
    let (a_body, a_tail) = a.as_chunks::<LANES>();
    let (b_body, b_tail) = b.as_chunks::<LANES>();
    for (x, y) in a_body.iter().zip(b_body) {
        for lane in 0..LANES {
            acc[lane] += f64::from(x[lane]) * f64::from(y[lane]);
        }
    }
    let mut sum = acc.iter().sum::<f64>();
    for (x, y) in a_tail.iter().zip(b_tail) {
        sum += f64::from(*x) * f64::from(*y);
    }
    sum
}

/// pgvector's cosine similarity: `dot / sqrt(|a|² |b|²)`, kept in [-1, 1]. A zero vector gives
/// NaN (positive, so it orders as the largest value).
fn cosine(query: &[f32], query_norm_sq: f64, stored: &IndexedVector) -> f64 {
    let similarity = dot(query, &stored.vector) / (query_norm_sq * stored.norm_sq).sqrt();
    if similarity.is_nan() {
        f64::NAN
    } else {
        similarity.clamp(-1.0, 1.0)
    }
}

/// The squared length of a vector, summed in float64.
pub(crate) fn norm_sq(vector: &[f32]) -> f64 {
    dot(vector, vector)
}

/// The text-space cosine `cosinesByChunkIds` reports for one served stored vector
/// (`cosineByChunkIdsStatement`): another dimension count, a zero vector or a zero query scores 0
/// without a comparison; otherwise `1 - (stored <=> query)`, with pgvector's cosine kept in [-1, 1].
pub(crate) fn served_cosine(query: &[f32], query_norm_sq: f64, stored: &[f32]) -> f64 {
    if stored.len() != query.len() {
        return 0.0;
    }
    let stored_norm_sq = dot(stored, stored);
    if stored_norm_sq == 0.0 || query_norm_sq == 0.0 {
        return 0.0;
    }
    let similarity = dot(query, stored) / (query_norm_sq * stored_norm_sq).sqrt();
    1.0 - (1.0 - similarity.clamp(-1.0, 1.0))
}

/// `ORDER BY score DESC` with NaN first, as Postgres orders a float.
fn score_desc(a: f64, b: f64) -> Ordering {
    b.total_cmp(&a)
}

// ---------------------------------------------------------------------------------------------
// Refusals PGLite raises before it reads a row.

/// The text JavaScript gives a number, for a message that names one.
fn js_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_string()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
    } else if value != 0.0 && (value.abs() < 1e-6 || value.abs() >= 1e21) {
        let text = format!("{value:e}");
        match text.split_once('e') {
            Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
            _ => text,
        }
    } else {
        format!("{value}")
    }
}

/// pgvector's parse of the query vector: at least one dimension, every value finite and within float4 range (pgvector
/// reads each value as a float4 and refuses one out of range; a plain cast would turn it into an infinity).
pub(crate) fn check_query(query: &[f64]) -> Result<Vec<f32>> {
    if query.is_empty() {
        return Err(StoreError::invalid("vector must have at least 1 dimension"));
    }
    for value in query {
        if value.is_nan() {
            return Err(StoreError::invalid("NaN not allowed in vector"));
        }
        if value.is_infinite() {
            return Err(StoreError::invalid("infinite value not allowed in vector"));
        }
        // Rounds as strtof does: a value that rounds past f32::MAX overflows (ERANGE in pgvector).
        if (*value as f32).is_infinite() {
            return Err(StoreError::invalid(format!(
                "\"{value}\" is out of range for type vector"
            )));
        }
    }
    Ok(query.iter().map(|v| *v as f32).collect())
}

fn dims_mismatch(query: usize, stored: usize) -> StoreError {
    StoreError::invalid(format!("different vector dimensions {query} and {stored}"))
}

/// The offset as a row count, after the checks PGLite's statement makes: its candidate limit
/// (`offset + max(limit * 5, 100)`) must be a non-negative integer, then the offset must not be
/// negative.
fn resolve_offset(offset: &Option<Value>, limit: u64) -> Result<usize> {
    let offset = match offset {
        None | Some(Value::Null) => 0.0,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) if s == "Infinity" => f64::INFINITY,
        Some(Value::String(s)) if s == "-Infinity" => f64::NEG_INFINITY,
        Some(other) => {
            return Err(StoreError::invalid(format!(
                "searchVector: offset must be a number, got {other}"
            )));
        }
    };
    let inner = offset + (limit as f64 * 5.0).max(100.0);
    if inner.fract() != 0.0 || !inner.is_finite() {
        return Err(StoreError::invalid(format!(
            "invalid input syntax for type integer: \"{}\"",
            js_number(inner)
        )));
    }
    if inner < 0.0 {
        return Err(StoreError::invalid("LIMIT must not be negative"));
    }
    if offset < 0.0 {
        return Err(StoreError::invalid("OFFSET must not be negative"));
    }
    // A float past usize::MAX saturates; it skips every row either way.
    Ok(offset as usize)
}

// ---------------------------------------------------------------------------------------------
// Filters.

/// `p.frontmatter->>key`: a string as is, JSON null as NULL, anything else as its jsonb text.
fn frontmatter_text(page: &PageRecord, key: &str) -> Option<String> {
    match page.frontmatter.get(key)? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(crate::timeline_queries::jsonb_text(other)),
    }
}

/// Postgres `[[:space:]]`.
fn pg_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\x0b' | '\x0c' | '\r')
}

/// An unverified auto-extracted stub never takes a source factor (issue #160).
fn unverified_stub(page: &PageRecord) -> bool {
    frontmatter_text(page, "provenance").as_deref() == Some("auto-extracted")
        && frontmatter_text(page, "status").as_deref() == Some("unverified")
}

/// `buildSourceFactorCase('slug', boosts, detail, 'unverified_stub')`.
fn source_factor(page: &PageRecord, factors: &[(String, f64)]) -> f64 {
    if factors.is_empty() || unverified_stub(page) {
        return 1.0;
    }
    factors
        .iter()
        .find(|(prefix, _)| page.slug.starts_with(prefix.as_str()))
        .map_or(1.0, |(_, factor)| *factor)
}

/// The page-level filters of the scan; `archived` caches each source's archive flag.
fn page_passes(
    read: &dyn KvRead,
    page: &PageRecord,
    options: &VectorSearchOptions,
    hard_excludes: &[String],
    archived: &mut HashMap<String, bool>,
    owner_only: &mut OwnerOnlyCache,
) -> Result<bool> {
    let served = page.text_projection_revision.as_deref() == Some(page.knowledge_revision.as_str())
        || page.text_projection_revision.as_deref() == Some(ACTIVATION_SERVED_REVISION);
    let hidden = page.deleted_at_us.is_some()
        || !served
        || HIDING_FRONTMATTER_KEYS
            .iter()
            .any(|key| page.frontmatter.contains_key(*key))
        || options
            .page_type
            .as_ref()
            .is_some_and(|t| !t.is_empty() && *t != page.page_type)
        || options
            .types
            .as_ref()
            .is_some_and(|ts| !ts.is_empty() && !ts.contains(&page.page_type))
        || options
            .exclude_slugs
            .as_ref()
            .is_some_and(|slugs| slugs.contains(&page.slug))
        || hard_excludes
            .iter()
            .any(|p| !p.is_empty() && page.slug.starts_with(p.as_str()))
        || options
            .source_ids
            .as_ref()
            .is_some_and(|ids| !ids.contains(&page.source_id))
        // `safeChunksFilter` is `chunker_version >= 4`: a page that records no version is not safe (the SQL
        // comparison is NULL), the same rule as the keyword gate and the relational evidence gate.
        || (options.require_safe_chunks
            && !page
                .chunker_version
                .is_some_and(|v| v >= SAFE_FENCE_CHUNKER_VERSION));
    if hidden {
        return Ok(false);
    }
    if let Some(policy) = &options.exclude_private
        && owner_only.page_hidden(read, page, policy)?
    {
        return Ok(false);
    }
    let is_archived = match archived.get(&page.source_id) {
        Some(a) => *a,
        None => {
            let a = read_source(read, &page.source_id)?.is_some_and(|s| s.archived);
            archived.insert(page.source_id.clone(), a);
            a
        }
    };
    Ok(!is_archived)
}

/// PGLite's guard for a named model: `cc.model = $model AND (cc.embedded_text_hash =
/// md5(cc.chunk_text) OR cc.embedded_text_hash IS NULL)`. The chunk record keeps the model label and
/// the hash of the text its vector was computed from (`chunks::EmbedState`).
fn written_by(chunk: &ChunkRecord, model: &str) -> bool {
    chunk.meta.get("model").and_then(Value::as_str) == Some(model)
        && chunk
            .embed
            .text_hash
            .as_deref()
            .is_none_or(|hash| hash == text_hash(&chunk.chunk_text))
}

/// The chunk-level filters of the scan.
fn chunk_passes(chunk: &ChunkRecord, options: &VectorSearchOptions) -> bool {
    let meta_is = |key: &str, want: &Option<String>| match want.as_deref() {
        None | Some("") => true,
        Some(want) => chunk.meta.get(key).and_then(Value::as_str) == Some(want),
    };
    chunk.modality == "text"
        && !(options.detail.as_deref() == Some("low") && chunk.chunk_source != "compiled_truth")
        && meta_is("language", &options.language)
        && meta_is("symbol_type", &options.symbol_kind)
}

/// `holder = ANY(list)` when a list is given (a null element matches nothing).
fn holder_allowed(list: &Option<Vec<Option<String>>>, holder: &str) -> bool {
    list.as_ref()
        .is_none_or(|l| l.iter().any(|h| h.as_deref() == Some(holder)))
}

/// `p.source_id = ANY(list)` when a scope is given.
fn take_in_scope(scope: &Option<Vec<Option<String>>>, source_id: &str) -> bool {
    scope
        .as_ref()
        .is_none_or(|l| l.iter().any(|s| s.as_deref() == Some(source_id)))
}

// ---------------------------------------------------------------------------------------------
// The searches.

/// One page's best chunk so far.
struct Hit {
    page: PageRecord,
    chunk: ChunkRecord,
    score: f64,
}

fn search_chunks(
    read: &dyn KvRead,
    index: &VectorIndex,
    query: &[f64],
    options: &VectorSearchOptions,
) -> Result<Vec<Value>> {
    let query = check_query(query)?;
    let limit = options.limit.unwrap_or(DEFAULT_VECTOR_LIMIT);
    let offset = resolve_offset(&options.offset, limit)?;
    let limit = limit as usize;
    let hard_excludes: Vec<String> = options.hard_excludes.clone().unwrap_or_else(|| {
        DEFAULT_HARD_EXCLUDES
            .iter()
            .map(|s| s.to_string())
            .collect()
    });
    let query_norm_sq = dot(&query, &query);
    // Read once, and only when the guard needs it.
    let mut migrating: Option<bool> = None;
    let mut archived: HashMap<String, bool> = HashMap::new();
    let mut owner_only = OwnerOnlyCache::default();
    let mut hits: Vec<Hit> = Vec::new();

    for group in index.chunks.chunk_by(|a, b| a.id == b.id) {
        let page_id = group[0].id;
        let Some(page) = read_page_by_id(read, page_id)? else {
            continue;
        };
        if !page_passes(
            read,
            &page,
            options,
            &hard_excludes,
            &mut archived,
            &mut owner_only,
        )? {
            continue;
        }
        let mut chunks: HashMap<u32, ChunkRecord> = visible_chunks(read, page_id)?
            .into_iter()
            .map(|c| (c.chunk_index, c))
            .collect();
        let factor = source_factor(&page, &options.source_factors);
        let mut best: Option<(f64, ChunkRecord)> = None;
        for stored in group {
            let Some(chunk) = chunks.get(&stored.chunk_index) else {
                continue;
            };
            if !chunk_passes(chunk, options) {
                continue;
            }
            if stored.vector.len() != query.len() {
                return Err(dims_mismatch(query.len(), stored.vector.len()));
            }
            let fresh = match options.model.as_deref() {
                Some(model) => written_by(chunk, model),
                None => {
                    !*migrating.get_or_insert(read_config(read, MIGRATION_STATE_KEY)?.is_some())
                }
            };
            if !fresh {
                continue;
            }
            // `1 - (embedding <=> q)`, then the source factor.
            let raw = 1.0 - (1.0 - cosine(&query, query_norm_sq, stored));
            let score = if raw.is_nan() { f64::NAN } else { raw * factor };
            let replace = match &best {
                None => true,
                Some((current, kept)) => match score_desc(score, *current) {
                    Ordering::Less => true,
                    Ordering::Equal => chunk.id < kept.id,
                    Ordering::Greater => false,
                },
            };
            if replace {
                let chunk = chunks.remove(&stored.chunk_index).expect("present above");
                best = Some((score, chunk));
            }
        }
        if let Some((score, chunk)) = best {
            hits.push(Hit { page, chunk, score });
        }
    }

    hits.sort_by(|a, b| {
        score_desc(a.score, b.score)
            .then(a.page.id.cmp(&b.page.id))
            .then(a.chunk.id.cmp(&b.chunk.id))
    });
    hits.into_iter()
        .skip(offset)
        .take(limit)
        .map(|hit| hit_row(read, hit))
        .collect()
}

/// The row `rowToSearchResult` reads. A NaN score goes out as null (JSON has no NaN).
fn hit_row(read: &dyn KvRead, hit: Hit) -> Result<Value> {
    let Hit { page, chunk, score } = hit;
    // PGLite's rule: a page is stale when a timeline entry was added after its last write.
    let stale = crate::timeline::latest_entry_micros(read, page.id)?
        .is_some_and(|latest| page.updated_at_us < latest);
    let mut row = json!({
        "slug": page.slug,
        "page_id": page.id,
        "title": page.title,
        "type": page.page_type,
        "source_id": page.source_id,
        "chunk_text": chunk.chunk_text,
        "chunk_source": chunk.chunk_source,
        "chunk_id": chunk.id,
        "chunk_index": chunk.chunk_index,
        "score": if score.is_nan() { Value::Null } else { json!(score) },
        "stale": stale,
    });
    if let Some(us) = page.effective_date_us {
        row["effective_date"] = Value::String(iso(us)[..10].to_string());
    }
    if let Some(source) = &page.effective_date_source {
        row["effective_date_source"] = Value::String(source.clone());
    }
    let message_id =
        frontmatter_text(&page, "message_id").filter(|m| !m.trim_matches(pg_space).is_empty());
    if let Some(thread) = frontmatter_text(&page, "thread_id") {
        row["thread_id"] = Value::String(thread);
    }
    if let Some(message) = message_id {
        row["message_id"] = Value::String(message);
        if let Some(subject) = frontmatter_text(&page, "subject").filter(|s| !s.is_empty()) {
            row["source_subject"] = Value::String(subject);
        }
    }
    Ok(row)
}

fn search_takes(
    read: &dyn KvRead,
    index: &VectorIndex,
    query: &[f64],
    options: &TakesVectorOptions,
) -> Result<Vec<Value>> {
    let query = check_query(query)?;
    let limit = options.limit.unwrap_or(DEFAULT_TAKES_LIMIT) as usize;
    if index.takes.is_empty() {
        return Ok(Vec::new());
    }
    let query_norm_sq = dot(&query, &query);
    let mut takes: HashMap<u64, TakeRecord> =
        all_takes(read)?.into_iter().map(|t| (t.id, t)).collect();
    let mut pages: HashMap<u64, Option<PageRecord>> = HashMap::new();
    // (distance, take, page slug)
    let mut hits: Vec<(f64, TakeRecord, String)> = Vec::new();
    for stored in &index.takes {
        let Some(take) = takes.get(&stored.id) else {
            continue;
        };
        if !take.active || !holder_allowed(&options.allow_list, &take.holder) {
            continue;
        }
        let page = match pages.entry(take.page_id) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(read_page_by_id(read, take.page_id)?)
            }
        };
        let Some(page) = page.as_ref() else {
            continue;
        };
        let eligible = page.deleted_at_us.is_none() && !page.frontmatter.contains_key("quarantine");
        if !take_in_scope(&options.source_ids, &page.source_id)
            || (options.eligible_only && !eligible)
        {
            continue;
        }
        if stored.vector.len() != query.len() {
            return Err(dims_mismatch(query.len(), stored.vector.len()));
        }
        let distance = 1.0 - cosine(&query, query_norm_sq, stored);
        let slug = page.slug.clone();
        let take = takes.remove(&stored.id).expect("present above");
        hits.push((distance, take, slug));
    }
    // `ORDER BY embedding <=> q`: nearest first, NaN last; equal distances by take id.
    hits.sort_by(|(da, a, _), (db, b, _)| da.total_cmp(db).then(a.id.cmp(&b.id)));
    Ok(hits
        .iter()
        .take(limit)
        .map(|(distance, t, slug)| {
            let score = real_out((1.0 - distance) as f32);
            json!({
                "take_id": t.id,
                "page_id": t.page_id,
                "page_slug": slug,
                "row_num": t.row_num,
                "claim": t.claim,
                "kind": t.kind,
                "holder": t.holder,
                "weight": real_out(t.weight),
                "since_date": t.since_date,
                "until_date": t.until_date,
                "source": t.source,
                "score": if score.is_nan() { Value::Null } else { json!(score) },
            })
        })
        .collect())
}

impl Store {
    /// `searchVector(embedding, opts)`: one row per page (its best chunk), best score first,
    /// then page id, then chunk id.
    pub fn search_vector(
        &self,
        query: &[f64],
        options: &VectorSearchOptions,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let index = load_index(&*read, Some(&self.vectors))?;
        search_chunks(&*read, &index, query, options)
    }

    /// `searchTakesVector(embedding, opts)`: active takes with a vector, nearest first.
    pub fn search_takes_vector(
        &self,
        query: &[f64],
        options: &TakesVectorOptions,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let index = load_index(&*read, Some(&self.vectors))?;
        search_takes(&*read, &index, query, options)
    }
}

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`).
/// This family keeps no records: the vectors are the embeddings family's.
pub(crate) fn remove_page_rows(_tx: &mut dyn KvWrite, _page: &PageRecord) -> Result<()> {
    Ok(())
}

/// Deletes this family's records of chunks that are gone (`cascade::remove_chunk_rows`).
/// This family keeps no records: the vectors are the embeddings family's.
pub(crate) fn remove_chunk_rows(
    _tx: &mut dyn KvWrite,
    _page_id: u64,
    _chunk_ids: &[u64],
) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Vectors are written through the members that write them (`upsertChunks` with an
    //! `embedding`, `updateTakeEmbeddings`); the crate-private cache is tested here too. The
    //! refusals through the public API are in `tests/vectors.rs`.
    use super::*;
    use crate::chunks::{ChunkInput, UpsertChunksOptions};
    use crate::embeddings::TakeEmbeddingInput;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::sources::SourceInput;
    use crate::takes::TakeInput;
    use crate::test_support::store;

    #[test]
    fn a_query_value_beyond_float4_range_is_refused_not_turned_into_infinity() {
        // pgvector parses each value as a float4 and refuses one out of its range; a cast would make it infinite.
        for value in [1e39, -1e39, f64::from(f32::MAX) * 2.0] {
            let error = check_query(&[0.5, value]).expect_err("out of range");
            assert_eq!(error.code, crate::error::INVALID_ARGUMENT, "{value}");
        }
        assert_eq!(
            check_query(&[f64::from(f32::MAX), f64::from(f32::MIN)]).unwrap(),
            vec![f32::MAX, f32::MIN]
        );
    }

    const MODEL: &str = "openai:text-embedding-3-large";

    /// A sealed page whose chunk `i` holds `vectors[i]` (no vector for an empty one), written by
    /// `MODEL`. The brain's `embedding_dimensions` is set to the vectors' width first.
    fn page(store: &Store, source: &str, slug: &str, vectors: &[Vec<f32>], extra: Value) -> u64 {
        let mut input =
            json!({"type": "note", "title": slug, "compiled_truth": format!("body {slug}")});
        if let (Some(obj), Value::Object(more)) = (input.as_object_mut(), extra) {
            obj.extend(more);
        }
        let input: PageInput = serde_json::from_value(input).unwrap();
        let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
        store.put_page(slug, &input, &opts).unwrap();
        if let Some(v) = vectors.iter().find(|v| !v.is_empty()) {
            store
                .set_config("embedding_dimensions", &v.len().to_string())
                .unwrap();
        }
        let chunks: Vec<ChunkInput> = vectors
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let mut chunk = json!({
                    "chunk_index": i, "chunk_text": format!("body {slug} {i}"),
                    "chunk_source": if i == 1 { "timeline" } else { "compiled_truth" },
                });
                if !v.is_empty() {
                    chunk["embedding"] = json!(v);
                    chunk["model"] = json!(MODEL);
                }
                serde_json::from_value(chunk).unwrap()
            })
            .collect();
        let up: UpsertChunksOptions =
            serde_json::from_value(json!({"sourceId": source, "seal": true})).unwrap();
        store.upsert_chunks(slug, &chunks, &up).unwrap();
        crate::pages::read_page(&*store.read().unwrap(), source, slug)
            .unwrap()
            .unwrap()
            .id
    }

    fn axis(i: usize, dims: usize) -> Vec<f32> {
        let mut v = vec![0.0; dims];
        v[i] = 1.0;
        v
    }

    fn q(values: &[f32]) -> Vec<f64> {
        values.iter().map(|v| f64::from(*v)).collect()
    }

    fn names(rows: &[Value]) -> Vec<String> {
        rows.iter()
            .map(|r| {
                let score = r["score"]
                    .as_f64()
                    .map_or("NaN".to_string(), |s| format!("{s:.4}"));
                format!(
                    "{}#{} {score}",
                    r["slug"].as_str().unwrap(),
                    r["chunk_index"]
                )
            })
            .collect()
    }

    fn opts(v: Value) -> VectorSearchOptions {
        serde_json::from_value(v).unwrap()
    }

    fn corpus() -> Store {
        let s = store();
        page(&s, "default", "a-exact", &[axis(0, 4)], json!({}));
        page(
            &s,
            "default",
            "b-tie1",
            &[vec![0.0, 1.0, 1.0, 0.0]],
            json!({}),
        );
        page(
            &s,
            "default",
            "c-tie2",
            &[vec![0.0, 1.0, 1.0, 0.0]],
            json!({}),
        );
        page(
            &s,
            "default",
            "d-multi",
            &[axis(1, 4), vec![1.0, 0.1, 0.0, 0.0]],
            json!({}),
        );
        page(
            &s,
            "default",
            "e-opposite",
            &[vec![-1.0, 0.0, 0.0, 0.0]],
            json!({}),
        );
        s
    }

    #[test]
    fn ranks_best_chunk_per_page_with_ties_by_page() {
        let s = corpus();
        let rows = s.search_vector(&q(&axis(0, 4)), &opts(json!({}))).unwrap();
        assert_eq!(
            names(&rows),
            [
                "a-exact#0 1.0000",
                "d-multi#1 0.9950",
                "b-tie1#0 0.0000",
                "c-tie2#0 0.0000",
                "e-opposite#0 -1.0000"
            ]
        );
        let mut keys: Vec<&String> = rows[0].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "chunk_id",
                "chunk_index",
                "chunk_source",
                "chunk_text",
                "page_id",
                "score",
                "slug",
                "source_id",
                "stale",
                "title",
                "type"
            ]
        );
        // A scaled query ranks the same; limit and offset cut the ranked list.
        let scaled = s
            .search_vector(&q(&[3.0, 0.0, 0.0, 0.0]), &opts(json!({})))
            .unwrap();
        assert_eq!(names(&scaled), names(&rows));
        let page2 = s
            .search_vector(&q(&axis(0, 4)), &opts(json!({"limit": 2, "offset": 2})))
            .unwrap();
        assert_eq!(names(&page2), ["b-tie1#0 0.0000", "c-tie2#0 0.0000"]);
        let past = s
            .search_vector(&q(&axis(0, 4)), &opts(json!({"offset": 3e9})))
            .unwrap();
        assert!(past.is_empty());
    }

    #[test]
    fn zero_query_gives_nan_rows_in_page_order() {
        let s = corpus();
        let rows = s.search_vector(&[0.0; 4], &opts(json!({}))).unwrap();
        assert_eq!(
            names(&rows),
            [
                "a-exact#0 NaN",
                "b-tie1#0 NaN",
                "c-tie2#0 NaN",
                "d-multi#0 NaN",
                "e-opposite#0 NaN"
            ]
        );
    }

    #[test]
    fn refuses_what_pglite_refuses_in_its_order() {
        let s = corpus();
        let err = |query: &[f64], o: Value| s.search_vector(query, &opts(o)).unwrap_err();
        let good = q(&axis(0, 4));
        let msg = |e: StoreError| (e.code, e.message);
        let invalid = |m: &str| ("invalid_argument", m.to_string());
        assert_eq!(
            msg(err(&[], json!({}))),
            invalid("vector must have at least 1 dimension")
        );
        assert_eq!(
            msg(err(&[1.0, f64::NAN, f64::INFINITY], json!({}))),
            invalid("NaN not allowed in vector")
        );
        assert_eq!(
            msg(err(&[f64::NEG_INFINITY], json!({}))),
            invalid("infinite value not allowed in vector")
        );
        assert_eq!(
            msg(err(&good, json!({"offset": 1.5}))),
            invalid("invalid input syntax for type integer: \"101.5\"")
        );
        assert_eq!(
            msg(err(&good, json!({"offset": "Infinity"}))),
            invalid("invalid input syntax for type integer: \"Infinity\"")
        );
        assert_eq!(
            msg(err(&good, json!({"offset": "-Infinity"}))),
            invalid("invalid input syntax for type integer: \"-Infinity\"")
        );
        assert_eq!(
            msg(err(&good, json!({"offset": -200}))),
            invalid("LIMIT must not be negative")
        );
        assert_eq!(
            msg(err(&good, json!({"offset": -1}))),
            invalid("OFFSET must not be negative")
        );
        assert_eq!(
            msg(err(&[0.1; 8], json!({}))),
            invalid("different vector dimensions 8 and 4")
        );
        // A filter that leaves no candidate leaves nothing to compare.
        assert!(
            s.search_vector(&[0.1; 8], &opts(json!({"type": "person"})))
                .unwrap()
                .is_empty()
        );
        // The model guard runs after the dimension check.
        assert_eq!(
            msg(err(&[0.1; 8], json!({"model": "zzz"}))),
            invalid("different vector dimensions 8 and 4")
        );
        // An empty store has no vector to compare.
        assert!(
            store()
                .search_vector(&[0.1; 8], &opts(json!({})))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn filters_apply_before_ranking() {
        let s = corpus();
        let src: SourceInput =
            serde_json::from_value(json!({"id": "src-b", "name": "src-b"})).unwrap();
        s.upsert_source(&src).unwrap();
        let arch: SourceInput =
            serde_json::from_value(json!({"id": "src-arch", "name": "src-arch"})).unwrap();
        s.upsert_source(&arch).unwrap();
        page(&s, "src-b", "f-srcb", &[axis(0, 4)], json!({}));
        page(&s, "src-arch", "g-archived", &[axis(0, 4)], json!({}));
        s.set_source_archived("src-arch", true).unwrap();
        page(&s, "default", "h-deleted", &[axis(0, 4)], json!({}));
        s.soft_delete_page("h-deleted", None).unwrap();
        page(
            &s,
            "default",
            "i-quarantined",
            &[axis(0, 4)],
            json!({"frontmatter": {"quarantine": true}}),
        );
        page(
            &s,
            "default",
            "j-pinned",
            &[axis(0, 4)],
            json!({"frontmatter": {"pinned_question": "x"}}),
        );
        page(&s, "default", "test/k-hidden", &[axis(0, 4)], json!({}));
        page(
            &s,
            "default",
            "l-person",
            &[axis(0, 4)],
            json!({"type": "person"}),
        );
        let top = |o: Value| -> Vec<String> {
            let rows = s.search_vector(&q(&axis(0, 4)), &opts(o)).unwrap();
            rows.iter()
                .map(|r| r["slug"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(top(json!({"limit": 3})), ["a-exact", "f-srcb", "l-person"]);
        assert_eq!(top(json!({"type": "person"})), ["l-person"]);
        assert_eq!(top(json!({"types": ["person", "x"]})), ["l-person"]);
        assert_eq!(top(json!({"source_ids": ["src-b"]})), ["f-srcb"]);
        assert_eq!(
            top(json!({"source_ids": ["src-arch"]})),
            Vec::<String>::new()
        );
        assert_eq!(
            top(json!({"exclude_slugs": ["a-exact"], "limit": 1})),
            ["f-srcb"]
        );
        assert_eq!(
            top(json!({"hard_excludes": [], "limit": 3})),
            ["a-exact", "f-srcb", "test/k-hidden"]
        );
        assert_eq!(
            top(json!({"hard_excludes": ["a-"], "limit": 1})),
            ["f-srcb"]
        );
        // Detail low drops the timeline chunk, so d-multi falls back to its other chunk.
        let low = s
            .search_vector(&q(&axis(0, 4)), &opts(json!({"detail": "low"})))
            .unwrap();
        assert!(names(&low).contains(&"d-multi#0 0.0000".to_string()));
        // Safe readers see a page only when its recorded chunker is at or above the safe fence chunker. A page
        // that records no version (a store written before chunks were stamped) is not certified safe: SQL's
        // `chunker_version >= 4` is NULL, and the keyword gate refuses it too.
        assert_eq!(
            top(json!({"require_safe_chunks": true, "limit": 1})),
            ["a-exact"]
        );
        let stamp = |version: Option<i16>| {
            s.write(|tx| {
                let mut p = crate::pages::read_page(&*tx, "default", "a-exact")?.unwrap();
                p.chunker_version = version;
                crate::pages::write_page(tx, &p)?;
                Ok(())
            })
            .unwrap();
        };
        stamp(None);
        assert_eq!(
            top(json!({"require_safe_chunks": true, "limit": 1})),
            ["f-srcb"]
        );
        // A page recorded as chunked before the safe fence chunker drops out too.
        stamp(Some(3));
        assert_eq!(
            top(json!({"require_safe_chunks": true, "limit": 1})),
            ["f-srcb"]
        );
        assert_eq!(top(json!({"limit": 1})), ["a-exact"]);
        // The model guard: the named model only; no model reads every vector until a migration starts.
        assert_eq!(top(json!({"model": MODEL, "limit": 1})), ["a-exact"]);
        assert!(top(json!({"model": "other:model"})).is_empty());
        s.set_config(MIGRATION_STATE_KEY, "running").unwrap();
        assert!(top(json!({})).is_empty());
        assert_eq!(top(json!({"model": MODEL, "limit": 1})), ["a-exact"]);
    }

    /// `excludePrivate` adds the page policy `privatePagesFilterForCaller('p')` before ranking: a hidden page never
    /// takes a result slot (so a limit counts only visible pages), whatever its score.
    #[test]
    fn exclude_private_hides_the_pages_the_page_policy_hides() {
        let s = corpus();
        page(
            &s,
            "default",
            "m-visibility",
            &[axis(0, 4)],
            json!({"frontmatter": {"visibility": "private"}}),
        );
        page(
            &s,
            "default",
            "n-access",
            &[axis(0, 4)],
            json!({"frontmatter": {"access": "private"}}),
        );
        page(
            &s,
            "default",
            "o-public",
            &[axis(0, 4)],
            json!({"frontmatter": {"visibility": "public", "access": "private"}}),
        );
        // A derived page (an atom) is private unless it says otherwise.
        page(
            &s,
            "default",
            "p-atom",
            &[axis(0, 4)],
            json!({"type": "atom"}),
        );
        let top = |o: Value| -> Vec<String> {
            let rows = s.search_vector(&q(&axis(0, 4)), &opts(o)).unwrap();
            rows.iter()
                .map(|r| r["slug"].as_str().unwrap().to_string())
                .collect()
        };
        let all = ["a-exact", "m-visibility", "n-access", "o-public", "p-atom"];
        assert_eq!(top(json!({"limit": 5})), all);
        let policy = json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "lineage"});
        // The limit counts visible pages only: the hidden pages tie at the top score and take no slot.
        assert_eq!(
            top(json!({"limit": 3, "exclude_private": policy})),
            ["a-exact", "o-public", "d-multi"]
        );
        assert_eq!(
            top(json!({"limit": 2, "exclude_private": policy})),
            ["a-exact", "o-public"]
        );
        assert_eq!(
            top(json!({"limit": 1, "offset": 1, "exclude_private": policy})),
            ["o-public"]
        );
        // Without the alias keys only `visibility` (and a derived page's default) hides a page.
        let visibility_only =
            json!({"honorAliases": false, "entityPrivacy": true, "ownerOnly": "lineage"});
        assert_eq!(
            top(json!({"limit": 3, "exclude_private": visibility_only})),
            ["a-exact", "n-access", "o-public"]
        );
        // With the privacy part of the entity gate relaxed, only the member-access part applies: nothing here is hidden.
        let relaxed = json!({"honorAliases": true, "entityPrivacy": false, "ownerOnly": "lineage"});
        assert_eq!(top(json!({"limit": 5, "exclude_private": relaxed})), all);
        // `null` (excludePrivate off) hides nothing, and the policy composes with the other filters.
        assert_eq!(top(json!({"limit": 5, "exclude_private": null})), all);
        assert_eq!(
            top(json!({"exclude_private": policy, "type": "atom"})),
            Vec::<String>::new()
        );
        assert_eq!(
            top(json!({"exclude_private": policy, "exclude_slugs": ["a-exact"], "limit": 2})),
            ["o-public", "d-multi"]
        );
    }

    /// The owner-only part of the page policy: a page of an owner-only source never takes a result slot, nor (under the
    /// lineage form) a concept synthesized from one; under the closed form no page is served while the brain holds an
    /// owner-only source. A relaxed privacy part keeps it.
    #[test]
    fn exclude_private_hides_owner_only_pages_and_what_is_derived_from_them() {
        let s = corpus();
        let source: crate::sources::SourceInput =
            serde_json::from_value(json!({"id": "vault", "config": {"owner_only": true}})).unwrap();
        s.upsert_source(&source).unwrap();
        page(&s, "vault", "q-vault", &[axis(0, 4)], json!({}));
        let derived = json!({"frontmatter": {"synthesized_by": "dream", "visibility": "world"}, "type": "concept"});
        page(
            &s,
            "default",
            "r-from-vault",
            &[axis(0, 4)],
            derived.clone(),
        );
        page(&s, "default", "s-from-open", &[axis(0, 4)], derived);
        let link = |from: &str, to: &str, to_source: &str| {
            let options = crate::links::AddLinkOptions {
                link_type: Some("synthesized_from".into()),
                link_source: Some("concept-provenance".into()),
                to_source_id: Some(to_source.into()),
                ..Default::default()
            };
            s.add_link(from, to, &options).unwrap();
        };
        link("r-from-vault", "q-vault", "vault");
        link("s-from-open", "a-exact", "default");
        let top = |form: &str, privacy: bool| -> Vec<String> {
            let policy = json!({"honorAliases": true, "entityPrivacy": privacy, "ownerOnly": form});
            let o = opts(json!({"limit": 20, "exclude_private": policy}));
            let rows = s.search_vector(&q(&axis(0, 4)), &o).unwrap();
            let mut slugs: Vec<String> = rows
                .iter()
                .map(|r| r["slug"].as_str().unwrap().to_string())
                .collect();
            slugs.sort();
            slugs
        };
        let plain = opts(json!({"limit": 20}));
        let every = s.search_vector(&q(&axis(0, 4)), &plain).unwrap();
        let has = |slug: &str| every.iter().any(|r| r["slug"] == slug);
        assert!(has("q-vault") && has("r-from-vault"));
        for privacy in [true, false] {
            let served = top("lineage", privacy);
            assert!(!served.iter().any(|x| x == "q-vault" || x == "r-from-vault"));
            assert!(served.iter().any(|x| x == "a-exact"));
            assert!(served.iter().any(|x| x == "s-from-open"));
            assert!(top("closed", privacy).is_empty());
        }
    }

    /// The feeder's guard cases that edit `content_chunks` with SQL: a chunk's model label and its
    /// text hash, edited on the chunk record here.
    #[test]
    fn a_named_model_needs_the_chunk_label_and_a_current_text_hash() {
        let s = store();
        let a = page(&s, "default", "a-exact", &[axis(0, 4)], json!({}));
        page(&s, "default", "b-other", &[axis(1, 4)], json!({}));
        let edit = |f: &dyn Fn(&mut ChunkRecord)| {
            s.write(|tx| {
                let mut chunk = crate::chunks::read_chunks(&*tx, a)?.remove(0);
                f(&mut chunk);
                crate::put_json(tx, &crate::keys::chunk(a, 0), &chunk)
            })
            .unwrap();
        };
        let top = |model: Option<&str>| -> Vec<String> {
            let o = opts(json!({"model": model}));
            s.search_vector(&q(&axis(0, 4)), &o)
                .unwrap()
                .iter()
                .map(|r| r["slug"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(top(Some(MODEL)), ["a-exact", "b-other"]);
        edit(&|c| {
            c.meta.insert("model".into(), json!("other:model"));
        });
        assert_eq!(top(Some("other:model")), ["a-exact"]);
        assert_eq!(top(Some(MODEL)), ["b-other"]);
        // A hash of other text hides the vector from a named model only.
        edit(&|c| c.embed.text_hash = Some(text_hash("other text")));
        assert!(top(Some("other:model")).is_empty());
        assert_eq!(top(None), ["a-exact", "b-other"]);
        // No hash at all counts as current.
        edit(&|c| c.embed.text_hash = None);
        assert_eq!(top(Some("other:model")), ["a-exact"]);
    }

    #[test]
    fn source_factors_scale_scores_but_not_unverified_stubs() {
        let s = store();
        page(
            &s,
            "default",
            "people/alice-example",
            &[vec![1.0, 1.0]],
            json!({}),
        );
        page(
            &s,
            "default",
            "people/bob-example",
            &[vec![1.0, 1.0]],
            json!({"frontmatter": {"provenance": "auto-extracted", "status": "unverified"}}),
        );
        page(&s, "default", "notes/top", &[vec![1.0, 0.0]], json!({}));
        let factors = json!({"source_factors": [["people/alice", 3.0], ["people/", 2.0]]});
        let rows = s.search_vector(&[1.0, 0.0], &opts(factors)).unwrap();
        assert_eq!(
            names(&rows),
            [
                "people/alice-example#0 2.1213",
                "notes/top#0 1.0000",
                "people/bob-example#0 0.7071"
            ]
        );
    }

    #[test]
    fn cache_reuses_an_index_until_the_generation_moves() {
        let s = corpus();
        let cache = VectorCache::default();
        let first = cache.index(&*s.read().unwrap()).unwrap();
        let again = cache.index(&*s.read().unwrap()).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(first.chunks.len(), 6);
        let old = s.read().unwrap();
        page(&s, "default", "z-new", &[axis(2, 4)], json!({}));
        let rebuilt = cache.index(&*s.read().unwrap()).unwrap();
        assert!(!Arc::ptr_eq(&first, &rebuilt));
        assert_eq!(rebuilt.chunks.len(), 7);
        // An older snapshot gets its own index and leaves the newer one cached.
        let stale = cache.index(&*old).unwrap();
        assert_eq!(stale.chunks.len(), 6);
        assert!(Arc::ptr_eq(
            &rebuilt,
            &cache.index(&*s.read().unwrap()).unwrap()
        ));
        // A search over the cached index answers as one over a fresh index.
        let read = s.read().unwrap();
        let via_cache = search_chunks(
            &*read,
            &cache.index(&*read).unwrap(),
            &q(&axis(2, 4)),
            &opts(json!({"limit": 1})),
        )
        .unwrap();
        assert_eq!(names(&via_cache), ["z-new#0 1.0000"]);
    }

    #[test]
    fn take_vectors_rank_nearest_first_with_filters() {
        let s = store();
        let src: SourceInput =
            serde_json::from_value(json!({"id": "side", "name": "side"})).unwrap();
        s.upsert_source(&src).unwrap();
        let main = page(&s, "default", "takes-main", &[], json!({}));
        let side = page(&s, "side", "takes-side", &[], json!({}));
        let add = |page_id: u64, row: i32, claim: &str, holder: &str| {
            let input: TakeInput = serde_json::from_value(json!({
                "page_id": page_id, "row_num": row, "claim": claim, "kind": "take",
                "holder": holder, "weight": 0.5, "active": true,
            }))
            .unwrap();
            s.add_takes_batch(&[input]).unwrap();
        };
        add(main, 1, "axis zero take", "garry");
        add(main, 2, "axis one take", "alice");
        add(side, 1, "side axis zero take", "garry");
        let takes = all_takes(&*s.read().unwrap()).unwrap();
        let id = |claim: &str| takes.iter().find(|t| t.claim == claim).unwrap().id;
        s.set_config("embedding_dimensions", "2").unwrap();
        for (claim, v) in [
            ("axis zero take", vec![1.0f32, 0.0]),
            ("axis one take", vec![0.0, 1.0]),
            ("side axis zero take", vec![0.9, 0.1]),
        ] {
            let row = TakeEmbeddingInput {
                take_id: id(claim),
                embedding: v.iter().map(|x| f64::from(*x)).collect(),
                claim: claim.to_string(),
                model: MODEL.to_string(),
            };
            assert_eq!(s.update_take_embeddings(&[row]).unwrap(), 1);
        }
        let claims = |o: Value| -> Vec<String> {
            let o: TakesVectorOptions = serde_json::from_value(o).unwrap();
            s.search_takes_vector(&[1.0, 0.0], &o)
                .unwrap()
                .iter()
                .map(|r| r["claim"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            claims(json!({})),
            ["axis zero take", "side axis zero take", "axis one take"]
        );
        assert_eq!(claims(json!({"limit": 1})), ["axis zero take"]);
        assert_eq!(claims(json!({"allow_list": ["alice"]})), ["axis one take"]);
        assert_eq!(
            claims(json!({"source_ids": ["side"]})),
            ["side axis zero take"]
        );
        assert!(claims(json!({"allow_list": []})).is_empty());
        let row = &s
            .search_takes_vector(&[1.0, 0.0], &TakesVectorOptions::default())
            .unwrap()[0];
        assert_eq!(row["score"], json!(1.0));
        assert_eq!(row["weight"], json!(0.5));
        let err = s
            .search_takes_vector(&[1.0, 0.0, 0.0], &TakesVectorOptions::default())
            .unwrap_err();
        assert_eq!(err.message, "different vector dimensions 3 and 2");
        s.soft_delete_page("takes-side", Some("side")).unwrap();
        assert_eq!(
            claims(json!({"eligible_only": true})),
            ["axis zero take", "axis one take"]
        );
    }

    #[test]
    fn dot_and_number_text() {
        let a: Vec<f32> = (0..19).map(|i| i as f32 * 0.5).collect();
        let naive: f64 = a.iter().map(|x| f64::from(*x) * f64::from(*x)).sum();
        assert!((dot(&a, &a) - naive).abs() < 1e-9);
        assert_eq!(js_number(101.5), "101.5");
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(js_number(1.5e21), "1.5e+21");
        assert_eq!(js_number(f64::NEG_INFINITY), "-Infinity");
    }
}
