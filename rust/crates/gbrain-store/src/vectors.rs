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
//! - `searchVector` scores every vector first, then reads pages in order of the best score each
//!   can reach and stops once the result is settled (`bounded_scan`); the answer is the full
//!   scan's (`full_scan`), which still runs when the bound does not apply.
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
use crate::keyword::{DateBound, DateWindow, frontmatter_holds, parse_trust_floor};
use crate::kv::{KvRead, KvWrite};
use crate::pages::{PageRecord, read_page_by_id};
use crate::sources::read_source;
use crate::takes::{TakeRecord, all_takes, real_out};
use crate::trust::{TrustTier, activation_suppressed};
use crate::{Store, env::iso};
use serde::Deserialize;
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
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
    /// `frontmatterWhereClauses`: every entry must hold; an entry holds when the top-level field
    /// equals one of its values or is a list holding one (`keyword::frontmatter_holds`).
    #[serde(rename = "where")]
    pub where_fields: Vec<(String, Vec<Value>)>,
    /// `afterDate` / `beforeDate` with their `*Inclusive` flags, the bound in UTC microseconds
    /// (`search-filters.ts` `dateMicros`).
    pub after_date: Option<DateBound>,
    pub before_date: Option<DateBound>,
    /// `minTrust`: the trust floor (`trustFloorSql(p)`), a page's stamped tier at or above it.
    /// `None` or empty keeps every tier; a name that is no tier refuses.
    pub min_trust: Option<String>,
    /// `suppressFlagged`: drop a page at or below `agent_written` that holds a `flag` receipt in an
    /// activation reason family (`activationSuppressedSql`).
    pub suppress_flagged: bool,
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
    /// `eligibility.floor`: `trustFloorSql` over the take's stored tier; null sets none.
    pub min_trust: Option<String>,
    /// `eligibility.suppressFlagged`: drop a take `activationSuppressedSql('takes')` flags.
    pub suppress_flagged: bool,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`); null reads every page.
    pub exclude_private: Option<PrivacyPolicy>,
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
    /// Each page's run of vectors in `chunks`, as `start..end`, in page id order (a page's
    /// vectors are adjacent because `chunks` is in page id order).
    page_runs: Vec<(usize, usize)>,
    /// The width every chunk vector has; `None` when the widths differ or there is no vector.
    chunk_width: Option<usize>,
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
        let mut page_runs = Vec::new();
        let mut start = 0;
        for group in chunks.chunk_by(|a, b| a.id == b.id) {
            page_runs.push((start, start + group.len()));
            start += group.len();
        }
        let chunk_width = chunks
            .first()
            .map(|v| v.vector.len())
            .filter(|width| chunks.iter().all(|v| v.vector.len() == *width));
        Ok(VectorIndex {
            generation,
            chunks,
            takes,
            page_runs,
            chunk_width,
        })
    }
}

/// One [`VectorIndex`] per store, rebuilt when the vector generation moves. Reads only committed
/// snapshots (`Store::read`), so a rolled-back write never reaches it. An older snapshot never
/// replaces a newer index. A build that a [`VectorCache::clear`] overtook is not cached: the clear
/// moves the epoch, and an index is installed only under the epoch its build started in.
#[derive(Debug, Default)]
pub(crate) struct VectorCache {
    slot: Mutex<Option<Arc<VectorIndex>>>,
    /// Bumped by every `clear`; read before a build and checked, under the slot lock, at install.
    epoch: std::sync::atomic::AtomicU64,
}

#[cfg(test)]
thread_local! {
    /// Test seam: runs in `VectorCache::index` after the index is built and before it is cached.
    static AFTER_BUILD: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
}

fn after_build() {
    #[cfg(test)]
    if let Some(hook) = AFTER_BUILD.with(|h| h.borrow_mut().take()) {
        hook();
    }
}

impl VectorCache {
    /// The cached index, for tests.
    #[cfg(test)]
    fn cached(&self) -> Option<Arc<VectorIndex>> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Drops the cached index. A transaction's store calls it when a savepoint or the transaction
    /// rolls back: the vector generation goes back with the dropped writes, so the next write
    /// would reach a cached generation number again with other vectors.
    pub(crate) fn clear(&self) {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        self.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *slot = None;
    }

    /// The index of `read`'s snapshot, from the cache when its generation matches.
    pub(crate) fn index(&self, read: &dyn KvRead) -> Result<Arc<VectorIndex>> {
        let generation = vector_generation(read)?;
        let epoch = self.epoch.load(std::sync::atomic::Ordering::SeqCst);
        {
            let slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(index) = slot.as_ref().filter(|i| i.generation == generation) {
                return Ok(Arc::clone(index));
            }
        }
        let built = Arc::new(VectorIndex::build(read, generation)?);
        after_build();
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if self.epoch.load(std::sync::atomic::Ordering::SeqCst) == epoch
            && slot.as_ref().is_none_or(|i| i.generation < generation)
        {
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

/// The page filters of a read parsed once before the scan.
struct ScanBounds {
    hard_excludes: Vec<String>,
    dates: DateWindow,
    floor: Option<TrustTier>,
}

impl ScanBounds {
    fn parse(options: &VectorSearchOptions) -> Result<Self> {
        let hard_excludes = options.hard_excludes.clone().unwrap_or_else(|| {
            DEFAULT_HARD_EXCLUDES
                .iter()
                .map(|s| s.to_string())
                .collect()
        });
        Ok(Self {
            hard_excludes,
            dates: DateWindow::parse(options.after_date.as_ref(), options.before_date.as_ref())?,
            floor: parse_trust_floor(options.min_trust.as_deref())?,
        })
    }
}

/// The page-level filters of the scan; `archived` caches each source's archive flag.
fn page_passes(
    read: &dyn KvRead,
    page: &PageRecord,
    options: &VectorSearchOptions,
    bounds: &ScanBounds,
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
        || !bounds.dates.admits(page)
        || bounds
            .hard_excludes
            .iter()
            .any(|p| !p.is_empty() && page.slug.starts_with(p.as_str()))
        || options
            .source_ids
            .as_ref()
            .is_some_and(|ids| !ids.contains(&page.source_id))
        || !options
            .where_fields
            .iter()
            .all(|(key, values)| frontmatter_holds(&page.frontmatter, key, values))
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
    // `pageEligibleSql(p)`: the trust floor, then the flagged-page filter.
    let tier = TrustTier::stored(page.trust_tier.as_deref());
    if bounds
        .floor
        .as_ref()
        .is_some_and(|floor| tier.rank() < floor.rank())
    {
        return Ok(false);
    }
    if options.suppress_flagged && activation_suppressed(read, "pages", page.id, tier)? {
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

/// The page and chunk filters of one `searchVector` call, with the caches its page checks share.
struct ChunkScan<'a> {
    read: &'a dyn KvRead,
    options: &'a VectorSearchOptions,
    bounds: ScanBounds,
    query_len: usize,
    /// Read once, and only when the guard needs it.
    migrating: Option<bool>,
    archived: HashMap<String, bool>,
    owner_only: OwnerOnlyCache,
}

impl ChunkScan<'_> {
    /// The best admitted chunk of one page, whose vectors are `group` (one page's run of the
    /// index), or `None` when the page or every chunk is filtered out. `raw(i)` is
    /// `1 - (embedding <=> q)` for `group[i]`; both scans call this, so they apply the same filters,
    /// guard, factor, tie rule and refusals.
    fn best_chunk(
        &mut self,
        group: &[IndexedVector],
        raw: impl Fn(usize, &IndexedVector) -> f64,
    ) -> Result<Option<Hit>> {
        let (read, options) = (self.read, self.options);
        #[cfg(test)]
        tests::PAGES_READ.with(|n| n.set(n.get() + 1));
        let page_id = group[0].id;
        let Some(page) = read_page_by_id(read, page_id)? else {
            return Ok(None);
        };
        if !page_passes(
            read,
            &page,
            options,
            &self.bounds,
            &mut self.archived,
            &mut self.owner_only,
        )? {
            return Ok(None);
        }
        let mut chunks: HashMap<u32, ChunkRecord> = visible_chunks(read, page_id)?
            .into_iter()
            .map(|c| (c.chunk_index, c))
            .collect();
        let factor = source_factor(&page, &options.source_factors);
        let mut best: Option<(f64, ChunkRecord)> = None;
        for (i, stored) in group.iter().enumerate() {
            let Some(chunk) = chunks.get(&stored.chunk_index) else {
                continue;
            };
            if !chunk_passes(chunk, options) {
                continue;
            }
            if stored.vector.len() != self.query_len {
                return Err(dims_mismatch(self.query_len, stored.vector.len()));
            }
            let fresh = match options.model.as_deref() {
                Some(model) => written_by(chunk, model),
                None => !*self
                    .migrating
                    .get_or_insert(read_config(read, MIGRATION_STATE_KEY)?.is_some()),
            };
            if !fresh {
                continue;
            }
            // `1 - (embedding <=> q)`, then the source factor.
            let raw = raw(i, stored);
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
        Ok(best.map(|(score, chunk)| Hit { page, chunk, score }))
    }
}

/// The result order: score (NaN first), then page id, then chunk id.
fn hit_order(a: &Hit, b: &Hit) -> Ordering {
    score_desc(a.score, b.score)
        .then(a.page.id.cmp(&b.page.id))
        .then(a.chunk.id.cmp(&b.chunk.id))
}

/// A hit in a max-heap whose top is the hit that ranks last.
struct Ranked(Hit);

impl PartialEq for Ranked {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Ranked {}
impl PartialOrd for Ranked {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Ranked {
    fn cmp(&self, other: &Self) -> Ordering {
        hit_order(&self.0, &other.0)
    }
}

/// `GBRAIN_RUST_VECTOR_SCAN=full` makes every `searchVector` take the full scan (the bench and
/// its verify mode compare the two paths on one store). Read on every call.
fn full_scan_forced() -> bool {
    std::env::var_os("GBRAIN_RUST_VECTOR_SCAN").is_some_and(|v| v == "full")
}

/// Below this many vectors the raw scores are computed on the calling thread.
const PARALLEL_MIN_VECTORS: usize = 4096;

/// Helper threads the raw-score passes of all searches hold right now. The process-wide budget is
/// the core count minus one, so concurrent searches share the cores instead of each starting a
/// thread per core.
static HELPERS_IN_USE: AtomicUsize = AtomicUsize::new(0);

/// Up to `wanted` helper threads from the process-wide budget, given back when dropped.
struct Helpers(usize);

impl Helpers {
    fn take(wanted: usize) -> Self {
        let budget = std::thread::available_parallelism().map_or(1, |n| n.get()) - 1;
        let mut used = HELPERS_IN_USE.load(AtomicOrdering::Relaxed);
        loop {
            let granted = wanted.min(budget.saturating_sub(used));
            if granted == 0 {
                return Helpers(0);
            }
            match HELPERS_IN_USE.compare_exchange_weak(
                used,
                used + granted,
                AtomicOrdering::AcqRel,
                AtomicOrdering::Relaxed,
            ) {
                Ok(_) => return Helpers(granted),
                Err(now) => used = now,
            }
        }
    }
}

impl Drop for Helpers {
    fn drop(&mut self) {
        if self.0 > 0 {
            HELPERS_IN_USE.fetch_sub(self.0, AtomicOrdering::AcqRel);
        }
    }
}

/// `1 - (embedding <=> q)` of every vector, in index order, split across the machine's cores
/// for a large index. Each value is computed exactly as the full scan computes it.
fn raw_scores(query: &[f32], query_norm_sq: f64, vectors: &[IndexedVector]) -> Vec<f64> {
    let score = |stored: &IndexedVector| 1.0 - (1.0 - cosine(query, query_norm_sq, stored));
    let mut out = vec![0.0; vectors.len()];
    let helpers = if vectors.len() < PARALLEL_MIN_VECTORS {
        Helpers(0)
    } else {
        Helpers::take(vectors.len() / (PARALLEL_MIN_VECTORS / 2))
    };
    // The calling thread scores one part too.
    let threads = helpers.0 + 1;
    if threads <= 1 {
        for (slot, stored) in out.iter_mut().zip(vectors) {
            *slot = score(stored);
        }
        return out;
    }
    let per = vectors.len().div_ceil(threads);
    let failed = std::thread::scope(|scope| {
        let mut failed = false;
        let mut parts = out.chunks_mut(per).zip(vectors.chunks(per));
        let own = parts.next();
        for (slots, part) in parts {
            let work = move || {
                for (slot, stored) in slots.iter_mut().zip(part) {
                    *slot = score(stored);
                }
            };
            failed |= std::thread::Builder::new()
                .spawn_scoped(scope, work)
                .is_err();
        }
        if let Some((slots, part)) = own {
            for (slot, stored) in slots.iter_mut().zip(part) {
                *slot = score(stored);
            }
        }
        failed
    });
    drop(helpers);
    // A thread the system could not start left its part unscored: score everything here.
    if failed {
        for (slot, stored) in out.iter_mut().zip(vectors) {
            *slot = score(stored);
        }
    }
    out
}

/// The largest score a page whose raw scores are `raws` can reach under any factor in `factors`:
/// the score is one raw times one factor, and a product is monotone in the raw for a fixed
/// factor, so the largest product over the raws' maximum and minimum bounds it. A NaN raw makes
/// the bound NaN, which ranks above every number, as the score would.
fn page_bound(raws: &[f64], factors: &[f64]) -> f64 {
    let (mut high, mut low) = (raws[0], raws[0]);
    for &raw in raws {
        if raw.is_nan() {
            return f64::NAN;
        }
        if raw.total_cmp(&high).is_gt() {
            high = raw;
        }
        if raw.total_cmp(&low).is_lt() {
            low = raw;
        }
    }
    let mut bound = high * factors[0];
    for factor in factors {
        for product in [high * factor, low * factor] {
            if product.total_cmp(&bound).is_gt() {
                bound = product;
            }
        }
    }
    bound
}

/// The bounded scan: score every vector first (arithmetic only), then read pages in order of the
/// largest score each can reach, and stop once the best `keep` hits are settled. Every page that
/// could rank goes through `ChunkScan::best_chunk`, as in the full scan, so the hits are the
/// full scan's. Returns `None` when this read must take the full scan instead.
fn bounded_scan(
    scan: &mut ChunkScan<'_>,
    index: &VectorIndex,
    query: &[f32],
    query_norm_sq: f64,
    keep: usize,
) -> Result<Option<Vec<Hit>>> {
    let options = scan.options;
    // A stored vector of another width refuses in the full scan, at the first one the filters
    // admit; and a factor that is not a finite number has no bound. Both take the full scan.
    if index.chunks.is_empty() {
        return Ok(Some(Vec::new()));
    }
    if index.chunk_width != Some(query.len())
        || options.source_factors.iter().any(|(_, f)| !f.is_finite())
    {
        return Ok(None);
    }
    if keep == 0 {
        return Ok(Some(Vec::new()));
    }
    // With no model, a running embedding migration hides every vector.
    if options.model.is_none() {
        let migrating = read_config(scan.read, MIGRATION_STATE_KEY)?.is_some();
        scan.migrating = Some(migrating);
        if migrating {
            return Ok(Some(Vec::new()));
        }
    }
    let raws = raw_scores(query, query_norm_sq, &index.chunks);
    let factors: Vec<f64> = std::iter::once(1.0)
        .chain(options.source_factors.iter().map(|(_, f)| *f))
        .collect();
    let mut order: Vec<(f64, usize)> = index
        .page_runs
        .iter()
        .enumerate()
        .map(|(run, &(start, end))| (page_bound(&raws[start..end], &factors), run))
        .collect();
    order.sort_unstable_by(|a, b| score_desc(a.0, b.0).then(a.1.cmp(&b.1)));
    let mut best: BinaryHeap<Ranked> = BinaryHeap::new();
    for (bound, run) in order {
        // Every page left can reach at most `bound`. Once that ranks below the last kept hit,
        // no page left can enter (a tie can, by a lower page id, so a tie is still read).
        if best.len() >= keep
            && best
                .peek()
                .is_some_and(|last| score_desc(bound, last.0.score) == Ordering::Greater)
        {
            break;
        }
        let (start, end) = index.page_runs[run];
        let page_raws = &raws[start..end];
        if let Some(hit) = scan.best_chunk(&index.chunks[start..end], |i, _| page_raws[i])? {
            best.push(Ranked(hit));
            if best.len() > keep {
                best.pop();
            }
        }
    }
    Ok(Some(best.into_iter().map(|ranked| ranked.0).collect()))
}

/// The full scan: every page with a vector, in page id order.
fn full_scan(
    scan: &mut ChunkScan<'_>,
    index: &VectorIndex,
    query: &[f32],
    query_norm_sq: f64,
) -> Result<Vec<Hit>> {
    let mut hits = Vec::new();
    for &(start, end) in &index.page_runs {
        let score =
            |_: usize, stored: &IndexedVector| 1.0 - (1.0 - cosine(query, query_norm_sq, stored));
        if let Some(hit) = scan.best_chunk(&index.chunks[start..end], score)? {
            hits.push(hit);
        }
    }
    Ok(hits)
}

fn search_chunks(
    read: &dyn KvRead,
    index: &VectorIndex,
    query: &[f64],
    options: &VectorSearchOptions,
) -> Result<Vec<Value>> {
    search_chunks_by(read, index, query, options, full_scan_forced())
}

/// `searchVector` over one snapshot; `full` takes the full scan whatever the bounded scan could do.
fn search_chunks_by(
    read: &dyn KvRead,
    index: &VectorIndex,
    query: &[f64],
    options: &VectorSearchOptions,
    full: bool,
) -> Result<Vec<Value>> {
    let query = check_query(query)?;
    let limit = options.limit.unwrap_or(DEFAULT_VECTOR_LIMIT);
    let offset = resolve_offset(&options.offset, limit)?;
    let limit = limit as usize;
    let query_norm_sq = dot(&query, &query);
    let mut scan = ChunkScan {
        read,
        options,
        bounds: ScanBounds::parse(options)?,
        query_len: query.len(),
        migrating: None,
        archived: HashMap::new(),
        owner_only: OwnerOnlyCache::default(),
    };
    let bounded = if full {
        None
    } else {
        let keep = offset.saturating_add(limit);
        bounded_scan(&mut scan, index, &query, query_norm_sq, keep)?
    };
    let mut hits = match bounded {
        Some(hits) => hits,
        None => full_scan(&mut scan, index, &query, query_norm_sq)?,
    };
    hits.sort_by(hit_order);
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
    // Postgres refuses a NUL byte in a text parameter before it runs the statement.
    let texts: Vec<(&str, &str)> = [
        ("takesHoldersAllowList", &options.allow_list),
        ("sourceIds", &options.source_ids),
    ]
    .into_iter()
    .flat_map(|(name, list)| {
        list.iter()
            .flatten()
            .flatten()
            .map(move |v| (name, v.as_str()))
    })
    .collect();
    crate::links::no_nul("searchTakesVector", &texts)?;
    let query = check_query(query)?;
    let limit = options.limit.unwrap_or(DEFAULT_TAKES_LIMIT) as usize;
    if index.takes.is_empty() {
        return Ok(Vec::new());
    }
    let query_norm_sq = dot(&query, &query);
    let trust =
        crate::trust::TrustPolicy::parse(options.min_trust.as_deref(), options.suppress_flagged)?;
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
        if let Some(policy) = &options.exclude_private
            && crate::facts::page_hidden(read, page, policy)?
        {
            continue;
        }
        if !trust.admits(read, "takes", take.id, take.trust.tier())? {
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
    hits.sort_by(|(da, a, _), (db, b, _)| {
        da.is_nan()
            .cmp(&db.is_nan())
            .then(da.total_cmp(db))
            .then(a.id.cmp(&b.id))
    });
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

    thread_local! {
        /// Pages `ChunkScan::best_chunk` read on this thread, so a test can show the bounded scan
        /// reads fewer pages than the full scan.
        pub(super) static PAGES_READ: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }

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
        let policy = json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn"});
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
            json!({"honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn"});
        assert_eq!(
            top(json!({"limit": 3, "exclude_private": visibility_only})),
            ["a-exact", "n-access", "o-public"]
        );
        // With the privacy part of the entity gate relaxed, only the member-access part applies: nothing here is hidden.
        let relaxed = json!({"honorAliases": true, "entityPrivacy": false, "ownerOnly": "fn"});
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
            let served = top("fn", privacy);
            assert!(!served.iter().any(|x| x == "q-vault" || x == "r-from-vault"));
            assert!(served.iter().any(|x| x == "a-exact"));
            assert!(served.iter().any(|x| x == "s-from-open"));
            assert!(top("closed", privacy).is_empty());
        }
    }

    /// `where` (`frontmatterWhereClauses`): every key holds, a key's values OR together, a list
    /// field holds a value it contains, and the filter applies before the limit.
    #[test]
    fn where_keeps_the_pages_whose_frontmatter_holds_every_key() {
        let s = corpus();
        let fm = |v: Value| json!({ "frontmatter": v });
        page(
            &s,
            "default",
            "m-draft",
            &[axis(0, 4)],
            fm(json!({"status": "draft"})),
        );
        page(
            &s,
            "default",
            "n-listed",
            &[axis(0, 4)],
            fm(json!({"status": ["active", "x"]})),
        );
        page(
            &s,
            "default",
            "o-ranked",
            &[axis(0, 4)],
            fm(json!({"status": "active", "rank": 3})),
        );
        page(
            &s,
            "default",
            "p-pinned",
            &[axis(0, 4)],
            fm(json!({"pinned": true})),
        );
        let top = |o: Value| -> Vec<String> {
            let rows = s.search_vector(&q(&axis(0, 4)), &opts(o)).unwrap();
            rows.iter()
                .map(|r| r["slug"].as_str().unwrap().to_string())
                .collect()
        };
        let all = ["a-exact", "m-draft", "n-listed", "o-ranked", "p-pinned"];
        assert_eq!(top(json!({"limit": 5})), all);
        assert_eq!(top(json!({"limit": 5, "where": []})), all);
        assert_eq!(
            top(json!({"where": [["status", ["active"]]]})),
            ["n-listed", "o-ranked"]
        );
        // The limit counts kept pages only: the dropped pages tie at the top score and take no slot.
        assert_eq!(
            top(json!({"limit": 1, "where": [["status", ["active"]]]})),
            ["n-listed"]
        );
        assert_eq!(
            top(json!({"limit": 1, "offset": 1, "where": [["status", ["active"]]]})),
            ["o-ranked"]
        );
        assert_eq!(
            top(json!({"where": [["status", ["draft", "x"]]]})),
            ["m-draft", "n-listed"]
        );
        // The member sends a string's numeric and boolean readings beside it.
        assert_eq!(top(json!({"where": [["rank", ["3", 3]]]})), ["o-ranked"]);
        assert_eq!(
            top(json!({"where": [["rank", ["3"]]]})),
            Vec::<String>::new()
        );
        assert_eq!(
            top(json!({"where": [["pinned", ["true", true]]]})),
            ["p-pinned"]
        );
        assert_eq!(
            top(json!({"where": [["status", ["active"]], ["rank", [3]]]})),
            ["o-ranked"]
        );
        assert_eq!(
            top(json!({"where": [["missing", ["x"]]]})),
            Vec::<String>::new()
        );
    }

    /// `afterDate` / `beforeDate`: a page is dated by its effective date, else its `updated_at`;
    /// a bound is strict unless inclusive, and applies before the limit.
    #[test]
    fn date_bounds_keep_the_pages_dated_inside_them() {
        let s = corpus();
        let on = |iso: &str| json!({ "effective_date": iso });
        page(
            &s,
            "default",
            "m-edge",
            &[axis(0, 4)],
            on("2026-02-01T00:00:00Z"),
        );
        page(
            &s,
            "default",
            "n-late",
            &[axis(0, 4)],
            on("2026-05-10T00:00:00Z"),
        );
        page(
            &s,
            "default",
            "o-old",
            &[axis(0, 4)],
            on("2019-07-04T00:00:00Z"),
        );
        // 2026-02-01T00:00:00Z in microseconds.
        let edge = "1769904000000000";
        let bound = |inclusive: bool| json!({ "micros": edge, "inclusive": inclusive });
        let top = |o: Value| -> Vec<String> {
            let rows = s.search_vector(&q(&axis(0, 4)), &opts(o)).unwrap();
            rows.iter()
                .map(|r| r["slug"].as_str().unwrap().to_string())
                .collect()
        };
        let exclude = json!(["a-exact", "b-tie1", "c-tie2", "d-multi", "e-opposite"]);
        assert_eq!(
            top(json!({"exclude_slugs": exclude, "after_date": bound(false)})),
            ["n-late"]
        );
        assert_eq!(
            top(json!({"exclude_slugs": exclude, "after_date": bound(true)})),
            ["m-edge", "n-late"]
        );
        assert_eq!(
            top(json!({"exclude_slugs": exclude, "before_date": bound(false)})),
            ["o-old"]
        );
        assert_eq!(
            top(json!({"exclude_slugs": exclude, "before_date": bound(true)})),
            ["m-edge", "o-old"]
        );
        // The limit counts kept pages only.
        assert_eq!(
            top(json!({"limit": 1, "before_date": bound(false), "exclude_slugs": ["a-exact"]})),
            ["o-old"]
        );
        // The corpus pages have no effective date: their `updated_at` (now) dates them.
        assert_eq!(
            top(json!({"limit": 3, "after_date": bound(true)})),
            ["a-exact", "m-edge", "n-late"]
        );
        let err = s
            .search_vector(
                &q(&axis(0, 4)),
                &opts(json!({"after_date": {"micros": "soon", "inclusive": false}})),
            )
            .unwrap_err();
        assert!(err.to_string().contains("afterDate"), "{err}");
    }

    /// A page written in a transaction that declares `tier` as the writer's trust tier.
    fn page_at(s: &Store, tier: &str, slug: &str) {
        let tx = s.begin_transaction(false).unwrap();
        let names = ["gbrain.write_trust_tier", "gbrain.write_origin"].map(String::from);
        tx.apply_write_trust(
            &names,
            &[tier.to_string(), r#"{"channel":"test"}"#.to_string()],
        )
        .unwrap();
        page(&tx, "default", slug, &[axis(0, 4)], json!({}));
        tx.commit_transaction().unwrap();
    }

    /// `minTrust` (`trustFloorSql`): a page's stamped tier at or above the floor, applied before
    /// the limit; an empty floor keeps every tier and a name that is no tier refuses.
    #[test]
    fn min_trust_keeps_the_pages_at_or_above_the_floor() {
        let s = corpus();
        page_at(&s, "operator_curated", "m-curated");
        page_at(&s, "tool_observed", "n-observed");
        page_at(&s, "agent_written", "o-agent");
        page_at(&s, "external_untrusted", "p-outside");
        let top = |o: Value| -> Vec<String> {
            let rows = s.search_vector(&q(&axis(0, 4)), &opts(o)).unwrap();
            rows.iter()
                .map(|r| r["slug"].as_str().unwrap().to_string())
                .collect()
        };
        let exclude = json!(["a-exact", "b-tie1", "c-tie2", "d-multi", "e-opposite"]);
        let tiered = ["m-curated", "n-observed", "o-agent", "p-outside"];
        assert_eq!(top(json!({"exclude_slugs": exclude})), tiered);
        assert_eq!(
            top(json!({"exclude_slugs": exclude, "min_trust": ""})),
            tiered
        );
        assert_eq!(
            top(json!({"exclude_slugs": exclude, "min_trust": "external_untrusted"})),
            tiered
        );
        assert_eq!(
            top(json!({"exclude_slugs": exclude, "min_trust": "tool_observed"})),
            ["m-curated", "n-observed"]
        );
        assert_eq!(
            top(json!({"exclude_slugs": exclude, "min_trust": "agent_written"})),
            ["m-curated", "n-observed", "o-agent"]
        );
        // The limit counts kept pages only: the dropped page ties at the top score and takes no slot.
        assert_eq!(
            top(
                json!({"limit": 1, "offset": 1, "exclude_slugs": ["a-exact"], "min_trust": "operator_curated"})
            ),
            Vec::<String>::new()
        );
        assert_eq!(
            top(
                json!({"limit": 1, "exclude_slugs": ["a-exact", "m-curated"], "min_trust": "tool_observed"})
            ),
            ["n-observed"]
        );
        let err = s
            .search_vector(&q(&axis(0, 4)), &opts(json!({"min_trust": "trusted"})))
            .unwrap_err();
        assert!(err.to_string().contains("names no trust tier"), "{err}");
    }

    /// A `flag` receipt on a page, in the given reason families.
    fn flag(s: &Store, slug: &str, families: &[&str]) {
        let families: Vec<String> = families.iter().map(|f| f.to_string()).collect();
        let fields = crate::trust::write_gate::ReceiptFields {
            content_hash: "h1".into(),
            tier: "agent_written".into(),
            detector_version: 1,
            verdict: "flag".into(),
            reason_families: families.clone(),
            reasons: families,
            detector_error: false,
            request_id: None,
        };
        assert!(
            s.upsert_page_write_gate_receipt("default", slug, fields)
                .unwrap()
                .is_some()
        );
    }

    /// `suppressFlagged` (`activationSuppressedSql`): a page at or below `agent_written` with a flag
    /// receipt in an activation family drops before the limit; a flag in another family, or on a
    /// page above `agent_written`, suppresses nothing.
    #[test]
    fn suppress_flagged_drops_the_flagged_pages_at_or_below_agent_written() {
        let s = corpus();
        page_at(&s, "operator_curated", "m-curated-flagged");
        page_at(&s, "agent_written", "n-agent-flagged");
        page_at(&s, "agent_written", "o-agent-other");
        page_at(&s, "agent_written", "p-agent");
        flag(&s, "m-curated-flagged", &["override"]);
        flag(&s, "n-agent-flagged", &["exfiltration"]);
        flag(&s, "o-agent-other", &["other"]);
        let top = |o: Value| -> Vec<String> {
            let rows = s.search_vector(&q(&axis(0, 4)), &opts(o)).unwrap();
            rows.iter()
                .map(|r| r["slug"].as_str().unwrap().to_string())
                .collect()
        };
        let exclude = json!(["a-exact", "b-tie1", "c-tie2", "d-multi", "e-opposite"]);
        assert_eq!(
            top(json!({"exclude_slugs": exclude})),
            [
                "m-curated-flagged",
                "n-agent-flagged",
                "o-agent-other",
                "p-agent"
            ]
        );
        assert_eq!(
            top(json!({"exclude_slugs": exclude, "suppress_flagged": true})),
            ["m-curated-flagged", "o-agent-other", "p-agent"]
        );
        // The limit counts kept pages only: the suppressed page takes no slot.
        assert_eq!(
            top(
                json!({"limit": 1, "exclude_slugs": ["a-exact", "m-curated-flagged"], "suppress_flagged": true})
            ),
            ["o-agent-other"]
        );
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

    /// Second-model review 1.6: a clear (a savepoint or transaction rollback) that lands while a
    /// search builds an index keeps that index out of the cache: it was built from writes the
    /// rollback dropped, and the next write reaches the same generation number with other vectors.
    #[test]
    fn a_clear_during_a_build_keeps_the_built_index_out_of_the_cache() {
        let s = corpus();
        let cache = Arc::new(VectorCache::default());
        let clearing = cache.clone();
        AFTER_BUILD.with(|h| *h.borrow_mut() = Some(Box::new(move || clearing.clear())));
        let built = cache.index(&*s.read().unwrap()).unwrap();
        assert_eq!(
            built.chunks.len(),
            6,
            "the caller still gets the index it built"
        );
        assert!(
            cache.cached().is_none(),
            "an index built before a clear was cached"
        );
        // With no clear in between, the next build is cached as before.
        let again = cache.index(&*s.read().unwrap()).unwrap();
        assert!(Arc::ptr_eq(&again, &cache.cached().unwrap()));
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

    // ---------------------------------------------------------------------------------------
    // The bounded scan answers what the full scan answers.

    /// Both paths over one snapshot, as the text a caller would see (rows or the refusal).
    fn both_paths(s: &Store, query: &[f64], options: &VectorSearchOptions) -> (String, String) {
        let read = s.read().unwrap();
        let index = load_index(&*read, Some(&s.vectors)).unwrap();
        let text = |r: Result<Vec<Value>>| match r {
            Ok(rows) => serde_json::to_string(&rows).unwrap(),
            Err(e) => format!("error: {e}"),
        };
        (
            text(search_chunks_by(&*read, &index, query, options, false)),
            text(search_chunks_by(&*read, &index, query, options, true)),
        )
    }

    #[test]
    fn bounded_scan_matches_full_scan_on_ties_nan_factors_and_offsets() {
        let s = corpus();
        page(&s, "default", "f-zero", &[vec![0.0; 4]], json!({}));
        page(
            &s,
            "default",
            "g-tie3",
            &[vec![0.0, 1.0, 1.0, 0.0], vec![0.0, 1.0, 1.0, 0.0]],
            json!({}),
        );
        let queries = [
            q(&[1.0, 0.0, 0.0, 0.0]),
            q(&[0.0, 1.0, 1.0, 0.0]),
            q(&[0.0; 4]),
            q(&[-1.0, 0.5, 0.0, 0.0]),
        ];
        let factor_sets = [
            json!([]),
            json!([["b-", 2.0], ["d-", 0.5]]),
            json!([["a-", -1.0], ["e-", 0.0]]),
            json!([["c-", 1.0], ["g-", 3.0]]),
        ];
        for query in &queries {
            for factors in &factor_sets {
                for (limit, offset) in [
                    (0, json!(0)),
                    (1, json!(0)),
                    (2, json!(1)),
                    (3, json!(5)),
                    (20, json!(0)),
                    (2, json!(1e18)),
                    (2, json!("Infinity")),
                ] {
                    let o =
                        opts(json!({"limit": limit, "offset": offset, "source_factors": factors}));
                    let (bounded, full) = both_paths(&s, query, &o);
                    assert_eq!(
                        bounded, full,
                        "query {query:?} factors {factors} limit {limit} offset {offset}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_bounded_scan_reads_only_the_pages_that_can_rank() {
        let s = store();
        page(&s, "default", "best", &[axis(0, 4)], json!({}));
        for i in 0..30 {
            page(
                &s,
                "default",
                &format!("far-{i:02}"),
                &[vec![0.1, 1.0, 0.0, 0.0]],
                json!({}),
            );
        }
        let query = q(&[1.0, 0.0, 0.0, 0.0]);
        let read = s.read().unwrap();
        let index = load_index(&*read, Some(&s.vectors)).unwrap();
        let o = opts(json!({"limit": 1}));
        let mut reads = [0usize; 2];
        let mut rows = Vec::new();
        for (slot, full) in [false, true].into_iter().enumerate() {
            PAGES_READ.with(|n| n.set(0));
            rows.push(search_chunks_by(&*read, &index, &query, &o, full).unwrap());
            reads[slot] = PAGES_READ.with(|n| n.get());
        }
        assert_eq!(names(&rows[0]), ["best#0 1.0000"]);
        assert_eq!(rows[0], rows[1]);
        assert_eq!(reads, [1, 31]);
    }

    #[test]
    fn a_page_that_only_ties_the_last_kept_hit_is_still_read() {
        // `y-low` scores 0.25 * 2 = 0.5 and `x-high` scores 0.5 * 1 = 0.5, a tie the lower page id
        // wins. `x-high` reaches the bound 0.5 * 2 = 1.0 first, so the scan meets `y-low` with a
        // full heap whose last hit ties `y-low`'s bound: stopping there would drop the winner.
        let s = store();
        let mut wide = vec![1.0f32; 16];
        page(&s, "default", "y-low", &[wide.clone()], json!({}));
        wide[4..].iter_mut().for_each(|v| *v = 0.0);
        page(&s, "default", "x-high", &[wide], json!({}));
        let mut query = vec![0.0; 16];
        query[0] = 1.0;
        let o = opts(json!({"limit": 1, "source_factors": [["y-", 2.0]]}));
        let (bounded, full) = both_paths(&s, &query, &o);
        assert_eq!(bounded, full);
        assert_eq!(
            names(&s.search_vector(&query, &o).unwrap()),
            ["y-low#0 0.5000"]
        );
    }

    #[test]
    fn mixed_widths_and_bad_factors_take_the_full_scan_and_refuse_alike() {
        let s = corpus();
        page(
            &s,
            "default",
            "z-wide",
            &[vec![1.0, 0.0, 0.0, 0.0, 0.0]],
            json!({}),
        );
        for limit in [0, 1, 5] {
            let o = opts(json!({"limit": limit}));
            let (bounded, full) = both_paths(&s, &q(&[1.0, 0.0, 0.0, 0.0]), &o);
            assert!(full.starts_with("error: "), "{full}");
            assert_eq!(bounded, full);
        }
        let s = corpus();
        for factor in [f64::INFINITY, f64::NAN] {
            let o = VectorSearchOptions {
                limit: Some(3),
                source_factors: vec![("a-".to_string(), factor)],
                ..VectorSearchOptions::default()
            };
            let (bounded, full) = both_paths(&s, &q(&[1.0, 0.0, 0.0, 0.0]), &o);
            assert_eq!(bounded, full);
        }
        // A query of another width than every stored vector refuses on both paths.
        let (bounded, full) = both_paths(&s, &q(&[1.0, 0.0]), &opts(json!({})));
        assert!(full.starts_with("error: "), "{full}");
        assert_eq!(bounded, full);
    }

    #[test]
    fn raw_scores_split_across_threads_equal_the_serial_scores() {
        let mut rng = 0x1234_5678_u64;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            ((rng >> 40) as f32 / (1u64 << 24) as f32) - 0.5
        };
        let vectors: Vec<IndexedVector> = (0..PARALLEL_MIN_VECTORS * 2 + 7)
            .map(|i| {
                let v: Vec<f32> = (0..9).map(|_| next()).collect();
                IndexedVector::new(&StoredVector {
                    id: i as u64,
                    chunk_index: 0,
                    model: String::new(),
                    embedded_at_us: 0,
                    vector: if i % 997 == 0 { vec![0.0; 9] } else { v },
                })
            })
            .collect();
        let query: Vec<f32> = (0..9).map(|_| next()).collect();
        let norm = dot(&query, &query);
        let parallel = raw_scores(&query, norm, &vectors);
        let serial: Vec<f64> = vectors
            .iter()
            .map(|v| 1.0 - (1.0 - cosine(&query, norm, v)))
            .collect();
        assert_eq!(parallel.len(), serial.len());
        for (a, b) in parallel.iter().zip(&serial) {
            assert_eq!(a.to_bits(), b.to_bits());
        }
        assert_eq!(HELPERS_IN_USE.load(AtomicOrdering::Relaxed), 0);
    }

    mod differential {
        //! Random small brains: the bounded scan's bytes equal the full scan's for every filter,
        //! factor set, limit and offset drawn.
        use super::*;
        use proptest::prelude::*;

        const PREFIXES: &[&str] = &["a/", "b/", "c/", "test/"];

        #[derive(Debug, Clone)]
        struct PageSpec {
            prefix: usize,
            side: bool,
            concept: bool,
            stub: bool,
            hidden: bool,
            chunks: Vec<Vec<f32>>,
        }

        fn page_spec() -> impl Strategy<Value = PageSpec> {
            let component = prop::sample::select(vec![-1.0f32, 0.0, 0.5, 1.0]);
            (
                0..PREFIXES.len(),
                any::<bool>(),
                any::<bool>(),
                prop::bool::weighted(0.2),
                prop::bool::weighted(0.1),
                prop::collection::vec(prop::collection::vec(component, 3), 1..4),
            )
                .prop_map(|(prefix, side, concept, stub, hidden, chunks)| PageSpec {
                    prefix,
                    side,
                    concept,
                    stub,
                    hidden,
                    chunks,
                })
        }

        fn options() -> impl Strategy<Value = Value> {
            let factor = prop::sample::select(vec![-1.0f64, 0.0, 0.5, 1.0, 1.3, 2.0]);
            (
                0u64..8,
                0u64..4,
                prop::collection::vec(factor, PREFIXES.len()),
                prop::collection::vec(any::<bool>(), PREFIXES.len()),
                0..4usize,
                any::<bool>(),
                any::<bool>(),
            )
                .prop_map(|(limit, offset, factors, on, filter, low, model)| {
                    let source_factors: Vec<Value> = PREFIXES
                        .iter()
                        .zip(factors.iter().zip(&on))
                        .filter(|(_, (_, on))| **on)
                        .map(|(p, (f, _))| json!([p, f]))
                        .collect();
                    let mut o =
                        json!({"limit": limit, "offset": offset, "source_factors": source_factors});
                    match filter {
                        1 => o["source_ids"] = json!(["side"]),
                        2 => o["types"] = json!(["concept"]),
                        3 => o["hard_excludes"] = json!([]),
                        _ => {}
                    }
                    if low {
                        o["detail"] = json!("low");
                    }
                    if model {
                        o["model"] = json!(MODEL);
                    }
                    o
                })
        }

        proptest! {
            #![proptest_config(ProptestConfig {
                cases: 48,
                // No regression files in the source tree, as the crate's other property tests.
                failure_persistence: None,
                ..ProptestConfig::default()
            })]
            #[test]
            fn bounded_equals_full(
                pages in prop::collection::vec(page_spec(), 1..12),
                query in prop::collection::vec(prop::sample::select(vec![-1.0f64, 0.0, 0.5, 1.0]), 3),
                runs in prop::collection::vec(options(), 1..6),
            ) {
                let s = store();
                s.upsert_source(&SourceInput { id: "side".to_string(), ..SourceInput::default() }).unwrap();
                for (i, spec) in pages.iter().enumerate() {
                    let mut fm = json!({});
                    if spec.stub {
                        fm = json!({"provenance": "auto-extracted", "status": "unverified"});
                    }
                    if spec.hidden {
                        fm["quarantine"] = json!(true);
                    }
                    let extra = json!({
                        "type": if spec.concept { "concept" } else { "note" },
                        "frontmatter": fm,
                    });
                    let source = if spec.side { "side" } else { "default" };
                    page(&s, source, &format!("{}p{i}", PREFIXES[spec.prefix]), &spec.chunks, extra);
                }
                for run in runs {
                    let o = opts(run.clone());
                    let (bounded, full) = both_paths(&s, &query, &o);
                    prop_assert_eq!(bounded, full, "options {}", run);
                }
            }

            #[test]
            fn page_bound_is_at_least_every_score(
                raws in prop::collection::vec(-1.0f64..=1.0, 1..6),
                factors in prop::collection::vec(prop::sample::select(vec![-2.0f64, -0.5, 0.0, 0.3, 1.0, 1.5]), 0..4),
            ) {
                let set: Vec<f64> = std::iter::once(1.0).chain(factors.iter().copied()).collect();
                let bound = page_bound(&raws, &set);
                for raw in &raws {
                    for factor in &set {
                        prop_assert!((raw * factor).total_cmp(&bound).is_le());
                    }
                }
            }
        }
    }
}
