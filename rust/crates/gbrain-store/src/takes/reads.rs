//! Takes: the reads behind the doctor weight-grid check, the onboarding takes count, the fact purge
//! plan, the fence import's stored rows, the MCP-resolved count of the scorecard and the take
//! supersession repair. Each is one `BrainEngine` member (`src/core/engine-sql/takes-reads.ts`); the
//! answers match its SQL row for row.
//!
//! Members: countOffGridTakeWeights, countTakes, planFactPurgeTakes, listTakeRowsForPage,
//! countMcpResolvedTakes, listTakeSupersessionCandidates.
//!
//! A take is scoped by the page it hangs on, read now (its `source_id` and `slug`), not by the
//! source it was inserted under. No read here hides a soft-deleted page unless its SQL does.
//! `countMcpResolvedTakes` takes the page policy of a caller (`excludePrivate`, see
//! `facts/privacy.rs`) the way the salience reads do.

use super::*;
use crate::facts::{PrivacyPolicy, fact_fingerprint, page_hidden, read_fact};

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
}
