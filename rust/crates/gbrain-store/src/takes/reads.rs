//! Takes: the reads behind the doctor weight-grid check, the onboarding takes count, the fact purge
//! plan, the fence import's stored rows, the MCP-resolved count of the scorecard and the take
//! supersession repair. Each is one `BrainEngine` member (`src/core/engine-sql/takes-reads.ts`); the
//! answers match its SQL row for row.
//!
//! Members: countOffGridTakeWeights, countTakes, planFactPurgeTakes, listTakeRowsForPage,
//! countMcpResolvedTakes, listTakeSupersessionCandidates, listTakePointers, listTakeSupersedeReceipts,
//! setTakeSupersededBy.
//!
//! A take is scoped by the page it hangs on, read now (its `source_id` and `slug`), not by the
//! source it was inserted under. No read here hides a soft-deleted page unless its SQL does.
//! `countMcpResolvedTakes` takes the page policy of a caller (`excludePrivate`, see
//! `facts/privacy.rs`) the way the salience reads do.

use super::*;
use crate::facts::{PrivacyPolicy, fact_fingerprint, page_hidden, read_fact};
use crate::timeline_queries::timestamptz_text;

/// The widest `10^-exp` the grid check works on exactly. A weight with more places than this is
/// within 1e-30 of zero, and zero is on the grid.
const MAX_PLACES: i32 = 30;

/// Whether `weight::numeric` is further than 0.001 from `ROUND(weight::numeric * 20) / 20`.
///
/// `weight::numeric` of a `real` prints six significant digits (`Decimal::of_real`), so the check is
/// exact integer arithmetic on that decimal: with `x = m / D` (`D = 10^places`), `20x = 20m / D`
/// rounds half away from zero to `r`, and `|x - r/20| > 1/1000` is `50 * |20m - r*D| > D`.
fn off_grid(weight: f32) -> bool {
    let value = Decimal::of_real(weight);
    if value.exp >= 0 || value.mantissa == 0 {
        return false;
    }
    let places = -value.exp;
    if places > MAX_PLACES {
        return false;
    }
    let Some(d) = pow10(places as u32) else {
        return false;
    };
    let y = 20 * value.mantissa.abs();
    let r = (2 * y + d) / (2 * d);
    50 * (y - r * d).abs() > d
}

/// `planFactPurgeTakes` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeTakesInput {
    pub source_id: String,
    /// The facts the purge removes: the takes they were consolidated into go with them.
    #[serde(default)]
    pub fact_ids: Vec<i64>,
    /// `gbrain_fact_fingerprint` of the purged claim.
    pub fact_hash: String,
    /// A page slug, or `*` for every page of the source.
    pub subject: String,
}

/// `listHeldFenceTakeRows` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldFenceTakeSpec {
    pub source_id: String,
    pub kind: String,
    pub owner_key: String,
    pub page_id: i64,
}

/// `readTakePreimages` arguments. The TypeScript member checks every number first
/// (`checkTakePreimageRead`), so the numbers arrive whole and in range.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakePreimageInput {
    pub page_id: f64,
    /// `id`: `gone` names takes by id; `row_num`: by row number.
    pub by: String,
    #[serde(default)]
    pub gone: Vec<f64>,
    #[serde(default)]
    pub incoming: Vec<IncomingTakeRow>,
}

/// One `jsonb_to_recordset` row of `readTakePreimages`: a missing column reads as SQL NULL.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct IncomingTakeRow {
    pub row_num: Option<f64>,
    pub claim: Option<String>,
    pub kind: Option<String>,
    pub holder: Option<String>,
}

/// A take's before-state as `TAKE_PREIMAGE_SQL` builds it (`jsonb_build_object`).
fn take_preimage(t: &TakeRecord) -> Value {
    json!({
        "id": t.id,
        "page_id": t.page_id,
        "row_num": t.row_num,
        "claim": t.claim,
        "kind": t.kind,
        "holder": t.holder,
        "weight": real_out(t.weight),
        "since_date": t.since_date,
        "until_date": t.until_date,
        "source": t.source,
        "superseded_by": t.superseded_by,
        "active": t.active,
        "resolved_at": t.resolved_at_us.map(jsonb_time),
        "resolved_outcome": t.resolved_outcome,
        "resolved_value": t.resolved_value.map(real_out),
        "resolved_unit": t.resolved_unit,
        "resolved_source": t.resolved_source,
        "resolved_by": t.resolved_by,
        "resolved_quality": t.resolved_quality,
    })
}

/// `timestamptz` as `jsonb_build_object` writes it under a UTC session: `2026-06-18T09:00:00.5+00:00`.
fn jsonb_time(micros: i64) -> String {
    format!("{}:00", timestamptz_text(micros).replacen(' ', "T", 1))
}

/// `countMcpResolvedTakes` arguments: the scope the caller's read policy resolved to.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpResolvedInput {
    /// `p.source_id = ANY(...)`; `None` is no scope.
    pub source_ids: Option<Vec<Option<String>>>,
    /// `t.holder = ANY(...)`; `None` is no filter.
    pub holders: Option<Vec<Option<String>>>,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`); null reads every page.
    pub exclude_private: Option<PrivacyPolicy>,
}

impl Store {
    /// `countOffGridTakeWeights()`: `{ off_grid, total }` over every take, whatever its page.
    pub fn count_off_grid_take_weights(&self) -> Result<Value> {
        let read = self.read()?;
        let takes = all_takes(&*read)?;
        let off = takes.iter().filter(|t| off_grid(t.weight)).count();
        Ok(json!({ "off_grid": off, "total": takes.len() }))
    }

    /// `countTakes()`: how many takes the brain holds.
    pub fn count_takes(&self) -> Result<u64> {
        Ok(all_takes(&*self.read()?)?.len() as u64)
    }

    /// `planFactPurgeTakes(...)`: `[{ id, page_id }]` by id, the takes of the source that the
    /// purged facts were consolidated into, or whose claim has the purged fingerprint on the
    /// subject's page.
    pub fn plan_fact_purge_takes(&self, input: &PurgeTakesInput) -> Result<Vec<Value>> {
        const OP: &str = "planFactPurgeTakes";
        no_nul(
            OP,
            &[
                ("sourceId", input.source_id.as_str()),
                ("subject", input.subject.as_str()),
            ],
        )?;
        let read = self.read()?;
        let mut consolidated = BTreeSet::new();
        for id in input.fact_ids.iter().filter(|id| **id >= 1) {
            if let Some(into) = read_fact(&*read, *id as u64)?.and_then(|f| f.consolidated_into) {
                consolidated.insert(into);
            }
        }
        let mut pages = PageCache::new(&*read);
        let mut out = Vec::new();
        for take in all_takes(&*read)? {
            let Some(page) = pages.get(take.page_id)? else {
                continue;
            };
            if page.source_id != input.source_id {
                continue;
            }
            let named = i64::try_from(take.id).is_ok_and(|id| consolidated.contains(&id));
            let echoed = fact_fingerprint(&take.claim) == input.fact_hash
                && (input.subject == "*" || page.slug == input.subject);
            if named || echoed {
                out.push((take.id, take.page_id));
            }
        }
        out.sort_unstable();
        Ok(out
            .into_iter()
            .map(|(id, page_id)| json!({ "id": id, "page_id": page_id }))
            .collect())
    }

    /// `listTakeRowsForPage(pageId)`: `[{ row_num, claim }]` of the page's takes, by row number.
    pub fn list_take_rows_for_page(&self, page_id: i64) -> Result<Vec<Value>> {
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(Vec::new());
        };
        Ok(page_takes(&*self.read()?, page_id)?
            .into_iter()
            .map(|t| json!({ "row_num": t.row_num, "claim": t.claim }))
            .collect())
    }

    /// `listHeldFenceTakeRows(spec)`: the page's takes by row number, resolution cells included,
    /// while the `(sourceId, kind, ownerKey)` generation is held `fence_absent`; none otherwise.
    pub fn list_held_fence_take_rows(&self, spec: &HeldFenceTakeSpec) -> Result<Vec<Value>> {
        let read = self.read()?;
        let key = crate::generations::GenerationKey {
            source_id: spec.source_id.clone(),
            kind: spec.kind.clone(),
            owner_key: spec.owner_key.clone(),
        };
        if !crate::generations::held_for(&*read, &key, "fence_absent")? {
            return Ok(Vec::new());
        }
        let Ok(page_id) = u64::try_from(spec.page_id) else {
            return Ok(Vec::new());
        };
        let mut takes = page_takes(&*read, page_id)?;
        takes.sort_by_key(|t| t.row_num);
        Ok(takes
            .iter()
            .map(|t| {
                json!({
                    "row_num": t.row_num,
                    "claim": t.claim,
                    "kind": t.kind,
                    "holder": t.holder,
                    "weight": real_out(t.weight),
                    "since_date": t.since_date,
                    "until_date": t.until_date,
                    "source": t.source,
                    "active": t.active,
                    "resolved_at": t.resolved_at_us.map(iso),
                    "resolved_quality": t.resolved_quality,
                    "resolved_outcome": t.resolved_outcome,
                    "resolved_source": t.resolved_source,
                    "resolved_value": t.resolved_value.map(real_out),
                    "resolved_unit": t.resolved_unit,
                    "resolved_by": t.resolved_by,
                })
            })
            .collect())
    }

    /// `readTakePreimages(read)`: `[{ preimage, gone }]` by row number. A take is listed when
    /// `gone` names it, or when an incoming row of its number has another claim, kind or holder
    /// (`IS DISTINCT FROM`, so an incoming NULL differs). The `LEFT JOIN` gives a take once per
    /// incoming row of its number (once when there is none), and each joined row is kept or dropped
    /// on its own.
    pub fn read_take_preimages(&self, input: &TakePreimageInput) -> Result<Vec<Value>> {
        let Some(page_id) = (input.page_id >= 0.0).then_some(input.page_id as u64) else {
            return Ok(Vec::new());
        };
        let by_id = match input.by.as_str() {
            "id" => true,
            "row_num" => false,
            other => {
                return Err(StoreError::invalid(format!(
                    "readTakePreimages: by must be id or row_num, not {other:?}"
                )));
            }
        };
        let gone: HashSet<i64> = input.gone.iter().map(|n| *n as i64).collect();
        let mut out = Vec::new();
        for take in page_takes(&*self.read()?, page_id)? {
            let named = if by_id {
                i64::try_from(take.id).is_ok_and(|id| gone.contains(&id))
            } else {
                gone.contains(&i64::from(take.row_num))
            };
            let joined: Vec<&IncomingTakeRow> = input
                .incoming
                .iter()
                .filter(|n| {
                    n.row_num
                        .is_some_and(|r| r as i64 == i64::from(take.row_num))
                })
                .collect();
            let kept = |n: Option<&IncomingTakeRow>| {
                named
                    || n.is_some_and(|n| {
                        n.claim.as_deref() != Some(take.claim.as_str())
                            || n.kind.as_deref() != Some(take.kind.as_str())
                            || n.holder.as_deref() != Some(take.holder.as_str())
                    })
            };
            let rows: Vec<Option<&IncomingTakeRow>> = if joined.is_empty() {
                vec![None]
            } else {
                joined.into_iter().map(Some).collect()
            };
            for n in rows {
                if kept(n) {
                    out.push(json!({ "preimage": take_preimage(&take), "gone": named }));
                }
            }
        }
        Ok(out)
    }

    /// `countMcpResolvedTakes(scope)`: the resolved takes whose `resolved_by` starts with `mcp:`,
    /// on a page in the source scope, held by a listed holder. With `exclude_private`, a take on a
    /// page the page policy hides is not counted (a soft-deleted page is still judged, as its row
    /// stays in `pages`).
    pub fn count_mcp_resolved_takes(&self, input: &McpResolvedInput) -> Result<u64> {
        let read = self.read()?;
        let mut pages = PageCache::new(&*read);
        let mut n = 0;
        for take in all_takes(&*read)? {
            if take.resolved_at_us.is_none()
                || !take
                    .resolved_by
                    .as_deref()
                    .is_some_and(|b| b.starts_with("mcp:"))
                || !allowed(&input.holders, &take.holder)
            {
                continue;
            }
            let Some(page) = pages.get(take.page_id)? else {
                continue;
            };
            if !in_scope(&input.source_ids, &page.source_id) {
                continue;
            }
            if let Some(policy) = &input.exclude_private
                && page_hidden(&*read, page, policy)?
            {
                continue;
            }
            n += 1;
        }
        Ok(n)
    }

    /// `listTakeSupersessionCandidates(sourceIds)`: `[{ id, source_id, slug }]` by page id, the live
    /// pages of those sources with a take that is inactive or whose source cell says
    /// `superseded by #` (any case).
    pub fn list_take_supersession_candidates(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut page_ids = BTreeSet::new();
        for take in all_takes(&*read)? {
            let named = match &take.source {
                Some(text) => crate::facts::like(text, "%superseded by #%", true)?,
                None => false,
            };
            if !take.active || named {
                page_ids.insert(take.page_id);
            }
        }
        let mut out = Vec::new();
        let mut pages = PageCache::new(&*read);
        for id in page_ids {
            if let Some(page) = pages.get(id)?
                && page.deleted_at_us.is_none()
                && source_ids.contains(&page.source_id)
            {
                out.push(json!({ "id": page.id, "source_id": page.source_id, "slug": page.slug }));
            }
        }
        Ok(out)
    }

    /// `listTakePointers(pageId)`: `[{ row_num, superseded_by }]`, every take on the page, in key
    /// order (the SQL has no `ORDER BY`; the repair reads it into a map).
    pub fn list_take_pointers(&self, page_id: u64) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(all_takes(&*read)?
            .into_iter()
            .filter(|t| t.page_id == page_id)
            .map(|t| json!({ "row_num": t.row_num, "superseded_by": t.superseded_by }))
            .collect())
    }

    /// `listTakeSupersedeReceipts(sourceId, pageId, slug)`: `[{ old_row, new_row }]`, the
    /// `outcome->>'old_row'` / `outcome->>'new_row'` text of the committed `takes_supersede`
    /// requests of the source whose page is `pageId`, or that recorded no page and name `slug`.
    pub fn list_take_supersede_receipts(
        &self,
        source_id: &str,
        page_id: u64,
        slug: &str,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let field = |outcome: &Option<Value>, key: &str| {
            outcome
                .as_ref()
                .and_then(|o| o.get(key))
                .and_then(crate::cli_reads::entities::arrow_text)
        };
        Ok(crate::persistence::all_requests(&*read)?
            .into_iter()
            .filter(|r| {
                r.operation == "takes_supersede"
                    && r.state == "committed"
                    && r.source_id == source_id
                    && match r.page_id {
                        Some(id) => id == page_id,
                        None => r.slug == slug,
                    }
            })
            .map(|r| {
                json!({
                    "old_row": field(&r.outcome, "old_row"),
                    "new_row": field(&r.outcome, "new_row"),
                })
            })
            .collect())
    }

    /// `readTakeRowTier(pageId, rowNum)`: `{ id, trust_tier }` of the take in that row of the page, or null.
    pub fn read_take_row_tier(&self, page_id: u64, row_num: i32) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(take_at(&*read, page_id, row_num)?
            .map(|t| json!({ "id": t.id, "trust_tier": t.trust.tier().as_str() })))
    }

    /// `hasTakeClaim(pageId, claim)`: whether page `pageId` holds a take with that claim.
    pub fn has_take_claim(&self, page_id: u64, claim: &str) -> Result<bool> {
        let read = self.read()?;
        Ok(page_takes(&*read, page_id)?
            .iter()
            .any(|t| t.claim == claim))
    }

    /// `listTakeRowNums(pageId)`: the row number of every take of the page, ascending.
    pub fn list_take_row_nums(&self, page_id: u64) -> Result<Vec<i32>> {
        let read = self.read()?;
        let mut out: Vec<i32> = page_takes(&*read, page_id)?
            .iter()
            .map(|t| t.row_num)
            .collect();
        out.sort_unstable();
        Ok(out)
    }

    /// `readTakeRowTierByClaim(pageId, rowNum, claim)`: `{ id, trust_tier }` of the take at that row of the page with
    /// that claim, or null.
    pub fn read_take_row_tier_by_claim(
        &self,
        page_id: u64,
        row_num: i32,
        claim: &str,
    ) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(take_at(&*read, page_id, row_num)?
            .filter(|t| t.claim == claim)
            .map(|t| json!({ "id": t.id, "trust_tier": t.trust.tier().as_str() })))
    }

    /// `setTakeSupersededBy(pageId, rowNum, supersededBy)`: stores the take's `superseded_by`
    /// (null clears it). The `UPDATE` sets no other column, so `updated_at` and the trust stamp stay.
    pub fn set_take_superseded_by(
        &self,
        page_id: u64,
        row_num: i32,
        superseded_by: Option<i32>,
    ) -> Result<()> {
        self.write(|tx| {
            if let Some(mut take) = take_at(&*tx, page_id, row_num)? {
                take.superseded_by = superseded_by;
                store_take(tx, &take)?;
            }
            Ok(())
        })
    }
}
