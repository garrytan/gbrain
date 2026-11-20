//! Git sync holds: the statements of `src/core/engine-sql/git-holds.ts` (rust/docs/store/repair-bookkeeping.md,
//! "Git holds").
//!
//! A hold is one `sync-hold` op checkpoint per (source, incarnation, path); its source's summary is one
//! `sync-hold-summary` checkpoint per (source, incarnation) with the hold count and seven counters. Each write here is
//! one store write, so the compare-and-set of a hold and the summary counters it moves land together.

use super::housekeeping::HousekeepingRow;
use super::op_checkpoint::{
    op_checkpoint_completed_keys, parent_key, write_op_checkpoint_record_in,
};
use crate::cli_reads::pg_text::fm_text;
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::repair_plan_scans::SourceHoldRecord;
use crate::sources::read_source;
use crate::{Store, get_json, put_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

const GIT_HOLD_OP: &str = "sync-hold";
const GIT_HOLD_SUMMARY_OP: &str = "sync-hold-summary";
const GIT_HOLD_RETRY_OP: &str = "sync-hold-retry";

/// What a swap adds to the summary's `count` and each counter; each result is clamped at zero.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct GitHoldSummaryDelta {
    pub count: i64,
    pub stale: i64,
    pub images: i64,
    pub fences: i64,
    pub concurrent: i64,
    pub stalled: i64,
    pub dirty: i64,
    pub drift: i64,
}

impl GitHoldSummaryDelta {
    /// `count` then the counters, in the order `adjustSummary` writes them.
    fn fields(&self) -> [(&'static str, i64); 8] {
        [
            ("count", self.count),
            ("stale", self.stale),
            ("images", self.images),
            ("fences", self.fences),
            ("concurrent", self.concurrent),
            ("stalled", self.stalled),
            ("dirty", self.dirty),
            ("drift", self.drift),
        ]
    }
}

fn hold_fingerprint(source_id: &str, incarnation: &str, path: &str) -> String {
    format!("{source_id}:{incarnation}:{path}")
}

fn summary_fingerprint(source_id: &str, incarnation: &str) -> String {
    format!("{source_id}:{incarnation}")
}

/// jsonb equality: numbers by value, objects by key set, arrays element by element.
fn jsonb_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(l, r)| jsonb_eq(l, r))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| jsonb_eq(v, w)))
        }
        _ => a == b,
    }
}

/// `(x->>'name')::int`, null or absent as 0: a number, or text holding an integer.
fn counter_of(record: &Map<String, Value>, name: &str) -> i64 {
    match record.get(name) {
        Some(Value::Number(n)) => n
            .as_i64()
            .unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// `lockSummary`: the summary row created with a zero count, or its stamp moved to now.
fn lock_summary(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    source_id: &str,
    incarnation: &str,
) -> Result<()> {
    let key = parent_key(
        GIT_HOLD_SUMMARY_OP,
        &summary_fingerprint(source_id, incarnation),
    )?;
    let completed_keys = match get_json::<HousekeepingRow>(&*tx, &key)? {
        Some(row) => row.completed_keys,
        None => {
            json!([{ "source_id": source_id, "incarnation": incarnation, "count": 0, "stale": 0 }])
        }
    };
    put_json(
        tx,
        &key,
        &HousekeepingRow {
            completed_keys,
            updated_at_us: env.now_micros(),
        },
    )
}

/// `adjustSummary`: the summary's count and counters moved by `delta`, each clamped at zero.
fn adjust_summary(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    source_id: &str,
    incarnation: &str,
    delta: &GitHoldSummaryDelta,
) -> Result<()> {
    let key = parent_key(
        GIT_HOLD_SUMMARY_OP,
        &summary_fingerprint(source_id, incarnation),
    )?;
    let Some(row) = get_json::<HousekeepingRow>(&*tx, &key)? else {
        return Ok(());
    };
    let mut record = match row.completed_keys.get(0) {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    for (name, step) in delta.fields() {
        let next = (counter_of(&record, name) + step).max(0);
        record.insert(name.to_owned(), json!(next));
    }
    put_json(
        tx,
        &key,
        &HousekeepingRow {
            completed_keys: json!([Value::Object(record)]),
            updated_at_us: env.now_micros(),
        },
    )
}

/// `swapGitHold`: the hold row at `path` replaced by `next` (`None` deletes it) when it still holds `prior` (`None`: no
/// row). With `summary`, the summary row is created or stamped first, and its counters move when the swap lands.
#[allow(clippy::too_many_arguments)]
pub(crate) fn swap_git_hold_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    source_id: &str,
    incarnation: &str,
    path: &str,
    prior: Option<&Value>,
    next: Option<&Value>,
    summary: Option<&GitHoldSummaryDelta>,
) -> Result<bool> {
    if prior.is_none() && next.is_none() {
        return Err(StoreError::invalid(
            "swapGitHold: prior and next cannot both be null",
        ));
    }
    if summary.is_some() {
        lock_summary(tx, env, source_id, incarnation)?;
    }
    let fingerprint = hold_fingerprint(source_id, incarnation, path);
    let current = get_json::<HousekeepingRow>(&*tx, &parent_key(GIT_HOLD_OP, &fingerprint)?)?;
    let hit = match (prior, &current) {
        (None, None) => true,
        (Some(prior), Some(row)) => jsonb_eq(prior, &row.completed_keys),
        _ => false,
    };
    if !hit {
        return Ok(false);
    }
    write_op_checkpoint_record_in(tx, env, GIT_HOLD_OP, &fingerprint, next)?;
    if let Some(delta) = summary.filter(|delta| delta.fields().iter().any(|(_, step)| *step != 0)) {
        adjust_summary(tx, env, source_id, incarnation, delta)?;
    }
    Ok(true)
}

/// `readGitHoldRecord`: the hold record at `path` with its source's read-only-mirror flag; `None` without a record.
pub(crate) fn read_git_hold_record_in(
    read: &dyn KvRead,
    source_id: &str,
    incarnation: &str,
    path: &str,
) -> Result<Option<SourceHoldRecord>> {
    let keys = op_checkpoint_completed_keys(
        read,
        GIT_HOLD_OP,
        &hold_fingerprint(source_id, incarnation, path),
    )?;
    let Some(record) = keys
        .as_ref()
        .and_then(|keys| keys.get(0))
        .filter(|record| !record.is_null())
    else {
        return Ok(None);
    };
    let mirror_read_only = read_source(read, source_id)?.is_some_and(|source| {
        fm_text(&source.config, "mirror_read_only").as_deref() == Some("true")
    });
    Ok(Some(SourceHoldRecord {
        record: record.clone(),
        mirror_read_only,
    }))
}

/// `requestGitHoldRetry`: the source's retry request holds the union of its paths and `paths`, once each in byte order,
/// stamped `requested_at`.
pub(crate) fn request_git_hold_retry_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    source_id: &str,
    incarnation: &str,
    paths: &[String],
    requested_at: &str,
) -> Result<()> {
    let fingerprint = summary_fingerprint(source_id, incarnation);
    let mut all: BTreeSet<String> = paths.iter().cloned().collect();
    let keys = op_checkpoint_completed_keys(&*tx, GIT_HOLD_RETRY_OP, &fingerprint)?;
    if let Some(Value::Array(prior)) = keys
        .as_ref()
        .and_then(|keys| keys.get(0))
        .and_then(|record| record.get("paths"))
    {
        all.extend(
            prior
                .iter()
                .map(|p| p.as_str().map_or_else(|| p.to_string(), str::to_owned)),
        );
    }
    let record = json!([{
        "version": 1,
        "source_id": source_id,
        "incarnation": incarnation,
        "paths": all.into_iter().collect::<Vec<_>>(),
        "requested_at": requested_at,
    }]);
    write_op_checkpoint_record_in(tx, env, GIT_HOLD_RETRY_OP, &fingerprint, Some(&record))
}

impl Store {
    /// `swapGitHold(input)`.
    #[allow(clippy::too_many_arguments)]
    pub fn swap_git_hold(
        &self,
        source_id: &str,
        incarnation: &str,
        path: &str,
        prior: Option<&Value>,
        next: Option<&Value>,
        summary: Option<&GitHoldSummaryDelta>,
    ) -> Result<bool> {
        self.write(|tx| {
            swap_git_hold_in(
                tx,
                &*self.env,
                source_id,
                incarnation,
                path,
                prior,
                next,
                summary,
            )
        })
    }

    /// `readGitHoldRecord(sourceId, incarnation, path)`.
    pub fn read_git_hold_record(
        &self,
        source_id: &str,
        incarnation: &str,
        path: &str,
    ) -> Result<Option<SourceHoldRecord>> {
        read_git_hold_record_in(&*self.read()?, source_id, incarnation, path)
    }

    /// `requestGitHoldRetry(sourceId, incarnation, paths, requestedAt)`.
    pub fn request_git_hold_retry(
        &self,
        source_id: &str,
        incarnation: &str,
        paths: &[String],
        requested_at: &str,
    ) -> Result<()> {
        self.write(|tx| {
            request_git_hold_retry_in(tx, &*self.env, source_id, incarnation, paths, requested_at)
        })
    }
}
