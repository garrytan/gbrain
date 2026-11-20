//! Live-page counts for `gbrain schema stats` and the `schema_stats` tool
//! (`src/core/schema-pack/stats.ts`), and the per-source page and chunk counts of the sync status
//! report (`src/core/sync-status-report.ts`). The SQL is in `src/core/engine-sql/cli-reads-ops.ts`.
//!
//! Members: countLivePagesBySourceType, countLivePagesBySlugPrefixes, countSourcePagesAndChunks.
//!
//! Each reads every page that is not soft-deleted, in every source: an archived source counts, as
//! the SQL engines count it (these reads take no `sources` join). A source filter keeps the pages
//! of the named sources. Nothing here writes, and no key of its own is kept.

use crate::Store;
use crate::chunks::read_chunks;
use crate::error::Result;
use crate::keyword::sql_like;
use crate::pages::all_pages;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

/// `{ sourceIds?, prefixes? }`. An empty or absent `sourceIds` counts every source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LivePageCountQuery {
    pub source_ids: Option<Vec<String>>,
    pub prefixes: Vec<String>,
}

impl LivePageCountQuery {
    fn keeps(&self, source_id: &str) -> bool {
        match self.source_ids.as_ref().filter(|ids| !ids.is_empty()) {
            Some(ids) => ids.iter().any(|id| id == source_id),
            None => true,
        }
    }
}

/// `{ sourceIds }`: the sources of a sync status report, in order (duplicates repeat).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceCoverageQuery {
    pub source_ids: Vec<String>,
}

impl Store {
    /// `countSourcePagesAndChunks({ sourceIds })`: one `{ source_id, pages, chunks_total,
    /// chunks_unembedded }` per requested source, in order: its live pages, every chunk of those
    /// pages (the rows of `content_chunks`, as `getStats` counts them) and the chunks with no stored
    /// vector (`embedding IS NULL`). A source with no live pages counts zero.
    pub fn count_source_pages_and_chunks(&self, query: &SourceCoverageQuery) -> Result<Vec<Value>> {
        if query.source_ids.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut counts: HashMap<String, [u64; 3]> = query
            .source_ids
            .iter()
            .map(|id| (id.clone(), [0; 3]))
            .collect();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() {
                continue;
            }
            let Some(count) = counts.get_mut(&page.source_id) else {
                continue;
            };
            let chunks = read_chunks(&*read, page.id)?;
            count[0] += 1;
            count[1] += chunks.len() as u64;
            count[2] += chunks.iter().filter(|c| !c.embed.has_vector()).count() as u64;
        }
        Ok(query
            .source_ids
            .iter()
            .map(|id| {
                let [pages, total, unembedded] = counts[id];
                json!({
                    "source_id": id,
                    "pages": pages,
                    "chunks_total": total,
                    "chunks_unembedded": unembedded,
                })
            })
            .collect())
    }

    /// `countLivePagesBySourceType({ sourceIds? })`: one `{ source_id, type, count }` per source and
    /// type of the live pages. An empty type reads as null (`NULLIF(type, '')`). Rows sort by source
    /// in byte order, then type in byte order with null last (`COLLATE "C"`, `NULLS LAST`).
    pub fn count_live_pages_by_source_type(
        &self,
        query: &LivePageCountQuery,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        // (source, type is null, type): null sorts after every type of its source.
        let mut counts: BTreeMap<(String, bool, String), u64> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || !query.keeps(&page.source_id) {
                continue;
            }
            let untyped = page.page_type.is_empty();
            *counts
                .entry((page.source_id, untyped, page.page_type))
                .or_default() += 1;
        }
        Ok(counts
            .into_iter()
            .map(|((source, untyped, kind), n)| {
                json!({
                    "source_id": source,
                    "type": if untyped { Value::Null } else { Value::String(kind) },
                    "count": n,
                })
            })
            .collect())
    }

    /// `countLivePagesBySlugPrefixes({ prefixes, sourceIds? })`: for each prefix, in order, how many
    /// live pages have a slug `LIKE prefix || '%'`. The prefix keeps SQL `LIKE` meaning: `%` and `_`
    /// in it are wildcards and `\` escapes, as the SQL engines bind it.
    pub fn count_live_pages_by_slug_prefixes(
        &self,
        query: &LivePageCountQuery,
    ) -> Result<Vec<u64>> {
        if query.prefixes.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let patterns: Vec<String> = query.prefixes.iter().map(|p| format!("{p}%")).collect();
        let mut counts = vec![0u64; patterns.len()];
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || !query.keeps(&page.source_id) {
                continue;
            }
            for (n, pattern) in counts.iter_mut().zip(&patterns) {
                if sql_like(&page.slug, pattern) {
                    *n += 1;
                }
            }
        }
        Ok(counts)
    }
}
