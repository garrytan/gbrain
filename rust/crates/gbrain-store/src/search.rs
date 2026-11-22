//! Keyword search over the posting index.
//!
//! This is a plain BM25 over chunks, not the Postgres full-text ranking PGLite uses, so scores
//! and order differ from the TypeScript engines (parity is a later design item, D5). What it
//! shares with them is the contract: every query term must match (AND), a page is represented
//! by its best chunk, results order by `score DESC, page_id ASC, chunk_id ASC`, soft-deleted
//! pages, quarantined and pinned-question pages, archived sources, image chunks and pages whose chunks are not sealed to the current
//! text never appear, and `test/`, `attachments/` and `.raw/` slugs are hidden unless the
//! caller opts back in.

use crate::chunks::{ChunkRecord, read_chunks, read_stats, tokenize};
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, read_page_by_id};
use crate::sources::read_source;
use crate::{Store, keys};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

const DEFAULT_LIMIT: usize = 20;
/// `MAX_SEARCH_LIMIT` of `src/core/engine.ts`.
pub const MAX_SEARCH_LIMIT: usize = 100;
const DEFAULT_HARD_EXCLUDES: &[&str] = &["test/", "attachments/", ".raw/"];
/// Frontmatter keys that hide a page from keyword search whatever their value is, as the JSONB
/// `?` test of `buildVisibilityClause` does: `quarantine` (junk the content gate caught) and
/// `pinned_question` (a pinned question's page is read through the questions API, never ranked).
const HIDING_FRONTMATTER_KEYS: &[&str] = &["quarantine", "pinned_question"];
const K1: f64 = 1.2;
const B: f64 = 0.75;
/// Words dropped from a query (the English full-text config drops them too). A query made only
/// of these keeps them.
const STOP_WORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it",
    "no", "not", "of", "on", "or", "such", "that", "the", "their", "then", "there", "these",
    "they", "this", "to", "was", "will", "with",
];

/// `SearchOpts` of `src/core/types.ts`, the part this engine honours. Options that would change
/// which pages match and are not supported (`where`, `afterDate`, `beforeDate`) are refused with
/// `invalid_argument` instead of being ignored. Ranking-only options are ignored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SearchOptions {
    pub limit: Option<f64>,
    pub offset: Option<f64>,
    #[serde(rename = "type")]
    pub page_type: Option<String>,
    pub types: Option<Vec<String>>,
    pub exclude_slugs: Option<Vec<String>>,
    pub exclude_slug_prefixes: Option<Vec<String>>,
    pub include_slug_prefixes: Option<Vec<String>>,
    pub detail: Option<String>,
    pub language: Option<String>,
    #[serde(rename = "symbolKind")]
    pub symbol_kind: Option<String>,
    #[serde(rename = "sourceId")]
    pub source_id: Option<String>,
    #[serde(rename = "sourceIds")]
    pub source_ids: Option<Vec<String>>,
    #[serde(rename = "where")]
    pub where_clause: Option<Value>,
    #[serde(rename = "afterDate")]
    pub after_date: Option<Value>,
    #[serde(rename = "beforeDate")]
    pub before_date: Option<Value>,
}

/// `clampSearchLimit(limit, 20, 100)`.
pub fn clamp_limit(limit: Option<f64>) -> usize {
    match limit {
        Some(l) if l.is_finite() && l > 0.0 => (l.floor() as usize).clamp(1, MAX_SEARCH_LIMIT),
        _ => DEFAULT_LIMIT,
    }
}

fn query_terms(query: &str) -> Vec<String> {
    let all = tokenize(query);
    let mut seen = HashSet::new();
    let unique: Vec<String> = all.into_iter().filter(|t| seen.insert(t.clone())).collect();
    let kept: Vec<String> = unique
        .iter()
        .filter(|t| !STOP_WORDS.contains(&t.as_str()))
        .cloned()
        .collect();
    if kept.is_empty() { unique } else { kept }
}

/// Postings of one term: `(page_id, chunk_index) -> term frequency`.
fn postings(read: &dyn KvRead, term: &str) -> Result<BTreeMap<(u64, u32), u32>> {
    let prefix = keys::posting_prefix(term);
    let mut out = BTreeMap::new();
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let tail = &k[prefix.len()..];
        match (
            tail.get(..8).and_then(keys::be8),
            tail.get(8..12).and_then(keys::be4),
            keys::be4(v),
        ) {
            (Some(page), Some(index), Some(tf)) if tail.len() == 12 => {
                out.insert((page, index), tf);
            }
            _ => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            format!("a posting for \"{term}\" is malformed"),
        ));
    }
    Ok(out)
}

fn hidden_by_slug(slug: &str, prefixes: &[String], exact: &[String]) -> bool {
    exact.iter().any(|s| s == slug)
        || prefixes
            .iter()
            .any(|p| !p.is_empty() && slug.starts_with(p.as_str()))
}

struct Hit {
    page_id: u64,
    chunk_id: u64,
    score: f64,
    chunk: ChunkRecord,
}

impl Store {
    /// `searchKeyword(query, opts)`: one result per matching page, best chunk first.
    pub fn search_keyword(&self, query: &str, options: &SearchOptions) -> Result<Vec<Value>> {
        for (name, value) in [
            ("where", &options.where_clause),
            ("afterDate", &options.after_date),
            ("beforeDate", &options.before_date),
        ] {
            if value.as_ref().is_some_and(|v| !v.is_null()) {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("searchKeyword: the {name} filter is not supported by the rust engine"),
                ));
            }
        }
        let limit = clamp_limit(options.limit);
        let offset = options
            .offset
            .filter(|o| o.is_finite() && *o > 0.0)
            .map_or(0, |o| o.floor() as usize);
        let terms = query_terms(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let stats = read_stats(&*read)?;
        if stats.chunks == 0 {
            return Ok(Vec::new());
        }

        let lists = terms
            .iter()
            .map(|t| postings(&*read, t))
            .collect::<Result<Vec<_>>>()?;
        if lists.iter().any(BTreeMap::is_empty) {
            return Ok(Vec::new());
        }
        let n = stats.chunks as f64;
        let avg_len = (stats.total_length as f64 / n).max(1.0);
        let idf: Vec<f64> = lists
            .iter()
            .map(|l| (1.0 + (n - l.len() as f64 + 0.5) / (l.len() as f64 + 0.5)).ln())
            .collect();

        let mut excludes: Vec<String> = DEFAULT_HARD_EXCLUDES
            .iter()
            .map(|s| s.to_string())
            .collect();
        excludes.extend(options.exclude_slug_prefixes.iter().flatten().cloned());
        if let Some(include) = &options.include_slug_prefixes {
            excludes.retain(|p| !include.contains(p));
        }
        let exact = options.exclude_slugs.clone().unwrap_or_default();
        let scoped: Option<Vec<String>> = match (&options.source_ids, &options.source_id) {
            (Some(ids), _) if !ids.is_empty() => Some(ids.clone()),
            (_, Some(id)) if !id.is_empty() => Some(vec![id.clone()]),
            _ => None,
        };

        let mut pages: HashMap<u64, Option<PageRecord>> = HashMap::new();
        let mut archived: HashMap<String, bool> = HashMap::new();
        let mut best: HashMap<u64, Hit> = HashMap::new();
        // Walk the rarest term's postings and require the rest.
        let rarest = (0..lists.len())
            .min_by_key(|i| lists[*i].len())
            .unwrap_or(0);
        'candidates: for key in lists[rarest].keys() {
            let mut tfs = Vec::with_capacity(lists.len());
            for list in &lists {
                match list.get(key) {
                    Some(tf) => tfs.push(*tf),
                    None => continue 'candidates,
                }
            }
            let (page_id, index) = *key;
            let entry = match pages.get(&page_id) {
                Some(cached) => cached.clone(),
                None => {
                    let found = read_page_by_id(&*read, page_id)?;
                    pages.insert(page_id, found.clone());
                    found
                }
            };
            let Some(page) = entry else { continue };
            if page.deleted_at_us.is_some()
                || HIDING_FRONTMATTER_KEYS
                    .iter()
                    .any(|key| page.frontmatter.contains_key(*key))
                || page.text_projection_revision.as_deref()
                    != Some(page.knowledge_revision.as_str())
                || hidden_by_slug(&page.slug, &excludes, &exact)
                || scoped
                    .as_ref()
                    .is_some_and(|ids| !ids.contains(&page.source_id))
                || options
                    .page_type
                    .as_ref()
                    .is_some_and(|t| *t != page.page_type)
                || options
                    .types
                    .as_ref()
                    .is_some_and(|ts| !ts.contains(&page.page_type))
            {
                continue;
            }
            let is_archived = match archived.get(&page.source_id) {
                Some(a) => *a,
                None => {
                    let a = read_source(&*read, &page.source_id)?.is_some_and(|s| s.archived);
                    archived.insert(page.source_id.clone(), a);
                    a
                }
            };
            if is_archived {
                continue;
            }
            let Some(raw) = read.get(&keys::chunk(page_id, index))? else {
                continue;
            };
            let chunk: ChunkRecord = serde_json::from_slice(&raw)?;
            if chunk.modality == "image"
                || (options.detail.as_deref() == Some("low")
                    && chunk.chunk_source != "compiled_truth")
                || options
                    .language
                    .as_ref()
                    .is_some_and(|l| chunk.meta.get("language").and_then(Value::as_str) != Some(l))
                || options.symbol_kind.as_ref().is_some_and(|k| {
                    chunk.meta.get("symbol_type").and_then(Value::as_str) != Some(k)
                })
            {
                continue;
            }
            let len = f64::from(chunk.length);
            let score: f64 = tfs
                .iter()
                .zip(&idf)
                .map(|(tf, idf)| {
                    let tf = f64::from(*tf);
                    idf * (tf * (K1 + 1.0)) / (tf + K1 * (1.0 - B + B * len / avg_len))
                })
                .sum();
            let hit = Hit {
                page_id,
                chunk_id: chunk.id,
                score,
                chunk,
            };
            match best.get(&page_id) {
                Some(current) if !better(&hit, current) => {}
                _ => {
                    best.insert(page_id, hit);
                }
            }
        }

        let mut hits: Vec<Hit> = best.into_values().collect();
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(a.page_id.cmp(&b.page_id))
                .then(a.chunk_id.cmp(&b.chunk_id))
        });
        let mut results = Vec::new();
        for hit in hits.into_iter().skip(offset).take(limit) {
            let Some(Some(page)) = pages.get(&hit.page_id) else {
                continue;
            };
            // PGLite's searchKeyword rule: a page is stale when a timeline entry was added
            // after the page was last written.
            let stale = crate::timeline::latest_entry_micros(&*read, page.id)?
                .is_some_and(|latest| page.updated_at_us < latest);
            let mut row = json!({
                "slug": page.slug,
                "page_id": page.id,
                "title": page.title,
                "type": page.page_type,
                "source_id": page.source_id,
                "chunk_text": hit.chunk.chunk_text,
                "chunk_source": hit.chunk.chunk_source,
                "chunk_id": hit.chunk_id,
                "chunk_index": hit.chunk.chunk_index,
                "score": hit.score,
                "stale": stale,
            });
            if let Some(us) = page.effective_date_us {
                row["effective_date"] = Value::String(crate::env::iso(us)[..10].to_string());
            }
            if let Some(source) = &page.effective_date_source {
                row["effective_date_source"] = Value::String(source.clone());
            }
            results.push(row);
        }
        Ok(results)
    }

    /// The chunks of a page, for callers that only have a page id.
    #[allow(dead_code)]
    pub(crate) fn chunks_of(&self, page_id: u64) -> Result<Vec<ChunkRecord>> {
        read_chunks(&*self.read()?, page_id)
    }
}

/// True when `a` should replace `b` as a page's chunk: higher score, then lower chunk id.
fn better(a: &Hit, b: &Hit) -> bool {
    a.score > b.score || (a.score == b.score && a.chunk_id < b.chunk_id)
}
