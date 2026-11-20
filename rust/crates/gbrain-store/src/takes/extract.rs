//! Takes: the reads and the delete of `gbrain extract takes` (`src/core/cycle/extract-takes.ts`,
//! `src/core/generations/adapters/take-rows.ts`). Each is one `BrainEngine` member
//! (`src/core/engine-sql/takes-reads.ts`); the answers match its SQL row for row.
//!
//! Members: readLivePageIdBySlug, readPageTierRef, readPageTierRows, pageHasFrontmatterKey,
//! listTakeIdsLeavingFence, listTakePreimages, deleteTakesByIds, findTakeId.
//!
//! Only `readLivePageIdBySlug` hides a soft-deleted page, as only its SQL does. A page's tier is
//! its stored tier read back (`TrustTier::stored`: none, or text that names no tier, is `unknown`).

use super::*;
use crate::facts::jsonb_time;
use crate::pages::read_page;
use crate::trust::TrustTier;

/// One row of `listTakeIdsLeavingFence`'s `replaced` form: a row number and the claim stated there.
#[derive(Debug, Clone, Deserialize)]
pub struct FenceRowClaim {
    pub row_num: i32,
    pub claim: String,
}

/// `listTakeIdsLeavingFence(pageId, fence)`: the fence, by `change`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "change", rename_all = "camelCase")]
pub enum TakesLeavingFence {
    /// The takes at no row number of `row_nums`.
    #[serde(rename = "removed", rename_all = "camelCase")]
    Removed { row_nums: Vec<i32> },
    /// The takes that no `rows` entry states at the same row number with the same claim.
    #[serde(rename = "replaced")]
    Replaced { rows: Vec<FenceRowClaim> },
}

/// One incoming row of `listTakePreimages`: what a fence row would write at its row number.
#[derive(Debug, Clone, Deserialize)]
pub struct IncomingTake {
    pub row_num: i32,
    pub claim: String,
    pub kind: String,
    pub holder: String,
}

fn tier_of(page: &PageRecord) -> &'static str {
    TrustTier::stored(page.trust_tier.as_deref()).as_str()
}

/// `TAKE_PREIMAGE_SQL`: a take's before-state, as `jsonb_build_object` writes it.
fn preimage(take: &TakeRecord) -> Value {
    json!({
        "id": take.id,
        "page_id": take.page_id,
        "row_num": take.row_num,
        "claim": take.claim,
        "kind": take.kind,
        "holder": take.holder,
        "weight": real_out(take.weight),
        "since_date": take.since_date,
        "until_date": take.until_date,
        "source": take.source,
        "superseded_by": take.superseded_by,
        "active": take.active,
        "resolved_at": take.resolved_at_us.map(jsonb_time),
        "resolved_outcome": take.resolved_outcome,
        "resolved_value": take.resolved_value.map(real_out),
        "resolved_unit": take.resolved_unit,
        "resolved_source": take.resolved_source,
        "resolved_by": take.resolved_by,
        "resolved_quality": take.resolved_quality,
    })
}

impl Store {
    /// `readLivePageIdBySlug(slug, sourceId)`: the id of the live page, or `None`.
    pub fn read_live_page_id_by_slug(&self, slug: &str, source_id: &str) -> Result<Option<u64>> {
        Ok(read_page(&*self.read()?, source_id, slug)?
            .filter(|p| p.deleted_at_us.is_none())
            .map(|p| p.id))
    }

    /// `readPageTierRef(pageId)`: `{ source_id, slug, trust_tier }` of the page, deleted or not.
    pub fn read_page_tier_ref(&self, page_id: i64) -> Result<Option<Value>> {
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(None);
        };
        Ok(read_page_by_id(&*self.read()?, page_id)?.map(
            |p| json!({ "source_id": p.source_id, "slug": p.slug, "trust_tier": tier_of(&p) }),
        ))
    }

    /// `readPageTierRows(ids)`: `[{ id, source_id, slug, trust_tier }]` by id, of the pages among
    /// `ids`, deleted or not. A listed id twice reads once, as `id = ANY(...)` does.
    pub fn read_page_tier_rows(&self, ids: &[i64]) -> Result<Vec<Value>> {
        let wanted: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let read = self.read()?;
        let mut out = Vec::new();
        for id in wanted {
            if let Some(p) = read_page_by_id(&*read, id)? {
                out.push(json!({ "id": p.id, "source_id": p.source_id, "slug": p.slug, "trust_tier": tier_of(&p) }));
            }
        }
        Ok(out)
    }

    /// `pageHasFrontmatterKey(pageId, key)`: whether the page's frontmatter has the top-level key,
    /// deleted or not (`frontmatter ? key`).
    pub fn page_has_frontmatter_key(&self, page_id: i64, key: &str) -> Result<bool> {
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(false);
        };
        Ok(read_page_by_id(&*self.read()?, page_id)?
            .is_some_and(|p| p.frontmatter.contains_key(key)))
    }

    /// `listTakeIdsLeavingFence(pageId, fence)`: the ids of the page's takes that leave the fence,
    /// by row number.
    pub fn list_take_ids_leaving_fence(
        &self,
        page_id: i64,
        fence: &TakesLeavingFence,
    ) -> Result<Vec<u64>> {
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(Vec::new());
        };
        let takes = page_takes(&*self.read()?, page_id)?;
        Ok(takes
            .into_iter()
            .filter(|t| match fence {
                TakesLeavingFence::Removed { row_nums } => !row_nums.contains(&t.row_num),
                TakesLeavingFence::Replaced { rows } => !rows
                    .iter()
                    .any(|r| r.row_num == t.row_num && r.claim == t.claim),
            })
            .map(|t| t.id)
            .collect())
    }

    /// `listTakePreimages(pageId, ids, incoming)`: `[{ preimage, gone }]` by row number. A take
    /// among `ids` is `gone`; a take an incoming row of its number states with another claim, kind
    /// or holder is listed once per such row, as the SQL's `LEFT JOIN` lists it.
    pub fn list_take_preimages(
        &self,
        page_id: i64,
        ids: &[i64],
        incoming: &[IncomingTake],
    ) -> Result<Vec<Value>> {
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(Vec::new());
        };
        let gone_ids: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for take in page_takes(&*self.read()?, page_id)? {
            let gone = gone_ids.contains(&take.id);
            let same_row: Vec<&IncomingTake> = incoming
                .iter()
                .filter(|n| n.row_num == take.row_num)
                .collect();
            let listed = if same_row.is_empty() {
                usize::from(gone)
            } else {
                same_row
                    .iter()
                    .filter(|n| {
                        gone || (&take.claim, &take.kind, &take.holder)
                            != (&n.claim, &n.kind, &n.holder)
                    })
                    .count()
            };
            for _ in 0..listed {
                out.push(json!({ "preimage": preimage(&take), "gone": gone }));
            }
        }
        Ok(out)
    }

    /// `deleteTakesByIds(ids)`: deletes the takes, whatever their page, with the evidence rows that
    /// cite them and their embeddings. An id with no take deletes nothing; an empty list is no write.
    pub fn delete_takes_by_ids(&self, ids: &[i64]) -> Result<()> {
        let wanted: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        if wanted.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            for id in wanted.iter().copied() {
                if let Some(take) = read_take(&*tx, id)? {
                    delete_take(tx, &take)?;
                }
            }
            Ok(())
        })
    }

    /// `findTakeId(pageId, rowNum)`: the id of the page's take at the row number, or `None`.
    pub fn find_take_id(&self, page_id: i64, row_num: i64) -> Result<Option<u64>> {
        let (Ok(page_id), Ok(row_num)) = (u64::try_from(page_id), i32::try_from(row_num)) else {
            return Ok(None);
        };
        Ok(take_at(&*self.read()?, page_id, row_num)?.map(|t| t.id))
    }
}
