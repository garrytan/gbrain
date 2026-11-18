//! The writer-version reads (`src/core/engine-sql/writer-versions.ts`): which binaries admitted and
//! published the retained write requests, from the `admitter_*` and `consumer_*` stamps in each
//! request's `extra` columns.
//!
//! The cutoff (`persistence_brain.writer_version_cutoff`, the moment migration 178 started stamping
//! requests on Postgres) is the brain's creation time here: a Rust brain stamps every request it
//! admits from birth. No request is bound to a worktree on this engine (`persistence.rs`), so an
//! unstamped consumer has no owner host to fall back to.

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
    let since = env.now_micros() - (days * DAY_US) as i64;
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

impl Store {
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
