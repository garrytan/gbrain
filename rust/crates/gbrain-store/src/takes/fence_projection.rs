//! The take statements of a page publication's fence projection
//! (`src/core/engine-sql/fence-projection.ts`): the stored takes at the row numbers a write drops
//! (the quoted-fence check), the page's take row numbers, and the two resolution writes. A put_page
//! that updates a page with a `## Takes` fence runs them inside its publication; the writes join the
//! bound transaction (`Store::write`) and change no `updated_at`, as the statements set none.
//!
//! Members: listQuotedTakeRows, listPageTakeRowNums, clearChangedTakeResolutions,
//! writeFenceTakeResolutions. They add no keys. See rust/docs/store/takes.md, "The fence projection's
//! statements".

use super::resolved_at::{self, ResolvedAtError};
use super::{QUALITIES, TAKES, check_failed, page_takes, real, store_take};
use crate::Store;
use crate::error::{Result, StoreError, UNMODELED_INPUT};
use crate::links::no_nul;
use crate::write_receipt::float_distinct;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// `n(row_num integer, claim text)` of `clearChangedTakeResolutions`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ClaimRow {
    row_num: Option<f64>,
    claim: Option<String>,
}

/// `r(row_num integer, resolved_at text, ...)` of `writeFenceTakeResolutions`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ResolutionRow {
    row_num: Option<f64>,
    resolved_at: Option<String>,
    resolved_quality: Option<String>,
    resolved_outcome: Option<bool>,
    resolved_source: Option<String>,
    resolved_value: Option<f64>,
    resolved_unit: Option<String>,
    resolved_by: Option<String>,
}

fn invalid(message: String) -> StoreError {
    StoreError::invalid(message)
}

/// `jsonb_to_recordset($2::text::jsonb)`: an array of objects, each decoded as `T`.
fn records<T: for<'de> Deserialize<'de>>(op: &str, text: &str) -> Result<Vec<T>> {
    let bad = |what: &str| invalid(format!("{op}: {what}"));
    let Value::Array(items) =
        serde_json::from_str::<Value>(text).map_err(|_| bad("not a JSON document"))?
    else {
        return Err(bad("the record set is not an array"));
    };
    items
        .into_iter()
        .map(|item| {
            if !item.is_object() {
                return Err(bad("a record is not an object"));
            }
            serde_json::from_value(item).map_err(|_| bad("a record field has the wrong type"))
        })
        .collect()
}

/// A JS number bound to an `integer` column of the record set.
fn row_num(op: &str, value: Option<f64>) -> Result<Option<i32>> {
    value
        .map(|v| {
            if v.fract() != 0.0 || v < f64::from(i32::MIN) || v > f64::from(i32::MAX) {
                Err(invalid(format!(
                    "{op}: row_num must be an integer in the int4 range, got {v}"
                )))
            } else {
                Ok(v as i32)
            }
        })
        .transpose()
}

/// `resolved_at.rs`: Postgres's error as `invalid_argument`, and a form the store does not read
/// as `unmodeled_input`, which the engine refuses by name.
fn resolved(text: &str, now: i64) -> Result<i64> {
    resolved_at::parse(text, now).map_err(|e| match e {
        ResolvedAtError::Unmodeled => StoreError::new(UNMODELED_INPUT, e.message(text)),
        _ => invalid(e.message(text)),
    })
}

/// `takes_resolution_consistency`: passes unless it is false (a CHECK passes on NULL).
fn consistent(quality: Option<&str>, outcome: Option<bool>) -> bool {
    match quality {
        None => true,
        Some("correct") => outcome != Some(false),
        Some("incorrect") => outcome != Some(true),
        Some("partial" | "unresolvable") => outcome.is_none(),
        Some(_) => false,
    }
}

impl Store {
    /// `listQuotedTakeRows(pageId, rowNums)`: `{ row_num, claim }` of the page's takes at those row
    /// numbers, by row number.
    pub fn list_quoted_take_rows(&self, page_id: f64, row_nums: &[f64]) -> Result<Vec<Value>> {
        const OP: &str = "listQuotedTakeRows";
        let Some(page) = row_num(OP, Some(page_id))? else {
            return Ok(Vec::new());
        };
        let mut wanted = BTreeSet::new();
        for n in row_nums {
            if let Some(n) = row_num(OP, Some(*n))? {
                wanted.insert(n);
            }
        }
        let Ok(page) = u64::try_from(page) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        Ok(page_takes(&*read, page)?
            .iter()
            .filter(|t| wanted.contains(&t.row_num))
            .map(|t| json!({ "row_num": t.row_num, "claim": t.claim }))
            .collect())
    }

    /// `listPageTakeRowNums(pageId)`: the row number of every take of the page, ascending.
    pub fn list_page_take_row_nums(&self, page_id: f64) -> Result<Vec<i32>> {
        let Some(page) = row_num("listPageTakeRowNums", Some(page_id))? else {
            return Ok(Vec::new());
        };
        let Ok(page) = u64::try_from(page) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        Ok(page_takes(&*read, page)?
            .iter()
            .map(|t| t.row_num)
            .collect())
    }

    /// `clearChangedTakeResolutions(pageId, claims)`: each resolved take of the page at a row number
    /// of `claims` whose claim differs from the claim there loses its resolution (the seven
    /// `resolved_*` columns NULL).
    pub fn clear_changed_take_resolutions(&self, page_id: f64, claims: &str) -> Result<()> {
        const OP: &str = "clearChangedTakeResolutions";
        let page = row_num(OP, Some(page_id))?;
        let mut by_row: BTreeMap<i32, Option<String>> = BTreeMap::new();
        for c in records::<ClaimRow>(OP, claims)? {
            if let Some(claim) = &c.claim {
                no_nul(OP, &[("claim", claim)])?;
            }
            if let Some(n) = row_num(OP, c.row_num)? {
                by_row.entry(n).or_insert(c.claim);
            }
        }
        let Some(Ok(page)) = page.map(u64::try_from) else {
            return Ok(());
        };
        if by_row.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            for old in page_takes(&*tx, page)? {
                let Some(claim) = by_row.get(&old.row_num) else {
                    continue;
                };
                if old.resolved_at_us.is_none() || claim.as_deref() == Some(old.claim.as_str()) {
                    continue;
                }
                let mut take = old.clone();
                take.resolved_at_us = None;
                take.resolved_quality = None;
                take.resolved_outcome = None;
                take.resolved_source = None;
                take.resolved_value = None;
                take.resolved_unit = None;
                take.resolved_by = None;
                store_take(tx, &take)?;
            }
            Ok(())
        })
    }

    /// `writeFenceTakeResolutions(pageId, resolutions)`: each take of the page at a record's row
    /// number takes the record's seven resolution cells, when any differs. Every record is cast
    /// first; the table's CHECK constraints refuse a bad quality or quality/outcome pair.
    pub fn write_fence_take_resolutions(&self, page_id: f64, resolutions: &str) -> Result<()> {
        const OP: &str = "writeFenceTakeResolutions";
        struct Cells {
            at: Option<i64>,
            quality: Option<String>,
            outcome: Option<bool>,
            source: Option<String>,
            value: Option<f32>,
            unit: Option<String>,
            by: Option<String>,
        }
        let page = row_num(OP, Some(page_id))?;
        let now = self.env.now_micros();
        let mut by_row: BTreeMap<i32, Cells> = BTreeMap::new();
        for r in records::<ResolutionRow>(OP, resolutions)? {
            let n = row_num(OP, r.row_num)?;
            let parts = [
                ("resolved_at", &r.resolved_at),
                ("resolved_quality", &r.resolved_quality),
                ("resolved_source", &r.resolved_source),
                ("resolved_unit", &r.resolved_unit),
                ("resolved_by", &r.resolved_by),
            ];
            for (column, text) in parts {
                if let Some(text) = text {
                    no_nul(OP, &[(column, text)])?;
                }
            }
            let cells = Cells {
                at: r
                    .resolved_at
                    .as_deref()
                    .map(|t| resolved(t, now))
                    .transpose()?,
                quality: r.resolved_quality,
                outcome: r.resolved_outcome,
                source: r.resolved_source,
                value: r.resolved_value.map(|v| real(v, OP)).transpose()?,
                unit: r.resolved_unit,
                by: r.resolved_by,
            };
            if let Some(n) = n {
                by_row.entry(n).or_insert(cells);
            }
        }
        let Some(Ok(page)) = page.map(u64::try_from) else {
            return Ok(());
        };
        if by_row.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            for old in page_takes(&*tx, page)? {
                let Some(c) = by_row.get(&old.row_num) else {
                    continue;
                };
                let same = (
                    old.resolved_at_us,
                    &old.resolved_quality,
                    old.resolved_outcome,
                    &old.resolved_source,
                    &old.resolved_unit,
                    &old.resolved_by,
                ) == (c.at, &c.quality, c.outcome, &c.source, &c.unit, &c.by)
                    && !float_distinct(old.resolved_value, c.value);
                if same {
                    continue;
                }
                if !consistent(c.quality.as_deref(), c.outcome) {
                    return Err(check_failed(TAKES, "takes_resolution_consistency"));
                }
                if c.quality
                    .as_deref()
                    .is_some_and(|q| !QUALITIES.contains(&q))
                {
                    return Err(check_failed(TAKES, "takes_resolved_quality_values"));
                }
                let mut take = old.clone();
                take.resolved_at_us = c.at;
                take.resolved_quality = c.quality.clone();
                take.resolved_outcome = c.outcome;
                take.resolved_source = c.source.clone();
                take.resolved_value = c.value;
                take.resolved_unit = c.unit.clone();
                take.resolved_by = c.by.clone();
                store_take(tx, &take)?;
            }
            Ok(())
        })
    }
}
