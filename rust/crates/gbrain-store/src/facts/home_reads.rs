//! The facts-home scan's reads (src/core/engine-sql/collate-facts-home-reads.ts): the unfenced facts of a source, the
//! fenced facts waiting on a holding page, the fenced facts whose page is missing, and a live page's file origin.
//!
//! Members: scanUnfencedFactRows, listHeldFactRows, listFencedFactsOfMissingPages, readPageFileOrigin.
//!
//! Keys: none. Each read scans the source's fact rows (`source_rows`) and reads the pages they name. Text compares in
//! byte order, as `COLLATE "C"` does, and a NUL byte in a text argument is refused whether or not a row would match, as
//! Postgres refuses the bound parameter.

use super::privacy::holding_slug;
use super::purge::fence_columns;
use super::{FactRecord, source_rows};
use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::read_page;
use serde_json::{Map, Value, json};

/// Whether `row` is a held row of its source: a fence position, no ontology dimension, about an entity that is no holding
/// page, whose `source_markdown_slug` names a holding page that has a row in the source (a soft-deleted page counts: the
/// SQL tests only for the page row).
fn on_holding(read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
    let Some(slug) = row.source_markdown_slug.as_deref() else {
        return Ok(false);
    };
    let about_other = row.entity_slug.as_deref().is_some_and(|e| !holding_slug(e));
    if !(holding_slug(slug) && row.row_num.is_some() && row.dimension.is_none() && about_other) {
        return Ok(false);
    }
    Ok(read_page(read, &row.source_id, slug)?.is_some())
}

/// `EXISTS (SELECT 1 FROM pages WHERE source_id = $1 AND slug = entity_slug AND deleted_at IS [NOT] NULL)`.
fn page_state(read: &dyn KvRead, row: &FactRecord) -> Result<(bool, bool)> {
    let Some(entity) = row.entity_slug.as_deref() else {
        return Ok((false, false));
    };
    Ok(match read_page(read, &row.source_id, entity)? {
        Some(page) => (page.deleted_at_us.is_none(), page.deleted_at_us.is_some()),
        None => (false, false),
    })
}

/// The columns a scan row carries before the page flags: the fact's identity, its text, then the fence columns.
fn base_columns(r: &FactRecord) -> Map<String, Value> {
    let mut row = Map::new();
    row.insert("id".into(), json!(r.id));
    row.insert("source_id".into(), json!(r.source_id));
    row.insert("entity_slug".into(), json!(r.entity_slug));
    row.insert("fact".into(), json!(r.fact));
    fence_columns(&mut row, r);
    row
}

/// The `days` text as the micros `($2 || ' days')::interval` is: an optionally signed decimal number. Another interval
/// text is refused (the TypeScript member refuses it before it asks), and so is one too large for an interval.
fn days_micros(days: &str) -> Result<i64> {
    let bad = || {
        StoreError::invalid(format!(
            "listHeldFactRows: days {days:?} is not a plain number"
        ))
    };
    let (negative, digits) = match days.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, days.strip_prefix('+').unwrap_or(days)),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let plain = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty()
        || whole.len() > 6
        || fraction.len() > 6
        || !plain(whole)
        || !plain(fraction)
    {
        return Err(bad());
    }
    let whole: i64 = whole.parse().map_err(|_| bad())?;
    let fraction: i64 = if fraction.is_empty() {
        0
    } else {
        // 86_400_000_000 micros a day, so each digit of the fraction is a whole number of micros at most six places deep.
        let scale = 10_i64.pow(fraction.len() as u32);
        fraction.parse::<i64>().map_err(|_| bad())? * (86_400_000_000 / scale)
    };
    let micros = whole * 86_400_000_000 + fraction;
    Ok(if negative { -micros } else { micros })
}

impl Store {
    /// `scanUnfencedFactRows(sourceId)`: the unexpired rows with no fence position, by entity in byte order (none
    /// first), then id, with their ontology dimension and whether the entity page is live or soft-deleted.
    pub fn scan_unfenced_fact_rows(&self, source_id: &str) -> Result<Vec<Value>> {
        no_nul("scanUnfencedFactRows", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut rows: Vec<FactRecord> = source_rows(&*read, source_id)?
            .into_iter()
            .filter(|r| r.row_num.is_none() && r.expired_at_us.is_none())
            .collect();
        rows.sort_by(|a, b| (&a.entity_slug, a.id).cmp(&(&b.entity_slug, b.id)));
        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            let (exists, deleted) = page_state(&*read, r)?;
            let mut row = base_columns(r);
            row.insert("dimension".into(), json!(r.dimension));
            row.insert("page_exists".into(), json!(exists));
            row.insert("page_deleted".into(), json!(deleted));
            out.push(Value::Object(row));
        }
        Ok(out)
    }

    /// `listHeldFactRows(sourceId, days)`: the unexpired held rows, by entity in byte order then id, with when each
    /// started waiting (UTC, to the second) and whether that is more than `days` days ago.
    pub fn list_held_fact_rows(&self, source_id: &str, days: &str) -> Result<Vec<Value>> {
        no_nul(
            "listHeldFactRows",
            &[("sourceId", source_id), ("days", days)],
        )?;
        let cutoff = self.env.now_micros() - days_micros(days)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for r in source_rows(&*read, source_id)? {
            if r.expired_at_us.is_none() && on_holding(&*read, &r)? {
                rows.push(r);
            }
        }
        rows.sort_by(|a, b| (&a.entity_slug, a.id).cmp(&(&b.entity_slug, b.id)));
        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            let mut row = base_columns(r);
            row.insert("page_exists".into(), json!(page_state(&*read, r)?.0));
            row.insert("from_slug".into(), json!(r.source_markdown_slug));
            // `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` cuts the fraction of a second.
            row.insert(
                "held_since".into(),
                json!(format!("{}Z", &iso(r.created_at_us)[..19])),
            );
            row.insert("old".into(), json!(r.created_at_us < cutoff));
            out.push(Value::Object(row));
        }
        Ok(out)
    }

    /// `listFencedFactsOfMissingPages(sourceId)`: `{ id, slug }` for each unexpired fenced row whose page is missing or
    /// soft-deleted, by id.
    pub fn list_fenced_facts_of_missing_pages(&self, source_id: &str) -> Result<Vec<Value>> {
        no_nul("listFencedFactsOfMissingPages", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut out = Vec::new();
        let mut rows = source_rows(&*read, source_id)?;
        rows.sort_by_key(|r| r.id);
        for r in rows
            .iter()
            .filter(|r| r.row_num.is_some() && r.expired_at_us.is_none())
        {
            let live = match r.source_markdown_slug.as_deref() {
                Some(slug) => {
                    read_page(&*read, source_id, slug)?.is_some_and(|p| p.deleted_at_us.is_none())
                }
                None => false,
            };
            if !live {
                out.push(json!({ "id": r.id, "slug": r.source_markdown_slug }));
            }
        }
        Ok(out)
    }

    /// `readPageFileOrigin(sourceId, slug)`: the live page's file path and URI, null for none.
    pub fn read_page_file_origin(&self, source_id: &str, slug: &str) -> Result<Option<Value>> {
        no_nul(
            "readPageFileOrigin",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        Ok(read_page(&*read, source_id, slug)?
            .filter(|p| p.deleted_at_us.is_none())
            .map(|p| json!({ "source_path": p.source_path, "source_uri": p.source_uri })))
    }
}

#[cfg(test)]
mod tests {
    use super::days_micros;

    #[test]
    fn days_are_the_interval_a_plain_number_names() {
        assert_eq!(days_micros("30").unwrap(), 30 * 86_400_000_000);
        assert_eq!(days_micros("+1.5").unwrap(), 129_600_000_000);
        assert_eq!(days_micros("-2").unwrap(), -172_800_000_000);
        for bad in ["", ".5", "1e3", "1 day", "1234567", "1.1234567", "--1"] {
            assert!(days_micros(bad).is_err(), "{bad:?}");
        }
    }
}
