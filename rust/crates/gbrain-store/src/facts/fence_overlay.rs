//! The fence overlay's read of one page: `readFenceOverlayRows` (`engine-sql/cli-reads-ops.ts`), which
//! `eligibility/fence-overlay.ts` `loadFenceChunkOverlay` asks before chunking, evidence text and remote page reads show
//! a page body's world facts-fence rows.
//!
//! One answer row per incoming row, in incoming order: the live page's tier, the tier of the page's newest fact at the
//! row number (expired facts count, as the SQL reads `facts` with no `expired_at` filter) and whether that fact is
//! activation-suppressed, whether a held fact hold of the page carries the row's fingerprint, and, with `hideHeld`,
//! whether the row is held from a world-only fact reader (`held_cells::held` with no row admitted, for an uncut claim). `purged` is whether a
//! fact purge tombstone at the row's visibility names its fingerprint under subject `*` or the page
//! (`purge_ledger::purged_claim`).
//! See rust/docs/store/facts.md, "The fence overlay".

use super::{held_cells, page_rows};
use crate::Store;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::links::no_nul;
use crate::trust::TrustTier;
use serde::Deserialize;
use serde_json::{Value, json};

/// One world fence row of the page body (`FenceOverlayIncomingRow`). `visibility` is read only by the fact purge
/// check.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FenceOverlayIncomingRow {
    pub row_num: i64,
    pub claim: String,
    pub visibility: String,
    pub fp: Option<String>,
}

/// One facts-fence row a chunk names (`FenceRowKey`): its source, page slug and row number.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FenceRowKey {
    pub source_id: String,
    pub slug: String,
    pub row_num: i64,
}

/// `readFenceOverlayRows({ sourceId, slug }, incoming, { hideHeld })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FenceOverlayInput {
    pub source_id: String,
    pub slug: String,
    pub incoming: Vec<FenceOverlayIncomingRow>,
    #[serde(default)]
    pub hide_held: bool,
    /// With `hide_held`: the member caller (`callerMember()`), as `listHeldFenceCells` takes it.
    #[serde(default)]
    pub member: Option<held_cells::HeldFenceMember>,
    /// With `hide_held`: the sources of the caller's private-facts grant (`privateFactSources()`).
    #[serde(default)]
    pub grant_sources: Vec<String>,
}

impl Store {
    /// `readFenceOverlayRows`: `[{ row_num, page_tier, row_tier, row_flagged, purged, held, narrower }]`, one row per
    /// incoming row in incoming order. A NUL character or a row number outside `integer` is the error Postgres raises
    /// for the same parameters. No incoming rows answer `[]` without a read.
    pub fn read_fence_overlay_rows(&self, input: &FenceOverlayInput) -> Result<Vec<Value>> {
        const OP: &str = "readFenceOverlayRows";
        no_nul(OP, &[("sourceId", &input.source_id), ("slug", &input.slug)])?;
        let mut checked = Vec::with_capacity(input.incoming.len());
        for row in &input.incoming {
            no_nul(
                OP,
                &[
                    ("claim", &row.claim),
                    ("visibility", &row.visibility),
                    ("fp", row.fp.as_deref().unwrap_or("")),
                ],
            )?;
            let row_num = i32::try_from(row.row_num).map_err(|_| {
                StoreError::new(
                    INVALID_ARGUMENT,
                    format!(
                        "{OP}: row_num {} is out of range for type integer",
                        row.row_num
                    ),
                )
            })?;
            checked.push((row, row_num));
        }
        if checked.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let page_tier = crate::pages::read_page(&*read, &input.source_id, &input.slug)?
            .filter(|p| p.deleted_at_us.is_none())
            .map(|p| TrustTier::stored(p.trust_tier.as_deref()).as_str());
        let rows = page_rows(&*read, &input.source_id, &input.slug)?;
        // `heldRowSql` with the caller's admissions (its own member page and its private-facts grant), as
        // `listHeldFenceCells` reads them: a caller with neither admits no live row.
        let live: Vec<held_cells::LiveRow> = if input.hide_held {
            let caller = held_cells::HeldFenceCellsInput {
                keys: Vec::new(),
                member: input.member.clone(),
                grant_sources: input.grant_sources.clone(),
            };
            held_cells::live_rows(&*read, &caller, &input.source_id, &input.slug)?
        } else {
            Vec::new()
        };
        let held_fps = crate::trust::write_gate::held_fact_fingerprints(
            &*read,
            &input.source_id,
            &input.slug,
        )?;
        let mut out = Vec::with_capacity(checked.len());
        for (row, row_num) in checked {
            let newest = rows
                .iter()
                .filter(|f| f.row_num == Some(row_num))
                .max_by_key(|f| f.id);
            let (row_tier, row_flagged) = match newest {
                Some(f) => (
                    Some(f.trust_tier.clone()),
                    Some(crate::trust::activation_suppressed(
                        &*read,
                        "facts",
                        f.id,
                        f.tier(),
                    )?),
                ),
                None => (None, None),
            };
            let purged = super::purge_ledger::purged_claim(
                &*read,
                &input.source_id,
                &row.visibility,
                &row.claim,
                Some(&input.slug),
            )?;
            let held = row.fp.as_ref().is_some_and(|fp| held_fps.contains(fp));
            let narrower = input.hide_held
                && held_cells::held(
                    &live,
                    &held_cells::HeldFenceCellKey {
                        source_id: input.source_id.clone(),
                        slug: input.slug.clone(),
                        row_num: i64::from(row_num),
                        claim: row.claim.clone(),
                        partial: false,
                    },
                    row_num,
                );
            out.push(json!({
                "row_num": row_num,
                "page_tier": page_tier,
                "row_tier": row_tier,
                "row_flagged": row_flagged,
                "purged": purged,
                "held": held,
                "narrower": narrower,
            }));
        }
        Ok(out)
    }
}

impl Store {
    /// `listFenceRowTrust(keys)` (engine-sql/cli-reads-ops.ts): for each distinct key, the newest live fact at the row
    /// (`DISTINCT ON (source_id, slug, row_num) ... WHERE expired_at IS NULL ORDER BY ..., id DESC`) as `{ source_id,
    /// slug, row_num, trust_tier, flagged, contested }`, where `flagged` is `activationSuppressedSql` and `contested` is
    /// `contestedRefSql`. A key with no live fact gives no row; rows are in (source id, slug, row number) byte order. A
    /// row number outside `int` is refused, as the `int[]` bind refuses it; a NUL byte is refused, as `text[]` does.
    pub fn list_fence_row_trust(&self, keys: &[FenceRowKey]) -> Result<Vec<Value>> {
        const OP: &str = "listFenceRowTrust";
        let mut wanted = std::collections::BTreeSet::new();
        for k in keys {
            no_nul(
                OP,
                &[
                    ("source_id", k.source_id.as_str()),
                    ("slug", k.slug.as_str()),
                ],
            )?;
            let row = i32::try_from(k.row_num).map_err(|_| {
                StoreError::new(
                    INVALID_ARGUMENT,
                    format!(
                        "{OP}: row_num {} is out of range for type integer",
                        k.row_num
                    ),
                )
            })?;
            wanted.insert((k.source_id.clone(), k.slug.clone(), row));
        }
        let read = self.read()?;
        let mut out = Vec::new();
        let mut pages: std::collections::BTreeMap<(String, String), Vec<super::FactRecord>> =
            std::collections::BTreeMap::new();
        for (source_id, slug, row) in wanted {
            let key = (source_id.clone(), slug.clone());
            if !pages.contains_key(&key) {
                pages.insert(key.clone(), page_rows(&*read, &source_id, &slug)?);
            }
            let Some(fact) = pages[&key]
                .iter()
                .filter(|f| f.row_num == Some(row) && f.expired_at_us.is_none())
                .max_by_key(|f| f.id)
            else {
                continue;
            };
            let id = i64::try_from(fact.id).map_err(|_| {
                StoreError::new(INVALID_ARGUMENT, format!("{OP}: fact id out of range"))
            })?;
            out.push(json!({
                "source_id": source_id,
                "slug": slug,
                "row_num": row,
                "trust_tier": fact.trust_tier,
                "flagged": crate::trust::activation_suppressed(&*read, "facts", fact.id, fact.tier())?,
                "contested": crate::trust::proposals::contested_ref(&*read, "facts", id)?,
            }));
        }
        Ok(out)
    }
}
