//! The last family-tail reads: the scoped contradiction reader's two live re-reads
//! (`listLiveChunksByIds`, `listLiveTakesByIds`, `src/core/engine-sql/contradictions-cycle.ts`)
//! and the page read of the version history (`readPagesForVersionHistory`,
//! `src/core/engine-sql/admin-reads.ts`).
//!
//! The re-reads apply `pageReadFilter(.., live = true)` through the chunk family's page policy
//! (`chunk_queries::PageReadPolicy`): the source filter, the page privacy policy under
//! `excludePrivate`, the page trust floor and flag suppression, and the live test (not deleted,
//! not quarantined, in a source that exists and is not archived). The chunk re-read adds
//! `chunkVisibleFilter` (a served page, a chunk not ahead of the page's body generation) and,
//! when the policy requires safe chunks, the chunker-version fence. The take re-read adds `active`,
//! the holder allow-list and `projectionEligibleSql('takes', ..)`: its deleted-page and quarantine
//! clauses are the live test, its `needs_rederive` clause hides a take a purge marked
//! (`generations/needs_rederive.rs`), and its floor compares the take's own stored tier.
//!
//! None of these statements names an order; rows come in id order. Ids match once each, as
//! `= ANY` does. This module keeps no records: every read goes through the owning family's
//! `pub(crate)` readers. See rust/docs/store/tail_reads.md.

use crate::Store;
use crate::chunk_queries::{ChunkReadScope, PageReadPolicy, safe_chunks, served};
use crate::chunks::{read_chunks, read_segment_view};
use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::takes::read_take;
use crate::trust::TrustPolicy;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};

/// `listLiveChunksByIds(ids, policy, floor)` input. The TypeScript member folds `floor` into
/// `scope.minTrust`, as the SQL does (`{ ...policy, minTrust: floor }`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LiveChunksInput {
    pub ids: Vec<i64>,
    pub scope: ChunkReadScope,
    /// `requiresSafeChunks(policy)`: only pages past the chunker-version fence.
    pub require_safe_chunks: bool,
}

/// `listLiveTakesByIds(ids, policy, floor)` input. `scope.minTrust` is the page floor of the
/// policy; `floor` is the take floor of `projectionEligibleSql`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LiveTakesInput {
    pub ids: Vec<i64>,
    pub scope: ChunkReadScope,
    /// `takesHoldersAllowList`: absent is unrestricted; an empty list admits no holder.
    pub holders: Option<Vec<String>>,
    pub floor: Option<String>,
}

/// The ids an `= ANY($1)` bind matches, once each and in order. A negative id names no row.
fn wanted(ids: &[i64]) -> BTreeSet<u64> {
    ids.iter()
        .filter_map(|id| u64::try_from(*id).ok())
        .collect()
}

/// Pages by id, each read once.
struct PageCache<'a> {
    read: &'a dyn KvRead,
    pages: HashMap<u64, Option<PageRecord>>,
}

impl<'a> PageCache<'a> {
    fn get(&mut self, id: u64) -> Result<Option<&PageRecord>> {
        if !self.pages.contains_key(&id) {
            let page = read_page_by_id(self.read, id)?;
            self.pages.insert(id, page);
        }
        Ok(self.pages.get(&id).and_then(|p| p.as_ref()))
    }
}

impl Store {
    /// `listLiveChunksByIds`: `[{ id, page_id, chunk_text, slug, source_id }]`, the chunks with
    /// these ids whose page the policy admits and whose text the page serves.
    pub fn list_live_chunks_by_ids(&self, input: &LiveChunksInput) -> Result<Vec<Value>> {
        // The SQL builds its trust clause before it reads a row: a floor that names no tier is
        // refused even when no id matches.
        TrustPolicy::parse(
            input.scope.min_trust.as_deref(),
            input.scope.suppress_flagged,
        )?;
        let ids = wanted(&input.ids);
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let read = &*read;
        let mut policy = PageReadPolicy::new(read);
        let mut rows = Vec::new();
        for page in all_pages(read)? {
            if !served(&page)
                || (input.require_safe_chunks && !safe_chunks(&page))
                || !policy.passes(&page, &input.scope)?
            {
                continue;
            }
            let generation = read_segment_view(read, page.id)?.generation;
            for chunk in read_chunks(read, page.id)? {
                if ids.contains(&chunk.id) && chunk.visible_at(generation) {
                    rows.push((
                        chunk.id,
                        json!({
                            "id": chunk.id,
                            "page_id": page.id,
                            "chunk_text": chunk.chunk_text,
                            "slug": page.slug,
                            "source_id": page.source_id,
                        }),
                    ));
                }
            }
        }
        rows.sort_by_key(|(id, _)| *id);
        Ok(rows.into_iter().map(|(_, row)| row).collect())
    }

    /// `listLiveTakesByIds`: `[{ id, page_id, row_num, claim, holder, slug, source_id }]`, the
    /// active takes with these ids that the page policy, the holder allow-list and the take floor
    /// admit.
    pub fn list_live_takes_by_ids(&self, input: &LiveTakesInput) -> Result<Vec<Value>> {
        TrustPolicy::parse(
            input.scope.min_trust.as_deref(),
            input.scope.suppress_flagged,
        )?;
        let floor = TrustPolicy::parse(input.floor.as_deref(), false)?;
        let read = self.read()?;
        let read = &*read;
        let mut policy = PageReadPolicy::new(read);
        let mut pages = PageCache {
            read,
            pages: HashMap::new(),
        };
        let mut rows = Vec::new();
        for id in wanted(&input.ids) {
            let Some(take) = read_take(read, id)? else {
                continue;
            };
            if !take.active
                || input
                    .holders
                    .as_ref()
                    .is_some_and(|holders| !holders.contains(&take.holder))
            {
                continue;
            }
            let Some(page) = pages.get(take.page_id)? else {
                continue;
            };
            if !policy.passes(page, &input.scope)?
                || !floor.admits(read, "takes", take.id, take.trust.tier())?
                || crate::generations::needs_rederive::is_marked(read, "takes", take.id)?
            {
                continue;
            }
            rows.push(json!({
                "id": take.id,
                "page_id": take.page_id,
                "row_num": take.row_num,
                "claim": take.claim,
                "holder": take.holder,
                "slug": page.slug,
                "source_id": page.source_id,
            }));
        }
        Ok(rows)
    }

    /// `readPagesForVersionHistory(pageIds)`: `[{ id, slug, source_id, frontmatter }]` for the
    /// pages with these ids. The statement has no live test, so a soft-deleted page is read too.
    pub fn read_pages_for_version_history(&self, page_ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for id in wanted(page_ids) {
            if let Some(page) = read_page_by_id(&*read, id)? {
                rows.push(json!({
                    "id": page.id,
                    "slug": page.slug,
                    "source_id": page.source_id,
                    "frontmatter": Value::Object(page.frontmatter),
                }));
            }
        }
        Ok(rows)
    }
}
