//! The timeline reads of `src/core/engine-sql/timeline-reads.ts`: doctor's effective-date sample
//! (`sampleEffectiveDates`, `sampleEffectiveDateSources`) and its timeline-history clock
//! (`readMaxTimelineEntryId`), the canonical projection's stored-timeline read and row delete
//! (`listStoredTimelineRowsOrdered`, `deleteTimelineRows`), `gbrain repair timeline`'s batched row
//! read, segmented-page residual and comment-markup count (`storedTimelineRowsByPageIds`,
//! `countSegmentedTimelinePages`, `countTimelineCommentMarkupRows`) and the orphan prune's page
//! walk (`listTimelineOrphanPages`).
//!
//! Each member answers what the SQL engines' statement answers over the same rows. None of these
//! statements applies a read policy: a page is live when it is not soft-deleted, and the
//! effective-date sample reads soft-deleted pages too. An own timeline row is one with no event
//! page (`event_page_id IS NULL`). A segmented page is one whose `compiled_truth` and `timeline`
//! are both NULL (`pages_body_storage_chk` makes that `body_storage = 'segmented'`).
//!
//! `NOW() + INTERVAL '1 year'` is the store clock in UTC a calendar year later, the time of day
//! kept and February 29 moved to February 28, as Postgres adds a year with the session time zone
//! UTC.
//!
//! `deleteTimelineRows` deletes an entry's `E` key and its `D` key when the `D` key still names
//! it, and sets the page's `G` key to the newest `created_at` of the entries left (removes it with
//! none), so the stale flag of the keyword reads, `MAX(created_at)` on the SQL engines, follows
//! the delete.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, all_pages};
use crate::timeline::{TimelineRecord, parse_date};
use serde::Deserialize;
use serde_json::{Value, json};

const MICROS_PER_DAY: i64 = 86_400_000_000;
/// `TIMESTAMPTZ '1990-01-01'` with the session time zone UTC, in microseconds.
const START_OF_1990_US: i64 = 631_152_000_000_000;
/// The effective-date sample's window: the newest pages by id.
const SAMPLE: usize = 1000;
/// The effective-date sources that are explicit (a pre-1990 date from one is history, #5742).
const EXPLICIT_SOURCES: [&str; 4] = ["event_date", "date", "published", "created"];
/// The frontmatter keys whose presence makes a fallback a candidate.
const DATE_KEYS: [&str; 3] = ["event_date", "date", "published"];

/// One row of `deleteTimelineRows`' JSON document: each field as `jsonb_to_recordset` types it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TimelineRowDeletion {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub removed: Option<bool>,
}

/// `deleteTimelineRows(pageId, deletions)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTimelineRowsInput {
    pub page_id: i64,
    #[serde(default)]
    pub deletions: Vec<TimelineRowDeletion>,
}

/// `countSegmentedTimelinePages(sourceIds, limit)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentedTimelineInput {
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub limit: u64,
}

/// `listTimelineOrphanPages({ afterId, limit, sourceId? })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineOrphanInput {
    pub after_id: i64,
    pub limit: u64,
    #[serde(default)]
    pub source_id: Option<String>,
}

fn segmented(page: &PageRecord) -> bool {
    page.compiled_truth.is_null() && page.timeline.is_null()
}

/// Every timeline entry (`E`), in key order: page id, then date, then id.
fn all_entries(read: &dyn KvRead) -> Result<Vec<TimelineRecord>> {
    let mut entries = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::TIMELINE], false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(entry) => entries.push(entry),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(entries), Err)
}

/// The entries of one page, in date then id order.
fn page_entries(read: &dyn KvRead, page_id: u64) -> Result<Vec<TimelineRecord>> {
    let mut entries = Vec::new();
    let mut failure = None;
    scan_prefix(read, &keys::timeline_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(entry) => entries.push(entry),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(entries), Err)
}

/// The pages that hold an own timeline row.
fn pages_with_own_rows(read: &dyn KvRead) -> Result<BTreeMap<u64, usize>> {
    let mut rows = BTreeMap::new();
    for entry in all_entries(read)? {
        if entry.event_page_id.is_none() {
            *rows.entry(entry.page_id).or_insert(0) += 1;
        }
    }
    Ok(rows)
}

/// The newest 1000 pages by id, soft-deleted pages included.
fn sample(read: &dyn KvRead) -> Result<Vec<PageRecord>> {
    let mut pages = all_pages(read)?;
    pages.sort_by_key(|p| std::cmp::Reverse(p.id));
    pages.truncate(SAMPLE);
    Ok(pages)
}

/// The instant one calendar year after `micros`, in UTC.
fn one_year_later(micros: i64) -> i64 {
    let days = micros.div_euclid(MICROS_PER_DAY);
    let time = micros.rem_euclid(MICROS_PER_DAY);
    let (y, m, d) = civil_from_days(days);
    let y = y + 1;
    let d = if m == 2 && d == 29 && !leap(y) { 28 } else { d };
    days_from_civil(y, m, d) * MICROS_PER_DAY + time
}

fn leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// Howard Hinnant's civil calendar algorithms (the same as env.rs).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn own_row(entry: &TimelineRecord) -> Value {
    json!({
        "id": entry.id,
        "date": entry.date,
        "source": entry.source,
        "summary": entry.summary,
        "detail": entry.detail,
    })
}

/// Deletes the entry's `E` key and its `D` key when that key still names the entry.
fn delete_entry(tx: &mut dyn KvWrite, entry: &TimelineRecord) -> Result<()> {
    tx.delete(&keys::timeline(entry.page_id, &entry.date, entry.id))?;
    let dedup = entry.dedup_key();
    if tx.get(&dedup)?.and_then(|b| keys::be8(&b)) == Some(entry.id) {
        tx.delete(&dedup)?;
    }
    Ok(())
}

/// Sets `G page_id` to the newest `created_at` of the page's entries, or removes it with none.
fn reset_latest(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    let latest = page_entries(&*tx, page_id)?
        .iter()
        .map(|e| e.created_at_us)
        .max();
    match latest {
        Some(micros) => tx.put(&keys::timeline_latest(page_id), &micros.to_be_bytes()),
        None => tx.delete(&keys::timeline_latest(page_id)),
    }
}

impl Store {
    /// `sampleEffectiveDates()`: of the newest 1000 pages, those dated more than a year ahead
    /// and those with an inferred date before 1990.
    pub fn sample_effective_dates(&self) -> Result<Value> {
        let read = self.read()?;
        let horizon = one_year_later(self.env.now_micros());
        let (mut future, mut pre_1990) = (0u64, 0u64);
        for page in sample(&*read)? {
            let Some(date) = page.effective_date_us else {
                continue;
            };
            if date > horizon {
                future += 1;
            }
            let source = page.effective_date_source.as_deref().unwrap_or("");
            if date < START_OF_1990_US && !EXPLICIT_SOURCES.contains(&source) {
                pre_1990 += 1;
            }
        }
        Ok(json!({ "future_dated": future, "pre_1990": pre_1990 }))
    }

    /// `sampleEffectiveDateSources()`: of the newest 1000 pages, those whose effective date fell
    /// back while their frontmatter has an `event_date`, `date` or `published` key, newest
    /// first.
    pub fn sample_effective_date_sources(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(sample(&*read)?
            .into_iter()
            .filter(|page| page.effective_date_source.as_deref() == Some("fallback"))
            .filter(|page| {
                DATE_KEYS
                    .iter()
                    .any(|key| page.frontmatter.contains_key(*key))
            })
            .map(|page| {
                json!({
                    "slug": page.slug,
                    "frontmatter": Value::Object(page.frontmatter),
                    "created_at": iso(page.created_at_us),
                    "updated_at": iso(page.updated_at_us),
                })
            })
            .collect())
    }

    /// `readMaxTimelineEntryId()`: the largest entry id, event rows included, or 0.
    pub fn read_max_timeline_entry_id(&self) -> Result<u64> {
        let read = self.read()?;
        let mut max = 0;
        scan_prefix(&*read, &[keys::TIMELINE], false, &mut |k, _| {
            if let Some(id) = k.len().checked_sub(8).and_then(|at| keys::be8(&k[at..])) {
                max = max.max(id);
            }
            true
        })?;
        Ok(max)
    }

    /// `listStoredTimelineRowsOrdered(pageId)`: the page's own rows, by date then id.
    pub fn list_stored_timeline_rows_ordered(&self, page_id: i64) -> Result<Vec<Value>> {
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        Ok(page_entries(&*read, page_id)?
            .iter()
            .filter(|e| e.event_page_id.is_none())
            .map(own_row)
            .collect())
    }

    /// `deleteTimelineRows(pageId, deletions)`: deletes each own row of the page that still
    /// matches a deletion on id, date, source, summary and detail; returns each deleted row's
    /// date with the deletion's `removed` mark, in entry key order.
    pub fn delete_timeline_rows(&self, input: &DeleteTimelineRowsInput) -> Result<Vec<Value>> {
        // `d.date` is a `date` column: a value that is not a date fails before any row is read.
        let mut wanted: HashMap<i64, Vec<(Option<String>, &TimelineRowDeletion)>> = HashMap::new();
        for d in &input.deletions {
            let date = d.date.as_deref().map(parse_date).transpose()?;
            if let Some(id) = d.id {
                wanted.entry(id).or_default().push((date, d));
            }
        }
        let Ok(page_id) = u64::try_from(input.page_id) else {
            return Ok(Vec::new());
        };
        self.write(|tx| {
            let mut out = Vec::new();
            let mut done = BTreeSet::new();
            for entry in page_entries(&*tx, page_id)? {
                if entry.event_page_id.is_some() {
                    continue;
                }
                let Some(candidates) = i64::try_from(entry.id).ok().and_then(|id| wanted.get(&id))
                else {
                    continue;
                };
                let hit = candidates.iter().find(|(date, d)| {
                    date.as_deref() == Some(entry.date.as_str())
                        && d.source.as_deref() == Some(entry.source.as_str())
                        && d.summary.as_deref() == Some(entry.summary.as_str())
                        && d.detail.as_deref() == Some(entry.detail.as_str())
                });
                if let Some((_, d)) = hit {
                    delete_entry(tx, &entry)?;
                    done.insert(entry.id);
                    out.push(json!({ "date": entry.date, "removed": d.removed }));
                }
            }
            if !done.is_empty() {
                reset_latest(tx, page_id)?;
            }
            Ok(out)
        })
    }

    /// `storedTimelineRowsByPageIds(pageIds)`: the own rows of the pages, by page id then id.
    pub fn stored_timeline_rows_by_page_ids(&self, page_ids: &[i64]) -> Result<Vec<Value>> {
        let ids: BTreeSet<u64> = page_ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let read = self.read()?;
        let mut out = Vec::new();
        for page_id in ids {
            let mut entries: Vec<TimelineRecord> = page_entries(&*read, page_id)?
                .into_iter()
                .filter(|e| e.event_page_id.is_none())
                .collect();
            entries.sort_by_key(|e| e.id);
            for entry in entries {
                let mut row = own_row(&entry);
                row["page_id"] = json!(entry.page_id);
                out.push(row);
            }
        }
        Ok(out)
    }

    /// `countSegmentedTimelinePages(sourceIds, limit)`: live segmented pages of the sources that
    /// hold own rows, their row count and the first `limit` pages by id.
    pub fn count_segmented_timeline_pages(&self, input: &SegmentedTimelineInput) -> Result<Value> {
        let read = self.read()?;
        let sources: BTreeSet<&str> = input.source_ids.iter().map(String::as_str).collect();
        let rows = pages_with_own_rows(&*read)?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && segmented(p))
            .filter(|p| sources.contains(p.source_id.as_str()) && rows.contains_key(&p.id))
            .collect();
        if pages.is_empty() {
            return Ok(json!({ "pages": 0, "rows": 0, "sample": [] }));
        }
        pages.sort_by_key(|p| p.id);
        let total: usize = pages.iter().map(|p| rows[&p.id]).sum();
        let limit = usize::try_from(input.limit).unwrap_or(usize::MAX);
        let sample: Vec<Value> = pages
            .iter()
            .take(limit)
            .map(|p| json!({ "source_id": p.source_id, "slug": p.slug }))
            .collect();
        Ok(json!({ "pages": pages.len(), "rows": total, "sample": sample }))
    }

    /// `countTimelineCommentMarkupRows(sourceIds)`: own rows on live pages of the sources whose
    /// summary or source holds `<!--` or `-->`.
    pub fn count_timeline_comment_markup_rows(&self, source_ids: &[String]) -> Result<u64> {
        let read = self.read()?;
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let live: BTreeSet<u64> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && sources.contains(p.source_id.as_str()))
            .map(|p| p.id)
            .collect();
        let markup = |text: &str| text.contains("<!--") || text.contains("-->");
        Ok(all_entries(&*read)?
            .iter()
            .filter(|e| e.event_page_id.is_none() && live.contains(&e.page_id))
            .filter(|e| markup(&e.summary) || markup(&e.source))
            .count() as u64)
    }

    /// `listTimelineOrphanPages({ afterId, limit, sourceId? })`: live pages after `afterId`,
    /// in `sourceId` when it is not empty, that hold own rows, by id, at most `limit`.
    pub fn list_timeline_orphan_pages(&self, input: &TimelineOrphanInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let rows = pages_with_own_rows(&*read)?;
        let source = input.source_id.as_deref().filter(|s| !s.is_empty());
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| i64::try_from(p.id).is_ok_and(|id| id > input.after_id))
            .filter(|p| p.deleted_at_us.is_none() && rows.contains_key(&p.id))
            .filter(|p| source.is_none_or(|s| p.source_id == s))
            .collect();
        pages.sort_by_key(|p| p.id);
        let limit = usize::try_from(input.limit).unwrap_or(usize::MAX);
        Ok(pages
            .into_iter()
            .take(limit)
            .map(|p| {
                let storage = if segmented(&p) { "segmented" } else { "inline" };
                json!({
                    "id": p.id,
                    "slug": p.slug,
                    "source_id": p.source_id,
                    "compiled_truth": p.compiled_truth.as_deref(),
                    "timeline": p.timeline.as_deref(),
                    "body_storage": storage,
                    "revision": p.knowledge_revision,
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_year_later_keeps_the_time_of_day_and_moves_february_29() {
        let day = |y, m, d| days_from_civil(y, m, d) * MICROS_PER_DAY;
        let noon = MICROS_PER_DAY / 2;
        assert_eq!(
            one_year_later(day(2026, 11, 17) + noon),
            day(2027, 11, 17) + noon
        );
        assert_eq!(one_year_later(day(2028, 2, 29)), day(2029, 2, 28));
        assert_eq!(one_year_later(day(2027, 2, 28)), day(2028, 2, 28));
        assert_eq!(day(1990, 1, 1), START_OF_1990_US);
    }
}
