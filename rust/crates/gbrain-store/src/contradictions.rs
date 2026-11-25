//! Contradiction-probe runs and the judge cache: the `eval_contradictions_runs` and
//! `eval_contradictions_cache` tables of the PGLite engine.
//!
//! Members: writeContradictionsRun, loadContradictionsTrend, readLastContradictionsPromptVersion,
//! getContradictionCacheEntry, putContradictionCacheEntry, sweepContradictionCache, and listLinkContexts (the link contexts
//! the edge-contradictions phase quotes to its judge, read from the link records of links.rs).
//!
//! Keys (every one starts with `keys::CONTRADICTIONS`, `Q`):
//! - `Q 0x01 run_id -> RunRecord`: one probe run, the `run_id` primary key.
//! - `Q 0x02 ran_at run_id -> ()`: the `ran_at DESC` index. `ran_at` is the microsecond time as 8
//!   big-endian bytes with the sign bit flipped, so byte order is time order.
//! - `Q 0x03 chunk_a_hash \0 chunk_b_hash \0 model_id \0 prompt_version \0 truncation_policy ->
//!   CacheRecord`: one judge verdict, the five-part primary key. No part may hold a NUL byte.
//!
//! Numbers: the `INTEGER` columns take a JavaScript number only when it is an integer in range;
//! the `REAL` columns are rounded to `f32` on write and read back as the shortest decimal of that
//! `f32` (Postgres prints `0.08::real` as `0.08`).
//!
//! Time: `ran_at` and the cache's `created_at` are the store's clock. As in PGLite, the cache's
//! `expires_at` and the trend's cutoff are millisecond times (they come from `Date.now()` there).

use crate::dream::{int4, jsonb_check};
use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::jsonb::ordered;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const RUN: u8 = 0x01;
const RUN_BY_TIME: u8 = 0x02;
const CACHE: u8 = 0x03;

/// The cache's default lifetime and its floor (`Math.max(60, ttl_seconds ?? 30 * 86400)`).
const CACHE_TTL_SECONDS: f64 = 30.0 * 86_400.0;
const CACHE_TTL_FLOOR_SECONDS: f64 = 60.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RunRecord {
    run_id: String,
    ran_at_us: i64,
    schema_version: i32,
    judge_model: String,
    prompt_version: String,
    queries_evaluated: i32,
    queries_with_contradiction: i32,
    total_contradictions_flagged: i32,
    wilson_ci_lower: f32,
    wilson_ci_upper: f32,
    judge_errors_total: i32,
    cost_usd_total: f32,
    duration_ms: i32,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    source_tier_breakdown: Value,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    report_json: Value,
}

impl RunRecord {
    /// One row of `loadContradictionsTrend`. `ran_at` is microsecond ISO text; the TypeScript
    /// member prints it as `Date#toISOString` as PGLite does.
    fn to_json(&self) -> Value {
        json!({
            "run_id": self.run_id,
            "ran_at": iso(self.ran_at_us),
            "judge_model": self.judge_model,
            "queries_evaluated": self.queries_evaluated,
            "queries_with_contradiction": self.queries_with_contradiction,
            "total_contradictions_flagged": self.total_contradictions_flagged,
            "wilson_ci_lower": real(self.wilson_ci_lower),
            "wilson_ci_upper": real(self.wilson_ci_upper),
            "judge_errors_total": self.judge_errors_total,
            "cost_usd_total": real(self.cost_usd_total),
            "duration_ms": self.duration_ms,
            "source_tier_breakdown": ordered(&self.source_tier_breakdown),
            "report_json": ordered(&self.report_json),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheRecord {
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    verdict: Value,
    created_at_us: i64,
    expires_at_us: i64,
}

/// The run row `writeContradictionsRun` takes. Missing fields bind as NULL, which every column
/// refuses.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ContradictionsRunInput {
    pub run_id: Option<String>,
    pub judge_model: Option<String>,
    pub prompt_version: Option<String>,
    pub queries_evaluated: Option<f64>,
    pub queries_with_contradiction: Option<f64>,
    pub total_contradictions_flagged: Option<f64>,
    pub wilson_ci_lower: Option<f64>,
    pub wilson_ci_upper: Option<f64>,
    pub judge_errors_total: Option<f64>,
    pub cost_usd_total: Option<f64>,
    pub duration_ms: Option<f64>,
    pub source_tier_breakdown: Option<Value>,
    pub report_json: Option<Value>,
}

/// The five-part judge cache key, plus the verdict and lifetime for a put.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ContradictionCacheInput {
    pub chunk_a_hash: Option<String>,
    pub chunk_b_hash: Option<String>,
    pub model_id: Option<String>,
    pub prompt_version: Option<String>,
    pub truncation_policy: Option<String>,
    pub verdict: Option<Value>,
    pub ttl_seconds: Option<f64>,
}

/// A `REAL` read back: the shortest decimal that names the stored `f32`, as an `f64`.
fn real(value: f32) -> f64 {
    format!("{value}").parse().unwrap_or(f64::from(value))
}

fn time_bytes(us: i64) -> [u8; 8] {
    ((us as u64) ^ (1 << 63)).to_be_bytes()
}

fn run_key(run_id: &str) -> Vec<u8> {
    let mut key = vec![keys::CONTRADICTIONS, RUN];
    key.extend_from_slice(run_id.as_bytes());
    key
}

fn run_time_key(ran_at_us: i64, run_id: &str) -> Vec<u8> {
    let mut key = vec![keys::CONTRADICTIONS, RUN_BY_TIME];
    key.extend_from_slice(&time_bytes(ran_at_us));
    key.extend_from_slice(run_id.as_bytes());
    key
}

fn not_null(table: &str, column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"{table}\" violates not-null constraint"
        ),
    )
}

const RUNS: &str = "eval_contradictions_runs";
const CACHE_TABLE: &str = "eval_contradictions_cache";

/// The five key parts, checked: each present (the columns are `NOT NULL`) and free of NUL.
fn cache_key(op: &str, input: &ContradictionCacheInput) -> Result<Vec<u8>> {
    let parts = [
        ("chunk_a_hash", &input.chunk_a_hash),
        ("chunk_b_hash", &input.chunk_b_hash),
        ("model_id", &input.model_id),
        ("prompt_version", &input.prompt_version),
        ("truncation_policy", &input.truncation_policy),
    ];
    let mut texts = Vec::with_capacity(parts.len());
    for (column, value) in parts {
        let Some(text) = value.as_deref() else {
            return Err(not_null(CACHE_TABLE, column));
        };
        no_nul(op, &[(column, text)])?;
        texts.push(text);
    }
    let mut key = vec![keys::CONTRADICTIONS, CACHE];
    key.extend_from_slice(&keys::text(0, &texts)[1..]);
    Ok(key)
}

/// A missing cache key part matches no row (`col = NULL` is never true).
fn cache_lookup_key(input: &ContradictionCacheInput) -> Result<Option<Vec<u8>>> {
    match cache_key("getContradictionCacheEntry", input) {
        Ok(key) => Ok(Some(key)),
        Err(e) if e.code == CONSTRAINT_VIOLATION => Ok(None),
        Err(e) => Err(e),
    }
}

fn millis(us: i64) -> i64 {
    us.div_euclid(1000)
}

fn finite(op: &str, what: &str, value: f64) -> Result<f64> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: {what} must be a finite number"),
        ))
    }
}

fn read_records<T: for<'de> Deserialize<'de>>(
    read: &dyn KvRead,
    prefix: &[u8],
) -> Result<Vec<(Vec<u8>, T)>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        prefix,
        false,
        &mut |k, v| match serde_json::from_slice(v) {
            Ok(record) => {
                out.push((k.to_vec(), record));
                true
            }
            Err(e) => {
                bad = Some(StoreError::from(e));
                false
            }
        },
    )?;
    match bad {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

impl Store {
    /// `writeContradictionsRun(row)`: inserts the run unless one with its `run_id` exists. True
    /// when it inserted (`ON CONFLICT (run_id) DO NOTHING`).
    pub fn write_contradictions_run(&self, row: &ContradictionsRunInput) -> Result<bool> {
        const OP: &str = "writeContradictionsRun";
        let text = |column: &str, value: &Option<String>| -> Result<String> {
            let text = value.clone().ok_or_else(|| not_null(RUNS, column))?;
            no_nul(OP, &[(column, &text)])?;
            Ok(text)
        };
        let int = |column: &str, value: Option<f64>| -> Result<i32> {
            int4(OP, column, value.ok_or_else(|| not_null(RUNS, column))?)
        };
        let float = |column: &str, value: Option<f64>| -> Result<f32> {
            let value = finite(OP, column, value.ok_or_else(|| not_null(RUNS, column))?)?;
            // Postgres float4 input rounds to nearest; out of range is an error.
            let rounded = value as f32;
            if rounded.is_infinite() {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("{OP}: \"{value}\" is out of range for type real ({column})"),
                ));
            }
            Ok(rounded)
        };
        let json_col = |column: &str, value: &Option<Value>| -> Result<Value> {
            let value = value.clone().ok_or_else(|| not_null(RUNS, column))?;
            jsonb_check(OP, column, &value)?;
            Ok(value)
        };
        let run_id = text("run_id", &row.run_id)?;
        let record = RunRecord {
            ran_at_us: 0,
            schema_version: 1,
            judge_model: text("judge_model", &row.judge_model)?,
            prompt_version: text("prompt_version", &row.prompt_version)?,
            queries_evaluated: int("queries_evaluated", row.queries_evaluated)?,
            queries_with_contradiction: int(
                "queries_with_contradiction",
                row.queries_with_contradiction,
            )?,
            total_contradictions_flagged: int(
                "total_contradictions_flagged",
                row.total_contradictions_flagged,
            )?,
            wilson_ci_lower: float("wilson_ci_lower", row.wilson_ci_lower)?,
            wilson_ci_upper: float("wilson_ci_upper", row.wilson_ci_upper)?,
            judge_errors_total: int("judge_errors_total", row.judge_errors_total)?,
            cost_usd_total: float("cost_usd_total", row.cost_usd_total)?,
            duration_ms: int("duration_ms", row.duration_ms)?,
            source_tier_breakdown: json_col("source_tier_breakdown", &row.source_tier_breakdown)?,
            report_json: json_col("report_json", &row.report_json)?,
            run_id,
        };
        self.write(|tx| {
            let key = run_key(&record.run_id);
            if tx.get(&key)?.is_some() {
                return Ok(false);
            }
            let record = RunRecord {
                ran_at_us: self.env.now_micros(),
                ..record.clone()
            };
            put_json(tx, &key, &record)?;
            tx.put(&run_time_key(record.ran_at_us, &record.run_id), &[])?;
            Ok(true)
        })
    }

    /// `loadContradictionsTrend(days)`: the runs with `ran_at` at or after
    /// `Date.now() - max(0, days) days` (a millisecond cutoff), newest first.
    pub fn load_contradictions_trend(&self, days: f64) -> Result<Vec<Value>> {
        let days = finite("loadContradictionsTrend", "days", days)?.max(0.0);
        let now_ms = millis(self.env.now_micros()) as f64;
        // `new Date(x)` drops the fraction of a millisecond.
        let cutoff_ms = (now_ms - days * 86_400_000.0).trunc();
        let cutoff_us = if cutoff_ms < -9.0e15 {
            i64::MIN
        } else {
            (cutoff_ms as i64).saturating_mul(1000)
        };
        let read = self.read()?;
        let start = {
            let mut key = vec![keys::CONTRADICTIONS, RUN_BY_TIME];
            key.extend_from_slice(&time_bytes(cutoff_us));
            key
        };
        let end = vec![keys::CONTRADICTIONS, RUN_BY_TIME + 1];
        let mut ids = Vec::new();
        read.scan(&start, &end, true, &mut |k, _| {
            ids.push(String::from_utf8_lossy(&k[10..]).into_owned());
            true
        })?;
        let mut rows = Vec::with_capacity(ids.len());
        for id in ids {
            let record: RunRecord = get_json(&*read, &run_key(&id))?.ok_or_else(|| {
                StoreError::new(
                    crate::error::STORE_CORRUPT,
                    format!("contradiction run index names a missing run {id:?}"),
                )
            })?;
            rows.push(record.to_json());
        }
        Ok(rows)
    }

    /// `readLastContradictionsPromptVersion()`: the `prompt_version` of the newest run
    /// (`ORDER BY ran_at DESC LIMIT 1`), `None` before any run. Runs that tie on `ran_at` go to
    /// the largest `run_id` in byte order; Postgres names no order for such ties.
    pub fn read_last_contradictions_prompt_version(&self) -> Result<Option<String>> {
        let read = self.read()?;
        let mut newest = None;
        scan_prefix(
            &*read,
            &[keys::CONTRADICTIONS, RUN_BY_TIME],
            true,
            &mut |k, _| {
                newest = Some(String::from_utf8_lossy(&k[10..]).into_owned());
                false
            },
        )?;
        let Some(id) = newest else {
            return Ok(None);
        };
        let record: RunRecord = get_json(&*read, &run_key(&id))?.ok_or_else(|| {
            StoreError::new(
                crate::error::STORE_CORRUPT,
                format!("contradiction run index names a missing run {id:?}"),
            )
        })?;
        Ok(Some(record.prompt_version))
    }

    /// `getContradictionCacheEntry(key)`: the verdict of a live entry (`expires_at > now`), else
    /// `None`.
    pub fn get_contradiction_cache_entry(
        &self,
        input: &ContradictionCacheInput,
    ) -> Result<Option<Value>> {
        let Some(key) = cache_lookup_key(input)? else {
            return Ok(None);
        };
        let now = self.env.now_micros();
        let record: Option<CacheRecord> = get_json(&*self.read()?, &key)?;
        Ok(record
            .filter(|r| r.expires_at_us > now)
            .map(|r| ordered(&r.verdict)))
    }

    /// `putContradictionCacheEntry(entry)`: inserts or replaces the verdict, with
    /// `expires_at = Date.now() + max(60, ttl_seconds ?? 30 days)` and `created_at = now`.
    pub fn put_contradiction_cache_entry(&self, entry: &ContradictionCacheInput) -> Result<()> {
        const OP: &str = "putContradictionCacheEntry";
        let ttl = finite(
            OP,
            "ttl_seconds",
            entry.ttl_seconds.unwrap_or(CACHE_TTL_SECONDS),
        )?
        .max(CACHE_TTL_FLOOR_SECONDS);
        let key = cache_key(OP, entry)?;
        let verdict = entry
            .verdict
            .clone()
            .ok_or_else(|| not_null(CACHE_TABLE, "verdict"))?;
        jsonb_check(OP, "verdict", &verdict)?;
        let now = self.env.now_micros();
        let expires_ms = (millis(now) as f64 + ttl * 1000.0).trunc();
        if expires_ms > 8.64e15 {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{OP}: ttl_seconds is out of range"),
            ));
        }
        let record = CacheRecord {
            verdict,
            created_at_us: now,
            expires_at_us: (expires_ms as i64) * 1000,
        };
        self.write(|tx| put_json(tx, &key, &record))
    }

    /// `sweepContradictionCache()`: deletes every entry with `expires_at <= now`; returns how many.
    pub fn sweep_contradiction_cache(&self) -> Result<u64> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let doomed: Vec<Vec<u8>> =
                read_records::<CacheRecord>(&*tx, &[keys::CONTRADICTIONS, CACHE])?
                    .into_iter()
                    .filter(|(_, r)| r.expires_at_us <= now)
                    .map(|(k, _)| k)
                    .collect();
            for key in &doomed {
                tx.delete(key)?;
            }
            Ok(doomed.len() as u64)
        })
    }

    /// `listLinkContexts(fromPageId, toPageId, linkType)`: up to three distinct non-empty
    /// contexts of the links from one page to another with one link type (`SELECT DISTINCT
    /// context FROM links WHERE ... AND context <> '' LIMIT 3`). The SQL names no order; the
    /// store answers the three first in byte order. An id that is not a whole number at or above
    /// zero names no page and answers none.
    pub fn list_link_contexts(
        &self,
        from_page_id: f64,
        to_page_id: f64,
        link_type: &str,
    ) -> Result<Vec<String>> {
        let id =
            |n: f64| (n.fract() == 0.0 && (0.0..=u64::MAX as f64).contains(&n)).then_some(n as u64);
        let (Some(from), Some(to)) = (id(from_page_id), id(to_page_id)) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let contexts: std::collections::BTreeSet<String> = crate::links::out_links(&*read, from)?
            .into_iter()
            .filter(|l| l.to_page_id == to && l.link_type == link_type && !l.context.is_empty())
            .map(|l| l.context)
            .collect();
        Ok(contexts.into_iter().take(3).collect())
    }
}

/// The `eval_contradictions_cache` rows a fact purge's inventory probe searches (crate::facts::purge_probe).
pub(crate) fn purge_probe_cache_rows(
    read: &dyn KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow};
    Ok(
        read_records::<CacheRecord>(read, &[keys::CONTRADICTIONS, CACHE])?
            .into_iter()
            .map(|(_, r)| ProbeRow {
                source_id: None,
                cells: vec![("verdict", ProbeCell::jsonb(&r.verdict))],
            })
            .collect(),
    )
}

/// The `eval_contradictions_runs` rows a fact purge's inventory probe searches (crate::facts::purge_probe).
pub(crate) fn purge_probe_run_rows(
    read: &dyn KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow};
    Ok(
        read_records::<RunRecord>(read, &[keys::CONTRADICTIONS, RUN])?
            .into_iter()
            .map(|(_, r)| ProbeRow {
                source_id: None,
                cells: vec![("report_json", ProbeCell::jsonb(&r.report_json))],
            })
            .collect(),
    )
}
