//! The writer-version reads (`src/core/engine-sql/writer-versions.ts`): which binaries admitted and
//! published the retained write requests, from the `admitter_*` and `consumer_*` stamps in each
//! request's `extra` columns.
//!
//! The cutoff (`persistence_brain.writer_version_cutoff`, the moment migration 178 started stamping
//! requests on Postgres) is the brain's creation time here: a Rust brain stamps every request it
//! admits from birth. No request is bound to a worktree on this engine (`persistence.rs`), so an
//! unstamped consumer has no owner host to fall back to.

use super::all_requests;
use crate::env::{iso, parse_iso};
use crate::error::Result;
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use crate::{Store, StoredFormat, get_json, keys};
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::BTreeMap;

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

impl Store {
    /// `readWriterVersionCutoff()`.
    pub fn read_writer_version_cutoff(&self) -> Result<Option<String>> {
        read_writer_version_cutoff_in(&*self.read()?)
    }

    /// `listWriterVersions(limit)`.
    pub fn list_writer_versions(&self, limit: f64) -> Result<Vec<Value>> {
        list_writer_versions_in(&*self.read()?, limit)
    }
}
