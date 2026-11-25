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
//!
//! Write receipts and trust: every entry written through [`insert_entry`] or [`put_entry`] is
//! stamped with the write's actor, as the PGLite attribution trigger stamps it (`receipt.rs`), and
//! with its trust tier and write origin, as the `trust_tier_stamp` trigger stamps them (`tier.rs`).

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::{KvRead, KvWrite, prefix_end, scan_prefix};
use crate::links::{missing, no_nul};
use crate::pages::{PageRecord, clean, next_id, read_page, read_page_by_id, scope_sources};
use crate::sources::DEFAULT_SOURCE;
use crate::trust::TrustPolicy;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

mod held;
mod receipt;
mod tier;
pub(crate) use crate::write_receipt::WriteReceipt as TimelineReceipt;
pub use held::HeldTimelineSpec;
pub(crate) use tier::TimelineTrust;

pub(crate) const NEXT_TIMELINE_ID: &str = "next_timeline_id";

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
    /// The write receipt. Absent in a record stored before it, and omitted while every column is null.
    #[serde(default, skip_serializing_if = "TimelineReceipt::is_empty")]
    pub receipt: TimelineReceipt,
    /// `trust_tier` and `write_origin`. Absent in a record stored before them, and omitted while the
    /// tier is `unknown` with no origin.
    #[serde(default, skip_serializing_if = "TimelineTrust::is_empty")]
    pub trust: TimelineTrust,
}

impl TimelineRecord {
    pub(crate) fn dedup_key(&self) -> Vec<u8> {
        let digest: [u8; 32] = Sha256::digest(self.summary.as_bytes()).into();
        keys::timeline_dedup(self.page_id, &self.date, &digest, &self.source)
    }

    /// The `TimelineEntry` row with its trust and receipt columns. `date` stays `YYYY-MM-DD`;
    /// `created_at` and `last_written_at` are ISO strings.
    pub(crate) fn to_json(&self) -> Value {
        let mut row = json!({
            "id": self.id,
            "page_id": self.page_id,
            "date": self.date,
            "source": self.source,
            "summary": self.summary,
            "detail": self.detail,
            "event_page_id": self.event_page_id,
            "created_at": iso(self.created_at_us),
        });
        if let Value::Object(map) = &mut row {
            self.trust.extend_json(map);
            self.receipt.extend_json(map);
        }
        row
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
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`) the TypeScript member
    /// reads from the rendered SQL; null reads every row.
    pub exclude_private: Option<PrivacyPolicy>,
    /// A read-eligibility policy was given (`eligibility`): hide the rows `projectionEligibleSql`
    /// always hides.
    pub eligible_only: bool,
    /// The policy's `floor`: hide a row whose stored tier is below it (`trustFloorSql`).
    pub min_trust: Option<String>,
    /// The policy's `suppressFlagged`: hide an agent-written-or-lower row with an activation flag
    /// receipt (`activationSuppressedSql('timeline_entries', ..)`).
    pub suppress_flagged: bool,
    /// A raw `eligibility` value is refused; the TypeScript member sends `eligibleOnly` instead.
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
pub(crate) fn insert_entry(tx: &mut dyn KvWrite, mut record: TimelineRecord) -> Result<bool> {
    let dedup = record.dedup_key();
    record.id = next_id(tx, NEXT_TIMELINE_ID)?;
    if tx.get(&dedup)?.is_some() {
        return Ok(false);
    }
    let record = receipt::stamp(None, &tier::stamp(None, &record)?)?;
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

/// The shadow follow (`seed/follow.rs`): removes the entry `id` of `page_id` on `date`, with its
/// dedup key, and sets the page's newest `created_at` to what the remaining entries hold. `false`
/// when there is no such entry.
pub(crate) fn remove_entry_by_id(
    tx: &mut dyn KvWrite,
    page_id: u64,
    date: &str,
    id: u64,
) -> Result<bool> {
    let Some(old) = crate::get_json::<TimelineRecord>(&*tx, &keys::timeline(page_id, date, id))?
    else {
        return Ok(false);
    };
    // The shadow follow copies the primary's marks, so this delete writes none.
    remove_entry_unmarked(tx, &old)?;
    recompute_latest(tx, page_id)?;
    Ok(true)
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
/// Writes `new`'s `E` and `D` keys and raises `G` of `new.page_id`; this path never lowers `G`.
/// `new` is stored with its trust and write receipt stamped (`tier::stamp`, `receipt::stamp`; `old`
/// is the update's preimage).
/// One exception lowers it: `deleteTimelineRows` (timeline_queries/site_reads.rs `reset_latest`)
/// resets `G` to the newest `created_at` of the rows left, or deletes it when no row is left. On a
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
    let new = &receipt::stamp(old, &tier::stamp(old, new)?)?;
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

/// Deletes one entry: its `E` key, and its `D` key when that still points at the entry (a later
/// entry that took the dedup slot keeps it). The page's `G` is not touched; call
/// `recompute_latest` once after the deletes of one statement. Before it goes, an owner-only entry
/// (by its own lineage or its page's) marks what was derived from it (v322's trigger on
/// `timeline_entries`).
pub(crate) fn remove_entry(tx: &mut dyn KvWrite, entry: &TimelineRecord) -> Result<()> {
    mark_entry_before_delete(tx, entry)?;
    remove_entry_unmarked(tx, entry)
}

/// `owner_only_marks::mark_row_before_delete` for one timeline entry.
pub(crate) fn mark_entry_before_delete(tx: &mut dyn KvWrite, entry: &TimelineRecord) -> Result<()> {
    crate::owner_only_marks::mark_row_before_delete(
        tx,
        "timeline_entries",
        entry.id,
        None,
        Some(entry.page_id),
    )
}

/// [`remove_entry`] without the owner-only mark (the shadow follow copies the primary's marks).
fn remove_entry_unmarked(tx: &mut dyn KvWrite, entry: &TimelineRecord) -> Result<()> {
    tx.delete(&keys::timeline(entry.page_id, &entry.date, entry.id))?;
    let dedup = entry.dedup_key();
    if tx.get(&dedup)?.and_then(|b| keys::be8(&b)) == Some(entry.id) {
        tx.delete(&dedup)?;
    }
    Ok(())
}

/// Sets `G page_id` to the newest `created_at` of the entries the page still has (event
/// projections included), and deletes it when none is left: after a delete the `stale` flag of
/// keyword search must compare with the rows that exist, as `max(created_at)` does.
pub(crate) fn recompute_latest(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    let mut newest: Option<i64> = None;
    let mut bad = None;
    scan_prefix(&*tx, &keys::timeline_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(e) => newest = Some(newest.map_or(e.created_at_us, |n| n.max(e.created_at_us))),
            Err(e) => bad = Some(StoreError::from(e)),
        }
        bad.is_none()
    })?;
    if let Some(e) = bad {
        return Err(e);
    }
    let latest = keys::timeline_latest(page_id);
    match newest {
        Some(us) => tx.put(&latest, &us.to_be_bytes()),
        None => tx.delete(&latest),
    }
}

/// `ON DELETE CASCADE` of `timeline_entries.page_id`. Each entry is marked first when it is
/// owner-only, as the cascade fires v322's row trigger on every entry it deletes.
pub(crate) fn remove_page_timeline(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    for entry in crate::owner_only_marks::timeline_rows(&*tx, Some(page_id))? {
        mark_entry_before_delete(tx, &entry)?;
    }
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

/// `privateTimelineEventFilterForCaller(te)`: an entry with no event page passes. Otherwise its
/// event page, read by id whatever its source or deleted state (the SQL is an `EXISTS` on the id
/// alone), must exist and pass the page policy.
pub(crate) fn event_visible(
    read: &dyn KvRead,
    entry: &TimelineRecord,
    policy: &PrivacyPolicy,
) -> Result<bool> {
    let Some(id) = entry.event_page_id else {
        return Ok(true);
    };
    match read_page_by_id(read, id)? {
        None => Ok(false),
        Some(event) => Ok(!page_hidden(read, &event, policy)?),
    }
}

/// The entries of one page that `keep` accepts, newest first, inside `[after, before]`, at most
/// `limit`. The filter runs before the limit, as a SQL `WHERE` does.
fn page_entries(
    read: &dyn KvRead,
    page_id: u64,
    after: Option<&str>,
    before: Option<&str>,
    limit: usize,
    keep: &dyn Fn(&TimelineRecord) -> Result<bool>,
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
    let mut rows = Vec::new();
    let mut failure = None;
    if limit > 0 && start < end {
        read.scan(&start, &end, true, &mut |_, v| {
            let step = serde_json::from_slice::<TimelineRecord>(v)
                .map_err(StoreError::from)
                .and_then(|row| Ok(if keep(&row)? { Some(row) } else { None }));
            match step {
                Ok(Some(row)) => rows.push(row),
                Ok(None) => {}
                Err(error) => {
                    failure = Some(error);
                    return false;
                }
            }
            rows.len() < limit
        })?;
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(rows),
    }
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
            let Some(date) = date.clone() else {
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
                    receipt: TimelineReceipt::default(),
                    trust: TimelineTrust::default(),
                },
            )
        })
    }

    /// `readNewestTimelineEntryId(sourceId, slug, date, summary)`: the id of the newest entry of the
    /// page (deleted or not) on `date` whose summary is `summary`, event rows included; null when
    /// the page or such an entry is missing. A bad date fails, as the `$3::date` cast does.
    pub fn read_newest_timeline_entry_id(
        &self,
        source_id: &str,
        slug: &str,
        date: &str,
        summary: &str,
    ) -> Result<Option<u64>> {
        no_nul(
            "readNewestTimelineEntryId",
            &[
                ("sourceId", source_id),
                ("slug", slug),
                ("summary", summary),
            ],
        )?;
        let date = parse_date(date)?;
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)? else {
            return Ok(None);
        };
        let rows = page_entries(&*read, page.id, Some(&date), Some(&date), 1, &|row| {
            Ok(row.summary == summary)
        })?;
        Ok(rows.first().map(|row| row.id))
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
                    receipt: TimelineReceipt::default(),
                    trust: TimelineTrust::default(),
                };
                if insert_entry(tx, record)? {
                    inserted += 1;
                }
            }
            Ok(inserted)
        })
    }

    /// `getTimeline(slug, opts)`: newest first (`date DESC, id DESC`), `limit` rows (0 or absent
    /// means 100). Soft-deleted pages keep their timeline readable, as in PGLite. Under
    /// `excludePrivate` a page the policy hides reads no rows (`privatePagesFilterForCaller(p)`),
    /// and an entry drops when its event page is hidden ([`event_visible`]).
    pub fn get_timeline(&self, slug: &str, options: &TimelineOptions) -> Result<Vec<Value>> {
        if options.eligibility.as_ref().is_some_and(|v| !v.is_null()) {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                "getTimeline: the eligibility option is not supported by the rust engine",
            ));
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
        let trust = TrustPolicy::parse(options.min_trust.as_deref(), options.suppress_flagged)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for source in scope_sources(&*read, &options.source_id, &options.source_ids)? {
            if let Some(page) = read_page(&*read, &source, slug)?
                && page_visible(&*read, &page, &options.exclude_private)?
                && (!options.eligible_only || eligible_page(&page))
            {
                let keep = |row: &TimelineRecord| -> Result<bool> {
                    if !trust.admits(&*read, "timeline_entries", row.id, row.trust.tier())?
                        || (options.eligible_only
                            && crate::generations::needs_rederive::is_marked(
                                &*read,
                                "timeline_entries",
                                row.id,
                            )?)
                    {
                        return Ok(false);
                    }
                    match &options.exclude_private {
                        Some(policy) => event_visible(&*read, row, policy),
                        None => Ok(true),
                    }
                };
                rows.extend(page_entries(
                    &*read,
                    page.id,
                    after.as_deref(),
                    before.as_deref(),
                    limit,
                    &keep,
                )?);
            }
        }
        rows.sort_by(|a, b| (&b.date, b.id).cmp(&(&a.date, a.id)));
        rows.truncate(limit);
        Ok(rows.iter().map(TimelineRecord::to_json).collect())
    }
}

/// The page part of `projectionEligibleSql('timeline_entries', 'te', ..)` (the row part, `floor`
/// and `suppressFlagged`, is the `TrustPolicy` of `get_timeline`). Every row of `getTimeline` hangs on `page` (`te.page_id = p.id`), so a
/// soft-deleted page, or a page whose frontmatter has a `quarantine` key (any value), hides all of its
/// rows. The third clause, a row a purge marked in `needs_rederive` (`generations/needs_rederive.rs`),
/// is checked per row by `get_timeline`.
pub(crate) fn eligible_page(page: &PageRecord) -> bool {
    page.deleted_at_us.is_none() && !page.frontmatter.contains_key("quarantine")
}

/// Whether the page policy, when there is one, lets `page` read.
fn page_visible(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &Option<PrivacyPolicy>,
) -> Result<bool> {
    match policy {
        Some(policy) => Ok(!page_hidden(read, page, policy)?),
        None => Ok(true),
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
            receipt: TimelineReceipt::default(),
            trust: TimelineTrust::default(),
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

    #[test]
    fn remove_entry_keeps_a_dedup_key_that_points_elsewhere_and_recompute_follows_the_rows() {
        let store = crate::test_support::store();
        let a = page(&store, "a");
        let (x, y) = store
            .write(|tx| {
                let x = entry(next_entry_id(tx)?, a, "2026-01-02", "one", 10);
                put_entry(tx, None, &x)?;
                let y = entry(next_entry_id(tx)?, a, "2026-03-04", "two", 30);
                put_entry(tx, None, &y)?;
                Ok((x, y))
            })
            .unwrap();
        // Another entry took x's dedup slot: removing x leaves the slot with its owner.
        store
            .write(|tx| {
                tx.put(&x.dedup_key(), &y.id.to_be_bytes())?;
                remove_entry(tx, &x)?;
                recompute_latest(tx, a)
            })
            .unwrap();
        let read = store.read().unwrap();
        assert!(read_entry(&*read, a, "2026-01-02", x.id).unwrap().is_none());
        assert_eq!(
            read.get(&x.dedup_key()).unwrap(),
            Some(y.id.to_be_bytes().to_vec())
        );
        assert_eq!(latest_entry_micros(&*read, a).unwrap(), Some(30));
        drop(read);

        // The newest entry goes: G falls back to the newest row that is left, then disappears.
        let z = store
            .write(|tx| {
                let z = entry(next_entry_id(tx)?, a, "2026-05-06", "three", 20);
                put_entry(tx, None, &z)?;
                remove_entry(tx, &y)?;
                recompute_latest(tx, a)?;
                Ok(z)
            })
            .unwrap();
        let read = store.read().unwrap();
        assert!(read.get(&y.dedup_key()).unwrap().is_none());
        assert_eq!(latest_entry_micros(&*read, a).unwrap(), Some(20));
        drop(read);
        store
            .write(|tx| {
                remove_entry(tx, &z)?;
                recompute_latest(tx, a)
            })
            .unwrap();
        assert_eq!(
            latest_entry_micros(&*store.read().unwrap(), a).unwrap(),
            None
        );
    }

    #[test]
    fn exclude_private_hides_a_private_page_and_an_entry_whose_event_page_in_another_source_is_private()
     {
        let store = crate::test_support::store();
        let alt: crate::sources::SourceInput =
            serde_json::from_value(json!({"id": "alt", "name": "alt"})).unwrap();
        store.upsert_source(&alt).unwrap();
        let put = |slug: &str, source: &str, frontmatter: Value| -> u64 {
            let input: PageInput = serde_json::from_value(json!({
                "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter,
            }))
            .unwrap();
            let options: PutPageOptions =
                serde_json::from_value(json!({"sourceId": source})).unwrap();
            store.put_page(slug, &input, &options).unwrap()["id"]
                .as_u64()
                .unwrap()
        };
        let depth = put("people/a", "default", json!({}));
        let private = put("people/b", "default", json!({"visibility": "private"}));
        let foreign_private = put("events/x", "alt", json!({"visibility": "private"}));
        let foreign_open = put("events/y", "alt", json!({}));
        store
            .write(|tx| {
                for (page_id, event, date, summary) in [
                    (depth, None, "2026-01-01", "plain"),
                    (
                        depth,
                        Some(foreign_private),
                        "2026-01-02",
                        "foreign private event",
                    ),
                    (
                        depth,
                        Some(foreign_open),
                        "2026-01-03",
                        "foreign open event",
                    ),
                    (depth, Some(999_999), "2026-01-04", "missing event page"),
                    (private, None, "2026-01-01", "private page"),
                ] {
                    let id = next_entry_id(tx)?;
                    let mut row = entry(id, page_id, date, summary, 1);
                    row.event_page_id = event;
                    put_entry(tx, None, &row)?;
                }
                Ok(())
            })
            .unwrap();
        let summaries = |slug: &str, options: Value| -> Vec<Value> {
            let options: TimelineOptions = serde_json::from_value(options).unwrap();
            store
                .get_timeline(slug, &options)
                .unwrap()
                .iter()
                .map(|row| row["summary"].clone())
                .collect()
        };
        let policy = json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn"});
        assert_eq!(summaries("people/a", json!({})).len(), 4);
        // The event page is judged by id: a read scoped to `default` still hides the private event
        // page in `alt`, and an entry whose event page is gone fails the EXISTS.
        for options in [
            json!({"excludePrivate": policy}),
            json!({"sourceId": "default", "excludePrivate": policy}),
        ] {
            assert_eq!(
                summaries("people/a", options),
                vec![json!("foreign open event"), json!("plain")]
            );
        }
        // The filter runs before the limit.
        assert_eq!(
            summaries("people/a", json!({"limit": 1, "excludePrivate": policy})),
            vec![json!("foreign open event")]
        );
        assert_eq!(summaries("people/b", json!({})).len(), 1);
        assert!(summaries("people/b", json!({"excludePrivate": policy})).is_empty());
        // Eligibility still refuses.
        let options: TimelineOptions =
            serde_json::from_value(json!({"eligibility": {"x": 1}})).unwrap();
        assert!(store.get_timeline("people/a", &options).is_err());
    }

    #[test]
    fn eligible_only_hides_the_rows_of_a_soft_deleted_or_quarantined_page() {
        let store = crate::test_support::store();
        let put = |slug: &str, frontmatter: Value| -> u64 {
            let input: PageInput = serde_json::from_value(json!({
                "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter,
            }))
            .unwrap();
            store
                .put_page(slug, &input, &PutPageOptions::default())
                .unwrap()["id"]
                .as_u64()
                .unwrap()
        };
        let open = put("people/open", json!({}));
        let gone = put("people/gone", json!({}));
        let held = put("people/held", json!({"quarantine": false}));
        store
            .write(|tx| {
                for (page_id, summary) in [(open, "open"), (gone, "gone"), (held, "held")] {
                    let id = next_entry_id(tx)?;
                    put_entry(tx, None, &entry(id, page_id, "2026-01-01", summary, 1))?;
                }
                Ok(())
            })
            .unwrap();
        store.soft_delete_page("people/gone", None).unwrap();
        let count = |slug: &str, eligible_only: bool| -> usize {
            let options: TimelineOptions =
                serde_json::from_value(json!({"eligibleOnly": eligible_only})).unwrap();
            store.get_timeline(slug, &options).unwrap().len()
        };
        for slug in ["people/open", "people/gone", "people/held"] {
            assert_eq!(count(slug, false), 1, "{slug}");
        }
        assert_eq!(count("people/open", true), 1);
        assert_eq!(count("people/gone", true), 0);
        assert_eq!(count("people/held", true), 0);
    }
}
