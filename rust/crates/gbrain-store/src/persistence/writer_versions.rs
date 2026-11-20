//! The writer-version reads (`src/core/engine-sql/writer-versions.ts`): which binaries admitted and
//! published the retained write requests, from the `admitter_*` and `consumer_*` stamps in each
//! request's `extra` columns.
//!
//! The cutoff (`persistence_brain.writer_version_cutoff`, the moment migration 178 started stamping
//! requests on Postgres) is the brain's creation time here: a Rust brain stamps every request it
//! admits from birth. An unstamped consumer falls back to the owner host of its request's
//! worktree (`persistence_worktrees`, `worktree_rows.rs`), as `COALESCE(consumer_host_id,
//! w.owner_host_id)` does.
//!
//! The segmented-storage gate's evidence (`readSegmentedGateEvidence`) also reads the ingest
//! log's writer stamps (`stats.rs`). No `persistence_consumers` row exists here, so the resident
//! arm reads no rows.

use super::all_requests;
use crate::env::{Env, iso, parse_iso};
use crate::error::Result;
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use crate::{Store, StoredFormat, get_json, keys};
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::BTreeMap;

const DAY_US: f64 = 86_400_000_000.0;

fn text(r: &RequestRecord, column: &str) -> Option<String> {
    r.extra
        .get(column)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn principal(r: &RequestRecord) -> String {
    format!("{}:{}", r.principal_kind, r.principal_id)
}

/// `COALESCE(published_at, completed_at)`.
fn publication(r: &RequestRecord) -> Option<i64> {
    r.extra
        .get("published_at")
        .and_then(Value::as_str)
        .and_then(parse_iso)
        .or(r.completed_at_us)
}

/// One role's row before projection: (host, principal, version) and the time it last acted.
struct Seen {
    role: &'static str,
    host_id: Option<String>,
    principal: String,
    version: Option<String>,
    last_seen: Option<i64>,
    requests: i64,
}

impl Seen {
    fn row(&self, with_count: bool) -> Value {
        let mut row = json!({
            "role": self.role,
            "host_id": self.host_id,
            "principal": self.principal,
            "version": self.version,
            "last_seen": self.last_seen.map(iso),
        });
        if with_count {
            row["requests"] = json!(self.requests);
        }
        row
    }
}

/// `ORDER BY last_seen DESC`: Postgres puts NULL first in a descending order. Ties fall back to
/// role, host and principal so the answer is the same on every read.
fn newest_first(a: &Seen, b: &Seen) -> Ordering {
    match (a.last_seen, b.last_seen) {
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (x, y) => y.cmp(&x),
    }
    .then_with(|| a.role.cmp(b.role))
    .then_with(|| a.host_id.cmp(&b.host_id))
    .then_with(|| a.principal.cmp(&b.principal))
    .then_with(|| a.version.cmp(&b.version))
}

/// When the brain started stamping writer versions: its creation time.
pub(crate) fn read_writer_version_cutoff_in(read: &dyn KvRead) -> Result<Option<String>> {
    let format: Option<StoredFormat> = get_json(read, &keys::meta("format"))?;
    Ok(format.map(|f| iso(f.created_at_us)))
}

/// `LIST_WRITER_VERSIONS_SQL`: per role, the latest request for each host and principal
/// (`DISTINCT ON`), newest first, at most `limit`.
pub(crate) fn list_writer_versions_in(read: &dyn KvRead, limit: f64) -> Result<Vec<Value>> {
    let mut latest: BTreeMap<(&'static str, Option<String>, String), Seen> = BTreeMap::new();
    let mut keep = |seen: Seen| {
        let key = (seen.role, seen.host_id.clone(), seen.principal.clone());
        match latest.get(&key) {
            Some(old) if old.last_seen >= seen.last_seen => {}
            _ => {
                latest.insert(key, seen);
            }
        }
    };
    for r in all_requests(read)? {
        keep(Seen {
            role: "admitter",
            host_id: text(&r, "admitter_host_id"),
            principal: principal(&r),
            version: text(&r, "admitter_version"),
            last_seen: Some(r.created_at_us),
            requests: 1,
        });
        if r.state == "committed" {
            keep(Seen {
                role: "consumer",
                host_id: text(&r, "consumer_host_id"),
                principal: principal(&r),
                version: text(&r, "consumer_version"),
                last_seen: publication(&r),
                requests: 1,
            });
        }
    }
    let mut rows: Vec<Seen> = latest.into_values().collect();
    rows.sort_by(newest_first);
    let limit = if limit.is_finite() && limit > 0.0 {
        limit as usize
    } else {
        0
    };
    Ok(rows.iter().take(limit).map(|s| s.row(false)).collect())
}

/// `RECENT_WRITER_VERSIONS_SQL`: committed requests published in the last `days`, grouped per
/// role, host, principal and version. Admitters count when admitted at or after the cutoff and
/// consumers when published at or after it. No cutoff (no format record) reads no rows, as the
/// statement's `CROSS JOIN cutoff` does.
pub(crate) fn recent_writer_versions_in(
    read: &dyn KvRead,
    env: &dyn Env,
    days: f64,
) -> Result<Vec<Value>> {
    let format: Option<StoredFormat> = get_json(read, &keys::meta("format"))?;
    let Some(cutoff) = format.map(|f| f.created_at_us) else {
        return Ok(Vec::new());
    };
    let since = window_start(env, days)?;
    type Group = (&'static str, Option<String>, String, Option<String>);
    let mut groups: BTreeMap<Group, Seen> = BTreeMap::new();
    let mut add = |seen: Seen| {
        let key = (
            seen.role,
            seen.host_id.clone(),
            seen.principal.clone(),
            seen.version.clone(),
        );
        let at = seen.last_seen;
        let entry = groups.entry(key).or_insert(Seen {
            requests: 0,
            last_seen: None,
            ..seen
        });
        entry.requests += 1;
        entry.last_seen = entry.last_seen.max(at);
    };
    for r in all_requests(read)? {
        let Some(published) = publication(&r) else {
            continue;
        };
        if r.state != "committed" || published < since {
            continue;
        }
        if r.created_at_us >= cutoff {
            add(Seen {
                role: "admitter",
                host_id: text(&r, "admitter_host_id"),
                principal: principal(&r),
                version: text(&r, "admitter_version"),
                last_seen: Some(r.created_at_us),
                requests: 1,
            });
        }
        if published >= cutoff {
            add(Seen {
                role: "consumer",
                host_id: text(&r, "consumer_host_id"),
                principal: principal(&r),
                version: text(&r, "consumer_version"),
                last_seen: Some(published),
                requests: 1,
            });
        }
    }
    let mut rows: Vec<Seen> = groups.into_values().collect();
    rows.sort_by(newest_first);
    Ok(rows.iter().map(|s| s.row(true)).collect())
}

/// The earliest time Postgres stores, 4714-11-24 BC 00:00 UTC, in microseconds since 1970.
const MIN_TIMESTAMP_US: i128 = -210_866_803_200_000_000;

/// `now() - (days::double precision * interval '1 day')`, refused as Postgres refuses it: a day
/// count that is not finite or does not fit the interval's 32-bit day field is `interval out of
/// range`, and a start before the earliest stored time, or past the latest this store's clock
/// holds, is `timestamp out of range`. Nothing wraps or saturates.
fn window_start(env: &dyn Env, days: f64) -> Result<i64> {
    let out_of_range = |what: &str| {
        crate::error::StoreError::new(
            crate::error::INVALID_ARGUMENT,
            format!("{what} out of range: {days} days"),
        )
    };
    if !days.is_finite() || days.trunc() > f64::from(i32::MAX) || days.trunc() < f64::from(i32::MIN)
    {
        return Err(out_of_range("interval"));
    }
    // |days| < 2^31, so the span is under 2^31 * 8.64e10 < 2^68 microseconds: exact in i128.
    let since = i128::from(env.now_micros()) - (days * DAY_US) as i128;
    if since < MIN_TIMESTAMP_US {
        return Err(out_of_range("timestamp"));
    }
    i64::try_from(since).map_err(|_| out_of_range("timestamp"))
}

/// One gate group: (role, host, principal, version, segment reader).
type GateGroup = (&'static str, Option<String>, String, Option<String>, bool);

/// One gate group's window aggregates: `MAX` and `MIN` of its time and `COUNT(*)`.
struct GateSeen {
    last_seen: i64,
    first_seen: i64,
    requests: i64,
}

/// `READ_SEGMENTED_GATE_EVIDENCE_SQL`: every writer seen at or after `now - days`, grouped per
/// role, host, principal, version and segment-reader mark, newest first. Admitters count in any
/// state; consumers when committed and published in the window, with the worktree owner for an
/// unstamped host; importers per ingest log row. `days` must be finite, as the
/// `double precision` interval needs.
pub(crate) fn segmented_gate_evidence_in(
    read: &dyn KvRead,
    env: &dyn Env,
    days: f64,
) -> Result<Vec<Value>> {
    let since = window_start(env, days)?;
    let mut groups: BTreeMap<GateGroup, GateSeen> = BTreeMap::new();
    let mut add = |key: GateGroup, at: i64| {
        let g = groups.entry(key).or_insert(GateSeen {
            last_seen: at,
            first_seen: at,
            requests: 0,
        });
        g.requests += 1;
        g.last_seen = g.last_seen.max(at);
        g.first_seen = g.first_seen.min(at);
    };
    let flag = |r: &RequestRecord, column: &str| r.extra.get(column) == Some(&Value::Bool(true));
    for r in all_requests(read)? {
        if r.created_at_us >= since {
            add(
                (
                    "admitter",
                    text(&r, "admitter_host_id"),
                    principal(&r),
                    text(&r, "admitter_version"),
                    flag(&r, "admitter_segment_reader"),
                ),
                r.created_at_us,
            );
        }
        let Some(published) = publication(&r) else {
            continue;
        };
        if r.state != "committed" || published < since {
            continue;
        }
        let host = match text(&r, "consumer_host_id") {
            Some(h) => Some(h),
            None => match super::write_claim_terms::worktree_of(&r) {
                Some(w) => super::worktree_rows::read_worktree_row(read, &w)?
                    .and_then(|row| row.owner_host_id),
                None => None,
            },
        };
        add(
            (
                "consumer",
                host,
                principal(&r),
                text(&r, "consumer_version"),
                flag(&r, "consumer_segment_reader"),
            ),
            published,
        );
    }
    for l in crate::stats::ingest_writers_since(read, since)? {
        add(
            (
                "importer",
                l.writer_host_id,
                format!("ingest:{}", l.source_type),
                l.writer_version,
                l.segment_reader,
            ),
            l.created_at_us,
        );
    }
    let mut rows: Vec<(GateGroup, GateSeen)> = groups.into_iter().collect();
    // `ORDER BY last_seen DESC`; ties fall back to the group key so every read answers the same.
    rows.sort_by(|(ka, a), (kb, b)| b.last_seen.cmp(&a.last_seen).then_with(|| ka.cmp(kb)));
    Ok(rows
        .into_iter()
        .map(|((role, host_id, principal, version, segment_reader), g)| {
            json!({
                "role": role,
                "host_id": host_id,
                "principal": principal,
                "version": version,
                "segment_reader": segment_reader,
                "last_seen": iso(g.last_seen),
                "requests": g.requests,
                "first_seen": iso(g.first_seen),
            })
        })
        .collect())
}

impl Store {
    /// `readSegmentedGateEvidence(days)`.
    pub fn read_segmented_gate_evidence(&self, days: f64) -> Result<Vec<Value>> {
        segmented_gate_evidence_in(&*self.read()?, &*self.env, days)
    }

    /// `readWriterVersionCutoff()`.
    pub fn read_writer_version_cutoff(&self) -> Result<Option<String>> {
        read_writer_version_cutoff_in(&*self.read()?)
    }

    /// `listWriterVersions(limit)`.
    pub fn list_writer_versions(&self, limit: f64) -> Result<Vec<Value>> {
        list_writer_versions_in(&*self.read()?, limit)
    }

    /// `recentWriterVersions(days)`.
    pub fn recent_writer_versions(&self, days: f64) -> Result<Vec<Value>> {
        recent_writer_versions_in(&*self.read()?, &*self.env, days)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct At(i64);
    impl Env for At {
        fn now_micros(&self) -> i64 {
            self.0
        }
        fn new_uuid(&self) -> String {
            String::new()
        }
    }

    /// 2026-01-01 00:00 UTC.
    const NOW: i64 = 1_767_225_600_000_000;

    fn refusal(days: f64) -> String {
        window_start(&At(NOW), days).unwrap_err().message
    }

    #[test]
    fn the_window_start_refuses_a_day_count_as_postgres_does() {
        assert_eq!(
            window_start(&At(NOW), 7.0).unwrap(),
            NOW - 7 * 86_400_000_000
        );
        assert_eq!(window_start(&At(NOW), -1.5).unwrap(), NOW + 129_600_000_000);
        // A million days back is 712 BC and a hundred million ahead is year 275,000: both stored.
        assert!(window_start(&At(NOW), 1e6).is_ok());
        assert!(window_start(&At(NOW), -1e8).is_ok());
        for days in [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            1e10,
            -1e10,
            1e100,
            -1e100,
            2.5e9,
        ] {
            assert!(
                refusal(days).starts_with("interval out of range"),
                "{days}: {}",
                refusal(days)
            );
        }
        for days in [3e6, 1e8, -1e9] {
            assert!(
                refusal(days).starts_with("timestamp out of range"),
                "{days}: {}",
                refusal(days)
            );
        }
        assert_eq!(
            window_start(&At(NOW), 1e6).map(|_| ()).map_err(|e| e.code),
            Ok(())
        );
        assert_eq!(
            window_start(&At(NOW), 1e100).unwrap_err().code,
            crate::error::INVALID_ARGUMENT
        );
    }
}
