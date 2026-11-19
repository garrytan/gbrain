//! The held fence cells of a world-only fact read: `listHeldFenceCells` (`engine-sql/cli-reads-ops.ts`,
//! `eligibility/fence-overlay.ts` `heldRowSql`), which `eligibility/stamp.ts` `heldFenceLines` asks before get_page,
//! get_chunks, think and search_exact show a page's text to a caller whose fact reads are world-only.
//!
//! A cell is one facts-fence row line of the text: the page (`source_id`, `slug`), its row number (-1 for a fragment
//! that names none), its claim and whether a chunk boundary cut it (`partial`). The store answers the caller with no
//! member page and no private-facts grant, the form in which `heldRowSql` renders `memberFactAdmitSql` and
//! `grantedPrivateFactSql` as `FALSE` (the TypeScript member refuses any other caller). In that form a cell is held when
//! a live fact of the page (`expired_at IS NULL`, by the by-page index on `source_markdown_slug`) that is not world sits
//! at its row number, or when a live fact of the page that is not world states its claim and no live world fact of the
//! page states it. A fact states a claim when it equals it, or, for a cut claim, contains it (`strpos(fact, claim) > 0`).
//! See rust/docs/store/facts.md, "Held fence cells".

use super::{FactRecord, page_rows};
use crate::Store;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::links::no_nul;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

/// One fence cell (`HeldFenceCellKey`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldFenceCellKey {
    pub source_id: String,
    pub slug: String,
    pub row_num: i64,
    pub claim: String,
    pub partial: bool,
}

/// `listHeldFenceCells({ keys })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeldFenceCellsInput {
    pub keys: Vec<HeldFenceCellKey>,
}

/// `CASE WHEN partial THEN strpos(fact, claim) > 0 ELSE fact = claim END`.
fn states(row: &FactRecord, key: &HeldFenceCellKey) -> bool {
    if key.partial {
        row.fact.contains(key.claim.as_str())
    } else {
        row.fact == key.claim
    }
}

/// `heldRowSql` with both caller admissions `FALSE`, over the page's live rows.
pub(super) fn held(rows: &[FactRecord], key: &HeldFenceCellKey, row_num: i32) -> bool {
    let narrower = |r: &&FactRecord| r.visibility != "world";
    rows.iter()
        .filter(narrower)
        .any(|r| r.row_num == Some(row_num))
        || (rows.iter().filter(narrower).any(|r| states(r, key))
            && !rows
                .iter()
                .any(|r| r.visibility == "world" && states(r, key)))
}

impl Store {
    /// `listHeldFenceCells({ keys })`: `[{ source_id, slug, row_num, claim }]`, one row per distinct held cell, in the
    /// order of each cell's first key. A key with a NUL character or a row number outside `integer` is the error
    /// Postgres raises for the same parameters.
    pub fn list_held_fence_cells(&self, input: &HeldFenceCellsInput) -> Result<Vec<Value>> {
        let mut checked = Vec::with_capacity(input.keys.len());
        for key in &input.keys {
            no_nul(
                "listHeldFenceCells",
                &[
                    ("source_id", &key.source_id),
                    ("slug", &key.slug),
                    ("claim", &key.claim),
                ],
            )?;
            let row_num = i32::try_from(key.row_num).map_err(|_| {
                StoreError::new(
                    INVALID_ARGUMENT,
                    format!(
                        "listHeldFenceCells: row_num {} is out of range for type integer",
                        key.row_num
                    ),
                )
            })?;
            checked.push((key, row_num));
        }
        let read = self.read()?;
        let mut pages: HashMap<(&str, &str), Vec<FactRecord>> = HashMap::new();
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (key, row_num) in checked {
            let page = (key.source_id.as_str(), key.slug.as_str());
            let live = match pages.entry(page) {
                Entry::Occupied(e) => e.into_mut(),
                Entry::Vacant(e) => e.insert(
                    page_rows(&*read, page.0, page.1)?
                        .into_iter()
                        .filter(|r| r.expired_at_us.is_none())
                        .collect(),
                ),
            };
            if !held(live, key, row_num) {
                continue;
            }
            if seen.insert((page.0, page.1, row_num, key.claim.as_str())) {
                out.push(json!({
                    "source_id": key.source_id,
                    "slug": key.slug,
                    "row_num": row_num,
                    "claim": key.claim,
                }));
            }
        }
        Ok(out)
    }
}
