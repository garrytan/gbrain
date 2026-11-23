//! The scoped contradiction reader's two live re-reads (`listLiveChunksByIds`,
//! `listLiveTakesByIds`; SQL in `src/core/engine-sql/contradictions-cycle.ts`, docs in
//! `rust/docs/store/live-rereads.md`).
//!
//! Both re-read rows by id under the caller's read policy: `pageReadFilter(p, policy, live)` over
//! the row's page (the source clause, the page privacy policy, the page trust floor and the live
//! test), as [`Policy::passes`] models it.
//!
//! - A chunk also passes `chunkVisibleFilter`: its page is served and the chunk is at or below the
//!   page's body generation ([`visible_chunks`]). The page trust floor is the call's `floor` when
//!   one is given, else the policy's own `minTrust`, as the SQL merges them.
//! - A take is active, its holder is in the holder allow-list when one is given, it passes its own
//!   owner-only test under `excludePrivate` (`ownerOnlyTakeAllowedSql`, in the caller's form) and
//!   its row eligibility (`projectionEligibleSql('takes', t, floor)`): the floor and flag
//!   suppression on the take row. The store keeps no `needs_rederive` rows, so that clause hides
//!   nothing. The page trust floor is the policy's own `minTrust`.
//!
//! The chunk ids name no index here, so each read scans every page and its chunks or takes, as
//! `cosinesByChunkIds` does. Rows come back in id order; the SQL names no order.

use super::site_reads::{ChunkReadScope, Policy, served};
use crate::Store;
use crate::chunks::visible_chunks;
use crate::error::Result;
use crate::owner_only::{OwnerOnlyForm, OwnerOnlySources};
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::takes::all_takes;
use crate::trust::TrustPolicy;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

/// `listLiveChunksByIds(ids, policy, floor)`: `scope` is the policy's page read scope with the
/// call's floor already in `min_trust`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct LiveChunksInput {
    pub ids: Vec<i64>,
    pub scope: ChunkReadScope,
}

/// One row of `listLiveChunksByIds`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveChunkRow {
    pub id: u64,
    pub page_id: u64,
    pub slug: String,
    pub source_id: String,
    pub chunk_text: String,
}

/// `listLiveTakesByIds(ids, policy, floor)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LiveTakesInput {
    pub ids: Vec<i64>,
    /// The page read scope; its `min_trust` is the policy's own page floor.
    pub scope: ChunkReadScope,
    /// `takesHoldersAllowList`: when set, only these holders.
    pub holders: Option<Vec<String>>,
    /// The take's own owner-only form (`off` for the owner or without `excludePrivate`).
    pub owner_only: Option<OwnerOnlyForm>,
    /// The take row's floor (`projectionEligibleSql`'s `floor`).
    pub floor: Option<String>,
}

/// One row of `listLiveTakesByIds`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveTakeRow {
    pub id: u64,
    pub page_id: u64,
    pub slug: String,
    pub source_id: String,
    pub row_num: i32,
    pub claim: String,
    pub holder: String,
}

fn wanted(ids: &[i64]) -> BTreeSet<u64> {
    ids.iter()
        .filter_map(|id| u64::try_from(*id).ok())
        .collect()
}

impl Store {
    /// `listLiveChunksByIds`: the visible chunks with these ids whose page passes the scope.
    pub fn list_live_chunks_by_ids(&self, input: &LiveChunksInput) -> Result<Vec<LiveChunkRow>> {
        let ids = wanted(&input.ids);
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut policy = Policy::new(&*read);
        let mut rows = Vec::new();
        for page in all_pages(&*read)? {
            if !served(&page) || !policy.passes(&page, &input.scope)? {
                continue;
            }
            for chunk in visible_chunks(&*read, page.id)? {
                if ids.contains(&chunk.id) {
                    rows.push(LiveChunkRow {
                        id: chunk.id,
                        page_id: page.id,
                        slug: page.slug.clone(),
                        source_id: page.source_id.clone(),
                        chunk_text: chunk.chunk_text,
                    });
                }
            }
        }
        rows.sort_by_key(|r| r.id);
        Ok(rows)
    }

    /// `listLiveTakesByIds`: the active takes with these ids that pass the holder list, their own
    /// owner-only test and row eligibility, on a page that passes the scope.
    pub fn list_live_takes_by_ids(&self, input: &LiveTakesInput) -> Result<Vec<LiveTakeRow>> {
        let ids = wanted(&input.ids);
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let row_trust = TrustPolicy::parse(input.floor.as_deref(), false)?;
        let read = self.read()?;
        let owner_hidden = match input.owner_only.unwrap_or(OwnerOnlyForm::Off) {
            OwnerOnlyForm::Off | OwnerOnlyForm::Fn => false,
            OwnerOnlyForm::Closed => OwnerOnlySources::read(&*read)?.guarded(),
        };
        let mut policy = Policy::new(&*read);
        let mut pages: HashMap<u64, Option<PageRecord>> = HashMap::new();
        let mut rows = Vec::new();
        for take in all_takes(&*read)? {
            if !ids.contains(&take.id) || !take.active || owner_hidden {
                continue;
            }
            if input
                .holders
                .as_ref()
                .is_some_and(|h| !h.iter().any(|x| *x == take.holder))
            {
                continue;
            }
            let page = match pages.get(&take.page_id) {
                Some(page) => page.clone(),
                None => {
                    let page = read_page_by_id(&*read, take.page_id)?;
                    pages.insert(take.page_id, page.clone());
                    page
                }
            };
            let Some(page) = page else {
                continue;
            };
            if !policy.passes(&page, &input.scope)?
                || !row_trust.admits(&*read, "takes", take.id, take.trust.tier())?
            {
                continue;
            }
            rows.push(LiveTakeRow {
                id: take.id,
                page_id: page.id,
                slug: page.slug,
                source_id: page.source_id,
                row_num: take.row_num,
                claim: take.claim,
                holder: take.holder,
            });
        }
        rows.sort_by_key(|r| r.id);
        Ok(rows)
    }
}
