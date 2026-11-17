//! Chunk reads beyond the core chunks family: one page of a page's chunks
//! (`getChunkPage`), batched chunk windows for evidence delivery (`getChunkWindows`) and the
//! pages that have a body but no chunks (`countChunklessPagesWithContent`,
//! `listChunklessPagesWithContent`).
//!
//! Members: getChunkPage, getChunkWindows, countChunklessPagesWithContent,
//! listChunklessPagesWithContent.
//!
//! Every member reads records other families own (pages, chunks, sources) through their
//! `pub(crate)` readers and writes nothing, so this family keeps no records of its own: no key
//! starts with `keys::CHUNK_QUERIES` (`c`).
//!
//! The store keeps every body inline (no segmented pages), so the segmented branches of the SQL
//! engines never apply. It has no `chunker_version` column either: a page's chunks are sealed when
//! its `text_projection_revision` equals its `knowledge_revision`, the same test the SQL engines'
//! served-projection filter makes. See rust/docs/store/chunk_queries.md.

use crate::Store;
use crate::chunks::{ChunkRecord, read_chunks};
use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages, find_in_scope, read_page_by_id};
use crate::sources::read_source;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

/// `listChunklessPagesWithContent`'s default batch size.
const DEFAULT_CHUNKLESS_BATCH: u64 = 50;
/// The frontmatter key that hides a page (`QUARANTINE_FILTER_FRAGMENT`).
const QUARANTINE_KEY: &str = "quarantine";
/// The frontmatter key that marks a page whose chunks get no vectors.
const EMBED_SKIP_KEY: &str = "embed_skip";

/// `getChunkPage(slug, { sourceId, fromIndex, limit })`. The TypeScript member resolves the
/// scope to one named source before it calls the store.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChunkPageOptions {
    pub source_id: String,
    pub from_index: f64,
    pub limit: f64,
}

/// One `ChunkWindowRequest`: an inclusive `chunk_index` range of one page.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ChunkWindowRequest {
    pub page_id: i64,
    pub from_index: i64,
    pub to_index: i64,
    pub priority: i64,
}

/// `ChunkWindowOpts`, the part the store reads. `maxRows` arrives floored and not negative.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChunkWindowOptions {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub chunk_sources: Vec<String>,
    pub max_rows: u64,
}

/// `{ sourceId?, batchSize?, afterPageId? }` of the chunkless reads.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChunklessOptions {
    pub source_id: Option<String>,
    pub batch_size: Option<u64>,
    pub after_page_id: Option<i64>,
}

/// The page's chunks describe its current text (the served-projection filter).
fn sealed(page: &PageRecord) -> bool {
    page.text_projection_revision.as_deref() == Some(page.knowledge_revision.as_str())
}

fn source_archived(
    read: &dyn KvRead,
    cache: &mut HashMap<String, bool>,
    source_id: &str,
) -> Result<bool> {
    if let Some(archived) = cache.get(source_id) {
        return Ok(*archived);
    }
    let archived = read_source(read, source_id)?.is_some_and(|s| s.archived);
    cache.insert(source_id.to_string(), archived);
    Ok(archived)
}

/// `chunklessPagesWhere`: a live, not quarantined page with a body and no chunk rows, whose
/// chunks are not sealed or which carries `embed_skip`. A source id of `''` scopes nothing, as
/// the SQL engines' truthiness test does.
fn chunkless_pages(read: &dyn KvRead, source_id: Option<&str>) -> Result<Vec<PageRecord>> {
    let mut out = Vec::new();
    for page in all_pages(read)? {
        if source_id.is_some_and(|s| !s.is_empty() && s != page.source_id)
            || page.deleted_at_us.is_some()
            || (page.compiled_truth.is_empty() && page.timeline.is_empty())
            || page.frontmatter.contains_key(QUARANTINE_KEY)
            || (sealed(&page) && !page.frontmatter.contains_key(EMBED_SKIP_KEY))
            || !read_chunks(read, page.id)?.is_empty()
        {
            continue;
        }
        out.push(page);
    }
    out.sort_by_key(|p| p.id);
    Ok(out)
}

fn chunk_window_row(chunk: &ChunkRecord, prio: i64) -> Value {
    json!({
        "kind": "chunk",
        "page_id": chunk.page_id,
        "prio": prio,
        "chunk_id": chunk.id,
        "chunk_index": chunk.chunk_index,
        "chunk_text": chunk.chunk_text,
        "chunk_source": chunk.chunk_source,
        "projected_byte_start": chunk.meta.get("projected_byte_start").cloned().unwrap_or(Value::Null),
        "projected_byte_end": chunk.meta.get("projected_byte_end").cloned().unwrap_or(Value::Null),
        "occurrence_id": Value::Null,
    })
}

impl Store {
    /// `getChunkPage(slug, opts)`: the page's chunks with `fromIndex <= chunk_index <
    /// fromIndex + limit` in index order, the page's chunk count and its highest chunk index
    /// (`null` with no chunks). The page is read as `getChunks` reads it: the slug as written, a
    /// soft-deleted page like a live one, and no chunks unless they are sealed.
    pub fn get_chunk_page(&self, slug: &str, options: &ChunkPageOptions) -> Result<Value> {
        let read = self.read()?;
        let empty = json!({ "chunks": [], "total_chunks": 0, "max_chunk_index": Value::Null });
        let Some(page) =
            find_in_scope(&*read, slug, &Some(options.source_id.clone()), &None, true)?
        else {
            return Ok(empty);
        };
        if !sealed(&page) {
            return Ok(empty);
        }
        let mut chunks = read_chunks(&*read, page.id)?;
        chunks.sort_by_key(|c| c.chunk_index);
        let total = chunks.len();
        let max = chunks.iter().map(|c| c.chunk_index).max();
        let to = options.from_index + options.limit;
        let page_chunks: Vec<Value> = chunks
            .iter()
            .filter(|c| {
                let index = f64::from(c.chunk_index);
                index >= options.from_index && index < to
            })
            .map(ChunkRecord::to_chunk)
            .collect();
        Ok(json!({ "chunks": page_chunks, "total_chunks": total, "max_chunk_index": max }))
    }

    /// `getChunkWindows(requests, opts)`: the flat page and chunk rows of the SQL engines' UNION
    /// (`kind` `page` or `chunk`), which the TypeScript member groups with `mapChunkWindowRows`.
    /// A requested page is authorized when it is in scope, live, sealed, in a source that is not
    /// archived and not quarantined; the others are absent. Chunk rows of the authorized pages
    /// come from the chunk sources asked for, are text chunks inside some requested range, and
    /// are cut at `maxRows + 1` in `(prio, page_id, chunk_index)` order.
    pub fn get_chunk_windows(
        &self,
        requests: &[ChunkWindowRequest],
        options: &ChunkWindowOptions,
    ) -> Result<Vec<Value>> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let scope: Option<Vec<&str>> = match &options.source_ids {
            Some(ids) if !ids.is_empty() => Some(ids.iter().map(String::as_str).collect()),
            _ => options
                .source_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| vec![s]),
        };
        // page id -> lowest priority asked for it.
        let mut prio: BTreeMap<i64, i64> = BTreeMap::new();
        for r in requests {
            prio.entry(r.page_id)
                .and_modify(|p| *p = (*p).min(r.priority))
                .or_insert(r.priority);
        }
        let mut archived = HashMap::new();
        let mut page_rows = Vec::new();
        let mut chunk_rows: Vec<(i64, u64, u32, Value)> = Vec::new();
        for (&page_id, &page_prio) in &prio {
            let Ok(id) = u64::try_from(page_id) else {
                continue;
            };
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            if scope
                .as_ref()
                .is_some_and(|s| !s.contains(&page.source_id.as_str()))
                || page.deleted_at_us.is_some()
                || !sealed(&page)
                || source_archived(&*read, &mut archived, &page.source_id)?
                || page.frontmatter.contains_key(QUARANTINE_KEY)
            {
                continue;
            }
            let chunks = read_chunks(&*read, page.id)?;
            let max = chunks.iter().map(|c| c.chunk_index).max();
            for chunk in &chunks {
                let index = i64::from(chunk.chunk_index);
                if options.chunk_sources.contains(&chunk.chunk_source)
                    && chunk.modality == "text"
                    && requests.iter().any(|r| {
                        r.page_id == page_id && r.from_index <= index && index <= r.to_index
                    })
                {
                    chunk_rows.push((
                        page_prio,
                        page.id,
                        chunk.chunk_index,
                        chunk_window_row(chunk, page_prio),
                    ));
                }
            }
            page_rows.push(json!({
                "kind": "page",
                "page_id": page.id,
                "slug": page.slug,
                "source_id": page.source_id,
                "type": page.page_type,
                "revision": page.knowledge_revision,
                "sealed": true,
                "segmented": false,
                "prio": page_prio,
                "max_chunk_index": max,
                "compiled_truth": page.compiled_truth,
                "timeline": page.timeline,
            }));
        }
        chunk_rows.sort_by_key(|row| (row.0, row.1, row.2));
        let cap = usize::try_from(options.max_rows.saturating_add(1)).unwrap_or(usize::MAX);
        page_rows.extend(chunk_rows.into_iter().take(cap).map(|row| row.3));
        Ok(page_rows)
    }

    /// `countChunklessPagesWithContent({ sourceId? })`.
    pub fn count_chunkless_pages_with_content(&self, options: &ChunklessOptions) -> Result<u64> {
        let read = self.read()?;
        Ok(chunkless_pages(&*read, options.source_id.as_deref())?.len() as u64)
    }

    /// `listChunklessPagesWithContent({ sourceId?, batchSize?, afterPageId? })`: `{ id, slug,
    /// source_id, compiled_truth, timeline }` rows in page-id order after `afterPageId`, at most
    /// `batchSize` (default 50).
    pub fn list_chunkless_pages_with_content(
        &self,
        options: &ChunklessOptions,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let limit = usize::try_from(options.batch_size.unwrap_or(DEFAULT_CHUNKLESS_BATCH))
            .unwrap_or(usize::MAX);
        Ok(chunkless_pages(&*read, options.source_id.as_deref())?
            .into_iter()
            .filter(|p| {
                options
                    .after_page_id
                    .is_none_or(|after| i128::from(p.id) > i128::from(after))
            })
            .take(limit)
            .map(|p| {
                json!({
                    "id": p.id,
                    "slug": p.slug,
                    "source_id": p.source_id,
                    "compiled_truth": p.compiled_truth,
                    "timeline": p.timeline,
                })
            })
            .collect())
    }
}
