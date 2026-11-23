//! The remote-caller reads around rank_entities and search_exact that the ops layer ran through
//! `executeRaw` (`src/core/engine-sql/cli-reads-ops.ts`): one source's rank coverage, and the
//! stored chunks search_exact reads again to take out fence rows held from the caller.
//!
//! Each read applies the caller's page policy when the TypeScript member sends one
//! (`storePagePolicy` with caller readers), as the SQL adds `privatePagesFilterForCaller('p')`.
//! What the store does not keep, and what each read answers for it (rust/docs/store/cli-reads-ops.md):
//! - no `page_mention_state` rows: with mention types, every readable page owes a mention pass;
//! - no `links_extract_failure` rows: no page is held from link extraction.
//!
//! Keys: none of its own. It reads the page, page-id, chunk, extraction, wanted-link and source
//! records.

use super::reads::{Sources, has_key, served};
use crate::Store;
use crate::chunks::SAFE_FENCE_CHUNKER_VERSION;
use crate::chunks::{ChunkRecord, read_chunks, read_segment_view};
use crate::error::Result;
use crate::extraction::{guest_sources, owes_link_extraction, version_us};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::wanted_links::stale_origin_page_ids;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap};

/// `RankCoverageStatementOpts`; `exclude_private` is the caller's page policy, or None.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RankCoverageInput {
    pub source_id: String,
    pub version_ts: Option<String>,
    pub mention_types: Option<Vec<String>>,
    pub exclude_private: Option<PrivacyPolicy>,
}

/// `RankCoverageRow`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RankCoverageRow {
    pub link_behind: bool,
    pub mention_due: bool,
}

/// One `ExactSnippetKey`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExactSnippetKey {
    pub page_id: i64,
    pub chunk_index: i64,
    pub snippet: String,
}

/// `readExactSnippetChunks(keys, { excludePrivate })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExactSnippetChunksInput {
    pub keys: Vec<ExactSnippetKey>,
    pub exclude_private: Option<PrivacyPolicy>,
}

/// `ExactSnippetChunkRow`: `i` is the 1-based position of the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExactSnippetChunkRow {
    pub i: u64,
    pub chunk_text: String,
}

/// `listExactRescanChunks(pageIds, { excludePrivate })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExactRescanInput {
    pub page_ids: Vec<i64>,
    pub exclude_private: Option<PrivacyPolicy>,
}

/// `ExactRescanChunkRow`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExactRescanChunkRow {
    pub page_id: u64,
    pub chunk_index: u32,
    pub chunk_source: String,
    pub chunk_text: String,
}

/// Whether the caller's page policy (when sent) leaves the page readable.
fn readable_under(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: Option<&PrivacyPolicy>,
) -> Result<bool> {
    match policy {
        Some(policy) => Ok(!page_hidden(read, page, policy)?),
        None => Ok(true),
    }
}

/// `chunkVisibleFilter(p, cc)`: the page serves its text projection and the chunk is not ahead of
/// the page's body generation. Chunks in chunk-index order.
fn visible_chunks(read: &dyn KvRead, page: &PageRecord) -> Result<Vec<ChunkRecord>> {
    if !served(page) {
        return Ok(Vec::new());
    }
    let generation = read_segment_view(read, page.id)?.generation;
    let mut chunks: Vec<ChunkRecord> = read_chunks(read, page.id)?
        .into_iter()
        .filter(|c| c.visible_at(generation))
        .collect();
    chunks.sort_by_key(|c| c.chunk_index);
    Ok(chunks)
}

impl Store {
    /// `readRankCoverage`: over the pages of `source_id` the caller may read (live, not
    /// quarantined, in an unarchived source, not hidden by its page policy), whether any still owes
    /// link extraction (`staleForExtractionSql`, guest sources never stale) and, with
    /// `mention_types`, whether any owes a mention pass (here: any readable page at all).
    pub fn read_rank_coverage(&self, input: &RankCoverageInput) -> Result<RankCoverageRow> {
        let version = version_us(input.version_ts.as_deref())?;
        let read = self.read()?;
        let read = &*read;
        let mut sources = Sources::new(read);
        if !sources.live(&input.source_id)? {
            return Ok(RankCoverageRow::default());
        }
        let mut readable = Vec::new();
        for page in all_pages(read)? {
            if page.source_id == input.source_id
                && page.deleted_at_us.is_none()
                && !has_key(&page, "quarantine")
                && readable_under(read, &page, input.exclude_private.as_ref())?
            {
                readable.push(page);
            }
        }
        let mention_due = input.mention_types.is_some() && !readable.is_empty();
        let guests = guest_sources(read, &readable)?;
        let wanted = stale_origin_page_ids(read, None)?;
        let mut link_behind = false;
        for page in readable.iter().filter(|p| !guests.contains(&p.source_id)) {
            if owes_link_extraction(read, page, version, &wanted)? {
                link_behind = true;
                break;
            }
        }
        Ok(RankCoverageRow {
            link_behind,
            mention_due,
        })
    }

    /// `readExactSnippetChunks`: per key, in key order, the text of its chunk when the chunk is
    /// visible and holds the snippet (`strpos > 0`) and the caller may read the page.
    pub fn read_exact_snippet_chunks(
        &self,
        input: &ExactSnippetChunksInput,
    ) -> Result<Vec<ExactSnippetChunkRow>> {
        let read = self.read()?;
        let read = &*read;
        let mut pages: HashMap<u64, Option<Vec<ChunkRecord>>> = HashMap::new();
        let mut rows = Vec::new();
        for (n, key) in input.keys.iter().enumerate() {
            let (Ok(page_id), Ok(chunk_index)) =
                (u64::try_from(key.page_id), u32::try_from(key.chunk_index))
            else {
                continue;
            };
            if let Entry::Vacant(slot) = pages.entry(page_id) {
                let entry = match read_page_by_id(read, page_id)? {
                    Some(page) if readable_under(read, &page, input.exclude_private.as_ref())? => {
                        Some(visible_chunks(read, &page)?)
                    }
                    _ => None,
                };
                slot.insert(entry);
            }
            let Some(chunks) = &pages[&page_id] else {
                continue;
            };
            if let Some(chunk) = chunks
                .iter()
                .find(|c| c.chunk_index == chunk_index && c.chunk_text.contains(&key.snippet))
            {
                rows.push(ExactSnippetChunkRow {
                    i: n as u64 + 1,
                    chunk_text: chunk.chunk_text.clone(),
                });
            }
        }
        Ok(rows)
    }

    /// `listExactRescanChunks`: the visible chunks past the safe-chunk fence of the pages, by page
    /// id then chunk index, for the pages the caller may read.
    pub fn list_exact_rescan_chunks(
        &self,
        input: &ExactRescanInput,
    ) -> Result<Vec<ExactRescanChunkRow>> {
        let read = self.read()?;
        let read = &*read;
        let ids: BTreeSet<u64> = input
            .page_ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut rows = Vec::new();
        for id in ids {
            let Some(page) = read_page_by_id(read, id)? else {
                continue;
            };
            // `safeChunksFilter(p)`; a record with no version is below the fence.
            if page.chunker_version.unwrap_or(0) < SAFE_FENCE_CHUNKER_VERSION
                || !readable_under(read, &page, input.exclude_private.as_ref())?
            {
                continue;
            }
            rows.extend(
                visible_chunks(read, &page)?
                    .into_iter()
                    .map(|c| ExactRescanChunkRow {
                        page_id: id,
                        chunk_index: c.chunk_index,
                        chunk_source: c.chunk_source,
                        chunk_text: c.chunk_text,
                    }),
            );
        }
        Ok(rows)
    }
}
