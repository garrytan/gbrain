//! The chunk reads of `src/core/engine-sql/chunk-reads.ts`: code-def's and code-refs' symbol
//! lookups (`findCodeDefinitions`, `listSymbolTypesForName`, `findCodeRefChunks`), the code
//! readiness probes (`codeChunksExist`, `currentCodeChunksExist`), the recursive walk's
//! disambiguation (`listQualifiedSymbolNames`), three doctor counts (`countOversizedEmbedSkips`,
//! `countOrphanChunks`, `countCodeChunkPages`), withdrawal's chunk scan and delete
//! (`listWithdrawalChunks`, `deleteChunksForPages`), the import's `deleteChunksExcept`, the
//! contextual-mode repair plan (`listContextualModeCandidates`) and evidence delivery's frozen
//! hits (`resolveFrozenHits`).
//!
//! Each member answers what the SQL engines' statement answers over the same rows. The read policy
//! is `pageReadFilter`'s source clause, its page privacy policy and its live test (not deleted,
//! not quarantined, in a source that exists and is not archived); the TypeScript members refuse a
//! trust, flag or safe-chunk policy before they call the store. A served page is one whose
//! `text_projection_revision` is its `knowledge_revision` or the v153 activation marker
//! (`servedTextProjectionFilter`). Strings compare by bytes, as PGLite's C collation does, and a
//! NULL sorts after every value in ascending order. Rows the SQL leaves in plan order tie-break
//! on chunk id.
//!
//! `resolveFrozenHits` joins the chunk of the page's live body: an inline chunk of a page that is
//! not segmented, or a segmented chunk at or below the page's body generation. The SQL engines
//! also require a live `page_body_manifest` row for a segmented chunk; that manifest is the
//! page_body family's private state, which this family does not read (follow-up
//! `frozen-hit-manifest-liveness`).

use super::{EMBED_SKIP_KEY, QUARANTINE_KEY, SAFE_FENCE_CHUNKER_VERSION, sealed, segmented};
use crate::Store;
use crate::chunks::{
    ChunkRecord, clear_chunks, delete_chunks_matching, in_live_body, read_chunks, read_segment_view,
};
use crate::error::Result;
use crate::facts::{PrivacyPolicy, like, page_hidden, pg_lower_char};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::sources::{DEFAULT_SOURCE, read_source};
use crate::timeline_queries::jsonb_field_text;
use crate::trust::{TrustPolicy, TrustTier};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};

/// `ACTIVATION_SERVED_REVISION` (`src/core/search/safe-chunks.ts`).
const ACTIVATION_SERVED_REVISION: &str = "00000000-0000-0000-0000-000000000153";

/// The read policy the TypeScript members send: `pageReadFilter`'s source clause, under
/// `excludePrivate` the page privacy policy, and its `pageEligibleSql` trust floor and flag
/// suppression (`minTrust`, `suppressFlagged`). `allSources` has already dropped `sourceId`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChunkReadScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub exclude_private: Option<PrivacyPolicy>,
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
}

impl ChunkReadScope {
    /// `sourceIds` when not empty, else a non-empty `sourceId`, else every source.
    fn source_ok(&self, source_id: &str) -> bool {
        match (&self.source_ids, &self.source_id) {
            (Some(ids), _) if !ids.is_empty() => ids.iter().any(|id| id == source_id),
            (_, Some(id)) if !id.is_empty() => id == source_id,
            _ => true,
        }
    }
}

/// `findCodeDefinitions` / `listSymbolTypesForName` / `findCodeRefChunks` input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodeSymbolInput {
    pub symbol: String,
    pub language: Option<String>,
    pub limit: Option<u64>,
    /// `findCodeDefinitions`: the definition types (`DEF_TYPES` plus `export statement`).
    pub def_types: Vec<String>,
    pub scope: ChunkReadScope,
}

/// `codeChunksExist` / `currentCodeChunksExist` input. `served` asks for the served projection
/// (`codeReadFilter`), `withSymbol` for a chunk with a `symbol_name`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CodeChunksExistInput {
    pub served: bool,
    pub with_symbol: bool,
    pub scope: ChunkReadScope,
}

/// `hasUnsealedPages(scope)`: the page read scope, and search's type list and hard-excluded slug
/// prefixes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UnsealedPagesInput {
    pub scope: ChunkReadScope,
    pub types: Option<Vec<String>>,
    pub exclude_slug_prefixes: Vec<String>,
}

/// `listQualifiedSymbolNames(sourceId, symbol, { match, limit })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QualifiedNamesInput {
    pub source_id: String,
    pub symbol: String,
    /// `exact` or `contains`.
    #[serde(rename = "match")]
    pub match_kind: String,
    pub limit: u64,
}

/// One withdrawal key.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct WithdrawalKey {
    pub subject: String,
    pub patterns: Vec<String>,
}

/// `listWithdrawalChunks(sourceId, keys, { after, limit, subjects })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WithdrawalChunksInput {
    pub source_id: String,
    pub keys: Vec<WithdrawalKey>,
    pub after: i64,
    pub limit: u64,
    pub subjects: Option<Vec<String>>,
}

/// `deleteChunksExcept(slug, keepIds, { sourceId })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DeleteChunksExceptInput {
    pub slug: String,
    pub keep_ids: Vec<i64>,
    pub source_id: Option<String>,
}

/// One frozen hit: `chunk_id` 0 (or below) names the page's first chunk.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct FrozenHit {
    pub source_id: String,
    pub slug: String,
    pub chunk_id: i64,
    pub ord: i64,
}

/// `resolveFrozenHits(hits, scope)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct FrozenHitsInput {
    pub hits: Vec<FrozenHit>,
    pub scope: ChunkReadScope,
}

/// A chunk metadata column as text: NULL when absent or null.
fn meta_text(chunk: &ChunkRecord, key: &str) -> Option<String> {
    chunk.meta.get(key).and_then(jsonb_field_text)
}

fn meta_value(chunk: &ChunkRecord, key: &str) -> Value {
    chunk.meta.get(key).cloned().unwrap_or(Value::Null)
}

fn meta_line(chunk: &ChunkRecord, key: &str) -> Option<i64> {
    chunk.meta.get(key).and_then(Value::as_i64)
}

/// `servedTextProjectionFilter`.
fn served(page: &PageRecord) -> bool {
    sealed(page) || page.text_projection_revision.as_deref() == Some(ACTIVATION_SERVED_REVISION)
}

/// `frontmatter ->> 'file'`.
fn frontmatter_file(page: &PageRecord) -> Value {
    page.frontmatter
        .get("file")
        .and_then(jsonb_field_text)
        .map_or(Value::Null, Value::String)
}

/// Ascending order with NULLs last.
fn nulls_last<T: Ord>(a: &Option<T>, b: &Option<T>) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => a.cmp(b),
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
    }
}

/// `pageReadFilter(.., live = true)` over pages, with the source cache it needs.
struct Policy<'a> {
    read: &'a dyn KvRead,
    sources: HashMap<String, bool>,
}

impl<'a> Policy<'a> {
    fn new(read: &'a dyn KvRead) -> Self {
        Self {
            read,
            sources: HashMap::new(),
        }
    }

    fn source_live(&mut self, source_id: &str) -> Result<bool> {
        if let Some(live) = self.sources.get(source_id) {
            return Ok(*live);
        }
        let live = read_source(self.read, source_id)?.is_some_and(|s| !s.archived);
        self.sources.insert(source_id.to_string(), live);
        Ok(live)
    }

    fn passes(&mut self, page: &PageRecord, scope: &ChunkReadScope) -> Result<bool> {
        if !scope.source_ok(&page.source_id) {
            return Ok(false);
        }
        if let Some(policy) = &scope.exclude_private
            && page_hidden(self.read, page, policy)?
        {
            return Ok(false);
        }
        let trust = TrustPolicy::parse(scope.min_trust.as_deref(), scope.suppress_flagged)?;
        let tier = TrustTier::stored(page.trust_tier.as_deref());
        if !trust.admits(self.read, "pages", page.id, tier)? {
            return Ok(false);
        }
        Ok(page.deleted_at_us.is_none()
            && !page.frontmatter.contains_key(QUARANTINE_KEY)
            && self.source_live(&page.source_id)?)
    }
}

/// The served live code pages `scope` reads (`p.page_kind = 'code' AND codeReadFilter`), with
/// their chunks.
fn served_code_chunks(
    read: &dyn KvRead,
    scope: &ChunkReadScope,
) -> Result<Vec<(PageRecord, Vec<ChunkRecord>)>> {
    let mut policy = Policy::new(read);
    let mut out = Vec::new();
    for page in all_pages(read)? {
        if page.page_kind != "code" || !served(&page) || !policy.passes(&page, scope)? {
            continue;
        }
        let chunks = read_chunks(read, page.id)?;
        out.push((page, chunks));
    }
    Ok(out)
}

/// `findCodeDefinitions`' `CASE cc.symbol_type ... END`.
fn definition_rank(symbol_type: Option<&str>) -> u8 {
    match symbol_type {
        Some("function") => 1,
        Some("class") => 2,
        Some("interface") => 3,
        Some("type") => 4,
        Some("enum") => 5,
        Some("struct") => 6,
        _ => 7,
    }
}

fn code_row(page: &PageRecord, chunk: &ChunkRecord, with_name: bool) -> Value {
    let mut row = json!({
        "slug": page.slug,
        "source_id": page.source_id,
        "file": frontmatter_file(page),
        "language": meta_value(chunk, "language"),
        "symbol_type": meta_value(chunk, "symbol_type"),
        "start_line": meta_value(chunk, "start_line"),
        "end_line": meta_value(chunk, "end_line"),
        "chunk_text": chunk.chunk_text,
    });
    if with_name {
        row["symbol_name"] = meta_value(chunk, "symbol_name");
    }
    row
}

fn language_ok(chunk: &ChunkRecord, language: &Option<String>) -> bool {
    match language.as_deref().filter(|l| !l.is_empty()) {
        Some(lang) => meta_text(chunk, "language").as_deref() == Some(lang),
        None => true,
    }
}

fn take(limit: u64) -> usize {
    usize::try_from(limit).unwrap_or(usize::MAX)
}

impl Store {
    /// `findCodeDefinitions(symbol, opts)`.
    pub fn find_code_definitions(&self, input: &CodeSymbolInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut hits: Vec<(u8, String, Option<i64>, String, u64, Value)> = Vec::new();
        for (page, chunks) in served_code_chunks(&*read, &input.scope)? {
            for chunk in &chunks {
                let symbol_type = meta_text(chunk, "symbol_type");
                if meta_text(chunk, "symbol_name").as_deref() != Some(input.symbol.as_str())
                    || !language_ok(chunk, &input.language)
                    || !symbol_type
                        .as_ref()
                        .is_some_and(|t| input.def_types.contains(t))
                {
                    continue;
                }
                hits.push((
                    definition_rank(symbol_type.as_deref()),
                    page.slug.clone(),
                    meta_line(chunk, "start_line"),
                    page.source_id.clone(),
                    chunk.id,
                    code_row(&page, chunk, false),
                ));
            }
        }
        hits.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| nulls_last(&a.2, &b.2))
                .then_with(|| a.3.cmp(&b.3))
                .then_with(|| a.4.cmp(&b.4))
        });
        Ok(hits
            .into_iter()
            .take(take(input.limit.unwrap_or(20)))
            .map(|h| h.5)
            .collect())
    }

    /// `listSymbolTypesForName(symbol, opts)`: distinct, in order, NULL last, at most 20.
    pub fn list_symbol_types_for_name(&self, input: &CodeSymbolInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut types: BTreeSet<Option<String>> = BTreeSet::new();
        for (_, chunks) in served_code_chunks(&*read, &input.scope)? {
            for chunk in &chunks {
                if meta_text(chunk, "symbol_name").as_deref() == Some(input.symbol.as_str())
                    && language_ok(chunk, &input.language)
                {
                    types.insert(meta_text(chunk, "symbol_type"));
                }
            }
        }
        let mut list: Vec<Option<String>> = types.into_iter().collect();
        list.sort_by(nulls_last);
        Ok(list
            .into_iter()
            .take(20)
            .map(|t| t.map_or(Value::Null, Value::String))
            .collect())
    }

    /// `findCodeRefChunks(symbol, opts)`: `chunk_text ILIKE '%symbol%'`, the symbol unescaped.
    pub fn find_code_ref_chunks(&self, input: &CodeSymbolInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let pattern = format!("%{}%", input.symbol);
        let mut hits: Vec<(String, Option<i64>, String, u64, Value)> = Vec::new();
        for (page, chunks) in served_code_chunks(&*read, &input.scope)? {
            for chunk in &chunks {
                if !language_ok(chunk, &input.language) || !like(&chunk.chunk_text, &pattern, true)?
                {
                    continue;
                }
                hits.push((
                    page.slug.clone(),
                    meta_line(chunk, "start_line"),
                    page.source_id.clone(),
                    chunk.id,
                    code_row(&page, chunk, true),
                ));
            }
        }
        hits.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| nulls_last(&a.1, &b.1))
                .then_with(|| a.2.cmp(&b.2))
                .then_with(|| a.3.cmp(&b.3))
        });
        Ok(hits
            .into_iter()
            .take(take(input.limit.unwrap_or(50)))
            .map(|h| h.4)
            .collect())
    }

    /// `countOversizedEmbedSkips(maxBytes)`: `{ marked, chunkless }`.
    pub fn count_oversized_embed_skips(&self, max_bytes: f64) -> Result<Value> {
        let read = self.read()?;
        let (mut marked, mut chunkless) = (0u64, 0u64);
        for page in all_pages(&*read)? {
            let reason = page
                .frontmatter
                .get(EMBED_SKIP_KEY)
                .and_then(Value::as_object)
                .and_then(|skip| skip.get("reason"))
                .and_then(jsonb_field_text);
            if page.deleted_at_us.is_some()
                || reason.as_deref() != Some("oversized")
                || page.compiled_truth.is_null()
            {
                continue;
            }
            let bytes = page.compiled_truth.len() + page.timeline.len();
            if bytes as f64 > max_bytes {
                continue;
            }
            marked += 1;
            if read_chunks(&*read, page.id)?.is_empty() {
                chunkless += 1;
            }
        }
        Ok(json!({ "marked": marked, "chunkless": chunkless }))
    }

    /// `countOrphanChunks()`: chunk rows whose page id names no page.
    pub fn count_orphan_chunks(&self) -> Result<u64> {
        let read = self.read()?;
        let mut per_page: HashMap<u64, u64> = HashMap::new();
        scan_prefix(&*read, &[keys::CHUNK], false, &mut |key, _| {
            if let Some(id) = key.get(1..9).and_then(|b| <[u8; 8]>::try_from(b).ok()) {
                *per_page.entry(u64::from_be_bytes(id)).or_default() += 1;
            }
            true
        })?;
        let mut orphans = 0;
        for (page_id, n) in per_page {
            if read_page_by_id(&*read, page_id)?.is_none() {
                orphans += n;
            }
        }
        Ok(orphans)
    }

    /// `countCodeChunkPages()`: chunks of live `type: code` pages with neither a symbol name nor
    /// a language, and their pages.
    pub fn count_code_chunk_pages(&self) -> Result<Value> {
        let read = self.read()?;
        let (mut chunks, mut pages) = (0u64, 0u64);
        for page in all_pages(&*read)? {
            if page.page_type != "code" || page.deleted_at_us.is_some() {
                continue;
            }
            let bare = read_chunks(&*read, page.id)?
                .iter()
                .filter(|c| {
                    meta_text(c, "symbol_name").is_none() && meta_text(c, "language").is_none()
                })
                .count() as u64;
            chunks += bare;
            pages += u64::from(bare > 0);
        }
        Ok(json!({ "chunks": chunks, "pages": pages }))
    }

    /// `codeChunksExist` (`served: false`, any stored chunk) and `currentCodeChunksExist`
    /// (`served: true`, optionally `withSymbol`).
    pub fn code_chunks_exist(&self, input: &CodeChunksExistInput) -> Result<bool> {
        let read = self.read()?;
        let mut policy = Policy::new(&*read);
        for page in all_pages(&*read)? {
            if page.page_kind != "code"
                || (input.served && !served(&page))
                || !policy.passes(&page, &input.scope)?
            {
                continue;
            }
            let chunks = read_chunks(&*read, page.id)?;
            if chunks
                .iter()
                .any(|c| !input.with_symbol || meta_text(c, "symbol_name").is_some())
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `hasUnsealedPages(scope)`: a live page in scope whose `chunker_version` is below the
    /// safe-chunk fence, of one of `types` when given and under none of the excluded slug prefixes
    /// (`LEFT(p.slug, LENGTH(prefix)) <> prefix`). A record that stores no version counts as 0, as
    /// the remote reads count it.
    pub fn has_unsealed_pages(&self, input: &UnsealedPagesInput) -> Result<bool> {
        if input.scope.source_ids.as_ref().is_some_and(Vec::is_empty) {
            return Ok(false);
        }
        let read = self.read()?;
        let mut policy = Policy::new(&*read);
        for page in all_pages(&*read)? {
            if page.chunker_version.unwrap_or(0) >= SAFE_FENCE_CHUNKER_VERSION
                || input
                    .types
                    .as_ref()
                    .is_some_and(|types| !types.contains(&page.page_type))
                || input
                    .exclude_slug_prefixes
                    .iter()
                    .any(|prefix| page.slug.starts_with(prefix.as_str()))
            {
                continue;
            }
            if policy.passes(&page, &input.scope)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `listQualifiedSymbolNames(sourceId, symbol, { match, limit })`.
    pub fn list_qualified_symbol_names(&self, input: &QualifiedNamesInput) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut policy = Policy::new(&*read);
        let scope = ChunkReadScope::default();
        let contains = input.match_kind == "contains";
        let pattern = format!("%{}%", input.symbol);
        let mut names: BTreeSet<String> = BTreeSet::new();
        for page in all_pages(&*read)? {
            if page.source_id != input.source_id
                || !served(&page)
                || !policy.passes(&page, &scope)?
            {
                continue;
            }
            for chunk in read_chunks(&*read, page.id)? {
                let Some(qualified) = meta_text(&chunk, "symbol_name_qualified") else {
                    continue;
                };
                let hit = if contains {
                    like(&qualified, &pattern, true)?
                } else {
                    qualified == input.symbol
                        || meta_text(&chunk, "symbol_name").as_deref()
                            == Some(input.symbol.as_str())
                };
                if hit {
                    names.insert(qualified);
                }
            }
        }
        Ok(names.into_iter().take(take(input.limit)).collect())
    }

    /// `listWithdrawalChunks(sourceId, keys, { after, limit, subjects })`.
    pub fn list_withdrawal_chunks(&self, input: &WithdrawalChunksInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut hits: Vec<(u64, Value)> = Vec::new();
        for page in all_pages(&*read)? {
            if page.source_id != input.source_id
                || input
                    .subjects
                    .as_ref()
                    .is_some_and(|s| !s.contains(&page.slug))
            {
                continue;
            }
            let keys: Vec<&WithdrawalKey> = input
                .keys
                .iter()
                .filter(|k| k.subject == "*" || k.subject == page.slug)
                .collect();
            if keys.is_empty() {
                continue;
            }
            for chunk in read_chunks(&*read, page.id)? {
                if i128::from(chunk.id) <= i128::from(input.after) {
                    continue;
                }
                let lowered: String = chunk.chunk_text.chars().map(pg_lower_char).collect();
                let mut matched = false;
                for key in &keys {
                    let mut all = true;
                    for pattern in &key.patterns {
                        if !like(&lowered, pattern, false)? {
                            all = false;
                            break;
                        }
                    }
                    if all {
                        matched = true;
                        break;
                    }
                }
                if matched {
                    hits.push((
                        chunk.id,
                        json!({ "id": chunk.id, "page_id": chunk.page_id, "slug": page.slug, "chunk_text": chunk.chunk_text }),
                    ));
                }
            }
        }
        hits.sort_by_key(|h| h.0);
        Ok(hits
            .into_iter()
            .take(take(input.limit))
            .map(|h| h.1)
            .collect())
    }

    /// `deleteChunksForPages(pageIds)`: every chunk of those pages; seals nothing.
    pub fn delete_chunks_for_pages(&self, page_ids: &[i64]) -> Result<()> {
        self.write(|tx| {
            let ids: BTreeSet<u64> = page_ids
                .iter()
                .filter_map(|id| u64::try_from(*id).ok())
                .collect();
            for id in ids {
                clear_chunks(tx, id)?;
            }
            Ok(())
        })
    }

    /// `deleteChunksExcept(slug, keepIds, { sourceId })`: the slug as written, source `default`
    /// unless named; the text seal is kept.
    pub fn delete_chunks_except(&self, input: &DeleteChunksExceptInput) -> Result<()> {
        self.write(|tx| {
            let source = input.source_id.as_deref().unwrap_or(DEFAULT_SOURCE);
            if let Some(page) = read_page(&*tx, source, &input.slug)? {
                let keep: BTreeSet<i64> = input.keep_ids.iter().copied().collect();
                delete_chunks_matching(tx, page.id, &|c| {
                    i64::try_from(c.id).map_or(true, |id| !keep.contains(&id))
                })?;
            }
            Ok(())
        })
    }

    /// `listContextualModeCandidates(sourceIds)`.
    pub fn list_contextual_mode_candidates(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for page in all_pages(&*read)? {
            if !source_ids.contains(&page.source_id)
                || page.deleted_at_us.is_some()
                || page.page_kind != "markdown"
            {
                continue;
            }
            let mut columns = Value::Object(Map::new());
            crate::page_columns::add_page_columns(&*read, &page, &mut columns)?;
            if !columns
                .get("contextual_retrieval_mode")
                .is_none_or(Value::is_null)
            {
                continue;
            }
            let sealed_col = page
                .text_projection_revision
                .as_deref()
                .map_or(Value::Null, |tpr| {
                    Value::Bool(tpr == page.knowledge_revision)
                });
            let chars: usize = read_chunks(&*read, page.id)?
                .iter()
                .map(|c| c.chunk_text.chars().count())
                .sum();
            out.push(json!({
                "id": page.id,
                "source_id": page.source_id,
                "slug": page.slug,
                "sealed": sealed_col,
                "embed_skip": page.frontmatter.contains_key(EMBED_SKIP_KEY),
                "chars": chars,
            }));
        }
        out.sort_by_key(|row| row["id"].as_u64());
        Ok(out)
    }

    /// `resolveFrozenHits(hits, scope)`: one row per hit and joined chunk (chunk columns NULL
    /// when the page holds no such chunk), in hit order.
    pub fn resolve_frozen_hits(&self, input: &FrozenHitsInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut policy = Policy::new(&*read);
        let mut out = Vec::new();
        for hit in &input.hits {
            let Some(page) = read_page(&*read, &hit.source_id, &hit.slug)? else {
                continue;
            };
            if !served(&page) || !policy.passes(&page, &input.scope)? {
                continue;
            }
            // `chunkGenerationFilter`: a chunk of the live body. A chunk whose occurrence a deferred retire
            // closed has no live manifest row, so it is not one, though its generation is not above the page's.
            let view = read_segment_view(&*read, page.id)?;
            let segmented_page = segmented(&page);
            let mut chunks: Vec<ChunkRecord> = read_chunks(&*read, page.id)?
                .into_iter()
                .filter(|c| in_live_body(c, segmented_page, &view))
                .filter(|c| {
                    if hit.chunk_id > 0 {
                        i64::try_from(c.id).is_ok_and(|id| id == hit.chunk_id)
                    } else {
                        c.chunk_index == 0
                    }
                })
                .collect();
            chunks.sort_by_key(|c| c.id);
            let base = json!({
                "ord": hit.ord,
                "page_id": page.id,
                "slug": page.slug,
                "source_id": page.source_id,
                "title": page.title,
                "type": page.page_type,
                "effective_date": page.effective_date_us.map(crate::env::iso),
                "effective_date_source": page.effective_date_source,
                "chunk_id": Value::Null,
                "chunk_index": Value::Null,
                "chunk_text": Value::Null,
                "chunk_source": Value::Null,
            });
            if chunks.is_empty() {
                out.push(base);
                continue;
            }
            for chunk in chunks {
                let mut row = base.clone();
                row["chunk_id"] = json!(chunk.id);
                row["chunk_index"] = json!(chunk.chunk_index);
                row["chunk_text"] = json!(chunk.chunk_text);
                row["chunk_source"] = json!(chunk.chunk_source);
                out.push(row);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunks::{ChunkInput, UpsertChunksOptions};
    use crate::pages::{PageInput, PutPageOptions, ReadScope};
    use crate::test_support::store;

    /// A code page with one chunk per `(symbol, type, text)`, sealed when `seal`.
    fn code(store: &Store, slug: &str, symbols: &[(&str, &str, &str)], seal: bool) -> Vec<u64> {
        let input = PageInput {
            page_type: "code".into(),
            page_kind: Some("code".into()),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        let chunks: Vec<ChunkInput> = symbols
            .iter()
            .enumerate()
            .map(|(i, (name, kind, text))| {
                let mut rest = Map::new();
                rest.insert("symbol_name".into(), json!(name));
                rest.insert("symbol_name_qualified".into(), json!(format!("m.{name}")));
                rest.insert("symbol_type".into(), json!(kind));
                ChunkInput {
                    chunk_index: i as u32,
                    chunk_text: (*text).into(),
                    rest,
                    ..ChunkInput::default()
                }
            })
            .collect();
        let options = UpsertChunksOptions {
            seal,
            ..UpsertChunksOptions::default()
        };
        store.upsert_chunks(slug, &chunks, &options).unwrap();
        store
            .get_chunks(
                slug,
                &serde_json::from_value::<ReadScope>(json!({ "includeUnsealed": true })).unwrap(),
            )
            .unwrap()
            .iter()
            .map(|c| c["id"].as_u64().unwrap())
            .collect()
    }

    fn symbol(name: &str) -> CodeSymbolInput {
        CodeSymbolInput {
            symbol: name.into(),
            def_types: vec!["function".into(), "class".into()],
            ..CodeSymbolInput::default()
        }
    }

    #[test]
    fn has_unsealed_pages_reads_the_fence_under_the_type_and_slug_prefix_filters() {
        let store = store();
        let probe = |value: Value| {
            store
                .has_unsealed_pages(&serde_json::from_value::<UnsealedPagesInput>(value).unwrap())
                .unwrap()
        };
        assert!(!probe(json!({})));
        // A page written without the inline index stays below the fence, as PGLite's putPage leaves it.
        let unindexed = PutPageOptions {
            index: Some(false),
            ..PutPageOptions::default()
        };
        let input = PageInput {
            page_type: "note".into(),
            title: "draft".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store.put_page("notes/draft", &input, &unindexed).unwrap();
        assert!(probe(json!({})));
        assert!(probe(json!({ "types": ["note"] })));
        assert!(!probe(json!({ "types": ["concept"] })));
        assert!(!probe(json!({ "excludeSlugPrefixes": ["notes/"] })));
        assert!(!probe(json!({ "scope": { "sourceIds": [] } })));
        assert!(!probe(json!({ "scope": { "sourceId": "other" } })));
        let chunk = ChunkInput {
            chunk_text: "body".into(),
            ..ChunkInput::default()
        };
        let seal = UpsertChunksOptions {
            seal: true,
            ..UpsertChunksOptions::default()
        };
        store.upsert_chunks("notes/draft", &[chunk], &seal).unwrap();
        assert!(!probe(json!({})));
    }

    #[test]
    fn definitions_rank_functions_first_and_skip_unserved_pages() {
        let store = store();
        code(
            &store,
            "a",
            &[("run", "class", "class run"), ("run", "function", "fn run")],
            true,
        );
        code(&store, "b", &[("run", "function", "fn run")], false);
        // Not served: no text projection revision.
        store
            .write(|tx| {
                let mut page = read_page(&*tx, DEFAULT_SOURCE, "b")?.unwrap();
                page.text_projection_revision = None;
                crate::pages::write_page(tx, &page)
            })
            .unwrap();
        let rows = store.find_code_definitions(&symbol("run")).unwrap();
        let got: Vec<(&str, &str)> = rows
            .iter()
            .map(|r| {
                (
                    r["slug"].as_str().unwrap(),
                    r["symbol_type"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(got, vec![("a", "function"), ("a", "class")]);
        let any = CodeChunksExistInput::default();
        assert!(
            store.code_chunks_exist(&any).unwrap(),
            "an unserved stored chunk counts"
        );
    }

    #[test]
    fn qualified_names_are_sorted_distinct_and_bounded() {
        let store = store();
        code(
            &store,
            "a",
            &[
                ("zeta", "function", "z"),
                ("alpha", "function", "a"),
                ("alpha", "class", "a"),
            ],
            true,
        );
        let names = store
            .list_qualified_symbol_names(&QualifiedNamesInput {
                source_id: DEFAULT_SOURCE.into(),
                symbol: "a".into(),
                match_kind: "contains".into(),
                limit: 5,
            })
            .unwrap();
        assert_eq!(names, vec!["m.alpha", "m.zeta"]);
        let one = QualifiedNamesInput {
            source_id: DEFAULT_SOURCE.into(),
            symbol: "a".into(),
            match_kind: "contains".into(),
            limit: 1,
        };
        assert_eq!(
            store.list_qualified_symbol_names(&one).unwrap(),
            vec!["m.alpha"]
        );
    }

    #[test]
    fn delete_chunks_except_keeps_only_the_named_ids() {
        let store = store();
        let ids = code(
            &store,
            "a",
            &[("x", "function", "x"), ("y", "function", "y")],
            true,
        );
        store
            .delete_chunks_except(&DeleteChunksExceptInput {
                slug: "a".into(),
                keep_ids: vec![ids[1] as i64],
                source_id: None,
            })
            .unwrap();
        let page = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "a")
            .unwrap()
            .unwrap();
        let left: Vec<u64> = read_chunks(&*store.read().unwrap(), page.id)
            .unwrap()
            .iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(left, vec![ids[1]]);
        store.delete_chunks_for_pages(&[page.id as i64]).unwrap();
        assert!(
            read_chunks(&*store.read().unwrap(), page.id)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_frozen_hit_on_a_chunk_the_page_does_not_hold_keeps_its_page_row() {
        let store = store();
        let ids = code(
            &store,
            "a",
            &[("x", "function", "x"), ("y", "function", "y")],
            true,
        );
        let hit = |chunk_id: i64, ord: i64| FrozenHit {
            source_id: DEFAULT_SOURCE.into(),
            slug: "a".into(),
            chunk_id,
            ord,
        };
        let rows = store
            .resolve_frozen_hits(&FrozenHitsInput {
                hits: vec![hit(ids[1] as i64, 0), hit(0, 1), hit(999_999, 2)],
                scope: ChunkReadScope::default(),
            })
            .unwrap();
        let got: Vec<(i64, Value)> = rows
            .iter()
            .map(|r| (r["ord"].as_i64().unwrap(), r["chunk_index"].clone()))
            .collect();
        assert_eq!(got, vec![(0, json!(1)), (1, json!(0)), (2, Value::Null)]);
    }
}
