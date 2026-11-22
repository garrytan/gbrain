//! Timeline entries: the `timeline_entries` table of the PGLite engine.
//!
//! An entry lives at `E page_id date entry_id`, so one reverse scan of a page reads
//! `ORDER BY date DESC, id DESC` and the `after` / `before` filters are key ranges.
//! `D page_id date sha256(summary) source -> entry_id` is the
//! `(page_id, date, md5(summary), source)` dedup index (a different digest, the same rule).
//! `G page_id` holds the newest `created_at` of the page's entries, which is what the `stale` flag
//! of keyword search compares with the page's `updated_at`. Deleting a page removes all three.
//!
//! Dates: Postgres casts many spellings to `date`. This engine takes `YYYY-MM-DD` or
//! `YYYY/MM/DD`, optionally followed by `T` or a space and a time it ignores, and refuses the
//! rest with `invalid_argument`. A date that does not exist (`2026-02-30`) is refused too.

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, KvWrite, prefix_end, scan_prefix};
use crate::links::{missing, no_nul};
use crate::pages::{clean, next_id, read_page, scope_sources};
use crate::sources::DEFAULT_SOURCE;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const NEXT_TIMELINE_ID: &str = "next_timeline_id";

/// What is stored for a timeline entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TimelineRecord {
    pub id: u64,
    pub page_id: u64,
    /// `YYYY-MM-DD`.
    pub date: String,
    pub source: String,
    pub summary: String,
    pub detail: String,
    #[serde(default)]
    pub event_page_id: Option<u64>,
    pub created_at_us: i64,
}

impl TimelineRecord {
    pub(crate) fn dedup_key(&self) -> Vec<u8> {
        let digest: [u8; 32] = Sha256::digest(self.summary.as_bytes()).into();
        keys::timeline_dedup(self.page_id, &self.date, &digest, &self.source)
    }

    /// The `TimelineEntry` row. `date` stays `YYYY-MM-DD`; `created_at` is an ISO string.
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "page_id": self.page_id,
            "date": self.date,
            "source": self.source,
            "summary": self.summary,
            "detail": self.detail,
            "event_page_id": self.event_page_id,
            "created_at": iso(self.created_at_us),
        })
    }
}

/// `TimelineInput`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TimelineInput {
    pub date: Option<String>,
    pub source: Option<String>,
    pub summary: Option<String>,
    pub detail: Option<String>,
}

/// The options of `addTimelineEntry`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AddTimelineOptions {
    pub skip_existence_check: Option<bool>,
    pub source_id: Option<String>,
}

/// One `TimelineBatchInput` of `addTimelineEntriesBatch`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TimelineBatchInput {
    pub slug: Option<String>,
    pub date: Option<String>,
    pub source: Option<String>,
    pub summary: Option<String>,
    pub detail: Option<String>,
    pub source_id: Option<String>,
}

/// `TimelineOpts` of `getTimeline`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TimelineOptions {
    pub limit: Option<i64>,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub after: Option<String>,
    pub before: Option<String>,
    pub exclude_private: Option<bool>,
    pub eligibility: Option<Value>,
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400) => {
            29
        }
        _ => 28,
    }
}

/// The `::date` cast this engine supports: `YYYY-MM-DD` out, `invalid_argument` otherwise.
pub(crate) fn parse_date(text: &str) -> Result<String> {
    let syntax = || {
        StoreError::new(
            INVALID_ARGUMENT,
            format!("invalid input syntax for type date: \"{text}\""),
        )
    };
    let trimmed = text.trim();
    let b = trimmed.as_bytes();
    if b.len() < 10 || (b.len() > 10 && b[10] != b'T' && b[10] != b' ') {
        return Err(syntax());
    }
    let sep = b[4];
    if (sep != b'-' && sep != b'/') || b[7] != sep {
        return Err(syntax());
    }
    let digits = |r: std::ops::Range<usize>| -> Option<u32> {
        let part = &b[r];
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| part.iter().fold(0u32, |n, d| n * 10 + u32::from(d - b'0')))
    };
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return Err(syntax());
    };
    if year == 0 || !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("date/time field value out of range: \"{text}\""),
        ));
    }
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

/// Inserts the entry unless an equal one exists. True when it inserted.
///
/// The id is taken before the dedup check, as `INSERT .. ON CONFLICT DO NOTHING` takes the
/// serial's next value before it finds the conflict: a deduped add leaves the same gap in
/// the ids PGLite leaves, so the ids `getTimeline` returns match.
fn insert_entry(tx: &mut dyn KvWrite, mut record: TimelineRecord) -> Result<bool> {
    let dedup = record.dedup_key();
    record.id = next_id(tx, NEXT_TIMELINE_ID)?;
    if tx.get(&dedup)?.is_some() {
        return Ok(false);
    }
    put_json(
        tx,
        &keys::timeline(record.page_id, &record.date, record.id),
        &record,
    )?;
    tx.put(&dedup, &record.id.to_be_bytes())?;
    raise_latest(tx, record.page_id, record.created_at_us)?;
    Ok(true)
}

/// Raises `G page_id` to `created_at_us` when it is newer than what `G` holds.
fn raise_latest(tx: &mut dyn KvWrite, page_id: u64, created_at_us: i64) -> Result<()> {
    let latest = keys::timeline_latest(page_id);
    let newer = match tx.get(&latest)? {
        Some(bytes) => latest_micros(&bytes).is_none_or(|old| created_at_us > old),
        None => true,
    };
    if newer {
        tx.put(&latest, &created_at_us.to_be_bytes())?;
    }
    Ok(())
}

/// The next timeline entry id, from the same counter `addTimelineEntry` uses (the `serial`).
// timeline_queries (upsertEventProjection) is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn next_entry_id(tx: &mut dyn KvWrite) -> Result<u64> {
    next_id(tx, NEXT_TIMELINE_ID)
}

/// The entry at `E page_id date id`, if there is one.
// timeline_queries (upsertEventProjection) is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn read_entry(
    read: &dyn KvRead,
    page_id: u64,
    date: &str,
    id: u64,
) -> Result<Option<TimelineRecord>> {
    get_json(read, &keys::timeline(page_id, date, id))
}

/// Writes `new`, replacing `old` (the same entry as it was stored before) when given. Removes
/// `old`'s `E` key and its `D` key when that `D` key still points at `old.id`. Refuses with
/// `constraint_violation` when `new`'s `D` key points at another entry (the dedup unique index).
/// Writes `new`'s `E` and `D` keys and raises `G` of `new.page_id`; `G` is never lowered. On a
/// refusal the caller returns the error, so the write transaction keeps nothing.
// timeline_queries (upsertEventProjection) is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn put_entry(
    tx: &mut dyn KvWrite,
    old: Option<&TimelineRecord>,
    new: &TimelineRecord,
) -> Result<()> {
    if let Some(old) = old {
        tx.delete(&keys::timeline(old.page_id, &old.date, old.id))?;
        let dedup = old.dedup_key();
        if tx.get(&dedup)?.and_then(|b| keys::be8(&b)) == Some(old.id) {
            tx.delete(&dedup)?;
        }
    }
    let dedup = new.dedup_key();
    if tx
        .get(&dedup)?
        .is_some_and(|bytes| keys::be8(&bytes) != Some(new.id))
    {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "duplicate key value violates unique constraint on timeline_entries (page_id, date, summary, source)",
        ));
    }
    put_json(tx, &keys::timeline(new.page_id, &new.date, new.id), new)?;
    tx.put(&dedup, &new.id.to_be_bytes())?;
    raise_latest(tx, new.page_id, new.created_at_us)
}

fn latest_micros(bytes: &[u8]) -> Option<i64> {
    Some(i64::from_be_bytes(bytes.try_into().ok()?))
}

/// The newest `created_at` of a page's timeline entries.
pub(crate) fn latest_entry_micros(read: &dyn KvRead, page_id: u64) -> Result<Option<i64>> {
    Ok(read
        .get(&keys::timeline_latest(page_id))?
        .and_then(|b| latest_micros(&b)))
}

/// `ON DELETE CASCADE` of `timeline_entries.page_id`.
pub(crate) fn remove_page_timeline(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    let mut doomed = Vec::new();
    for prefix in [
        keys::timeline_prefix(page_id),
        keys::timeline_dedup_prefix(page_id),
    ] {
        scan_prefix(&*tx, &prefix, false, &mut |k, _| {
            doomed.push(k.to_vec());
            true
        })?;
    }
    for key in doomed {
        tx.delete(&key)?;
    }
    tx.delete(&keys::timeline_latest(page_id))
}

/// The entries of one page, newest first, inside `[after, before]`, at most `limit`.
fn page_entries(
    read: &dyn KvRead,
    page_id: u64,
    after: Option<&str>,
    before: Option<&str>,
    limit: usize,
) -> Result<Vec<TimelineRecord>> {
    let prefix = keys::timeline_prefix(page_id);
    let mut start = prefix.clone();
    if let Some(after) = after {
        start.extend_from_slice(after.as_bytes());
    }
    let end = match before {
        Some(before) => {
            let mut bound = prefix.clone();
            bound.extend_from_slice(before.as_bytes());
            prefix_end(&bound)
        }
        None => prefix_end(&prefix),
    }
    .unwrap_or_else(|| vec![0xFF; 64]);
    let mut raw = Vec::new();
    if limit > 0 && start < end {
        read.scan(&start, &end, true, &mut |_, v| {
            raw.push(v.to_vec());
            raw.len() < limit
        })?;
    }
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

impl Store {
    /// `addTimelineEntry(slug, entry, opts)`: true when it inserted, false for a duplicate.
    /// `page_not_found` when the page does not exist, unless `skipExistenceCheck` (then false).
    pub fn add_timeline_entry(
        &self,
        slug: &str,
        entry: &TimelineInput,
        options: &AddTimelineOptions,
    ) -> Result<bool> {
        let source_id = options.source_id.as_deref().unwrap_or(DEFAULT_SOURCE);
        no_nul(
            "addTimelineEntry",
            &[("slug", slug), ("sourceId", source_id)],
        )?;
        // Postgres folds the constant cast first, so a bad date fails even for a missing page.
        let date = entry.date.as_deref().map(parse_date).transpose()?;
        self.write(|tx| {
            let Some(page) = read_page(&*tx, source_id, slug)? else {
                if options.skip_existence_check == Some(true) {
                    return Ok(false);
                }
                return Err(missing("addTimelineEntry", "page", slug, source_id));
            };
            let Some(date) = date else {
                return Err(not_null("date"));
            };
            let Some(summary) = entry.summary.as_deref() else {
                return Err(not_null_summary());
            };
            insert_entry(
                tx,
                TimelineRecord {
                    id: 0,
                    page_id: page.id,
                    date,
                    source: clean(entry.source.as_deref().unwrap_or("")),
                    summary: clean(summary),
                    detail: clean(entry.detail.as_deref().unwrap_or("")),
                    event_page_id: None,
                    created_at_us: self.env.now_micros(),
                },
            )
        })
    }

    /// `addTimelineEntriesBatch`: rows whose page is missing or soft-deleted are skipped. Returns
    /// the number of entries inserted. One bad row fails the whole batch.
    pub fn add_timeline_entries_batch(&self, entries: &[TimelineBatchInput]) -> Result<u64> {
        for entry in entries {
            no_nul(
                "addTimelineEntriesBatch",
                &[
                    ("slug", entry.slug.as_deref().unwrap_or("")),
                    ("date", entry.date.as_deref().unwrap_or("")),
                    ("source_id", entry.source_id.as_deref().unwrap_or("")),
                ],
            )?;
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut inserted = 0u64;
            for entry in entries {
                let source_id = entry
                    .source_id
                    .clone()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| DEFAULT_SOURCE.into());
                let Some(slug) = entry.slug.as_deref() else {
                    continue;
                };
                let Some(page) =
                    read_page(&*tx, &source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
                else {
                    continue;
                };
                let date = match entry.date.as_deref() {
                    Some(text) => parse_date(text)?,
                    None => return Err(not_null("date")),
                };
                let Some(summary) = entry.summary.as_deref() else {
                    return Err(not_null_summary());
                };
                let record = TimelineRecord {
                    id: 0,
                    page_id: page.id,
                    date,
                    source: clean(entry.source.as_deref().unwrap_or("")),
                    summary: clean(summary),
                    detail: clean(entry.detail.as_deref().unwrap_or("")),
                    event_page_id: None,
                    created_at_us: now,
                };
                if insert_entry(tx, record)? {
                    inserted += 1;
                }
            }
            Ok(inserted)
        })
    }

    /// `getTimeline(slug, opts)`: newest first (`date DESC, id DESC`), `limit` rows (0 or absent
    /// means 100). Soft-deleted pages keep their timeline readable, as in PGLite.
    pub fn get_timeline(&self, slug: &str, options: &TimelineOptions) -> Result<Vec<Value>> {
        for (name, refused) in [
            ("excludePrivate", options.exclude_private == Some(true)),
            (
                "eligibility",
                options.eligibility.as_ref().is_some_and(|v| !v.is_null()),
            ),
        ] {
            if refused {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("getTimeline: the {name} option is not supported by the rust engine"),
                ));
            }
        }
        no_nul("getTimeline", &[("slug", slug)])?;
        let limit = match options.limit {
            None | Some(0) => 100,
            Some(n) if n < 0 => {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    "LIMIT must not be negative",
                ));
            }
            Some(n) => usize::try_from(n).unwrap_or(usize::MAX),
        };
        let bound = |v: &Option<String>| -> Result<Option<String>> {
            match v.as_deref().filter(|s| !s.is_empty()) {
                Some(text) => parse_date(text).map(Some),
                None => Ok(None),
            }
        };
        let after = bound(&options.after)?;
        let before = bound(&options.before)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for source in scope_sources(&*read, &options.source_id, &options.source_ids)? {
            if let Some(page) = read_page(&*read, &source, slug)? {
                rows.extend(page_entries(
                    &*read,
                    page.id,
                    after.as_deref(),
                    before.as_deref(),
                    limit,
                )?);
            }
        }
        rows.sort_by(|a, b| (&b.date, b.id).cmp(&(&a.date, a.id)));
        rows.truncate(limit);
        Ok(rows.iter().map(TimelineRecord::to_json).collect())
    }
}

fn not_null(column: &str) -> StoreError {
    StoreError::new(
        crate::error::CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"timeline_entries\" violates not-null constraint"
        ),
    )
}

fn not_null_summary() -> StoreError {
    not_null("summary")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};

    fn page(store: &Store, slug: &str) -> u64 {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        read_page(&*store.read().unwrap(), DEFAULT_SOURCE, slug)
            .unwrap()
            .unwrap()
            .id
    }

    fn entry(id: u64, page_id: u64, date: &str, summary: &str, at: i64) -> TimelineRecord {
        TimelineRecord {
            id,
            page_id,
            date: date.into(),
            source: "s".into(),
            summary: summary.into(),
            detail: String::new(),
            event_page_id: None,
            created_at_us: at,
        }
    }

    fn entries(store: &Store, slug: &str) -> Vec<Value> {
        store
            .get_timeline(slug, &TimelineOptions::default())
            .unwrap()
    }

    #[test]
    fn put_entry_writes_reads_and_replaces_an_entry() {
        let store = crate::test_support::store();
        let a = page(&store, "a");
        let first = store
            .write(|tx| {
                let id = next_entry_id(tx)?;
                put_entry(tx, None, &entry(id, a, "2026-01-02", "one", 10))?;
                Ok(id)
            })
            .unwrap();
        let stored = read_entry(&*store.read().unwrap(), a, "2026-01-02", first)
            .unwrap()
            .unwrap();
        assert_eq!(stored.summary, "one");
        assert_eq!(entries(&store, "a").len(), 1);

        // Move the entry to another date and summary; the old keys go.
        let moved = entry(first, a, "2026-03-04", "two", 20);
        store
            .write(|tx| put_entry(tx, Some(&stored), &moved))
            .unwrap();
        let read = store.read().unwrap();
        assert!(
            read_entry(&*read, a, "2026-01-02", first)
                .unwrap()
                .is_none()
        );
        assert!(read.get(&stored.dedup_key()).unwrap().is_none());
        assert_eq!(
            read.get(&moved.dedup_key()).unwrap(),
            Some(first.to_be_bytes().to_vec())
        );
        assert_eq!(latest_entry_micros(&*read, a).unwrap(), Some(20));
        let listed = entries(&store, "a");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["summary"], "two");

        // An older created_at does not lower G.
        let older = entry(first, a, "2026-03-04", "two", 5);
        store
            .write(|tx| put_entry(tx, Some(&moved), &older))
            .unwrap();
        assert_eq!(
            latest_entry_micros(&*store.read().unwrap(), a).unwrap(),
            Some(20)
        );
    }

    #[test]
    fn put_entry_refuses_a_duplicate_and_keeps_nothing() {
        let store = crate::test_support::store();
        let a = page(&store, "a");
        let entry_input = TimelineInput {
            date: Some("2026-01-02".into()),
            source: Some("s".into()),
            summary: Some("one".into()),
            detail: None,
        };
        assert!(
            store
                .add_timeline_entry("a", &entry_input, &AddTimelineOptions::default())
                .unwrap()
        );
        let error = store
            .write(|tx| {
                let id = next_entry_id(tx)?;
                put_entry(tx, None, &entry(id, a, "2026-01-02", "one", 10))
            })
            .unwrap_err();
        assert_eq!(error.code, CONSTRAINT_VIOLATION);
        assert_eq!(entries(&store, "a").len(), 1);
    }

    #[test]
    fn put_entry_keeps_a_dedup_key_that_points_at_another_entry() {
        let store = crate::test_support::store();
        let a = page(&store, "a");
        let (x, y) = store
            .write(|tx| {
                let x = entry(next_entry_id(tx)?, a, "2026-01-02", "one", 10);
                put_entry(tx, None, &x)?;
                // `y` is a stale copy whose dedup key is `x`'s.
                let y = entry(next_entry_id(tx)?, a, "2026-01-02", "one", 10);
                Ok((x, y))
            })
            .unwrap();
        store
            .write(|tx| put_entry(tx, Some(&y), &entry(y.id, a, "2026-05-06", "other", 10)))
            .unwrap();
        let read = store.read().unwrap();
        assert_eq!(
            read.get(&x.dedup_key()).unwrap(),
            Some(x.id.to_be_bytes().to_vec())
        );
        assert_eq!(entries(&store, "a").len(), 2);
    }
}
