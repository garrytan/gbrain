//! The page projection queue (Postgres `page_projection_jobs`): one job per page whose text
//! projection is behind its knowledge revision, and the two housekeeping reads over it
//! (`listPendingSegmentedProjections`, `selectProjectionWindowJobs` of
//! `src/core/engine-sql/persistence-housekeeping.ts`).
//!
//! Key `d 0x04 <source incarnation> 0x00 <slug>`, JSON `JobRecord`. An incarnation is the 36-byte
//! lower-case UUID text, so key order is `(source_incarnation, slug)` order: UUID text order is
//! Postgres's UUID order, and the slug compares by bytes (the C collation).
//!
//! `queue_page_projection` keeps the queue in step with every page write as PGLite's
//! `gbrain_queue_page_projection` trigger does. It is the only writer here: the other writers of a
//! job's `reason` (`segmented_projecting`, `rebuild_failed`, `chunk_replacement_continuing`) are
//! raw SQL the Rust engine refuses, so every job here has reason `canonical_change`. The reads
//! still apply the full reason filters. A source delete removes each page first
//! (`cascade.rs`), and the hook removes the page's job, so no job outlives its source.

use super::{QUEUE, uuid_param};
use crate::env::{Env, parse_iso, transaction_clock};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, read_page};
use crate::sources::{SourceRecord, all_sources, read_source};
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

/// The reason the trigger writes.
const CANONICAL_CHANGE: &str = "canonical_change";
/// `SEGMENTED_PROJECTION_CLAIMED`'s and `chunk_replacement_continuing`'s 60 seconds.
const CLAIM_US: i64 = 60_000_000;
/// `PROJECTION_RETRY_READY`'s `rebuild_failed` cooldown, 30 seconds.
const RETRY_US: i64 = 30_000_000;
/// The window's recency lane: `updated_at > mark - interval '10 minutes'`.
const RECENT_US: i64 = 600_000_000;
/// The window's row budgets (`residentWindowCtes`).
const RECENT_LIMIT: usize = 100;
const WINDOW_LIMIT: usize = 400;

/// One `page_projection_jobs` row; the key holds `source_incarnation` and `slug`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct JobRecord {
    pub revision: String,
    pub reason: String,
    pub updated_at_us: i64,
}

/// A job with its key fields.
#[derive(Debug, Clone)]
struct Job {
    incarnation: String,
    slug: String,
    record: JobRecord,
}

fn prefix() -> [u8; 2] {
    [keys::PERSISTENCE, QUEUE]
}

fn job_key(incarnation: &str, slug: &str) -> Vec<u8> {
    let mut key = prefix().to_vec();
    key.extend_from_slice(incarnation.as_bytes());
    key.push(0);
    key.extend_from_slice(slug.as_bytes());
    key
}

fn incarnation_of(read: &dyn KvRead, source_id: &str) -> Result<String> {
    read_source(read, source_id)?
        .map(|s| s.incarnation)
        .ok_or_else(|| StoreError::invalid(format!("page source {source_id} does not exist")))
}

/// `gbrain_queue_page_projection` for one page write (`page_projection::queue_page_projection`).
pub(crate) fn queue_page_projection(
    tx: &mut dyn KvWrite,
    before: Option<&PageRecord>,
    after: Option<&PageRecord>,
) -> Result<()> {
    let Some(after) = after else {
        // DELETE: the job of the old key goes.
        if let Some(before) = before {
            let key = job_key(&incarnation_of(&*tx, &before.source_id)?, &before.slug);
            tx.delete(&key)?;
        }
        return Ok(());
    };
    if let Some(before) = before
        && (before.source_id != after.source_id || before.slug != after.slug)
    {
        let key = job_key(&incarnation_of(&*tx, &before.source_id)?, &before.slug);
        tx.delete(&key)?;
    }
    let key = job_key(&incarnation_of(&*tx, &after.source_id)?, &after.slug);
    if after.deleted_at_us.is_some()
        || after.text_projection_revision.as_deref() == Some(after.knowledge_revision.as_str())
    {
        tx.delete(&key)?;
    } else if before.is_none_or(|b| b.knowledge_revision != after.knowledge_revision) {
        let now = transaction_clock::transaction_now().ok_or_else(|| {
            StoreError::invalid("a page write ran outside a store write transaction")
        })?;
        let job = JobRecord {
            revision: after.knowledge_revision.clone(),
            reason: CANONICAL_CHANGE.into(),
            updated_at_us: now,
        };
        put_json(tx, &key, &job)?;
    }
    Ok(())
}

/// Every job, in key order.
fn all_jobs(read: &dyn KvRead) -> Result<Vec<Job>> {
    let mut out = Vec::new();
    let mut failure = None;
    let start = prefix().len();
    scan_prefix(read, &prefix(), false, &mut |k, v| {
        let rest = &k[start..];
        let split = rest.iter().position(|b| *b == 0);
        match (split, serde_json::from_slice::<JobRecord>(v)) {
            (Some(at), Ok(record)) => out.push(Job {
                incarnation: String::from_utf8_lossy(&rest[..at]).into_owned(),
                slug: String::from_utf8_lossy(&rest[at + 1..]).into_owned(),
                record,
            }),
            (None, _) => failure = Some(StoreError::invalid("a projection job key has no slug")),
            (_, Err(e)) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// True when the queue holds no job: one key read.
pub(crate) fn projection_queue_empty_in(read: &dyn KvRead) -> Result<bool> {
    let mut empty = true;
    scan_prefix(read, &prefix(), false, &mut |_, _| {
        empty = false;
        false
    })?;
    Ok(empty)
}

/// `split_part(reason, ':', 1)`.
fn reason_kind(reason: &str) -> &str {
    reason.split(':').next().unwrap_or("")
}

/// `SEGMENTED_PROJECTION_CLAIMED_TEXT`.
fn claimed(job: &JobRecord, now: i64) -> bool {
    reason_kind(&job.reason) == "segmented_projecting" && job.updated_at_us >= now - CLAIM_US
}

/// `PROJECTION_RETRY_READY_TEXT`.
fn retry_ready(job: &JobRecord, now: i64) -> bool {
    (job.reason != "rebuild_failed" || job.updated_at_us < now - RETRY_US)
        && !claimed(job, now)
        && !(reason_kind(&job.reason) == "chunk_replacement_continuing"
            && job.updated_at_us >= now - CLAIM_US)
}

/// `<text>::timestamptz` with TimeZone UTC, for the forms the callers pass: `now()::text`
/// (`2026-11-18 02:37:05.215+00`) and ISO (`2026-11-18T02:37:05.215Z`). Other text is refused, as
/// Postgres refuses text that is not a time.
pub(crate) fn parse_timestamptz(text: &str, what: &str) -> Result<i64> {
    let bad = || StoreError::invalid(format!("{what} is not a timestamp: {text:?}"));
    let t = text.trim();
    let (date_time, zone_us) = match t.rfind(['+', '-', 'Z']).filter(|at| *at >= 19) {
        Some(at) => (&t[..at], zone_offset(&t[at..]).ok_or_else(bad)?),
        None => (t, 0),
    };
    let b = date_time.as_bytes();
    if b.len() < 19 || !(b[10] == b' ' || b[10] == b'T') {
        return Err(bad());
    }
    let iso = format!("{}T{}Z", &date_time[..10], &date_time[11..]);
    parse_iso(&iso).map(|us| us - zone_us).ok_or_else(bad)
}

/// `Z`, `+HH`, `+HH:MM` or `+HHMM` (and `-`), as microseconds east of UTC.
fn zone_offset(zone: &str) -> Option<i64> {
    if zone == "Z" {
        return Some(0);
    }
    let sign = match zone.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits: String = zone[1..].chars().filter(|c| *c != ':').collect();
    if !(digits.len() == 2 || digits.len() == 4) || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let hours: i64 = digits[..2].parse().ok()?;
    let minutes: i64 = if digits.len() == 4 {
        digits[2..].parse().ok()?
    } else {
        0
    };
    Some(sign * (hours * 3600 + minutes * 60) * 1_000_000)
}

/// What `listPendingSegmentedProjections` takes (`SegmentedProjectionFilter`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentedProjectionFilter {
    pub limit: f64,
    #[serde(default)]
    pub not_after: Option<String>,
    #[serde(default)]
    pub reasons: Option<Vec<String>>,
    #[serde(default)]
    pub exclude: Option<Vec<String>>,
    #[serde(default)]
    pub retry_cooldown: Option<bool>,
}

/// The sources by incarnation.
fn sources_by_incarnation(read: &dyn KvRead) -> Result<HashMap<String, SourceRecord>> {
    Ok(all_sources(read)?
        .into_iter()
        .map(|s| (s.incarnation.clone(), s))
        .collect())
}

/// `listPendingSegmentedProjections(filter)`: the jobs of live segmented pages of sources that
/// are not archived (`SEGMENTED_JOB_PROBES_SQL`), filtered, oldest first, at most
/// `max(1, limit)`.
pub(crate) fn list_pending_segmented_projections_in(
    read: &dyn KvRead,
    env: &dyn Env,
    filter: &SegmentedProjectionFilter,
) -> Result<Vec<Value>> {
    let now = env.now_micros();
    let not_after = filter
        .not_after
        .as_deref()
        .map(|t| parse_timestamptz(t, "notAfter"))
        .transpose()?;
    let sources = sources_by_incarnation(read)?;
    let mut rows = Vec::new();
    for job in all_jobs(read)? {
        let Some(source) = sources.get(&job.incarnation).filter(|s| !s.archived) else {
            continue;
        };
        let live_segmented = read_page(read, &source.id, &job.slug)?.is_some_and(|p| {
            p.deleted_at_us.is_none() && p.compiled_truth.is_null() && p.timeline.is_null()
        });
        let r = &job.record;
        let ready = if filter.retry_cooldown == Some(false) {
            !claimed(r, now)
        } else {
            retry_ready(r, now)
        };
        let keep = live_segmented
            && ready
            && not_after.is_none_or(|at| r.updated_at_us <= at)
            && filter
                .reasons
                .as_ref()
                .is_none_or(|rs| rs.contains(&r.reason))
            && filter
                .exclude
                .as_ref()
                .is_none_or(|ex| !ex.contains(&format!("{}/{}", job.incarnation, job.slug)));
        if keep {
            rows.push((source.id.clone(), job));
        }
    }
    rows.sort_by(|(_, a), (_, b)| {
        (a.record.updated_at_us, a.slug.as_bytes(), &a.incarnation).cmp(&(
            b.record.updated_at_us,
            b.slug.as_bytes(),
            &b.incarnation,
        ))
    });
    let limit = if filter.limit.is_finite() && filter.limit >= 1.0 {
        filter.limit as usize
    } else {
        1
    };
    Ok(rows
        .into_iter()
        .take(limit)
        .map(|(source_id, j)| {
            json!({
                "source_id": source_id,
                "source_incarnation": j.incarnation,
                "slug": j.slug,
                "revision": j.record.revision,
            })
        })
        .collect())
}

/// `selectProjectionWindowJobs(cursor, retryCooldown)`'s cursor: `after` and `highWater`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionWindowCursor {
    pub after: ProjectionWindowKey,
    #[serde(default)]
    pub high_water: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectionWindowKey {
    pub source_incarnation: String,
    pub slug: String,
}

/// A job's key, `(source_incarnation, slug)`, in key order.
fn job_order(j: &Job) -> (&str, &[u8]) {
    (j.incarnation.as_str(), j.slug.as_bytes())
}

fn window_row(job: &Job, lane: &str, ord: i64, high_water: &Value) -> Value {
    json!({
        "lane": lane,
        "ord": ord,
        "source_incarnation": job.incarnation,
        "slug": job.slug,
        "revision": job.record.revision,
        "high_water": high_water,
    })
}

/// `projectionWindowFragment(cursor, retryCooldown)`: the recency lane (jobs within 10 minutes of
/// the high water, newest first, at most 100, `ord` 0), then the key window (up to 400 jobs after
/// the cursor key, then from the start up to and including it, `ord` from 1). Every row carries
/// `max(updated_at)::text`; on no row, one row of nulls carries it.
pub(crate) fn select_projection_window_jobs_in(
    read: &dyn KvRead,
    env: &dyn Env,
    cursor: &ProjectionWindowCursor,
    retry_cooldown: bool,
) -> Result<Vec<Value>> {
    let now = env.now_micros();
    let inc = uuid_param(
        &cursor.after.source_incarnation,
        "cursor.after.source_incarnation",
    )?;
    let after = (inc.as_str(), cursor.after.slug.as_bytes());
    let jobs = all_jobs(read)?;
    let newest = jobs.iter().map(|j| j.record.updated_at_us).max();
    let mark = match cursor.high_water.as_deref() {
        Some(t) => Some(parse_timestamptz(t, "cursor.highWater")?),
        None => newest,
    };
    let high_water = newest.map_or(Value::Null, |us| {
        json!(crate::cli_reads::pg_text::timestamptz_text(us))
    });
    let pass = |j: &&Job| !retry_cooldown || retry_ready(&j.record, now);
    let mut recent: Vec<&Job> = match mark {
        Some(mark) => jobs
            .iter()
            .filter(|j| j.record.updated_at_us > mark - RECENT_US)
            .filter(pass)
            .collect(),
        None => Vec::new(),
    };
    recent.sort_by_key(|j| std::cmp::Reverse(j.record.updated_at_us));
    recent.truncate(RECENT_LIMIT);
    let forward = jobs.iter().filter(|j| job_order(j) > after).filter(pass);
    let wrap = jobs.iter().filter(|j| job_order(j) <= after).filter(pass);
    let window: Vec<&Job> = forward
        .take(WINDOW_LIMIT)
        .chain(wrap.take(WINDOW_LIMIT))
        .take(WINDOW_LIMIT)
        .collect();
    if recent.is_empty() && window.is_empty() {
        return Ok(vec![json!({
            "lane": null, "ord": null, "source_incarnation": null, "slug": null,
            "revision": null, "high_water": high_water,
        })]);
    }
    let mut rows: Vec<Value> = recent
        .iter()
        .map(|j| window_row(j, "recent", 0, &high_water))
        .collect();
    rows.extend(
        window
            .iter()
            .zip(1..)
            .map(|(j, ord)| window_row(j, "window", ord, &high_water)),
    );
    Ok(rows)
}

impl Store {
    /// `listPendingSegmentedProjections(filter)`.
    pub fn list_pending_segmented_projections(
        &self,
        filter: &SegmentedProjectionFilter,
    ) -> Result<Vec<Value>> {
        list_pending_segmented_projections_in(&*self.read()?, &*self.env, filter)
    }

    /// `selectProjectionWindowJobs(cursor, retryCooldown)`.
    pub fn select_projection_window_jobs(
        &self,
        cursor: &ProjectionWindowCursor,
        retry_cooldown: bool,
    ) -> Result<Vec<Value>> {
        select_projection_window_jobs_in(&*self.read()?, &*self.env, cursor, retry_cooldown)
    }

    /// Whether the page projection queue holds no job.
    pub fn projection_queue_empty(&self) -> Result<bool> {
        projection_queue_empty_in(&*self.read()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_reads::pg_text::timestamptz_text;
    use crate::pages::{PageInput, PutPageOptions};

    fn put(store: &Store, slug: &str) {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        let options = PutPageOptions {
            index: Some(false),
            ..PutPageOptions::default()
        };
        store.put_page(slug, &input, &options).unwrap();
    }

    /// Makes `slug` a segmented shell (both body columns NULL), as `createSegmentedPageShell`
    /// would; the revision stays, so the hook leaves its job alone.
    fn segment(store: &Store, slug: &str) {
        store
            .write(|tx| {
                let mut page = read_page(&*tx, "default", slug)?.unwrap();
                page.compiled_truth = crate::pages::PageText::null();
                page.timeline = crate::pages::PageText::null();
                crate::pages::write_page(tx, &page)
            })
            .unwrap();
    }

    fn set_job(store: &Store, slug: &str, reason: &str, age_us: i64) {
        let now = store.env.now_micros();
        store
            .write(|tx| {
                let key = job_key(&incarnation_of(&*tx, "default")?, slug);
                let mut job: JobRecord = crate::get_json(&*tx, &key)?.unwrap();
                job.reason = reason.into();
                job.updated_at_us = now - age_us;
                put_json(tx, &key, &job)
            })
            .unwrap();
    }

    fn pending(store: &Store, filter: Value) -> Vec<String> {
        let filter: SegmentedProjectionFilter = serde_json::from_value(filter).unwrap();
        store
            .list_pending_segmented_projections(&filter)
            .unwrap()
            .iter()
            .map(|r| r["slug"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn the_segmented_read_applies_the_reason_and_age_filters() {
        let store = crate::test_support::store();
        for slug in ["a", "b", "c", "d", "e", "inline"] {
            put(&store, slug);
        }
        for slug in ["a", "b", "c", "d", "e"] {
            segment(&store, slug);
        }
        set_job(&store, "a", "canonical_change", 5_000_000);
        set_job(&store, "b", "segmented_projecting:host", 1_000_000);
        set_job(&store, "c", "rebuild_failed", 1_000_000);
        set_job(&store, "d", "chunk_replacement_continuing:x", 1_000_000);
        set_job(&store, "e", "rebuild_failed", 120_000_000);
        // The inline page has a job but is not segmented; claimed, cooling and continuing jobs wait.
        assert_eq!(pending(&store, json!({ "limit": 10 })), ["e", "a"]);
        // Without the cooldown only the claimed job waits.
        assert_eq!(
            pending(&store, json!({ "limit": 10, "retryCooldown": false })),
            ["e", "a", "c", "d"]
        );
        assert_eq!(pending(&store, json!({ "limit": 0 })), ["e"]);
        assert_eq!(
            pending(
                &store,
                json!({ "limit": 10, "reasons": ["canonical_change"] })
            ),
            ["a"]
        );
        let inc = store.read_source_membership("default").unwrap().unwrap()["incarnation"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            pending(
                &store,
                json!({ "limit": 10, "exclude": [format!("{inc}/e")] })
            ),
            ["a"]
        );
        let cutoff = timestamptz_text(store.env.now_micros() - 60_000_000);
        assert_eq!(
            pending(&store, json!({ "limit": 10, "notAfter": cutoff })),
            ["e"]
        );
        store.set_source_archived("default", true).unwrap();
        assert!(pending(&store, json!({ "limit": 10 })).is_empty());
    }

    #[test]
    fn timestamptz_text_parses_the_forms_the_callers_pass() {
        let us = parse_iso("2026-11-18T02:37:05.215000Z").unwrap();
        assert_eq!(
            parse_timestamptz("2026-11-18 02:37:05.215+00", "t").unwrap(),
            us
        );
        assert_eq!(
            parse_timestamptz("2026-11-18T02:37:05.215Z", "t").unwrap(),
            us
        );
        assert_eq!(
            parse_timestamptz("2026-11-18 04:37:05.215+02:00", "t").unwrap(),
            us
        );
        assert_eq!(
            parse_timestamptz("2026-11-17 18:37:05.215-0800", "t").unwrap(),
            us
        );
        assert_eq!(parse_timestamptz(&timestamptz_text(us), "t").unwrap(), us);
        assert!(parse_timestamptz("2026-11-18", "t").is_err());
        assert!(parse_timestamptz("yesterday", "t").is_err());
    }

    #[test]
    fn the_hook_reads_the_clock_once_per_transaction() {
        let store = crate::test_support::store();
        store
            .write(|tx| {
                let first = transaction_clock::transaction_now();
                std::thread::sleep(std::time::Duration::from_millis(2));
                assert_eq!(transaction_clock::transaction_now(), first);
                let _ = tx;
                Ok(())
            })
            .unwrap();
        assert_eq!(transaction_clock::transaction_now(), None);
    }
}
