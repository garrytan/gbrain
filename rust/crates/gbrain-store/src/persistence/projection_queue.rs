//! The page projection queue (Postgres `page_projection_jobs`): one job per page whose text
//! projection is behind its knowledge revision, and the two housekeeping reads over it
//! (`listPendingSegmentedProjections`, `selectProjectionWindowJobs` of
//! `src/core/engine-sql/persistence-housekeeping.ts`).
//!
//! Key `d 0x04 <source incarnation> 0x00 <slug>`, value a `JobRecord` in the compact form of
//! `encode_job` (store format 3; format 2 kept JSON, which `decode_job` still reads). An
//! incarnation is the 36-byte lower-case UUID text, so key order is `(source_incarnation, slug)`
//! order: UUID text order is Postgres's UUID order, and the slug compares by bytes (the C
//! collation).
//!
//! `queue_page_projection` keeps the queue in step with every page write as PGLite's
//! `gbrain_queue_page_projection` trigger does. The segmented projector's queue writes
//! (`claimSegmentedProjection`, `renewSegmentedProjectionClaim`, `releaseSegmentedProjectionClaim`,
//! `deleteProjectionJob`, `markProjectionRebuildFailed` of `page-body/projection.ts`) are the
//! other writers; each runs in one `Store::write`. `chunk_replacement_continuing` and
//! `protocol_activation` still have no store writer, and the reads apply the full reason
//! filters. A source delete removes each page first (`cascade.rs`), and the hook removes the
//! page's job, so no job outlives its source.

use super::{QUEUE, uuid_param};
use crate::env::{Env, parse_iso, transaction_clock};
use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, read_page};
use crate::sources::{SourceRecord, all_sources, read_source};
use crate::{Store, keys};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

/// The reason the trigger writes.
const CANONICAL_CHANGE: &str = "canonical_change";
/// The reason of the jobs an upgrade's activation queues (no store writer yet).
const PROTOCOL_ACTIVATION: &str = "protocol_activation";
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
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct JobRecord {
    pub revision: String,
    pub reason: String,
    pub updated_at_us: i64,
}

/// The first byte of a compact job value. A JSON value starts with `{`.
const COMPACT: u8 = 1;
/// Flag: the revision is a lower-case UUID, stored as its 16 bytes.
const PACKED_UUID: u8 = 1;
/// Flag: the reason is `canonical_change`, stored as nothing.
const CANONICAL: u8 = 2;

/// The 16 bytes of `text` when it is a lower-case hyphenated UUID, the only form that prints back
/// to the same text.
fn pack_uuid(text: &str) -> Option<[u8; 16]> {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    let mut out = [0u8; 16];
    let mut nibbles = 0;
    for (at, b) in bytes.iter().enumerate() {
        if matches!(at, 8 | 13 | 18 | 23) {
            if *b != b'-' {
                return None;
            }
            continue;
        }
        let v = match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            _ => return None,
        };
        out[nibbles / 2] |= if nibbles % 2 == 0 { v << 4 } else { v };
        nibbles += 1;
    }
    Some(out)
}

fn unpack_uuid(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(36);
    for (at, b) in bytes.iter().enumerate() {
        if matches!(at, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push(HEX[usize::from(b >> 4)] as char);
        out.push(HEX[usize::from(b & 0x0f)] as char);
    }
    out
}

/// A job's stored value: `COMPACT`, a flags byte, `updated_at_us` (8 bytes, big-endian), the
/// revision (16 UUID bytes, or a 4-byte length and its text), then the reason text unless it is
/// `canonical_change`. A trigger job is 26 bytes where its JSON is about 110; each page write
/// puts one, so the queue's B-tree stays smaller and a write copies less of it.
fn encode_job(job: &JobRecord) -> Result<Vec<u8>> {
    let uuid = pack_uuid(&job.revision);
    let canonical = job.reason == CANONICAL_CHANGE;
    let mut out = Vec::with_capacity(26);
    out.push(COMPACT);
    let mut flags = 0;
    if uuid.is_some() {
        flags |= PACKED_UUID;
    }
    if canonical {
        flags |= CANONICAL;
    }
    out.push(flags);
    out.extend_from_slice(&job.updated_at_us.to_be_bytes());
    match uuid {
        Some(bytes) => out.extend_from_slice(&bytes),
        None => {
            let len = u32::try_from(job.revision.len())
                .map_err(|_| StoreError::invalid("a projection job revision is too long"))?;
            out.extend_from_slice(&len.to_be_bytes());
            out.extend_from_slice(job.revision.as_bytes());
        }
    }
    if !canonical {
        out.extend_from_slice(job.reason.as_bytes());
    }
    Ok(out)
}

/// Reads a job value in either stored form.
pub(crate) fn decode_job(value: &[u8]) -> Result<JobRecord> {
    let malformed = || StoreError::new(STORE_CORRUPT, "a projection job record is malformed");
    match value.first() {
        Some(b'{') => return Ok(serde_json::from_slice(value)?),
        Some(&COMPACT) => {}
        _ => return Err(malformed()),
    }
    let flags = *value.get(1).ok_or_else(malformed)?;
    let stamp: [u8; 8] = value
        .get(2..10)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(malformed)?;
    let rest = &value[10..];
    let (revision, rest) = if flags & PACKED_UUID != 0 {
        (
            unpack_uuid(rest.get(..16).ok_or_else(malformed)?),
            &rest[16..],
        )
    } else {
        let len: [u8; 4] = rest
            .get(..4)
            .and_then(|b| b.try_into().ok())
            .ok_or_else(malformed)?;
        let end = usize::try_from(u32::from_be_bytes(len))
            .ok()
            .and_then(|n| n.checked_add(4))
            .ok_or_else(malformed)?;
        let text = std::str::from_utf8(rest.get(4..end).ok_or_else(malformed)?)
            .map_err(|_| malformed())?;
        (text.to_owned(), &rest[end..])
    };
    let reason = if flags & CANONICAL != 0 {
        if !rest.is_empty() {
            return Err(malformed());
        }
        CANONICAL_CHANGE.to_owned()
    } else {
        std::str::from_utf8(rest)
            .map_err(|_| malformed())?
            .to_owned()
    };
    Ok(JobRecord {
        revision,
        reason,
        updated_at_us: i64::from_be_bytes(stamp),
    })
}

fn put_job(tx: &mut dyn KvWrite, key: &[u8], job: &JobRecord) -> Result<()> {
    tx.put(key, &encode_job(job)?)
}

/// Store format 2 to 3: rewrites every JSON job in the compact form. The keys stay.
pub(crate) fn compact_format_2_jobs(tx: &mut dyn KvWrite) -> Result<()> {
    let mut json = Vec::new();
    scan_prefix(&*tx, &prefix(), false, &mut |k, v| {
        if v.first() == Some(&b'{') {
            json.push((k.to_vec(), v.to_vec()));
        }
        true
    })?;
    for (key, value) in json {
        put_job(tx, &key, &decode_job(&value)?)?;
    }
    Ok(())
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
        put_job(tx, &key, &job)?;
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
        match (split, decode_job(v)) {
            (Some(at), Ok(record)) => out.push(Job {
                incarnation: String::from_utf8_lossy(&rest[..at]).into_owned(),
                slug: String::from_utf8_lossy(&rest[at + 1..]).into_owned(),
                record,
            }),
            (None, _) => failure = Some(StoreError::invalid("a projection job key has no slug")),
            (_, Err(e)) => failure = Some(e),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// `min(updated_at)` over the jobs with reason `protocol_activation`: when an upgrade's index rebuild
/// began, or none when no such job is queued (`projectionRebuildProgress`).
pub(crate) fn activation_started_us(read: &dyn KvRead) -> Result<Option<i64>> {
    Ok(all_jobs(read)?
        .iter()
        .filter(|job| job.record.reason == PROTOCOL_ACTIVATION)
        .map(|job| job.record.updated_at_us)
        .min())
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
pub(crate) fn sources_by_incarnation(read: &dyn KvRead) -> Result<HashMap<String, SourceRecord>> {
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

/// The reason `markProjectionRebuildFailed` writes.
const REBUILD_FAILED: &str = "rebuild_failed";

/// The transaction's time: `now()` and, for the projector's writes, `clock_timestamp()` (one
/// store write is one statement, so the two agree).
fn write_now() -> Result<i64> {
    transaction_clock::transaction_now().ok_or_else(|| {
        StoreError::invalid("a projection queue write ran outside a store write transaction")
    })
}

/// The key of the job of page `(source_id, slug)`, or none when the source does not exist (the
/// statements' `(SELECT incarnation FROM sources WHERE id=$1)` is NULL and matches no row).
fn page_job_key(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Option<Vec<u8>>> {
    Ok(read_source(read, source_id)?.map(|s| job_key(&s.incarnation, slug)))
}

fn read_job(read: &dyn KvRead, key: &[u8]) -> Result<Option<JobRecord>> {
    read.get(key)?.map(|v| decode_job(&v)).transpose()
}

/// `claimSegmentedProjection`: `claimed` when the page's job had no live claim and now carries
/// `claim`, `held` when another live claim holds it, `absent` when the page has no job.
pub(crate) fn claim_segmented_projection_in(
    tx: &mut dyn KvWrite,
    source_id: &str,
    slug: &str,
    claim: &str,
) -> Result<&'static str> {
    let Some(key) = page_job_key(&*tx, source_id, slug)? else {
        return Ok("absent");
    };
    let Some(mut job) = read_job(&*tx, &key)? else {
        return Ok("absent");
    };
    let now = write_now()?;
    if claimed(&job, now) {
        return Ok("held");
    }
    job.reason = claim.to_owned();
    job.updated_at_us = now;
    put_job(tx, &key, &job)?;
    Ok("claimed")
}

/// The page's job while its reason is `claim`, with its key.
fn claimed_job(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
    claim: &str,
) -> Result<Option<(Vec<u8>, JobRecord)>> {
    let Some(key) = page_job_key(read, source_id, slug)? else {
        return Ok(None);
    };
    Ok(read_job(read, &key)?
        .filter(|job| job.reason == claim)
        .map(|job| (key, job)))
}

/// `renewSegmentedProjectionClaim`: true when the job still carried `claim` and its time moved to now.
pub(crate) fn renew_segmented_projection_claim_in(
    tx: &mut dyn KvWrite,
    source_id: &str,
    slug: &str,
    claim: &str,
) -> Result<bool> {
    let Some((key, mut job)) = claimed_job(&*tx, source_id, slug, claim)? else {
        return Ok(false);
    };
    job.updated_at_us = write_now()?;
    put_job(tx, &key, &job)?;
    Ok(true)
}

/// `releaseSegmentedProjectionClaim`: a job that still carries `claim` goes back to `canonical_change`.
pub(crate) fn release_segmented_projection_claim_in(
    tx: &mut dyn KvWrite,
    source_id: &str,
    slug: &str,
    claim: &str,
) -> Result<()> {
    if let Some((key, mut job)) = claimed_job(&*tx, source_id, slug, claim)? {
        job.reason = CANONICAL_CHANGE.into();
        job.updated_at_us = write_now()?;
        put_job(tx, &key, &job)?;
    }
    Ok(())
}

/// The job at `(source_incarnation, slug)` when it is still queued at `revision`.
fn job_at_revision(
    read: &dyn KvRead,
    job: &ProjectionJobRef,
) -> Result<Option<(Vec<u8>, JobRecord)>> {
    let incarnation = uuid_param(&job.source_incarnation, "sourceIncarnation")?;
    let revision = uuid_param(&job.revision, "revision")?;
    let key = job_key(&incarnation, &job.slug);
    Ok(read_job(read, &key)?
        .filter(|record| record.revision.eq_ignore_ascii_case(&revision))
        .map(|record| (key, record)))
}

/// `deleteProjectionJob`: the job goes when it is still queued at `revision`.
pub(crate) fn delete_projection_job_in(tx: &mut dyn KvWrite, job: &ProjectionJobRef) -> Result<()> {
    if let Some((key, _)) = job_at_revision(&*tx, job)? {
        tx.delete(&key)?;
    }
    Ok(())
}

/// `markProjectionRebuildFailed`: a job still queued at `revision` that no live claim holds gets
/// reason `rebuild_failed` at now, so the retry window starts.
pub(crate) fn mark_projection_rebuild_failed_in(
    tx: &mut dyn KvWrite,
    job: &ProjectionJobRef,
) -> Result<()> {
    let now = write_now()?;
    if let Some((key, mut record)) = job_at_revision(&*tx, job)?
        && !claimed(&record, now)
    {
        record.reason = REBUILD_FAILED.into();
        record.updated_at_us = now;
        put_job(tx, &key, &record)?;
    }
    Ok(())
}

/// A queued job by its key and revision (`deleteProjectionJob`, `markProjectionRebuildFailed`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionJobRef {
    pub source_incarnation: String,
    pub slug: String,
    pub revision: String,
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

    /// `claimSegmentedProjection({ sourceId, slug }, claim)`: `claimed`, `held` or `absent`.
    pub fn claim_segmented_projection(
        &self,
        source_id: &str,
        slug: &str,
        claim: &str,
    ) -> Result<&'static str> {
        self.write(|tx| claim_segmented_projection_in(tx, source_id, slug, claim))
    }

    /// `renewSegmentedProjectionClaim({ sourceId, slug }, claim)`.
    pub fn renew_segmented_projection_claim(
        &self,
        source_id: &str,
        slug: &str,
        claim: &str,
    ) -> Result<bool> {
        self.write(|tx| renew_segmented_projection_claim_in(tx, source_id, slug, claim))
    }

    /// `releaseSegmentedProjectionClaim({ sourceId, slug }, claim)`.
    pub fn release_segmented_projection_claim(
        &self,
        source_id: &str,
        slug: &str,
        claim: &str,
    ) -> Result<()> {
        self.write(|tx| release_segmented_projection_claim_in(tx, source_id, slug, claim))
    }

    /// `deleteProjectionJob(job)`.
    pub fn delete_projection_job(&self, job: &ProjectionJobRef) -> Result<()> {
        self.write(|tx| delete_projection_job_in(tx, job))
    }

    /// `markProjectionRebuildFailed(job)`.
    pub fn mark_projection_rebuild_failed(&self, job: &ProjectionJobRef) -> Result<()> {
        self.write(|tx| mark_projection_rebuild_failed_in(tx, job))
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

    #[test]
    fn a_job_reads_back_from_its_compact_form_and_from_json() {
        let job = |revision: &str, reason: &str, at: i64| JobRecord {
            revision: revision.into(),
            reason: reason.into(),
            updated_at_us: at,
        };
        let cases = [
            job(
                "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
                CANONICAL_CHANGE,
                1_763_500_000_123_456,
            ),
            // Text that is not a lower-case UUID keeps its exact bytes.
            job("0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0", CANONICAL_CHANGE, 0),
            job("not-a-uuid", "rebuild_failed", -1),
            job("", "", i64::MIN),
            job("ünïcode revision", PROTOCOL_ACTIVATION, i64::MAX),
        ];
        for case in &cases {
            let bytes = encode_job(case).unwrap();
            assert_eq!(bytes[0], COMPACT);
            assert_eq!(&decode_job(&bytes).unwrap(), case);
            let json = serde_json::to_vec(&json!({
                "revision": case.revision, "reason": case.reason,
                "updated_at_us": case.updated_at_us,
            }))
            .unwrap();
            assert_eq!(&decode_job(&json).unwrap(), case);
        }
        assert_eq!(encode_job(&cases[0]).unwrap().len(), 26);
        for bad in [
            &b""[..],
            b"x",
            &[COMPACT],
            &[COMPACT, 3, 0, 0],
            &[COMPACT, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        ] {
            assert_eq!(decode_job(bad).unwrap_err().code, STORE_CORRUPT);
        }
        let mut tail = encode_job(&cases[0]).unwrap();
        tail.push(b'x');
        assert!(decode_job(&tail).is_err(), "bytes after a canonical job");
    }

    fn set_job(store: &Store, slug: &str, reason: &str, age_us: i64) {
        let now = store.env.now_micros();
        store
            .write(|tx| {
                let key = job_key(&incarnation_of(&*tx, "default")?, slug);
                let mut job = decode_job(&tx.get(&key)?.unwrap())?;
                job.reason = reason.into();
                job.updated_at_us = now - age_us;
                put_job(tx, &key, &job)
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

    /// `projectionRebuildProgress` reads the start of an activation's rebuild from the queue. No
    /// store writer queues `protocol_activation` yet, so the test writes the job's reason itself.
    #[test]
    fn rebuild_progress_starts_at_the_oldest_activation_job() {
        use crate::link_queries::CoverageScope;
        let store = crate::test_support::store();
        for slug in ["waiting", "sealed"] {
            put(&store, slug);
        }
        store
            .write(|tx| {
                let mut page = read_page(&*tx, "default", "sealed")?.unwrap();
                page.text_projection_revision = Some(page.knowledge_revision.clone());
                crate::pages::write_page(tx, &page)
            })
            .unwrap();
        let every = CoverageScope::default();
        assert_eq!(store.projection_rebuild_progress(&every).unwrap(), None);
        set_job(&store, "waiting", PROTOCOL_ACTIVATION, 10_000_000);
        let progress = store.projection_rebuild_progress(&every).unwrap().unwrap();
        assert_eq!((progress.done, progress.total), (1, 2));
        let rate = progress.pages_per_second.unwrap();
        assert!(rate > 0.05 && rate <= 0.1, "{rate}");
        let elsewhere: CoverageScope =
            serde_json::from_value(json!({ "sourceId": "elsewhere" })).unwrap();
        let none = store
            .projection_rebuild_progress(&elsewhere)
            .unwrap()
            .unwrap();
        assert_eq!((none.done, none.total, none.pages_per_second), (0, 0, None));
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

    /// The projector's queue writes: one live claim at a time, renew and release only by the
    /// holder, and the rebuilt and failed marks only at the queued revision.
    #[test]
    fn the_projector_claims_renews_releases_and_settles_a_job() {
        let store = crate::test_support::store();
        put(&store, "notes/a");
        let job = |store: &Store| {
            store
                .read()
                .and_then(|r| read_job(&*r, &job_key(&incarnation_of(&*r, "default")?, "notes/a")))
                .unwrap()
        };
        let (a, b) = ("segmented_projecting:a", "segmented_projecting:b");
        assert_eq!(
            store
                .claim_segmented_projection("default", "notes/none", a)
                .unwrap(),
            "absent"
        );
        assert_eq!(
            store
                .claim_segmented_projection("no-such-source", "notes/a", a)
                .unwrap(),
            "absent"
        );
        assert_eq!(
            store
                .claim_segmented_projection("default", "notes/a", a)
                .unwrap(),
            "claimed"
        );
        assert_eq!(job(&store).unwrap().reason, a);
        assert_eq!(
            store
                .claim_segmented_projection("default", "notes/a", b)
                .unwrap(),
            "held"
        );
        assert!(
            !store
                .renew_segmented_projection_claim("default", "notes/a", b)
                .unwrap()
        );
        assert!(
            store
                .renew_segmented_projection_claim("default", "notes/a", a)
                .unwrap()
        );
        store
            .release_segmented_projection_claim("default", "notes/a", b)
            .unwrap();
        assert_eq!(job(&store).unwrap().reason, a);
        let revision = job(&store).unwrap().revision;
        let incarnation = store
            .read()
            .and_then(|r| incarnation_of(&*r, "default"))
            .unwrap();
        let at = |revision: &str| ProjectionJobRef {
            source_incarnation: incarnation.clone(),
            slug: "notes/a".into(),
            revision: revision.into(),
        };
        // A live claim keeps the failed mark off.
        store
            .mark_projection_rebuild_failed(&at(&revision))
            .unwrap();
        assert_eq!(job(&store).unwrap().reason, a);
        store
            .release_segmented_projection_claim("default", "notes/a", a)
            .unwrap();
        assert_eq!(job(&store).unwrap().reason, CANONICAL_CHANGE);
        let other = "00000000-0000-4000-8000-000000000000";
        store.mark_projection_rebuild_failed(&at(other)).unwrap();
        assert_eq!(job(&store).unwrap().reason, CANONICAL_CHANGE);
        store
            .mark_projection_rebuild_failed(&at(&revision))
            .unwrap();
        assert_eq!(job(&store).unwrap().reason, REBUILD_FAILED);
        store.delete_projection_job(&at(other)).unwrap();
        assert!(job(&store).is_some());
        store
            .delete_projection_job(&at(&revision.to_uppercase()))
            .unwrap();
        assert!(job(&store).is_none());
        assert_eq!(
            store
                .claim_segmented_projection("default", "notes/a", a)
                .unwrap(),
            "absent"
        );
        assert!(store.delete_projection_job(&at("not-a-uuid")).is_err());
    }
}
