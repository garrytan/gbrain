//! The commit notifier's host lease and host source list: the `claimNotifierLease`,
//! `readNotifierLease`, `holdsNotifierLease`, `releaseNotifierLease` and
//! `listNotifierHostSourceRows` members of `src/core/engine-sql/notifier.ts`
//! (rust/docs/store/persistence.md, "Commit notifier").
//!
//! The lease is one `sync_notifier_leases` row per host. Key `d 0x08 0x01 <host_id>` (the host id
//! text, which cannot hold NUL, as Postgres text cannot), JSON `NotifierLeaseRecord`. A claim
//! wins when the host has no row, when the row is the caller's, or when it expired
//! (`expires_at <= now`); a takeover adds 1 to the fencing token, a renewal keeps it. A lost
//! claim reads the holder. The fencing check (`holdsNotifierLease`) is true only for the row's
//! owner, with its fence, before the expiry. A release (`releaseNotifierLease`) sets the expiry
//! to now when the caller owns the row, in one write; rows are never deleted on this engine.
//!
//! The per-source row is one `sync_notifier_sources` row per source. Key `d 0x08 0x02 <source_id>`
//! (a source id cannot hold NUL), JSON `NotifierSourceRecord`. A state, coverage or syncer write
//! inserts the row when the source has none and writes nothing when the source does not exist,
//! as Postgres's `INSERT ... SELECT ... FROM sources` does; every timestamp one write sets is the
//! same `now`. The state and the detection mode keep the v262 CHECK lists. Deleting the source
//! deletes its row (`remove_source_rows`, the `ON DELETE CASCADE`).
//!
//! The host source list reads the source records and the classic syncer host of each row. This
//! engine keeps no managed worktree bindings, so every row reads `bound` false and `owner` and
//! `root` null, as Postgres reads a source with none of those rows; `last_commit` is the source's.
//!
//! The wanted markers are one `sync_wanted_markers` row per source and intent: the
//! `upsertWantedMarker`, `attachWantedMarkerJob`, `readWantedMarkers`, `readDueWantedMarkers`,
//! `pruneSatisfiedWantedMarkers`, `clearWantedMarker`, `settleFreshnessMarker` and
//! `listSourceWantedMarkers` members. Key `d 0x08 0x03 <source_id> 0x00 <intent>`, JSON
//! `WantedMarkerRecord`. An upsert inserts generation 1 only when the source exists; a re-record
//! adds 1 to the generation, takes the new head and requester, keeps the old job id when no new
//! one is given, and keeps `first_due_at` unless the source was re-created (another
//! incarnation). Deleting the source deletes its markers (`remove_source_rows`).
//!
//! A source keeps the `last_commit` its sync anchor advanced (`advance_source_commit`), or
//! `None` before the first advance, which every marker term reads as Postgres reads a NULL column:
//! a freshness marker stays due while it names no head or another head, the prune deletes a
//! freshness or pull marker that names the source's head, and the settle deletes a freshness
//! marker that names no head or the source's head, or when the checkout head equals it.
//!
//! `readFirstDue` reads, per named source, the observed head of the notifier row and the earlier
//! of its `first_due_at` (when the row is not idle) and the oldest due freshness marker, both of
//! the source's current incarnation only.
//!
//! The status rows join each source that is not archived to its notifier row, to the lease of
//! the row's owner host and to the count of its due markers.

use crate::env::{Env, iso};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::sources::{SourceRecord, all_sources, read_source};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The byte after `d 0x08` of a lease row.
const LEASE: u8 = 0x01;
/// The byte after `d 0x08` of a per-source row.
const SOURCE_ROW: u8 = 0x02;
/// The byte after `d 0x08` of a wanted marker row.
const MARKER: u8 = 0x03;

/// `sync_wanted_markers.intent` CHECK.
const MARKER_INTENTS: &[&str] = &["freshness", "pull", "full"];
/// The marker reads' `LIMIT 1000`.
const MARKER_LIMIT: usize = 1000;

/// `sync_notifier_sources.state` CHECK.
const STATES: &[&str] = &["idle", "due", "running", "retry", "operator_blocked"];
/// `sync_notifier_sources.detection_mode` CHECK.
const DETECTION_MODES: &[&str] = &["watch", "poll"];
/// The status rows' `LIMIT 200`.
const STATUS_LIMIT: usize = 200;

/// One stored `sync_notifier_leases` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct NotifierLeaseRecord {
    owner_id: String,
    fence: i64,
    resident_kind: String,
    pid: Option<i64>,
    renewed_at_us: i64,
    expires_at_us: i64,
}

/// `claimNotifierLease(l)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifierLeaseClaim {
    pub host_id: String,
    pub owner_id: String,
    pub kind: String,
    pub pid: i64,
    pub lease_ms: f64,
}

/// One stored `sync_notifier_sources` row; a missing field reads as the column default.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct NotifierSourceRecord {
    source_incarnation: Option<String>,
    syncer_host_id: Option<String>,
    syncer_recorded_at_us: Option<i64>,
    state: String,
    reason: Option<String>,
    first_due_at_us: Option<i64>,
    attempts: i64,
    next_retry_at_us: Option<i64>,
    last_progress_at_us: Option<i64>,
    last_error_code: Option<String>,
    last_error: Option<String>,
    last_error_at_us: Option<i64>,
    trace_path: Option<String>,
    observed_head: Option<String>,
    observed_at_us: Option<i64>,
    detection_mode: Option<String>,
    owner_host_id: Option<String>,
    owner_kind: Option<String>,
    owner_pid: Option<i64>,
    owner_seen_at_us: Option<i64>,
    updated_at_us: i64,
}

impl NotifierSourceRecord {
    /// A new row with the column defaults (`state` 'idle', `attempts` 0).
    fn new(source_incarnation: String, now: i64) -> Self {
        Self {
            source_incarnation: Some(source_incarnation),
            state: "idle".into(),
            updated_at_us: now,
            ..Self::default()
        }
    }
}

/// `writeNotifierState(sourceId, patch)`. The TypeScript member sends `errorGiven` (the patch
/// named an error, or null to clear it) and the message already cut to 2000 characters.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifierStatePatch {
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
    pub first_due: String,
    #[serde(default)]
    pub attempts: Option<f64>,
    #[serde(default)]
    pub next_retry_in_ms: Option<f64>,
    #[serde(default)]
    pub progress: bool,
    #[serde(default)]
    pub error_given: bool,
    #[serde(default)]
    pub error: Option<NotifierStateError>,
}

/// The last error of a state patch.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifierStateError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub trace_path: Option<String>,
}

/// `writeNotifierCoverage(sourceId, coverage)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifierCoverage {
    #[serde(default)]
    pub head: Option<String>,
    pub mode: String,
    pub owner_host_id: String,
    pub owner_kind: String,
    pub owner_pid: f64,
}

/// One stored `sync_wanted_markers` row (the source id and intent are in the key).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WantedMarkerRecord {
    source_incarnation: Option<String>,
    wanted_head: Option<String>,
    generation: i64,
    first_due_at_us: i64,
    updated_at_us: i64,
    requested_by: String,
    job_id: Option<i64>,
}

/// `upsertWantedMarker(marker)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WantedMarkerInput {
    pub source_id: String,
    pub intent: String,
    #[serde(default)]
    pub wanted_head: Option<String>,
    pub requested_by: String,
    #[serde(default)]
    pub job_id: Option<i64>,
}

/// A number bound as `$n::int`: Postgres rounds half away from zero and refuses a value outside
/// the integer range.
fn pg_int(v: f64, name: &str) -> Result<i64> {
    let r = v.round();
    if !r.is_finite() || r < i32::MIN as f64 || r > i32::MAX as f64 {
        return Err(StoreError::invalid(format!(
            "{name} is out of the integer range"
        )));
    }
    Ok(r as i64)
}

fn source_row_key(source_id: &str) -> Vec<u8> {
    let mut key = vec![keys::PERSISTENCE, super::NOTIFIER, SOURCE_ROW];
    key.extend_from_slice(source_id.as_bytes());
    key
}

/// The source's incarnation and its stored row, or `None` when the source does not exist.
fn source_and_row(
    read: &dyn KvRead,
    source_id: &str,
) -> Result<Option<(String, Option<NotifierSourceRecord>)>> {
    let Some(source) = read_source(read, source_id)? else {
        return Ok(None);
    };
    let row = get_json::<NotifierSourceRecord>(read, &source_row_key(source_id))?;
    Ok(Some((source.incarnation, row)))
}

/// The key prefix of a source's markers, `d 0x08 0x03 <source_id> 0x00`, or `None` when the id
/// holds NUL (no source has such an id, so it names no marker).
fn marker_prefix(source_id: &str) -> Option<Vec<u8>> {
    if source_id.contains('\0') {
        return None;
    }
    let mut key = vec![keys::PERSISTENCE, super::NOTIFIER, MARKER];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    Some(key)
}

fn marker_key(source_id: &str, intent: &str) -> Option<Vec<u8>> {
    let mut key = marker_prefix(source_id)?;
    key.extend_from_slice(intent.as_bytes());
    Some(key)
}

fn lease_key(host_id: &str) -> Result<Vec<u8>> {
    if host_id.contains('\0') {
        return Err(StoreError::invalid("hostId must not contain NUL"));
    }
    let mut key = vec![keys::PERSISTENCE, super::NOTIFIER, LEASE];
    key.extend_from_slice(host_id.as_bytes());
    Ok(key)
}

/// The holder as `readNotifierLease` returns it.
fn holder(r: &NotifierLeaseRecord, now: i64) -> Value {
    json!({
        "owner_id": r.owner_id,
        "fence": r.fence,
        "resident_kind": r.resident_kind,
        "pid": r.pid,
        "expires_at": iso(r.expires_at_us),
        "live": r.expires_at_us > now,
    })
}

/// The INSERT ... ON CONFLICT ... WHERE ... RETURNING fence of the claim, then the holder read
/// when no row came back: `{ owner: true, fence }` or `{ owner: false, holder }`.
pub(crate) fn claim_notifier_lease_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    claim: &NotifierLeaseClaim,
) -> Result<Value> {
    let key = lease_key(&claim.host_id)?;
    // Math.max(1, Math.round(leaseMs)) milliseconds; JavaScript rounds half up.
    let lease_ms = (claim.lease_ms + 0.5).floor().max(1.0) as i64;
    let now = env.now_micros();
    let expires = now.saturating_add(lease_ms.saturating_mul(1000));
    let fence = match get_json::<NotifierLeaseRecord>(&*tx, &key)? {
        None => 1,
        Some(old) if old.owner_id == claim.owner_id => old.fence,
        Some(old) if old.expires_at_us <= now => old.fence + 1,
        Some(old) => return Ok(json!({ "owner": false, "holder": holder(&old, now) })),
    };
    let record = NotifierLeaseRecord {
        owner_id: claim.owner_id.clone(),
        fence,
        resident_kind: claim.kind.clone(),
        pid: Some(claim.pid),
        renewed_at_us: now,
        expires_at_us: expires,
    };
    put_json(tx, &key, &record)?;
    Ok(json!({ "owner": true, "fence": fence }))
}

/// The SELECT of `readNotifierLease`: the host's row as a holder, or `None` when it has none.
pub(crate) fn read_notifier_lease_in(
    read: &dyn KvRead,
    env: &dyn Env,
    host_id: &str,
) -> Result<Option<Value>> {
    let now = env.now_micros();
    Ok(get_json::<NotifierLeaseRecord>(read, &lease_key(host_id)?)?.map(|r| holder(&r, now)))
}

/// The SELECT of `holdsNotifierLease`: the row is `owner_id`'s, with `fence`, and unexpired
/// (`expires_at > now`).
pub(crate) fn holds_notifier_lease_in(
    read: &dyn KvRead,
    env: &dyn Env,
    host_id: &str,
    owner_id: &str,
    fence: f64,
) -> Result<bool> {
    let now = env.now_micros();
    Ok(
        get_json::<NotifierLeaseRecord>(read, &lease_key(host_id)?)?.is_some_and(|r| {
            r.owner_id == owner_id && r.fence as f64 == fence && r.expires_at_us > now
        }),
    )
}

/// The UPDATE of `releaseNotifierLease`: `expires_at = now` when the row is `owner_id`'s; any
/// other row, or none, is left as it is.
pub(crate) fn release_notifier_lease_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    host_id: &str,
    owner_id: &str,
) -> Result<()> {
    let key = lease_key(host_id)?;
    if let Some(mut r) = get_json::<NotifierLeaseRecord>(&*tx, &key)?
        && r.owner_id == owner_id
    {
        r.expires_at_us = env.now_micros();
        put_json(tx, &key, &r)?;
    }
    Ok(())
}

/// The SELECT * of `readNotifierSources`: the rows of `ids` (every row when `None`), in source id
/// order.
pub(crate) fn read_notifier_sources_in(
    read: &dyn KvRead,
    ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut failure = None;
    let prefix = [keys::PERSISTENCE, super::NOTIFIER, SOURCE_ROW];
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let id = String::from_utf8_lossy(&k[prefix.len()..]).into_owned();
        if ids.is_some_and(|ids| !ids.contains(&id)) {
            return true;
        }
        match serde_json::from_slice::<NotifierSourceRecord>(v) {
            Ok(r) => out.push(source_row(&id, &r)),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// A row as `SELECT *` returns it.
fn source_row(source_id: &str, r: &NotifierSourceRecord) -> Value {
    json!({
        "source_id": source_id,
        "source_incarnation": r.source_incarnation,
        "syncer_host_id": r.syncer_host_id,
        "syncer_recorded_at": r.syncer_recorded_at_us.map(iso),
        "state": r.state,
        "reason": r.reason,
        "first_due_at": r.first_due_at_us.map(iso),
        "attempts": r.attempts,
        "next_retry_at": r.next_retry_at_us.map(iso),
        "last_progress_at": r.last_progress_at_us.map(iso),
        "last_error_code": r.last_error_code,
        "last_error": r.last_error,
        "last_error_at": r.last_error_at_us.map(iso),
        "trace_path": r.trace_path,
        "observed_head": r.observed_head,
        "observed_at": r.observed_at_us.map(iso),
        "detection_mode": r.detection_mode,
        "owner_host_id": r.owner_host_id,
        "owner_kind": r.owner_kind,
        "owner_pid": r.owner_pid,
        "owner_seen_at": r.owner_seen_at_us.map(iso),
        "updated_at": iso(r.updated_at_us),
    })
}

/// The INSERT ... ON CONFLICT DO UPDATE of `writeNotifierState`: one transition.
pub(crate) fn write_notifier_state_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    source_id: &str,
    p: &NotifierStatePatch,
) -> Result<()> {
    if !STATES.contains(&p.state.as_str()) {
        return Err(StoreError::invalid(format!(
            "state \"{}\" is not one of {STATES:?}",
            p.state
        )));
    }
    let attempts = p.attempts.map(|a| pg_int(a, "attempts")).transpose()?;
    let retry_ms = p
        .next_retry_in_ms
        .map(|ms| pg_int(ms, "nextRetryInMs"))
        .transpose()?;
    let Some((incarnation, old)) = source_and_row(&*tx, source_id)? else {
        return Ok(());
    };
    let now = env.now_micros();
    let fresh = old.is_none();
    let mut r = old.unwrap_or_else(|| NotifierSourceRecord::new(incarnation.clone(), now));
    r.state = p.state.clone();
    r.reason = p.reason.clone();
    r.first_due_at_us = match (p.first_due.as_str(), fresh) {
        ("keep", true) => Some(now),
        (_, true) => None,
        ("clear", false) => None,
        (_, false) => r.first_due_at_us.or(Some(now)),
    };
    r.attempts = match (attempts, fresh) {
        (Some(a), _) => a,
        (None, true) => 0,
        (None, false) => r.attempts,
    };
    r.next_retry_at_us = retry_ms.map(|ms| now.saturating_add(ms.saturating_mul(1000)));
    if p.progress {
        r.last_progress_at_us = Some(now);
    } else if fresh {
        r.last_progress_at_us = None;
    }
    if fresh || p.error_given {
        let e = p.error.as_ref();
        r.last_error_code = e.map(|e| e.code.clone());
        r.last_error = e.map(|e| e.message.clone());
        r.last_error_at_us = e.map(|_| now);
        r.trace_path = e.and_then(|e| e.trace_path.clone());
    }
    r.source_incarnation = Some(incarnation);
    r.updated_at_us = now;
    put_json(tx, &source_row_key(source_id), &r)
}

/// The INSERT ... ON CONFLICT DO UPDATE of `writeNotifierCoverage`.
pub(crate) fn write_notifier_coverage_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    source_id: &str,
    c: &NotifierCoverage,
) -> Result<()> {
    if !DETECTION_MODES.contains(&c.mode.as_str()) {
        return Err(StoreError::invalid(format!(
            "detection_mode \"{}\" is not one of {DETECTION_MODES:?}",
            c.mode
        )));
    }
    let pid = pg_int(c.owner_pid, "ownerPid")?;
    let Some((incarnation, old)) = source_and_row(&*tx, source_id)? else {
        return Ok(());
    };
    let now = env.now_micros();
    let mut r = old.unwrap_or_else(|| NotifierSourceRecord::new(incarnation.clone(), now));
    r.observed_head = c.head.clone();
    r.observed_at_us = Some(now);
    r.detection_mode = Some(c.mode.clone());
    r.owner_host_id = Some(c.owner_host_id.clone());
    r.owner_kind = Some(c.owner_kind.clone());
    r.owner_pid = Some(pid);
    r.owner_seen_at_us = Some(now);
    r.source_incarnation = Some(incarnation);
    r.updated_at_us = now;
    put_json(tx, &source_row_key(source_id), &r)
}

/// The INSERT ... ON CONFLICT DO UPDATE ... WHERE of `recordNotifierSyncerHost`: nothing is
/// written when the row already names `host_id`. An update keeps the stored incarnation.
pub(crate) fn record_notifier_syncer_host_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    source_id: &str,
    host_id: &str,
) -> Result<()> {
    let Some((incarnation, old)) = source_and_row(&*tx, source_id)? else {
        return Ok(());
    };
    if old
        .as_ref()
        .is_some_and(|r| r.syncer_host_id.as_deref() == Some(host_id))
    {
        return Ok(());
    }
    let now = env.now_micros();
    let mut r = old.unwrap_or_else(|| NotifierSourceRecord::new(incarnation, now));
    r.syncer_host_id = Some(host_id.to_owned());
    r.syncer_recorded_at_us = Some(now);
    r.updated_at_us = now;
    put_json(tx, &source_row_key(source_id), &r)
}

/// The lease row of `host_id`, or `None` (a host id with NUL names no row).
fn lease_of(read: &dyn KvRead, host_id: &str) -> Result<Option<NotifierLeaseRecord>> {
    match lease_key(host_id) {
        Ok(key) => get_json(read, &key),
        Err(_) => Ok(None),
    }
}

/// The SELECT of `readNotifierStatusRows`: each source of `ids` (every source when `None`) that
/// is not archived, in id order, at most 200, with its notifier row and its owner's lease.
pub(crate) fn read_notifier_status_rows_in(
    read: &dyn KvRead,
    env: &dyn Env,
    ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    let now = env.now_micros();
    let mut sources = all_sources(read)?;
    sources.retain(|s| !s.archived && ids.is_none_or(|ids| ids.contains(&s.id)));
    sources.sort_by(|a, b| a.id.cmp(&b.id));
    sources.truncate(STATUS_LIMIT);
    let mut out = Vec::with_capacity(sources.len());
    for s in sources {
        let n = get_json::<NotifierSourceRecord>(read, &source_row_key(&s.id))?;
        let due_markers = source_markers(read, &s.id)?
            .iter()
            .filter(|m| is_due(m, last_commit_of(&s)))
            .count();
        let lease = match n.as_ref().and_then(|n| n.owner_host_id.as_deref()) {
            Some(host) => lease_of(read, host)?,
            None => None,
        };
        let n = n.as_ref();
        out.push(json!({
            "id": s.id,
            "last_commit": s.last_commit,
            "state": n.map(|n| n.state.clone()),
            "reason": n.and_then(|n| n.reason.clone()),
            "first_due_at": n.and_then(|n| n.first_due_at_us).map(iso),
            "attempts": n.map(|n| n.attempts),
            "next_retry_at": n.and_then(|n| n.next_retry_at_us).map(iso),
            "last_error_code": n.and_then(|n| n.last_error_code.clone()),
            "last_error": n.and_then(|n| n.last_error.clone()),
            "last_error_at": n.and_then(|n| n.last_error_at_us).map(iso),
            "trace_path": n.and_then(|n| n.trace_path.clone()),
            "observed_head": n.and_then(|n| n.observed_head.clone()),
            "observed_at": n.and_then(|n| n.observed_at_us).map(iso),
            "detection_mode": n.and_then(|n| n.detection_mode.clone()),
            "owner_host_id": n.and_then(|n| n.owner_host_id.clone()),
            "owner_kind": n.and_then(|n| n.owner_kind.clone()),
            "owner_pid": n.and_then(|n| n.owner_pid),
            "owner_seen_at": n.and_then(|n| n.owner_seen_at_us).map(iso),
            "lease_live": lease.as_ref().is_some_and(|l| l.expires_at_us > now),
            "lease_expires_at": lease.as_ref().map(|l| iso(l.expires_at_us)),
            "due_markers": due_markers,
        }));
    }
    Ok(out)
}

/// The SELECT EXISTS of `hasNotifierCoverage`: some row has an `observed_at`.
pub(crate) fn has_notifier_coverage_in(read: &dyn KvRead) -> Result<bool> {
    let mut covered = false;
    let mut failure = None;
    scan_prefix(
        read,
        &[keys::PERSISTENCE, super::NOTIFIER, SOURCE_ROW],
        false,
        &mut |_, v| {
            match serde_json::from_slice::<NotifierSourceRecord>(v) {
                Ok(r) => covered = r.observed_at_us.is_some(),
                Err(e) => failure = Some(StoreError::from(e)),
            }
            !covered && failure.is_none()
        },
    )?;
    failure.map_or(Ok(covered), Err)
}

/// The `ON DELETE CASCADE` of `sync_notifier_sources` and `sync_wanted_markers`: deleting a
/// source deletes its notifier row and its markers.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    tx.delete(&source_row_key(source_id))?;
    let Some(prefix) = marker_prefix(source_id) else {
        return Ok(());
    };
    let mut doomed = Vec::new();
    scan_prefix(&*tx, &prefix, false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for k in doomed {
        tx.delete(&k)?;
    }
    Ok(())
}

/// One marker read back with its source id and intent.
struct Marker {
    source_id: String,
    intent: String,
    record: WantedMarkerRecord,
}

/// A marker key's source id and intent.
fn split_marker_key(key: &[u8]) -> (String, String) {
    let rest = &key[3..];
    let nul = rest.iter().position(|b| *b == 0).unwrap_or(rest.len());
    let source_id = String::from_utf8_lossy(&rest[..nul]).into_owned();
    let intent = String::from_utf8_lossy(rest.get(nul + 1..).unwrap_or_default()).into_owned();
    (source_id, intent)
}

/// Every marker under `prefix`, in key order.
fn scan_markers(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<Marker>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, prefix, false, &mut |k, v| {
        match serde_json::from_slice::<WantedMarkerRecord>(v) {
            Ok(record) => {
                let (source_id, intent) = split_marker_key(k);
                out.push(Marker {
                    source_id,
                    intent,
                    record,
                });
            }
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// The markers of one source, in key order.
fn source_markers(read: &dyn KvRead, source_id: &str) -> Result<Vec<Marker>> {
    match marker_prefix(source_id) {
        Some(prefix) => scan_markers(read, &prefix),
        None => Ok(Vec::new()),
    }
}

/// The markers of `ids` (every marker when `None`), ordered by `first_due_at, source_id, intent`.
fn markers_of(read: &dyn KvRead, ids: Option<&[String]>) -> Result<Vec<Marker>> {
    let mut out = match ids {
        None => scan_markers(read, &[keys::PERSISTENCE, super::NOTIFIER, MARKER])?,
        Some(ids) => {
            let mut seen: Vec<&String> = ids.iter().collect();
            seen.sort();
            seen.dedup();
            let mut out = Vec::new();
            for id in seen {
                out.extend(source_markers(read, id)?);
            }
            out
        }
    };
    out.sort_by(|a, b| {
        (a.record.first_due_at_us, &a.source_id, &a.intent).cmp(&(
            b.record.first_due_at_us,
            &b.source_id,
            &b.intent,
        ))
    });
    Ok(out)
}

/// `m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM
/// s.last_commit`: a pull or full marker is due until a run clears it, a freshness marker while
/// `freshness_due` holds.
fn is_due(m: &Marker, last_commit: Option<&str>) -> bool {
    m.intent != "freshness" || freshness_due(m, last_commit)
}

/// A freshness marker still asks for work while its `wanted_head` is null or differs from the
/// source's `last_commit` (`wanted_head IS NULL OR wanted_head IS DISTINCT FROM s.last_commit`).
fn freshness_due(m: &Marker, last_commit: Option<&str>) -> bool {
    m.record.wanted_head.is_none() || m.record.wanted_head.as_deref() != last_commit
}

/// The source's `last_commit`, or `None` before its sync anchor first advanced.
fn last_commit_of(source: &SourceRecord) -> Option<&str> {
    source.last_commit.as_deref()
}

/// A marker row as `SELECT *` returns it.
fn marker_row(m: &Marker) -> Value {
    let r = &m.record;
    json!({
        "source_id": m.source_id,
        "intent": m.intent,
        "source_incarnation": r.source_incarnation,
        "wanted_head": r.wanted_head,
        "generation": r.generation,
        "first_due_at": iso(r.first_due_at_us),
        "updated_at": iso(r.updated_at_us),
        "requested_by": r.requested_by,
        "job_id": r.job_id,
    })
}

/// The INSERT ... SELECT ... ON CONFLICT DO UPDATE ... RETURNING * of `upsertWantedMarker`:
/// the row, or `None` when the source does not exist.
pub(crate) fn upsert_wanted_marker_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    m: &WantedMarkerInput,
) -> Result<Option<Value>> {
    if !MARKER_INTENTS.contains(&m.intent.as_str()) {
        return Err(StoreError::invalid(format!(
            "intent \"{}\" is not one of {MARKER_INTENTS:?}",
            m.intent
        )));
    }
    let Some(source) = read_source(&*tx, &m.source_id)? else {
        return Ok(None);
    };
    let Some(key) = marker_key(&m.source_id, &m.intent) else {
        return Ok(None);
    };
    let now = env.now_micros();
    let incarnation = Some(source.incarnation);
    let record = match get_json::<WantedMarkerRecord>(&*tx, &key)? {
        None => WantedMarkerRecord {
            source_incarnation: incarnation,
            wanted_head: m.wanted_head.clone(),
            generation: 1,
            first_due_at_us: now,
            updated_at_us: now,
            requested_by: m.requested_by.clone(),
            job_id: m.job_id,
        },
        Some(old) => WantedMarkerRecord {
            first_due_at_us: if old.source_incarnation != incarnation {
                now
            } else {
                old.first_due_at_us
            },
            source_incarnation: incarnation,
            wanted_head: m.wanted_head.clone(),
            generation: old.generation + 1,
            updated_at_us: now,
            requested_by: m.requested_by.clone(),
            job_id: m.job_id.or(old.job_id),
        },
    };
    put_json(tx, &key, &record)?;
    Ok(Some(marker_row(&Marker {
        source_id: m.source_id.clone(),
        intent: m.intent.clone(),
        record,
    })))
}

/// The UPDATE of `attachWantedMarkerJob`: `job_id` only while the marker is at `generation`.
pub(crate) fn attach_wanted_marker_job_in(
    tx: &mut dyn KvWrite,
    source_id: &str,
    intent: &str,
    generation: i64,
    job_id: i64,
) -> Result<()> {
    let Some(key) = marker_key(source_id, intent) else {
        return Ok(());
    };
    if let Some(mut r) = get_json::<WantedMarkerRecord>(&*tx, &key)?
        && r.generation == generation
    {
        r.job_id = Some(job_id);
        put_json(tx, &key, &r)?;
    }
    Ok(())
}

/// The SELECT * of `readWantedMarkers`.
pub(crate) fn read_wanted_markers_in(
    read: &dyn KvRead,
    ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    Ok(markers_of(read, ids)?
        .iter()
        .take(MARKER_LIMIT)
        .map(marker_row)
        .collect())
}

/// The SELECT m.* ... JOIN sources of `readDueWantedMarkers`.
pub(crate) fn read_due_wanted_markers_in(
    read: &dyn KvRead,
    ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for m in markers_of(read, ids)? {
        if out.len() == MARKER_LIMIT {
            break;
        }
        if let Some(source) = read_source(read, &m.source_id)?
            && is_due(&m, last_commit_of(&source))
        {
            out.push(marker_row(&m));
        }
    }
    Ok(out)
}

/// The DELETE of `pruneSatisfiedWantedMarkers`: each freshness or pull marker of an existing
/// source of `ids` whose head is set and equals the source's `last_commit`.
pub(crate) fn prune_satisfied_wanted_markers_in(
    tx: &mut dyn KvWrite,
    ids: &[String],
) -> Result<()> {
    let mut seen: Vec<&String> = ids.iter().collect();
    seen.sort();
    seen.dedup();
    for id in seen {
        let Some(source) = read_source(&*tx, id)? else {
            continue;
        };
        let Some(last_commit) = last_commit_of(&source) else {
            continue;
        };
        for intent in ["freshness", "pull"] {
            let Some(key) = marker_key(id, intent) else {
                continue;
            };
            if get_json::<WantedMarkerRecord>(&*tx, &key)?
                .is_some_and(|r| r.wanted_head.as_deref() == Some(last_commit))
            {
                tx.delete(&key)?;
            }
        }
    }
    Ok(())
}

/// The DELETE ... RETURNING of `clearWantedMarker`: true when the marker was at `generation`.
pub(crate) fn clear_wanted_marker_in(
    tx: &mut dyn KvWrite,
    source_id: &str,
    intent: &str,
    generation: i64,
) -> Result<bool> {
    let Some(key) = marker_key(source_id, intent) else {
        return Ok(false);
    };
    match get_json::<WantedMarkerRecord>(&*tx, &key)? {
        Some(r) if r.generation == generation => {
            tx.delete(&key)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// The DELETE of `settleFreshnessMarker`: the source's freshness marker at `generation` when
/// `wanted_head IS NULL OR wanted_head IS NOT DISTINCT FROM s.last_commit OR s.last_commit =
/// checkoutHead` (a null `last_commit` never equals the checkout head).
pub(crate) fn settle_freshness_marker_in(
    tx: &mut dyn KvWrite,
    source_id: &str,
    generation: i64,
    checkout_head: Option<&str>,
) -> Result<()> {
    let Some(key) = marker_key(source_id, "freshness") else {
        return Ok(());
    };
    let Some(r) = get_json::<WantedMarkerRecord>(&*tx, &key)? else {
        return Ok(());
    };
    let Some(source) = read_source(&*tx, source_id)? else {
        return Ok(());
    };
    let last_commit = last_commit_of(&source);
    let satisfied = r.wanted_head.is_none()
        || r.wanted_head.as_deref() == last_commit
        || (checkout_head.is_some() && last_commit.is_some() && last_commit == checkout_head);
    if r.generation == generation && satisfied {
        tx.delete(&key)?;
    }
    Ok(())
}

/// The SELECT of `listSourceWantedMarkers`: ordered by `first_due_at, intent`.
pub(crate) fn list_source_wanted_markers_in(
    read: &dyn KvRead,
    source_id: &str,
) -> Result<Vec<Value>> {
    let mut markers = source_markers(read, source_id)?;
    markers.sort_by(|a, b| {
        (a.record.first_due_at_us, &a.intent).cmp(&(b.record.first_due_at_us, &b.intent))
    });
    Ok(markers
        .iter()
        .map(|m| {
            json!({
                "intent": m.intent,
                "wanted_head": m.record.wanted_head,
                "first_due_at": iso(m.record.first_due_at_us),
                "requested_by": m.record.requested_by,
            })
        })
        .collect())
}

/// The SELECT of `readFirstDue`: one row per source of `ids` that exists (the SQL has no
/// `ORDER BY`; the caller builds a map), in id order. `observed_head` is the notifier row's, and
/// `first_due_at` the earlier of the row's (when its state is not idle) and the oldest due
/// freshness marker's (`LEAST` skips a NULL); both read only rows of the source's current
/// incarnation.
pub(crate) fn read_first_due_in(read: &dyn KvRead, ids: &[String]) -> Result<Vec<Value>> {
    let mut seen: Vec<&String> = ids.iter().collect();
    seen.sort();
    seen.dedup();
    let mut out = Vec::new();
    for id in seen {
        let Some(source) = read_source(read, id)? else {
            continue;
        };
        let incarnation = Some(source.incarnation.as_str());
        let row = get_json::<NotifierSourceRecord>(read, &source_row_key(id))?
            .filter(|n| n.source_incarnation.as_deref() == incarnation);
        let from_row = row
            .as_ref()
            .filter(|n| n.state != "idle")
            .and_then(|n| n.first_due_at_us);
        let from_marker = source_markers(read, id)?
            .iter()
            .filter(|m| {
                m.intent == "freshness"
                    && m.record.source_incarnation.as_deref() == incarnation
                    && is_due(m, source.last_commit.as_deref())
            })
            .map(|m| m.record.first_due_at_us)
            .min();
        let first_due = match (from_row, from_marker) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        out.push(json!({
            "source_id": id,
            "observed_head": row.and_then(|n| n.observed_head),
            "first_due_at": first_due.map(iso),
        }));
    }
    Ok(out)
}

/// The notifier's host source list: every source that is not archived, in id order.
pub(crate) fn list_notifier_host_source_rows_in(read: &dyn KvRead) -> Result<Vec<Value>> {
    let mut records = all_sources(read)?;
    records.retain(|r| !r.archived);
    records.sort_by(|a, b| a.id.cmp(&b.id));
    records
        .into_iter()
        .map(|r| {
            let syncer = get_json::<NotifierSourceRecord>(read, &source_row_key(&r.id))?
                .and_then(|n| n.syncer_host_id);
            Ok(json!({
                "id": r.id,
                "local_path": r.local_path,
                "last_commit": r.last_commit,
                "bound": false,
                "owner": Value::Null,
                "root": Value::Null,
                "syncer": syncer,
                "config": r.config,
            }))
        })
        .collect()
}

/// `readSourceSyncShape(sourceId)`: a source that exists and is not archived, as a sync request sees it. The store
/// keeps no managed worktree bindings, so `root` is null and `bound` false; `None` for a missing or archived source.
pub(crate) fn read_source_sync_shape_in(
    read: &dyn KvRead,
    source_id: &str,
) -> Result<Option<Value>> {
    Ok(read_source(read, source_id)?
        .filter(|r| !r.archived)
        .map(|r| json!({ "local_path": r.local_path, "root": Value::Null, "bound": false })))
}

/// The SELECT of `readNotifierFirstDue(sourceIds)`: one row per existing source of `ids` (archived
/// included), in id order. `observed_head` comes from the notifier row at the source's current
/// incarnation; `first_due_at` is the earlier of that row's `first_due_at` when its state is not
/// idle and the oldest freshness marker at the current incarnation whose `wanted_head` is null or
/// differs from the source's `last_commit`.
pub(crate) fn read_notifier_first_due_in(read: &dyn KvRead, ids: &[String]) -> Result<Vec<Value>> {
    let mut seen: Vec<&String> = ids.iter().collect();
    seen.sort();
    seen.dedup();
    let mut out = Vec::new();
    for id in seen {
        let Some(source) = read_source(read, id)? else {
            continue;
        };
        let incarnation = Some(source.incarnation.as_str());
        let row = get_json::<NotifierSourceRecord>(read, &source_row_key(id))?
            .filter(|n| n.source_incarnation.as_deref() == incarnation);
        let from_row = row
            .as_ref()
            .filter(|n| n.state != "idle")
            .and_then(|n| n.first_due_at_us);
        let from_marker = source_markers(read, id)?
            .iter()
            .filter(|m| {
                m.intent == "freshness"
                    && m.record.source_incarnation.as_deref() == incarnation
                    && freshness_due(m, last_commit_of(&source))
            })
            .map(|m| m.record.first_due_at_us)
            .min();
        let first_due = [from_row, from_marker].into_iter().flatten().min();
        out.push(json!({
            "source_id": source.id,
            "observed_head": row.and_then(|n| n.observed_head),
            "first_due_at": first_due.map(iso),
        }));
    }
    Ok(out)
}

impl Store {
    /// `claimNotifierLease(l)`.
    pub fn claim_notifier_lease(&self, claim: &NotifierLeaseClaim) -> Result<Value> {
        self.write(|tx| claim_notifier_lease_in(tx, &*self.env, claim))
    }

    /// `readNotifierLease(hostId)`.
    pub fn read_notifier_lease(&self, host_id: &str) -> Result<Option<Value>> {
        read_notifier_lease_in(&*self.read()?, &*self.env, host_id)
    }

    /// `holdsNotifierLease(hostId, ownerId, fence)`.
    pub fn holds_notifier_lease(&self, host_id: &str, owner_id: &str, fence: f64) -> Result<bool> {
        holds_notifier_lease_in(&*self.read()?, &*self.env, host_id, owner_id, fence)
    }

    /// `releaseNotifierLease(hostId, ownerId)`: one write.
    pub fn release_notifier_lease(&self, host_id: &str, owner_id: &str) -> Result<()> {
        self.write(|tx| release_notifier_lease_in(tx, &*self.env, host_id, owner_id))
    }

    /// `readNotifierSources(ids)`.
    pub fn read_notifier_sources(&self, ids: Option<&[String]>) -> Result<Vec<Value>> {
        read_notifier_sources_in(&*self.read()?, ids)
    }

    /// `writeNotifierState(sourceId, patch)`: one write.
    pub fn write_notifier_state(&self, source_id: &str, patch: &NotifierStatePatch) -> Result<()> {
        self.write(|tx| write_notifier_state_in(tx, &*self.env, source_id, patch))
    }

    /// `writeNotifierCoverage(sourceId, coverage)`: one write.
    pub fn write_notifier_coverage(
        &self,
        source_id: &str,
        coverage: &NotifierCoverage,
    ) -> Result<()> {
        self.write(|tx| write_notifier_coverage_in(tx, &*self.env, source_id, coverage))
    }

    /// `recordNotifierSyncerHost(sourceId, hostId)`: one write.
    pub fn record_notifier_syncer_host(&self, source_id: &str, host_id: &str) -> Result<()> {
        self.write(|tx| record_notifier_syncer_host_in(tx, &*self.env, source_id, host_id))
    }

    /// `readNotifierStatusRows(ids)`.
    pub fn read_notifier_status_rows(&self, ids: Option<&[String]>) -> Result<Vec<Value>> {
        read_notifier_status_rows_in(&*self.read()?, &*self.env, ids)
    }

    /// `hasNotifierCoverage()`.
    pub fn has_notifier_coverage(&self) -> Result<bool> {
        has_notifier_coverage_in(&*self.read()?)
    }

    /// `readFirstDue(sourceIds)`.
    pub fn read_first_due(&self, ids: &[String]) -> Result<Vec<Value>> {
        read_first_due_in(&*self.read()?, ids)
    }

    /// `listNotifierHostSourceRows()`.
    pub fn list_notifier_host_source_rows(&self) -> Result<Vec<Value>> {
        list_notifier_host_source_rows_in(&*self.read()?)
    }

    /// `upsertWantedMarker(marker)`: one write; `None` when the source does not exist.
    pub fn upsert_wanted_marker(&self, marker: &WantedMarkerInput) -> Result<Option<Value>> {
        self.write(|tx| upsert_wanted_marker_in(tx, &*self.env, marker))
    }

    /// `attachWantedMarkerJob(sourceId, intent, generation, jobId)`: one write.
    pub fn attach_wanted_marker_job(
        &self,
        source_id: &str,
        intent: &str,
        generation: i64,
        job_id: i64,
    ) -> Result<()> {
        self.write(|tx| attach_wanted_marker_job_in(tx, source_id, intent, generation, job_id))
    }

    /// `readWantedMarkers(sourceIds)`.
    pub fn read_wanted_markers(&self, ids: Option<&[String]>) -> Result<Vec<Value>> {
        read_wanted_markers_in(&*self.read()?, ids)
    }

    /// `readDueWantedMarkers(sourceIds)`.
    pub fn read_due_wanted_markers(&self, ids: Option<&[String]>) -> Result<Vec<Value>> {
        read_due_wanted_markers_in(&*self.read()?, ids)
    }

    /// `pruneSatisfiedWantedMarkers(sourceIds)`: one write.
    pub fn prune_satisfied_wanted_markers(&self, ids: &[String]) -> Result<()> {
        self.write(|tx| prune_satisfied_wanted_markers_in(tx, ids))
    }

    /// `clearWantedMarker(sourceId, intent, generation)`: one write.
    pub fn clear_wanted_marker(
        &self,
        source_id: &str,
        intent: &str,
        generation: i64,
    ) -> Result<bool> {
        self.write(|tx| clear_wanted_marker_in(tx, source_id, intent, generation))
    }

    /// `settleFreshnessMarker(sourceId, generation, checkoutHead)`: one write.
    pub fn settle_freshness_marker(
        &self,
        source_id: &str,
        generation: i64,
        checkout_head: Option<&str>,
    ) -> Result<()> {
        self.write(|tx| settle_freshness_marker_in(tx, source_id, generation, checkout_head))
    }

    /// `listSourceWantedMarkers(sourceId)`.
    pub fn list_source_wanted_markers(&self, source_id: &str) -> Result<Vec<Value>> {
        list_source_wanted_markers_in(&*self.read()?, source_id)
    }

    /// `readSourceSyncShape(sourceId)`.
    pub fn read_source_sync_shape(&self, source_id: &str) -> Result<Option<Value>> {
        read_source_sync_shape_in(&*self.read()?, source_id)
    }

    /// `readNotifierFirstDue(sourceIds)`.
    pub fn read_notifier_first_due(&self, ids: &[String]) -> Result<Vec<Value>> {
        read_notifier_first_due_in(&*self.read()?, ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every key under `prefix`: from the prefix itself up to (not including) the prefix with
    /// its last byte plus one.
    fn range(prefix: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut end = prefix.to_vec();
        *end.last_mut().unwrap() += 1;
        (prefix.to_vec(), end)
    }

    #[test]
    fn the_notifier_key_range_does_not_overlap_the_effect_and_checkpoint_path_range() {
        // `d 0x05` (effect rows), `d 0x06` (effect order) and `d 0x07` (operation checkpoint
        // paths) are taken by another change; the notifier owns `d 0x08` alone.
        let (taken_start, _) = range(&[keys::PERSISTENCE, 0x05]);
        let (_, taken_end) = range(&[keys::PERSISTENCE, 0x07]);
        let (start, end) = range(&[keys::PERSISTENCE, super::super::NOTIFIER]);
        assert!(
            start >= taken_end || end <= taken_start,
            "notifier range overlaps d 0x05-0x07"
        );
        for host in [
            "",
            "00000000-0000-4000-8000-00000000a001",
            "\u{ff}\u{ff}",
            "host\u{1}",
        ] {
            let key = lease_key(host).unwrap();
            assert!(
                key.as_slice() >= start.as_slice() && key.as_slice() < end.as_slice(),
                "{host:?}"
            );
            assert!(!(taken_start.as_slice()..taken_end.as_slice()).contains(&key.as_slice()));
        }
        // Nor does it share a byte with this family's other rows.
        for other in [
            super::super::COUNTER,
            super::super::HOUSEKEEPING,
            super::super::TOPOLOGY,
            super::super::QUEUE,
        ] {
            assert_ne!(other, super::super::NOTIFIER);
        }
    }

    #[test]
    fn a_source_row_key_sits_in_its_own_range_apart_from_the_leases() {
        let (lease_start, lease_end) = range(&[keys::PERSISTENCE, super::super::NOTIFIER, LEASE]);
        let (start, end) = range(&[keys::PERSISTENCE, super::super::NOTIFIER, SOURCE_ROW]);
        assert!(
            start >= lease_end || end <= lease_start,
            "source rows overlap the leases"
        );
        for id in ["", "default", "\u{ff}\u{ff}", "a\u{1}"] {
            let key = source_row_key(id);
            assert!(
                key.as_slice() >= start.as_slice() && key.as_slice() < end.as_slice(),
                "{id:?}"
            );
            assert!(!(lease_start.as_slice()..lease_end.as_slice()).contains(&key.as_slice()));
        }
    }

    #[test]
    fn a_source_delete_removes_its_notifier_row_only() {
        let store = crate::test_support::store();
        for id in ["a", "ab"] {
            let input = crate::sources::SourceInput {
                id: id.into(),
                ..crate::sources::SourceInput::default()
            };
            store.upsert_source(&input).unwrap();
            store.record_notifier_syncer_host(id, "host-s").unwrap();
        }
        store
            .write(|tx| crate::cascade::remove_source_rows(tx, "a"))
            .unwrap();
        let left: Vec<Value> = store
            .read_notifier_sources(None)
            .unwrap()
            .iter()
            .map(|r| r["source_id"].clone())
            .collect();
        assert_eq!(left, vec![json!("ab")]);
    }

    #[test]
    fn a_marker_key_sits_in_its_own_range_apart_from_the_leases_and_source_rows() {
        let (start, end) = range(&[keys::PERSISTENCE, super::super::NOTIFIER, MARKER]);
        for other in [LEASE, SOURCE_ROW] {
            let (o_start, o_end) = range(&[keys::PERSISTENCE, super::super::NOTIFIER, other]);
            assert!(start >= o_end || end <= o_start, "markers overlap {other}");
        }
        for id in ["", "default", "\u{ff}\u{ff}", "a\u{1}"] {
            for intent in MARKER_INTENTS {
                let key = marker_key(id, intent).unwrap();
                assert!(
                    key.as_slice() >= start.as_slice() && key.as_slice() < end.as_slice(),
                    "{id:?}"
                );
                assert_eq!(
                    split_marker_key(&key),
                    (id.to_owned(), (*intent).to_owned())
                );
            }
        }
        // One source's prefix never covers another source's markers: "a" stops at its NUL.
        let a = marker_prefix("a").unwrap();
        assert!(!marker_key("ab", "pull").unwrap().starts_with(&a));
        assert!(marker_prefix("a\0b").is_none());
    }

    #[test]
    fn a_source_delete_removes_its_markers_only() {
        let store = crate::test_support::store();
        for id in ["a", "ab"] {
            let input = crate::sources::SourceInput {
                id: id.into(),
                ..crate::sources::SourceInput::default()
            };
            store.upsert_source(&input).unwrap();
            for intent in ["freshness", "pull"] {
                let m = WantedMarkerInput {
                    source_id: id.into(),
                    intent: intent.into(),
                    wanted_head: None,
                    requested_by: "webhook".into(),
                    job_id: None,
                };
                assert!(store.upsert_wanted_marker(&m).unwrap().is_some());
            }
        }
        store
            .write(|tx| crate::cascade::remove_source_rows(tx, "a"))
            .unwrap();
        let left: Vec<Value> = store
            .read_wanted_markers(None)
            .unwrap()
            .iter()
            .map(|r| r["source_id"].clone())
            .collect();
        assert_eq!(left, vec![json!("ab"), json!("ab")]);
    }

    #[test]
    fn a_host_id_with_nul_is_refused() {
        assert!(lease_key("a\0b").is_err());
    }
}
