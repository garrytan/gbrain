//! Timeline reads by date (the Life Chronicle reads) and event projections.
//!
//! Members: getTimelineForDate, getSince, getOnThisDay, getLastSeen, upsertEventProjection,
//! removeTimelineRows, updateTimelineDetails, insertCanonicalTimelineRows. All eight are served.
//! The Life Chronicle projection row members (listEventProjectionRows, readEventProjectionId,
//! deleteEventProjections, restoreEventProjection) are `timeline_queries/event_rows.rs`. The
//! writes touch timeline entries only through the core helpers `timeline::{next_entry_id,
//! read_entry, put_entry, insert_entry, remove_entry, recompute_latest}`.
//!
//! What the reads mirror (src/core/engine-sql/timeline.ts): every timeline entry joined to its
//! page `p` (which must not be soft-deleted) and, when the entry is an event projection, LEFT
//! JOINed to its event page `ep`. The source scope (a non-empty `sourceIds` beats a non-empty
//! `sourceId`, which beats no scope) applies to `p` in the WHERE clause and to `ep` in the join:
//! an event page outside the scope reads as no event page (its slug, effective date and kind are
//! null), and the row stays. A soft-deleted event page in scope hides the row. An entry whose
//! event page no longer exists is skipped, as `ON DELETE CASCADE` would have removed it.
//!
//! `excludePrivate` carries the page policy the TypeScript member read from the rendered SQL
//! (`storePagePolicy`). Under it a row drops when the policy hides its depth page or its event
//! page (`page_hidden` in facts/privacy.rs); see [`joined_entries`].
//!
//! Keys: one record kind, the event index that stands in for the Postgres unique index
//! `idx_timeline_event_dedup` on `(event_page_id, date)`:
//!
//! `u 0x01 <event_page_id be8> <date YYYY-MM-DD>` -> `<page_id be8> <entry id be8>`
//!
//! The value names the entry's `E` key. A lookup reads that entry back and treats the index row
//! as absent when the entry is gone or no longer names the event page (a core write removed it,
//! for example the hard delete of its depth page). `remove_event_projections` deletes the entries
//! an event page's index rows name, with their `E` and `D` keys, when the event page is hard
//! deleted (`ON DELETE CASCADE`).
//!
//! The reads scan every timeline entry (`E`). A date index would need a write hook in the core
//! `addTimelineEntry` path, so it waits until speed needs it.

use std::collections::{BTreeSet, HashMap};

use crate::Store;
use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::sources::DEFAULT_SOURCE;
use crate::takes::{int4, not_null};
use crate::timeline::{
    TimelineReceipt, TimelineRecord, TimelineTrust, insert_entry, next_entry_id, parse_date,
    put_entry, read_entry, recompute_latest, remove_entry,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

mod event_rows;
mod redaction;
mod repair_reads;
mod site_reads;
mod twin_move;
pub use event_rows::{
    EventProjectionIdSpec, EventProjectionRestoreSpec, EventProjectionRowsSpec,
    EventProjectionSlugsSpec,
};
pub(crate) use redaction::{
    dedup_rows as redaction_dedup_rows, page_and_event_entries,
    rewrite_column as rewrite_timeline_column,
};
pub use repair_reads::{
    ConnectorFenceInput, TimelineHistoryInput, TimelineMarkupInput, TimelinePageScanInput,
    TimelineRowRewrite,
};
pub use site_reads::{
    DeleteTimelineRowsInput, SegmentedTimelineInput, TimelineOrphanInput, TimelineRowDeletion,
};
pub(crate) use twin_move::{move_twin_timeline, twin_timeline_reference};

const MICROS_PER_DAY: i64 = 86_400_000_000;
/// Second byte of an event index key.
const EVENT_INDEX: u8 = 0x01;
/// `timeline_entries.source` of an event projection: this prefix and the event slug.
const EVENT_SOURCE_PREFIX: &str = "life-chronicle:event:";

/// `upsertEventProjection(opts)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventProjectionInput {
    pub depth_slug: String,
    pub event_slug: String,
    pub date: String,
    pub summary: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
}

fn event_index_prefix(event_page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::TIMELINE_QUERIES, EVENT_INDEX];
    key.extend_from_slice(&event_page_id.to_be_bytes());
    key
}

fn event_index_key(event_page_id: u64, date: &str) -> Vec<u8> {
    let mut key = event_index_prefix(event_page_id);
    key.extend_from_slice(date.as_bytes());
    key
}

fn event_index_value(entry: &TimelineRecord) -> Vec<u8> {
    let mut value = entry.page_id.to_be_bytes().to_vec();
    value.extend_from_slice(&entry.id.to_be_bytes());
    value
}

/// The projection of `event_page_id` on `date` that an index value names, when that entry still
/// exists and still names the event page.
fn indexed_entry(
    read: &dyn KvRead,
    value: &[u8],
    event_page_id: u64,
    date: &str,
) -> Result<Option<TimelineRecord>> {
    if value.len() != 16 {
        return Ok(None);
    }
    let (Some(page_id), Some(id)) = (keys::be8(&value[..8]), keys::be8(&value[8..])) else {
        return Ok(None);
    };
    Ok(read_entry(read, page_id, date, id)?.filter(|e| e.event_page_id == Some(event_page_id)))
}

/// `ON DELETE CASCADE` of `timeline_entries.event_page_id`: deletes every timeline entry, on any
/// page, whose `event_page_id` is the page being hard deleted, with its `D` key (when it still
/// points at the entry) and its index row. `pages::remove_page` calls it in the same write
/// transaction. `G` is not lowered, as no core delete lowers it.
pub(crate) fn remove_event_projections(tx: &mut dyn KvWrite, event_page_id: u64) -> Result<()> {
    let prefix = event_index_prefix(event_page_id);
    let mut rows: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    scan_prefix(&*tx, &prefix, false, &mut |k, v| {
        rows.push((k.to_vec(), v.to_vec()));
        true
    })?;
    for (key, value) in rows {
        let date = String::from_utf8_lossy(&key[prefix.len()..]).into_owned();
        if let Some(entry) = indexed_entry(&*tx, &value, event_page_id, &date)? {
            crate::timeline::mark_entry_before_delete(tx, &entry)?;
            tx.delete(&keys::timeline(entry.page_id, &entry.date, entry.id))?;
            let dedup = entry.dedup_key();
            if tx.get(&dedup)?.and_then(|b| keys::be8(&b)) == Some(entry.id) {
                tx.delete(&dedup)?;
            }
        }
        tx.delete(&key)?;
    }
    Ok(())
}

/// One row of `removeTimelineRows`: the stored non-event row as it was read. A null field never
/// equals anything, so a row with one is never removed.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TimelineRowRemoval {
    pub id: Value,
    pub date: Option<String>,
    pub source: Option<String>,
    pub summary: Option<String>,
    pub detail: Option<String>,
    /// Handed back with the row's date; the store does not read it.
    pub removed: Option<bool>,
}

/// One row of `updateTimelineDetails`: the entry's detail preimage and the detail to write.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TimelineDetailRefresh {
    pub id: Value,
    pub detail: Option<String>,
    pub next: Option<String>,
}

/// One row of `insertCanonicalTimelineRows`: a timeline bullet of the page body.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CanonicalTimelineRow {
    pub date: Option<String>,
    pub source: Option<String>,
    pub summary: Option<String>,
    pub detail: Option<String>,
}

/// The page's own (no event page) entries by id: the scan the id-keyed writes search.
fn own_entries(read: &dyn KvRead, page_id: u64) -> Result<HashMap<u64, TimelineRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &keys::timeline_prefix(page_id), false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    let mut out = HashMap::new();
    for bytes in raw {
        let entry: TimelineRecord = serde_json::from_slice(&bytes)?;
        if entry.event_page_id.is_none() {
            out.insert(entry.id, entry);
        }
    }
    Ok(out)
}

/// A recordset `id integer` column: the entry id it names, or none when it is null or names no
/// possible entry (negative).
fn entry_id(value: &Value, op: &str) -> Result<Option<u64>> {
    Ok(int4(value, op, "id")?.and_then(|id| u64::try_from(id).ok()))
}

/// `ChronicleTimelineOpts` of `getTimelineForDate` and `getSince`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChronicleOptions {
    pub week: Option<bool>,
    pub kind: Option<String>,
    pub limit: Option<i64>,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`); null reads every row.
    pub exclude_private: Option<PrivacyPolicy>,
}

/// The options of `getOnThisDay`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OnThisDayOptions {
    pub date: Option<String>,
    pub limit: Option<i64>,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    /// `excludePrivate`, as in [`ChronicleOptions`].
    pub exclude_private: Option<PrivacyPolicy>,
}

/// The options of `getLastSeen`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LastSeenOptions {
    pub asof: Option<String>,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    /// `excludePrivate`, as in [`ChronicleOptions`].
    pub exclude_private: Option<PrivacyPolicy>,
}

/// One entry with its joined pages, as the chronicle reads see it.
struct Joined {
    entry: TimelineRecord,
    page_slug: String,
    /// The event page, when the entry has one inside the scope.
    event: Option<PageRecord>,
}

impl Joined {
    /// `COALESCE(ep.effective_date, te.date::timestamptz)`, in UTC microseconds.
    fn order_micros(&self) -> i64 {
        self.event
            .as_ref()
            .and_then(|ep| ep.effective_date_us)
            .unwrap_or_else(|| date_micros(&self.entry.date))
    }

    /// The `ChronicleTimelineRow`.
    fn to_row(&self) -> Value {
        let ep = self.event.as_ref();
        json!({
            "date": self.entry.date,
            "summary": self.entry.summary,
            "detail": self.entry.detail,
            "source": self.entry.source,
            "trust_tier": self.entry.trust.tier().as_str(),
            "page_id": self.entry.page_id,
            "page_slug": self.page_slug,
            "event_page_id": self.entry.event_page_id,
            "event_slug": ep.map(|p| p.slug.clone()),
            "effective_date": ep.and_then(|p| p.effective_date_us).map(timestamptz_text),
            "kind": ep.and_then(event_kind),
        })
    }
}

/// The source scope of a chronicle read: `None` reads every source.
fn scope(source_id: &Option<String>, source_ids: &Option<Vec<String>>) -> Option<BTreeSet<String>> {
    if let Some(ids) = source_ids.as_ref().filter(|ids| !ids.is_empty()) {
        return Some(ids.iter().cloned().collect());
    }
    source_id
        .as_ref()
        .filter(|id| !id.is_empty())
        .map(|id| BTreeSet::from([id.clone()]))
}

fn in_scope(scope: &Option<BTreeSet<String>>, page: &PageRecord) -> bool {
    scope
        .as_ref()
        .is_none_or(|ids| ids.contains(&page.source_id))
}

/// `LIMIT n`: `None` takes the member's default, a negative limit is the Postgres error.
fn limit_of(limit: Option<i64>, default: usize) -> Result<usize> {
    match limit {
        None => Ok(default),
        Some(n) if n < 0 => Err(StoreError::new(
            INVALID_ARGUMENT,
            "LIMIT must not be negative",
        )),
        Some(n) => Ok(usize::try_from(n).unwrap_or(usize::MAX)),
    }
}

/// Midnight UTC of a `YYYY-MM-DD` day.
fn date_micros(date: &str) -> i64 {
    parse_iso(&format!("{date}T00:00:00Z")).unwrap_or(0)
}

/// The `YYYY-MM-DD` day of a UTC instant.
fn day_of(micros: i64) -> String {
    iso(micros)[..10].to_string()
}

/// `timestamptz::text` with the session time zone UTC: `2026-06-18 09:00:00+00`, the fraction
/// of a second only when it is not zero, without trailing zeros.
pub(crate) fn timestamptz_text(micros: i64) -> String {
    let text = iso(micros);
    let (base, frac) = (&text[..19], &text[20..26]);
    let frac = frac.trim_end_matches('0');
    let base = base.replacen('T', " ", 1);
    if frac.is_empty() {
        format!("{base}+00")
    } else {
        format!("{base}.{frac}+00")
    }
}

/// The text form Postgres gives a `jsonb` value: `{"a": 1, "b": [1, 2]}`, object keys ordered
/// by length and then bytes, as jsonb stores them.
pub(crate) fn jsonb_text(value: &Value) -> String {
    let mut out = String::new();
    write_jsonb(value, &mut out);
    out
}

fn write_jsonb(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_jsonb(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| crate::jsonb::key_cmp(a, b));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push_str(": ");
                write_jsonb(&map[key], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// `->>`: a string's contents, any other value's jsonb text, and SQL NULL for JSON null.
pub(crate) fn jsonb_field_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// `frontmatter -> 'event'`.
fn event_of(frontmatter: &Map<String, Value>) -> Option<&Map<String, Value>> {
    frontmatter.get("event").and_then(Value::as_object)
}

/// `frontmatter -> 'event' ->> 'kind'`.
fn event_kind(page: &PageRecord) -> Option<String> {
    event_of(&page.frontmatter)
        .and_then(|event| event.get("kind"))
        .and_then(jsonb_field_text)
}

/// Whether the event page's `event.who` array names the entity: an element equal to the slug,
/// or holding the wikilink `[[slug]]` or `[[slug|label]]`. A `who` that is not an array names
/// nobody.
fn who_names(page: &PageRecord, slug: &str) -> bool {
    let Some(who) = event_of(&page.frontmatter)
        .and_then(|event| event.get("who"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    let exact = format!("[[{slug}]]");
    let labelled = format!("[[{slug}|");
    who.iter()
        .filter_map(jsonb_field_text)
        .any(|name| name == slug || name.contains(&exact) || name.contains(&labelled))
}

/// Every timeline entry that passes the shared join and filter of the chronicle reads, and the
/// `keep` predicate on the entry, in no particular order.
///
/// With a `policy` (`excludePrivate`), an entry drops when the policy hides its depth page
/// (`privatePagesFilterForCaller('p')`) or its event page (`privateTimelineEventFilterForCaller`,
/// an `EXISTS` on the event page by id: it judges the event page whatever its source or deleted
/// state, so an event page outside the scope still hides the row).
fn joined_entries(
    read: &dyn KvRead,
    scope: &Option<BTreeSet<String>>,
    policy: &Option<PrivacyPolicy>,
    keep: &dyn Fn(&TimelineRecord) -> bool,
) -> Result<Vec<Joined>> {
    let mut entries = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::TIMELINE], false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(entry) => {
                if keep(&entry) {
                    entries.push(entry);
                }
            }
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    if let Some(failure) = failure {
        return Err(failure);
    }
    let mut pages: HashMap<u64, Option<PageRecord>> = HashMap::new();
    let mut page = |id: u64| -> Result<Option<PageRecord>> {
        if let Some(found) = pages.get(&id) {
            return Ok(found.clone());
        }
        let found = read_page_by_id(read, id)?;
        pages.insert(id, found.clone());
        Ok(found)
    };
    let mut out = Vec::new();
    for entry in entries {
        let Some(depth) = page(entry.page_id)?.filter(|p| p.deleted_at_us.is_none()) else {
            continue;
        };
        if !in_scope(scope, &depth) {
            continue;
        }
        if let Some(policy) = policy
            && page_hidden(read, &depth, policy)?
        {
            continue;
        }
        let event = match entry.event_page_id {
            None => None,
            Some(id) => match page(id)? {
                // The cascade would have removed the entry with its event page.
                None => continue,
                Some(ep)
                    if policy
                        .as_ref()
                        .map(|p| page_hidden(read, &ep, p))
                        .transpose()?
                        == Some(true) =>
                {
                    continue;
                }
                Some(ep) if !in_scope(scope, &ep) => None,
                Some(ep) if ep.deleted_at_us.is_some() => continue,
                Some(ep) => Some(ep),
            },
        };
        out.push(Joined {
            entry,
            page_slug: depth.slug,
            event,
        });
    }
    Ok(out)
}

/// `ORDER BY COALESCE(ep.effective_date, te.date::timestamptz) ASC, te.id ASC LIMIT n`.
fn by_instant(mut rows: Vec<Joined>, limit: usize) -> Vec<Value> {
    rows.sort_by_key(|row| (row.order_micros(), row.entry.id));
    rows.iter().take(limit).map(Joined::to_row).collect()
}

/// `current_date` in UTC, or the `::date` cast of `date`.
fn target_day(store: &Store, date: &Option<String>) -> Result<String> {
    match date.as_deref().filter(|d| !d.is_empty()) {
        Some(text) => parse_date(text),
        None => Ok(day_of(store.env.now_micros())),
    }
}

impl Store {
    /// `getTimelineForDate(date, opts)`: the entries of one day, or of the ISO week (Monday to
    /// Sunday) that holds it when `week`, earliest first. `limit` defaults to 200.
    pub fn get_timeline_for_date(
        &self,
        date: &str,
        options: &ChronicleOptions,
    ) -> Result<Vec<Value>> {
        let day = parse_date(date)?;
        let limit = limit_of(options.limit, 200)?;
        let (lower, upper) = if options.week == Some(true) {
            let midnight = date_micros(&day);
            let days = midnight.div_euclid(MICROS_PER_DAY);
            // 1970-01-01 was a Thursday: three days after a Monday.
            let monday = midnight - (days + 3).rem_euclid(7) * MICROS_PER_DAY;
            (day_of(monday), day_of(monday + 6 * MICROS_PER_DAY))
        } else {
            (day.clone(), day)
        };
        let scope = scope(&options.source_id, &options.source_ids);
        let read = self.read()?;
        let rows = joined_entries(&*read, &scope, &options.exclude_private, &|e| {
            e.date.as_str() >= lower.as_str() && e.date.as_str() <= upper.as_str()
        })?;
        Ok(by_instant(rows, limit))
    }

    /// `getSince(date, opts)`: the entries on or after `date`, earliest first, only event
    /// projections whose event kind is `kind` when `kind` is set. `limit` defaults to 200.
    pub fn get_since(&self, date: &str, options: &ChronicleOptions) -> Result<Vec<Value>> {
        let day = parse_date(date)?;
        let limit = limit_of(options.limit, 200)?;
        let scope = scope(&options.source_id, &options.source_ids);
        let read = self.read()?;
        let mut rows = joined_entries(&*read, &scope, &options.exclude_private, &|e| {
            e.date.as_str() >= day.as_str()
        })?;
        if let Some(kind) = options.kind.as_deref().filter(|k| !k.is_empty()) {
            rows.retain(|row| {
                row.event
                    .as_ref()
                    .and_then(event_kind)
                    .is_some_and(|k| k == kind)
            });
        }
        Ok(by_instant(rows, limit))
    }

    /// `getOnThisDay(opts)`: the entries of earlier years on the month and day of `date`
    /// (today when absent), newest year first. `limit` defaults to 50.
    pub fn get_on_this_day(&self, options: &OnThisDayOptions) -> Result<Vec<Value>> {
        let target = target_day(self, &options.date)?;
        let limit = limit_of(options.limit, 50)?;
        let scope = scope(&options.source_id, &options.source_ids);
        let month_day = target[4..].to_string();
        let read = self.read()?;
        let mut rows = joined_entries(&*read, &scope, &options.exclude_private, &|e| {
            e.date[4..] == month_day[..] && e.date.as_str() < target.as_str()
        })?;
        // ORDER BY te.date DESC, te.id ASC.
        rows.sort_by(|a, b| {
            b.entry
                .date
                .cmp(&a.entry.date)
                .then(a.entry.id.cmp(&b.entry.id))
        });
        Ok(rows.iter().take(limit).map(Joined::to_row).collect())
    }

    /// `getLastSeen(entitySlug, opts)` before the day count: `{ last_date, last_event_slug }` of
    /// the newest entry on or before `asof` (today when absent) that is on the entity's own page
    /// or whose event page's `event.who` names it. Both are null when there is none.
    pub fn get_last_seen(&self, entity_slug: &str, options: &LastSeenOptions) -> Result<Value> {
        let through = target_day(self, &options.asof)?;
        let scope = scope(&options.source_id, &options.source_ids);
        let read = self.read()?;
        let rows = joined_entries(&*read, &scope, &options.exclude_private, &|e| {
            e.date.as_str() <= through.as_str()
        })?;
        // ORDER BY te.date DESC, COALESCE(ep.effective_date, te.date) DESC, te.id DESC LIMIT 1.
        let newest = rows
            .iter()
            .filter(|row| {
                row.page_slug == entity_slug
                    || row
                        .event
                        .as_ref()
                        .is_some_and(|ep| who_names(ep, entity_slug))
            })
            .max_by(|a, b| {
                (&a.entry.date, a.order_micros(), a.entry.id).cmp(&(
                    &b.entry.date,
                    b.order_micros(),
                    b.entry.id,
                ))
            });
        Ok(match newest {
            Some(row) => json!({
                "last_date": row.entry.date,
                "last_event_slug": row.event.as_ref().map(|ep| ep.slug.clone()),
            }),
            None => json!({ "last_date": null, "last_event_slug": null }),
        })
    }

    /// `upsertEventProjection({ depthSlug, eventSlug, date, summary, detail?, sourceId? })`:
    /// `INSERT ... SELECT` from the depth and event pages of one source (default `default`;
    /// soft-deleted pages count) `ON CONFLICT (event_page_id, date) DO UPDATE` of summary,
    /// detail, page and source. `{ projected: false }` when either page is missing; a bad date
    /// fails first. The serial is taken whenever both pages exist, the conflict path included,
    /// and the update keeps the entry's id and `created_at`. A new or updated entry whose
    /// `(page, date, summary, source)` matches another entry is `constraint_violation`.
    pub fn upsert_event_projection(&self, input: &EventProjectionInput) -> Result<Value> {
        let source_id = input.source_id.as_deref().unwrap_or(DEFAULT_SOURCE);
        let detail = input.detail.as_deref().unwrap_or("");
        no_nul(
            "upsertEventProjection",
            &[
                ("depthSlug", &input.depth_slug),
                ("eventSlug", &input.event_slug),
                ("summary", &input.summary),
                ("detail", detail),
                ("sourceId", source_id),
            ],
        )?;
        let date = parse_date(&input.date)?;
        let source = format!("{EVENT_SOURCE_PREFIX}{}", input.event_slug);
        let now = self.env.now_micros();
        self.write(|tx| {
            let depth = read_page(&*tx, source_id, &input.depth_slug)?;
            let event = read_page(&*tx, source_id, &input.event_slug)?;
            let (Some(depth), Some(event)) = (depth, event) else {
                return Ok(json!({ "projected": false }));
            };
            let id = next_entry_id(tx)?;
            event_rows::put_event_projection(
                tx,
                depth.id,
                event.id,
                &date,
                &source,
                &input.summary,
                detail,
                id,
                now,
            )?;
            Ok(json!({ "projected": true }))
        })
    }

    /// `removeTimelineRows(pageId, rows)`: deletes the page's own entries (never an event
    /// projection) that a row names by id and that still equal it in date, source, summary and
    /// detail; a null field matches nothing. Returns `[{ date, removed }]` for each deleted row,
    /// in the order of `rows` (a row named twice is deleted, and returned, once). Every date is
    /// read as a date before any row is touched, so a bad one fails the whole call. Each delete
    /// removes the entry's `D` key when it still points at it, and `G` is recomputed after.
    pub fn remove_timeline_rows(&self, page_id: i64, rows: &[TimelineRowRemoval]) -> Result<Value> {
        const OP: &str = "removeTimelineRows";
        let mut asked = Vec::with_capacity(rows.len());
        for row in rows {
            let date = row.date.as_deref().map(parse_date).transpose()?;
            let id = entry_id(&row.id, OP)?;
            no_nul(
                OP,
                &[
                    ("source", row.source.as_deref().unwrap_or("")),
                    ("summary", row.summary.as_deref().unwrap_or("")),
                    ("detail", row.detail.as_deref().unwrap_or("")),
                ],
            )?;
            asked.push((id, date, row));
        }
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(json!([]));
        };
        if asked.is_empty() {
            return Ok(json!([]));
        }
        self.write(|tx| {
            let own = own_entries(&*tx, page_id)?;
            let mut gone = BTreeSet::new();
            let mut out = Vec::new();
            for (id, date, row) in asked.clone() {
                let Some(entry) = id.and_then(|id| own.get(&id)) else {
                    continue;
                };
                let same = date.as_deref() == Some(entry.date.as_str())
                    && row.source.as_deref() == Some(entry.source.as_str())
                    && row.summary.as_deref() == Some(entry.summary.as_str())
                    && row.detail.as_deref() == Some(entry.detail.as_str());
                if !same || !gone.insert(entry.id) {
                    continue;
                }
                remove_entry(tx, entry)?;
                out.push(json!({ "date": entry.date, "removed": row.removed }));
            }
            if !gone.is_empty() {
                recompute_latest(tx, page_id)?;
            }
            Ok(Value::Array(out))
        })
    }

    /// `updateTimelineDetails(pageId, rows)`: sets `detail` to `next` on the page's own entries
    /// (never an event projection) a row names by id while the stored detail still equals the
    /// row's `detail` (a null one matches nothing). A row named twice applies once, the first.
    /// A null `next` on a matching row is `constraint_violation` (the column is `NOT NULL`) and
    /// the call writes nothing. The entry keeps its id, date, source, summary and `created_at`.
    pub fn update_timeline_details(
        &self,
        page_id: i64,
        rows: &[TimelineDetailRefresh],
    ) -> Result<()> {
        const OP: &str = "updateTimelineDetails";
        let mut asked = Vec::with_capacity(rows.len());
        for row in rows {
            let id = entry_id(&row.id, OP)?;
            no_nul(
                OP,
                &[
                    ("detail", row.detail.as_deref().unwrap_or("")),
                    ("next", row.next.as_deref().unwrap_or("")),
                ],
            )?;
            asked.push((id, row));
        }
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(());
        };
        if asked.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            let own = own_entries(&*tx, page_id)?;
            let mut done = BTreeSet::new();
            for (id, row) in asked.clone() {
                let Some(entry) = id.and_then(|id| own.get(&id)) else {
                    continue;
                };
                if row.detail.as_deref() != Some(entry.detail.as_str()) || !done.insert(entry.id) {
                    continue;
                }
                let Some(next) = &row.next else {
                    return Err(not_null("timeline_entries", "detail"));
                };
                let new = TimelineRecord {
                    detail: next.clone(),
                    ..entry.clone()
                };
                put_entry(tx, Some(entry), &new)?;
            }
            Ok(())
        })
    }

    /// `insertCanonicalTimelineRows(pageId, rows)`: inserts the rows as the page's own entries,
    /// in order, as `INSERT .. ON CONFLICT (page_id, date, md5(summary), source) DO NOTHING`
    /// does: a row equal to a stored entry of the page (or to an earlier row of the call) on date,
    /// summary and source is skipped, and still takes an id. The page may be soft-deleted; a
    /// missing page is `constraint_violation` (the foreign key). A null column is
    /// `constraint_violation` (`NOT NULL`), a bad date `invalid_argument`; either writes nothing.
    pub fn insert_canonical_timeline_rows(
        &self,
        page_id: i64,
        rows: &[CanonicalTimelineRow],
    ) -> Result<()> {
        const OP: &str = "insertCanonicalTimelineRows";
        let mut asked = Vec::with_capacity(rows.len());
        for row in rows {
            let column = |name: &str, value: &Option<String>| -> Result<String> {
                let text = value
                    .clone()
                    .ok_or_else(|| not_null("timeline_entries", name))?;
                no_nul(OP, &[(name, text.as_str())])?;
                Ok(text)
            };
            let date = parse_date(&column("date", &row.date)?)?;
            let (source, summary, detail) = (
                column("source", &row.source)?,
                column("summary", &row.summary)?,
                column("detail", &row.detail)?,
            );
            asked.push((date, source, summary, detail));
        }
        if asked.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            let page = u64::try_from(page_id)
                .ok()
                .map(|id| read_page_by_id(&*tx, id))
                .transpose()?
                .flatten()
                .ok_or_else(|| {
                    StoreError::new(
                        CONSTRAINT_VIOLATION,
                        "insert or update on table \"timeline_entries\" violates foreign key constraint \"timeline_entries_page_id_fkey\"",
                    )
                })?;
            let now = self.env.now_micros();
            for (date, source, summary, detail) in asked.clone() {
                let record = TimelineRecord {
                    id: 0,
                    page_id: page.id,
                    date,
                    source,
                    summary,
                    detail,
                    event_page_id: None,
                    created_at_us: now,
                    receipt: TimelineReceipt::default(),
                    trust: TimelineTrust::default(),
                };
                insert_entry(tx, record)?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamptz_text_trims_the_fraction() {
        let at = parse_iso("2026-06-18T09:00:00Z").unwrap();
        assert_eq!(timestamptz_text(at), "2026-06-18 09:00:00+00");
        assert_eq!(timestamptz_text(at + 500_000), "2026-06-18 09:00:00.5+00");
        assert_eq!(
            timestamptz_text(at + 123_456),
            "2026-06-18 09:00:00.123456+00"
        );
        assert_eq!(timestamptz_text(at + 120), "2026-06-18 09:00:00.00012+00");
    }

    #[test]
    fn jsonb_text_orders_keys_by_length_then_bytes() {
        let value = json!({"bb": 1, "a": [1, "x", null], "c": {"zz": true, "y": false}});
        assert_eq!(
            jsonb_text(&value),
            r#"{"a": [1, "x", null], "c": {"y": false, "zz": true}, "bb": 1}"#
        );
        assert_eq!(jsonb_field_text(&json!("plain")), Some("plain".into()));
        assert_eq!(jsonb_field_text(&json!(null)), None);
        assert_eq!(jsonb_field_text(&json!(2.5)), Some("2.5".into()));
    }

    #[test]
    fn limits_follow_postgres() {
        assert_eq!(limit_of(None, 200).unwrap(), 200);
        assert_eq!(limit_of(Some(0), 200).unwrap(), 0);
        assert_eq!(limit_of(Some(3), 200).unwrap(), 3);
        assert_eq!(limit_of(Some(-1), 200).unwrap_err().code, INVALID_ARGUMENT);
    }

    #[test]
    fn scope_prefers_a_non_empty_list() {
        let list = Some(vec!["a".to_string(), "b".to_string()]);
        assert_eq!(scope(&Some("c".into()), &list).unwrap().len(), 2);
        assert_eq!(
            scope(&Some("c".into()), &Some(vec![])).unwrap(),
            BTreeSet::from(["c".to_string()])
        );
        assert!(scope(&Some(String::new()), &None).is_none());
    }
}
