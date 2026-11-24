//! Telemetry: the `search_telemetry`, `mcp_request_log` and `mcp_request_log_rollup` tables of the
//! PGLite engine. The search telemetry flush (`src/core/search/telemetry.ts`) writes the first, read
//! by `gbrain search stats` and the search tune advisor. The MCP server, webhooks, surface audit,
//! access admin and memory settings append to the request log; the retention prune
//! (`src/core/mcp-request-log-retention.ts`) moves old rows into the per-token tally; `gbrain auth`
//! usage and doctor read both.
//!
//! Members: recordSearchTelemetry, readSearchStats, logMcpRequest, readMcpLogPruneCutoff,
//! pruneMcpRequestLogBatch, readClientOpUsage, readMcpRollupPrunedBefore, readMcpLifetimeUsage
//! readMcpRequestLogPage (`src/core/engine-sql/telemetry.ts`).
//!
//! Keys (every record starts with `keys::TELEMETRY`, `a`, then the table's sub-tag):
//! - `a 0x01 <date> 0x00 <mode> 0x00 <intent>` -> `SearchRecord` (JSON). The text parts are the
//!   table's primary key `(date, mode, intent)`; none may hold a NUL byte, so the key is unique.
//! - `a 0x02 <created_at BE8, sign bit flipped> <id BE8>` -> `LogRecord` (JSON). Key order is
//!   `created_at` order (the `idx_mcp_log_time_agent` order the prune takes), ties by id. The id
//!   comes from the `next_mcp_request_id` counter, as `SERIAL` does.
//! - `a 0x03 <token_name>` -> `RollupRecord` (JSON). The tally keys a NULL token as `''`, as the
//!   prune's `COALESCE(token_name, '')` does.
//!
//! The other sub-tags of `a` (retrieval feedback, budget ledger) have no records yet: those tables
//! are not served (rust/docs/store/telemetry.md).
//!
//! No table carries a source or a page: page and source deletes never touch them.

use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const TABLE: &str = "search_telemetry";
const OP_RECORD: &str = "recordSearchTelemetry";
const OP_READ: &str = "readSearchStats";
const LOG_TABLE: &str = "mcp_request_log";
const OP_LOG: &str = "logMcpRequest";
const OP_CUTOFF: &str = "readMcpLogPruneCutoff";
const OP_PRUNE: &str = "pruneMcpRequestLogBatch";
const OP_USAGE: &str = "readClientOpUsage";
const OP_LIFETIME: &str = "readMcpLifetimeUsage";
const OP_COUNT: &str = "countMcpRequestsLastDay";
const OP_COUNT_BY_TOKEN: &str = "countMcpRequestsLastDayByToken";
const OP_PAGE: &str = "readMcpRequestLogPage";
const LOG_ID_COUNTER: &str = "next_mcp_request_id";
const DAY_US: i128 = 86_400_000_000;
/// The write states still in flight, and the states of a write that ended without committing (`readPendingWriteHealth`).
const PENDING_STATES: &[&str] = &["queued", "deferred", "running", "recovering"];
const ENDED_UNCOMMITTED: &[&str] = &["conflict", "failed", "cancelled"];
/// The `timestamptz` range in Unix microseconds: 4714-11-24 BC 00:00:00 UTC up to (not including)
/// 294277-01-01 UTC, Postgres's `MIN_TIMESTAMP` and `END_TIMESTAMP` moved from the 2000 epoch.
const TIMESTAMP_MIN_US: i128 = -212_760_172_800_000_000;
const TIMESTAMP_END_US: i128 = 9_224_318_016_000_000_000;
/// The statuses `readClientOpUsage` counts as a successful request.
const SUCCESS_STATUSES: [&str; 3] = ["success", "success_with_warnings", "accepted_pending"];

/// The integer counters, in column order (the order Postgres checks them).
const COUNTERS: [&str; 10] = [
    "count",
    "sum_results",
    "sum_tokens",
    "sum_budget_dropped",
    "cache_hit",
    "cache_miss",
    "count_rank1",
    "rank1_lt_solid",
    "rank1_solid",
    "rank1_high",
];

fn search_prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_SEARCH]
}

fn search_key(date: &str, mode: &str, intent: &str) -> Vec<u8> {
    let mut key = vec![keys::TELEMETRY];
    key.extend(keys::text(keys::TELEMETRY_SEARCH, &[date, mode, intent]));
    key
}

/// One `search_telemetry` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SearchRecord {
    pub date: String,
    pub mode: String,
    pub intent: String,
    /// The counters, keyed by column name (`COUNTERS`).
    pub counters: BTreeMap<String, i32>,
    pub sum_rank1_score: f64,
    pub first_seen_us: i64,
    pub last_seen_us: i64,
}

/// One bucket of `recordSearchTelemetry`. Every field is optional here so a missing one fails as
/// Postgres fails it (a `NOT NULL` column refuses with `constraint_violation`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SearchTelemetryBucket {
    pub date: Option<String>,
    pub mode: Option<String>,
    pub intent: Option<String>,
    pub count: Option<f64>,
    pub sum_results: Option<f64>,
    pub sum_tokens: Option<f64>,
    pub sum_budget_dropped: Option<f64>,
    pub cache_hit: Option<f64>,
    pub cache_miss: Option<f64>,
    pub sum_rank1_score: Option<f64>,
    pub count_rank1: Option<f64>,
    pub rank1_lt_solid: Option<f64>,
    pub rank1_solid: Option<f64>,
    pub rank1_high: Option<f64>,
}

impl SearchTelemetryBucket {
    fn counter(&self, column: &str) -> Option<f64> {
        match column {
            "count" => self.count,
            "sum_results" => self.sum_results,
            "sum_tokens" => self.sum_tokens,
            "sum_budget_dropped" => self.sum_budget_dropped,
            "cache_hit" => self.cache_hit,
            "cache_miss" => self.cache_miss,
            "count_rank1" => self.count_rank1,
            "rank1_lt_solid" => self.rank1_lt_solid,
            "rank1_solid" => self.rank1_solid,
            "rank1_high" => self.rank1_high,
            _ => None,
        }
    }
}

fn not_null(column: &str) -> StoreError {
    not_null_in(TABLE, column)
}

pub(crate) fn not_null_in(table: &str, column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"{table}\" violates not-null constraint"
        ),
    )
}

fn integer_out_of_range(op: &str) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, format!("{op}: integer out of range"))
}

/// A number bound to an `INTEGER` parameter, as Postgres reads its text form: a whole number in
/// the `int4` range, or refused.
pub(crate) fn int4_param(op: &str, column: &str, value: f64) -> Result<i32> {
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: invalid input syntax for type integer: \"{value}\" ({column})"),
        ));
    }
    if value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: value \"{value}\" is out of range for type integer ({column})"),
        ));
    }
    // Whole and in range, so the cast is exact.
    Ok(value as i32)
}

/// A float8 sum: Postgres refuses a finite sum that overflows to infinity.
pub(crate) fn float_add(a: f64, b: f64, op: &str) -> Result<f64> {
    let sum = a + b;
    if sum.is_infinite() && a.is_finite() && b.is_finite() {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: value out of range: overflow"),
        ));
    }
    Ok(sum)
}

/// `timestamptz::text` in the UTC session time zone PGLite runs in:
/// `2026-11-18 07:46:03.336+00`, with the fraction's trailing zeros dropped (none when whole).
pub(crate) fn pg_timestamptz_text(micros: i64) -> String {
    // `iso` gives `2026-11-18T07:46:03.336000Z`: the same fields, in another layout.
    let iso = iso(micros);
    let (whole, frac) = iso.split_once('.').unwrap_or((iso.as_str(), "Z"));
    let frac = frac.trim_end_matches('Z').trim_end_matches('0');
    let mut text = whole.replacen('T', " ", 1);
    if !frac.is_empty() {
        text.push('.');
        text.push_str(frac);
    }
    text.push_str("+00");
    text
}

pub(crate) fn log_prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_MCP_REQUEST]
}

/// `a 0x02 <created_us, sign bit flipped, BE8> <id BE8>`: byte order is `created_at` order.
fn log_key(created_us: i64, id: u64) -> Vec<u8> {
    let mut key = log_prefix().to_vec();
    key.extend_from_slice(&((created_us as u64) ^ (1 << 63)).to_be_bytes());
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn rollup_prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_MCP_ROLLUP]
}

fn rollup_key(token_name: &str) -> Vec<u8> {
    let mut key = vec![keys::TELEMETRY];
    key.extend(keys::text(keys::TELEMETRY_MCP_ROLLUP, &[token_name]));
    key
}

/// One `mcp_request_log` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LogRecord {
    pub id: u64,
    pub token_name: Option<String>,
    pub agent_name: Option<String>,
    pub operation: String,
    pub latency_ms: Option<i32>,
    pub status: String,
    pub error_message: Option<String>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub params: Option<Value>,
    pub created_us: i64,
}

/// One `mcp_request_log_rollup` row: the tally of the pruned requests of one token (`''` for none).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RollupRecord {
    pub token_name: String,
    pub requests: i64,
    pub last_used_us: Option<i64>,
    pub pruned_through_us: Option<i64>,
}

/// The shadow seed (`seed.rs`): stores a `mcp_request_log_rollup` row copied from another engine,
/// under the key the prune gives it (`''` for no token). `false` when the token already has a row.
pub(crate) fn seed_rollup(tx: &mut dyn KvWrite, record: &RollupRecord) -> Result<bool> {
    let key = rollup_key(&record.token_name);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    put_json(tx, &key, record)?;
    Ok(true)
}

/// One row of `logMcpRequest`. Every field is optional here so a missing one fails as Postgres
/// fails it. `created_at` is ISO text; absent, the row takes the store clock (`now()`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct McpRequestLogInput {
    pub token_name: Option<String>,
    pub agent_name: Option<String>,
    pub operation: Option<String>,
    pub latency_ms: Option<f64>,
    pub status: Option<String>,
    pub error_message: Option<String>,
    pub params: Option<Value>,
    pub created_at: Option<String>,
}

/// `readMcpRequestLogPage` arguments: the admin request list's filters (null reads every row) and
/// its page. `limit` and `offset` are JavaScript numbers.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpRequestLogPageInput {
    pub token_name: Option<String>,
    pub operation: Option<String>,
    pub status: Option<String>,
    pub limit: Option<f64>,
    pub offset: Option<f64>,
}

/// A `LIMIT` / `OFFSET` value as Postgres binds a JavaScript number: a whole `bigint`, not negative.
fn page_bound(name: &str, value: Option<f64>) -> Result<usize> {
    let value = value.unwrap_or(0.0);
    if !value.is_finite() || value.fract() != 0.0 || value.abs() >= 9.2e18 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{OP_PAGE}: {name} is not a bigint: {value}"),
        ));
    }
    if value < 0.0 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{OP_PAGE}: {} must not be negative", name.to_uppercase()),
        ));
    }
    Ok(usize::try_from(value as i64).unwrap_or(usize::MAX))
}

/// Whether a JSON value holds a NUL character, which `jsonb` refuses.
fn json_has_nul(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains('\0'),
        Value::Array(items) => items.iter().any(json_has_nul),
        Value::Object(map) => map.iter().any(|(k, v)| k.contains('\0') || json_has_nul(v)),
        _ => false,
    }
}

/// `now() - (days::int * interval '1 day')`: the days are read as an `int4` parameter and the
/// result must stay in the `timestamptz` range. A null day count gives a null cutoff.
pub(crate) fn days_before(op: &str, now: i64, days: Option<f64>) -> Result<Option<i64>> {
    let Some(days) = days else {
        return Ok(None);
    };
    let days = int4_param(op, "days", days)?;
    let cutoff = i128::from(now) - i128::from(days) * DAY_US;
    if !(TIMESTAMP_MIN_US..TIMESTAMP_END_US).contains(&cutoff) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: timestamp out of range"),
        ));
    }
    // The store keeps microseconds in an i64, which ends a few decades before Postgres's range.
    i64::try_from(cutoff)
        .map(Some)
        .map_err(|_| StoreError::new(INVALID_ARGUMENT, format!("{op}: timestamp out of range")))
}

pub(crate) fn parse_timestamp(op: &str, text: &str) -> Result<i64> {
    parse_iso(text).ok_or_else(|| {
        StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: invalid input syntax for type timestamp with time zone: \"{text}\""),
        )
    })
}

fn read_log(read: &dyn KvRead) -> Result<Vec<(Vec<u8>, LogRecord)>> {
    let mut raw = Vec::new();
    scan_prefix(read, &log_prefix(), false, &mut |k, v| {
        raw.push((k.to_vec(), v.to_vec()));
        true
    })?;
    raw.into_iter()
        .map(|(k, v)| Ok((k, serde_json::from_slice(&v)?)))
        .collect()
}

fn read_rollups(read: &dyn KvRead) -> Result<Vec<RollupRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &rollup_prefix(), false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

fn read_search(read: &dyn KvRead) -> Result<Vec<SearchRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &search_prefix(), false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

impl Store {
    /// `recordSearchTelemetry(bucket)`: adds each counter of the bucket to its `(date, mode,
    /// intent)` row and stamps `last_seen` now, or inserts the row with `first_seen = last_seen =
    /// now`. As in Postgres, the parameters are read first (a number that is not a whole `int4`
    /// refuses with `invalid_argument`), then the `NOT NULL` columns in column order
    /// (`constraint_violation`), then an update whose sum leaves `int4` refuses with
    /// `invalid_argument` and writes nothing.
    pub fn record_search_telemetry(&self, bucket: &SearchTelemetryBucket) -> Result<()> {
        let mut texts: Vec<(&str, &str)> = Vec::new();
        for (name, value) in [
            ("date", &bucket.date),
            ("mode", &bucket.mode),
            ("intent", &bucket.intent),
        ] {
            if let Some(text) = value.as_deref() {
                texts.push((name, text));
            }
        }
        no_nul(OP_RECORD, &texts)?;
        let mut counters: Vec<(&str, Option<i32>)> = Vec::with_capacity(COUNTERS.len());
        for column in COUNTERS {
            let value = match bucket.counter(column) {
                Some(v) => Some(int4_param(OP_RECORD, column, v)?),
                None => None,
            };
            counters.push((column, value));
        }

        // NOT NULL, in column order: date, mode, intent, count .. cache_miss, sum_rank1_score,
        // count_rank1 .. rank1_high.
        let date = bucket.date.clone().ok_or_else(|| not_null("date"))?;
        let mode = bucket.mode.clone().ok_or_else(|| not_null("mode"))?;
        let intent = bucket.intent.clone().ok_or_else(|| not_null("intent"))?;
        let mut values: BTreeMap<String, i32> = BTreeMap::new();
        for (i, (column, value)) in counters.iter().enumerate() {
            if i == 6 && bucket.sum_rank1_score.is_none() {
                return Err(not_null("sum_rank1_score"));
            }
            let value = value.ok_or_else(|| not_null(column))?;
            values.insert((*column).to_string(), value);
        }
        let score = bucket
            .sum_rank1_score
            .ok_or_else(|| not_null("sum_rank1_score"))?;

        let now = self.env.now_micros();
        let key = search_key(&date, &mode, &intent);
        self.write(|tx| {
            let record = match get_json::<SearchRecord>(&*tx, &key)? {
                Some(mut row) => {
                    for (column, add) in &values {
                        let old = row.counters.get(column).copied().unwrap_or(0);
                        let sum = old
                            .checked_add(*add)
                            .ok_or_else(|| integer_out_of_range(OP_RECORD))?;
                        row.counters.insert(column.clone(), sum);
                    }
                    row.sum_rank1_score = float_add(row.sum_rank1_score, score, OP_RECORD)?;
                    row.last_seen_us = now;
                    row
                }
                None => SearchRecord {
                    date: date.clone(),
                    mode: mode.clone(),
                    intent: intent.clone(),
                    counters: values.clone(),
                    sum_rank1_score: score,
                    first_seen_us: now,
                    last_seen_us: now,
                },
            };
            put_json(tx, &key, &record)
        })
    }

    /// `readSearchStats(cutoffDate)`: one row per `(mode, intent)` with every counter summed over
    /// the rows whose `date >= cutoffDate` (byte order, the C collation), `MIN(first_seen)` and
    /// `MAX(last_seen)` as timestamp text. No row matches a null cutoff. A sum outside `int4`
    /// refuses with `invalid_argument`, as `SUM(..)::int` does. Rows come in `(mode, intent)` byte
    /// order; PGLite gives no set order and every caller keys the rows.
    pub fn read_search_stats(&self, cutoff: Option<&str>) -> Result<Vec<Value>> {
        let Some(cutoff) = cutoff else {
            return Ok(Vec::new());
        };
        no_nul(OP_READ, &[("cutoffDate", cutoff)])?;
        let read = self.read()?;
        struct Group {
            counters: BTreeMap<String, i64>,
            score: f64,
            first: i64,
            last: i64,
        }
        let mut groups: BTreeMap<(String, String), Group> = BTreeMap::new();
        for row in read_search(&*read)? {
            if row.date.as_bytes() < cutoff.as_bytes() {
                continue;
            }
            let group = groups
                .entry((row.mode.clone(), row.intent.clone()))
                .or_insert_with(|| Group {
                    counters: BTreeMap::new(),
                    score: 0.0,
                    first: row.first_seen_us,
                    last: row.last_seen_us,
                });
            for column in COUNTERS {
                let add = i64::from(row.counters.get(column).copied().unwrap_or(0));
                *group.counters.entry(column.to_string()).or_insert(0) += add;
            }
            group.score = float_add(group.score, row.sum_rank1_score, OP_READ)?;
            group.first = group.first.min(row.first_seen_us);
            group.last = group.last.max(row.last_seen_us);
        }
        let mut out = Vec::with_capacity(groups.len());
        for ((mode, intent), group) in groups {
            let mut row = json!({ "mode": mode, "intent": intent });
            for column in COUNTERS {
                let sum = group.counters.get(column).copied().unwrap_or(0);
                let sum = i32::try_from(sum).map_err(|_| integer_out_of_range(OP_READ))?;
                row[column] = json!(sum);
            }
            row["sum_rank1_score"] = json!(group.score);
            row["first_seen"] = json!(pg_timestamptz_text(group.first));
            row["last_seen"] = json!(pg_timestamptz_text(group.last));
            out.push(row);
        }
        Ok(out)
    }
}

impl Store {
    /// `logMcpRequest(row)`: appends one request log row with the next id. As in Postgres, the
    /// parameters are read first (a latency that is not a whole `int4`, a `created_at` that is not
    /// ISO text, or a NUL in text or `params` refuses with `invalid_argument`), then a null
    /// `operation` or `status` refuses with `constraint_violation`. `created_at` absent is now.
    pub fn log_mcp_request(&self, input: &McpRequestLogInput) -> Result<()> {
        let mut texts: Vec<(&str, &str)> = Vec::new();
        for (name, value) in [
            ("token_name", &input.token_name),
            ("agent_name", &input.agent_name),
            ("operation", &input.operation),
            ("status", &input.status),
            ("error_message", &input.error_message),
        ] {
            if let Some(text) = value.as_deref() {
                texts.push((name, text));
            }
        }
        no_nul(OP_LOG, &texts)?;
        let latency_ms = match input.latency_ms {
            Some(v) => Some(int4_param(OP_LOG, "latency_ms", v)?),
            None => None,
        };
        let created_us = match input.created_at.as_deref() {
            Some(text) => parse_timestamp(OP_LOG, text)?,
            None => self.env.now_micros(),
        };
        let params = input.params.clone().filter(|v| !v.is_null());
        if params.as_ref().is_some_and(json_has_nul) {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{OP_LOG}: unsupported Unicode escape sequence (params)"),
            ));
        }
        let operation = input
            .operation
            .clone()
            .ok_or_else(|| not_null_in(LOG_TABLE, "operation"))?;
        let status = input
            .status
            .clone()
            .ok_or_else(|| not_null_in(LOG_TABLE, "status"))?;
        self.write(|tx| {
            let id = crate::pages::next_id(tx, LOG_ID_COUNTER)?;
            let record = LogRecord {
                id,
                token_name: input.token_name.clone(),
                agent_name: input.agent_name.clone(),
                operation: operation.clone(),
                latency_ms,
                status: status.clone(),
                error_message: input.error_message.clone(),
                params: params.clone(),
                created_us,
            };
            put_json(tx, &log_key(created_us, id), &record)
        })
    }

    /// `readMcpLogPruneCutoff(days)`: the tally always exists in the store, and the cutoff is
    /// `now - days` as ISO text (null for a null day count).
    pub fn read_mcp_log_prune_cutoff(&self, days: Option<f64>) -> Result<Value> {
        let cutoff = days_before(OP_CUTOFF, self.env.now_micros(), days)?;
        Ok(json!({ "rollup_present": true, "cutoff": cutoff.map(iso) }))
    }

    /// `pruneMcpRequestLogBatch(cutoff, keepOperations, limit)`: deletes the oldest `limit` rows
    /// created before `cutoff` whose operation is not in `keepOperations` (key order: `created_at`,
    /// ties by id) and adds them to the per-token tally (requests, the newest `last_used_at` and
    /// `pruned_through`; a NULL token counts under `''`), in one write. Nothing qualifies for a null
    /// cutoff, a null list or a list holding a null (`<> ALL` is then never true); a null limit
    /// takes every row. A negative or fractional limit refuses with `invalid_argument`.
    pub fn prune_mcp_request_log_batch(
        &self,
        cutoff: Option<&str>,
        keep: Option<&[Option<String>]>,
        limit: Option<f64>,
    ) -> Result<Value> {
        let cutoff = match cutoff {
            Some(text) => Some(parse_timestamp(OP_PRUNE, text)?),
            None => None,
        };
        let limit = match limit {
            None => None,
            Some(v) if !v.is_finite() || v.fract() != 0.0 => {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("{OP_PRUNE}: invalid input syntax for type bigint: \"{v}\""),
                ));
            }
            Some(v) if v < 0.0 => {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("{OP_PRUNE}: LIMIT must not be negative"),
                ));
            }
            // Whole and non-negative; a count past usize::MAX saturates, which takes every row.
            Some(v) => Some(v as usize),
        };
        let (Some(cutoff), Some(keep)) = (cutoff, keep) else {
            return Ok(json!({ "deleted": 0, "newest": null }));
        };
        if keep.iter().any(Option::is_none) {
            return Ok(json!({ "deleted": 0, "newest": null }));
        }
        let keep: Vec<&str> = keep.iter().flatten().map(String::as_str).collect();
        self.write(|tx| {
            let mut victims: Vec<(Vec<u8>, LogRecord)> = Vec::new();
            for (key, row) in read_log(&*tx)? {
                if limit.is_some_and(|n| victims.len() >= n) || row.created_us >= cutoff {
                    break;
                }
                if !keep.contains(&row.operation.as_str()) {
                    victims.push((key, row));
                }
            }
            let mut tally: BTreeMap<String, (i64, i64)> = BTreeMap::new();
            let mut newest: Option<i64> = None;
            for (key, row) in &victims {
                tx.delete(key)?;
                let entry = tally
                    .entry(row.token_name.clone().unwrap_or_default())
                    .or_insert((0, row.created_us));
                entry.0 += 1;
                entry.1 = entry.1.max(row.created_us);
                newest = Some(newest.map_or(row.created_us, |n| n.max(row.created_us)));
            }
            for (token_name, (n, last)) in tally {
                let key = rollup_key(&token_name);
                let record = match get_json::<RollupRecord>(&*tx, &key)? {
                    Some(mut row) => {
                        row.requests = row.requests.checked_add(n).ok_or_else(|| {
                            StoreError::new(
                                INVALID_ARGUMENT,
                                format!("{OP_PRUNE}: bigint out of range"),
                            )
                        })?;
                        // GREATEST skips a NULL.
                        row.last_used_us = Some(row.last_used_us.map_or(last, |v| v.max(last)));
                        row.pruned_through_us =
                            Some(row.pruned_through_us.map_or(last, |v| v.max(last)));
                        row
                    }
                    None => RollupRecord {
                        token_name,
                        requests: n,
                        last_used_us: Some(last),
                        pruned_through_us: Some(last),
                    },
                };
                put_json(tx, &key, &record)?;
            }
            Ok(json!({ "deleted": victims.len(), "newest": newest.map(iso) }))
        })
    }

    /// `readClientOpUsage(days)`: per `(token_name, operation)`, the count and newest `created_at`
    /// (ISO text) of the requests created after `now - days` with a token and a successful status.
    /// A null day count matches nothing. Rows come in `(token, operation)` byte order; PGLite gives
    /// no set order and every caller keys the rows.
    pub fn read_client_op_usage(&self, days: Option<f64>) -> Result<Vec<Value>> {
        let Some(cutoff) = days_before(OP_USAGE, self.env.now_micros(), days)? else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let mut groups: BTreeMap<(String, String), (i64, i64)> = BTreeMap::new();
        for (_, row) in read_log(&*read)? {
            let Some(token) = row.token_name else {
                continue;
            };
            if row.created_us <= cutoff || !SUCCESS_STATUSES.contains(&row.status.as_str()) {
                continue;
            }
            let entry = groups
                .entry((token, row.operation))
                .or_insert((0, row.created_us));
            entry.0 += 1;
            entry.1 = entry.1.max(row.created_us);
        }
        let mut out = Vec::with_capacity(groups.len());
        for ((token_name, operation), (n, last)) in groups {
            let n = i32::try_from(n).map_err(|_| integer_out_of_range(OP_USAGE))?;
            out.push(json!({
                "token_name": token_name, "operation": operation, "n": n, "last_seen": iso(last),
            }));
        }
        Ok(out)
    }

    /// `readMcpLifetimeUsage(tokenNames)`: per asked token, the request log rows it still has (every
    /// status and operation) plus its tally row: `requests` summed, `last_used_at` the newest of the
    /// newest `created_at` and the tally's `last_used_at`, as ISO text. A null list or a null name
    /// matches nothing; a NULL-token log row never matches, and the tally's `''` row (the pruned
    /// NULL-token rows) matches only an asked `''`. Rows come in token byte order. A NUL in a name
    /// refuses with `invalid_argument`; a sum past `int8` with `integer out of range`.
    pub fn read_mcp_lifetime_usage(
        &self,
        token_names: Option<&[Option<String>]>,
    ) -> Result<Vec<Value>> {
        let asked: BTreeSet<&str> = token_names
            .unwrap_or_default()
            .iter()
            .flatten()
            .map(String::as_str)
            .collect();
        for name in &asked {
            no_nul(OP_LIFETIME, &[("tokenNames", name)])?;
        }
        if asked.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut totals: BTreeMap<String, (i64, Option<i64>)> = BTreeMap::new();
        for (_, row) in read_log(&*read)? {
            let Some(token) = row.token_name else {
                continue;
            };
            if !asked.contains(token.as_str()) {
                continue;
            }
            let entry = totals.entry(token).or_insert((0, None));
            entry.0 += 1;
            entry.1 = entry.1.max(Some(row.created_us));
        }
        for name in &asked {
            let Some(tally) = get_json::<RollupRecord>(&*read, &rollup_key(name))? else {
                continue;
            };
            let entry = totals.entry(tally.token_name).or_insert((0, None));
            entry.0 = entry
                .0
                .checked_add(tally.requests)
                .ok_or_else(|| integer_out_of_range(OP_LIFETIME))?;
            // max() skips a NULL, as Postgres's max does.
            entry.1 = entry.1.max(tally.last_used_us);
        }
        Ok(totals
            .into_iter()
            .map(|(token_name, (requests, last))| {
                json!({ "token_name": token_name, "requests": requests, "last_used_at": last.map(iso) })
            })
            .collect())
    }

    /// `countMcpRequestsLastDay(kind)`: the request log rows created after `now - 24 hours`: `all` counts every row,
    /// `traffic` leaves out the `surface_change` audit rows, `errors` is the traffic whose status is not a success or an
    /// admitted pending write. Any other kind refuses with `invalid_argument`.
    pub fn count_mcp_requests_last_day(&self, kind: &str) -> Result<i64> {
        if !["all", "traffic", "errors"].contains(&kind) {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{OP_COUNT}: unknown kind \"{kind}\""),
            ));
        }
        let cutoff = self.env.now_micros() - DAY_US as i64;
        let read = self.read()?;
        let mut count = 0_i64;
        for (_, row) in read_log(&*read)? {
            if row.created_us <= cutoff {
                continue;
            }
            if kind != "all" && row.operation == "surface_change" {
                continue;
            }
            if kind == "errors" && SUCCESS_STATUSES.contains(&row.status.as_str()) {
                continue;
            }
            count += 1;
        }
        Ok(count)
    }

    /// `readPendingWriteHealth()`: `{ pending_writes, oldest_pending_write_age_seconds, pending_writes_later_failed }`.
    /// The writes in `queued`, `deferred`, `running` or `recovering`, and the whole seconds since the oldest of them was
    /// created (0 with none, Postgres's `floor(extract(epoch FROM now() - min(created_at)))`); then the distinct
    /// requests in `conflict`, `failed` or `cancelled` whose request id an `accepted_pending` log row created after
    /// `now - 24 hours` names in `params.write_request_id`.
    pub fn read_pending_write_health(&self) -> Result<Value> {
        let now = self.env.now_micros();
        let cutoff = now - DAY_US as i64;
        let read = self.read()?;
        let requests = crate::persistence::all_requests(&*read)?;
        let mut pending = 0_i64;
        let mut oldest: Option<i64> = None;
        for r in &requests {
            if PENDING_STATES.contains(&r.state.as_str()) {
                pending += 1;
                oldest = Some(oldest.map_or(r.created_at_us, |o| o.min(r.created_at_us)));
            }
        }
        let mut named: BTreeSet<String> = BTreeSet::new();
        for (_, row) in read_log(&*read)? {
            if row.created_us <= cutoff || row.status != "accepted_pending" {
                continue;
            }
            if let Some(id) = row
                .params
                .as_ref()
                .and_then(|p| p.get("write_request_id"))
                .and_then(Value::as_str)
            {
                named.insert(id.to_string());
            }
        }
        let later_failed = requests
            .iter()
            .filter(|r| {
                ENDED_UNCOMMITTED.contains(&r.state.as_str()) && named.contains(&r.request_id)
            })
            .map(|r| r.id.as_str())
            .collect::<BTreeSet<_>>()
            .len();
        let age = oldest.map_or(0, |o| (now - o).div_euclid(1_000_000));
        Ok(json!({
            "pending_writes": pending,
            "oldest_pending_write_age_seconds": age,
            "pending_writes_later_failed": later_failed,
        }))
    }

    /// `countMcpRequestsLastDayByToken(tokenNames)`: `{ token_name, requests }` per asked token that has a request
    /// created after `now - 24 hours`, in token byte order. A NULL-token row never matches; a NUL in a name refuses with
    /// `invalid_argument`.
    pub fn count_mcp_requests_last_day_by_token(
        &self,
        token_names: Option<&[Option<String>]>,
    ) -> Result<Vec<Value>> {
        let asked: BTreeSet<&str> = token_names
            .unwrap_or_default()
            .iter()
            .flatten()
            .map(String::as_str)
            .collect();
        for name in &asked {
            no_nul(OP_COUNT_BY_TOKEN, &[("tokenNames", name)])?;
        }
        if asked.is_empty() {
            return Ok(Vec::new());
        }
        let cutoff = self.env.now_micros() - DAY_US as i64;
        let read = self.read()?;
        let mut counts: BTreeMap<String, i64> = BTreeMap::new();
        for (_, row) in read_log(&*read)? {
            let Some(token) = row.token_name else {
                continue;
            };
            if row.created_us > cutoff && asked.contains(token.as_str()) {
                *counts.entry(token).or_insert(0) += 1;
            }
        }
        Ok(counts
            .into_iter()
            .map(|(token_name, requests)| json!({ "token_name": token_name, "requests": requests }))
            .collect())
    }

    /// `readMcpRequestLogPage(spec)`: `{ rows, total }`. `rows` is the page of request log rows,
    /// newest `created_at` first (ties by the higher id first, where Postgres leaves them in no
    /// set order), whose token, operation and status equal each given filter byte for byte; each
    /// row's `agent_name` falls back to its token name. `total` counts every row the filters match.
    /// A negative offset or limit refuses with `invalid_argument`, as Postgres refuses it, and so
    /// does a NUL in a filter.
    pub fn read_mcp_request_log_page(&self, input: &McpRequestLogPageInput) -> Result<Value> {
        for (name, value) in [
            ("tokenName", &input.token_name),
            ("operation", &input.operation),
            ("status", &input.status),
        ] {
            if let Some(value) = value {
                no_nul(OP_PAGE, &[(name, value.as_str())])?;
            }
        }
        let limit = page_bound("limit", input.limit)?;
        let offset = page_bound("offset", input.offset)?;
        let matches = |want: &Option<String>, have: Option<&str>| {
            want.as_deref().is_none_or(|w| have == Some(w))
        };
        let read = self.read()?;
        let mut rows: Vec<LogRecord> = read_log(&*read)?
            .into_iter()
            .map(|(_, row)| row)
            .filter(|row| {
                matches(&input.token_name, row.token_name.as_deref())
                    && matches(&input.operation, Some(row.operation.as_str()))
                    && matches(&input.status, Some(row.status.as_str()))
            })
            .collect();
        let total = rows.len();
        rows.sort_by(|a, b| b.created_us.cmp(&a.created_us).then(b.id.cmp(&a.id)));
        let page: Vec<Value> = rows
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|row| {
                json!({
                    "id": row.id,
                    "agent_name": row.agent_name.clone().or_else(|| row.token_name.clone()),
                    "token_name": row.token_name,
                    "operation": row.operation,
                    "latency_ms": row.latency_ms,
                    "status": row.status,
                    "params": row.params,
                    "error_message": row.error_message,
                    "created_at": iso(row.created_us),
                })
            })
            .collect();
        Ok(json!({ "rows": page, "total": total }))
    }

    /// `readMcpRollupPrunedBefore()`: the newest `pruned_through` of the tally (null when nothing
    /// was pruned) and the store clock, as ISO text.
    pub fn read_mcp_rollup_pruned_before(&self) -> Result<Value> {
        let now = self.env.now_micros();
        let read = self.read()?;
        let newest = read_rollups(&*read)?
            .iter()
            .filter_map(|r| r.pruned_through_us)
            .max();
        Ok(json!({ "pruned_before": newest.map(iso), "now": iso(now) }))
    }
}

/// The `mcp_request_log` rows a fact purge's inventory probe searches (crate::facts::purge_probe).
pub(crate) fn purge_probe_rows(
    read: &dyn KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow};
    Ok(read_log(read)?
        .into_iter()
        .map(|(_, r)| ProbeRow {
            source_id: None,
            cells: vec![
                ("params", ProbeCell::opt_jsonb(r.params.as_ref())),
                (
                    "error_message",
                    ProbeCell::opt_text(r.error_message.as_deref()),
                ),
            ],
        })
        .collect())
}

/// The shadow follow (`seed/follow.rs`): removes the rollup row of `token_name`. `false` when there
/// is none.
pub(crate) fn remove_rollup(tx: &mut dyn KvWrite, token_name: &str) -> Result<bool> {
    let key = rollup_key(token_name);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    fn bucket(
        date: &str,
        mode: &str,
        intent: &str,
        count: f64,
        score: f64,
    ) -> SearchTelemetryBucket {
        serde_json::from_value(json!({
            "date": date, "mode": mode, "intent": intent, "count": count, "sum_results": 1,
            "sum_tokens": 2, "sum_budget_dropped": 0, "cache_hit": 1, "cache_miss": 0,
            "sum_rank1_score": score, "count_rank1": 1, "rank1_lt_solid": 0, "rank1_solid": 1,
            "rank1_high": 0,
        }))
        .unwrap()
    }

    #[test]
    fn adds_a_bucket_to_its_row_and_sums_rows_on_or_after_the_cutoff() {
        let s = store();
        s.record_search_telemetry(&bucket("2026-01-02", "balanced", "entity", 2.0, 0.5))
            .unwrap();
        s.record_search_telemetry(&bucket("2026-01-02", "balanced", "entity", 3.0, 0.25))
            .unwrap();
        s.record_search_telemetry(&bucket("2026-01-03", "balanced", "entity", 1.0, 0.25))
            .unwrap();
        s.record_search_telemetry(&bucket("2026-01-01", "balanced", "entity", 9.0, 1.0))
            .unwrap();
        s.record_search_telemetry(&bucket("2026-01-03", "tokenmax", "general", 1.0, 0.0))
            .unwrap();
        let rows = s.read_search_stats(Some("2026-01-02")).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["mode"], json!("balanced"));
        assert_eq!(rows[0]["count"], json!(6));
        assert_eq!(rows[0]["sum_results"], json!(3));
        assert_eq!(rows[0]["count_rank1"], json!(3));
        assert_eq!(rows[0]["sum_rank1_score"], json!(1.0));
        assert_eq!(rows[1]["mode"], json!("tokenmax"));
        assert!(s.read_search_stats(Some("2026-01-04")).unwrap().is_empty());
        assert!(s.read_search_stats(None).unwrap().is_empty());
    }

    #[test]
    fn refuses_as_postgres_does_and_writes_nothing() {
        let s = store();
        let err = s
            .record_search_telemetry(&bucket("2026-01-02", "m", "i", 1.5, 0.0))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        let mut missing = bucket("2026-01-02", "m", "i", 1.0, 0.0);
        missing.mode = None;
        let err = s.record_search_telemetry(&missing).unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
        assert!(err.message.contains("\"mode\""));
        s.record_search_telemetry(&bucket("2026-01-02", "m", "i", f64::from(i32::MAX), 0.0))
            .unwrap();
        let err = s
            .record_search_telemetry(&bucket("2026-01-02", "m", "i", 1.0, 0.0))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        let rows = s.read_search_stats(Some("2026-01-01")).unwrap();
        assert_eq!(rows[0]["count"], json!(i32::MAX));
        assert_eq!(rows[0]["sum_results"], json!(1));
    }

    #[test]
    fn a_sum_outside_int4_refuses_the_read() {
        let s = store();
        let max = f64::from(i32::MAX);
        s.record_search_telemetry(&bucket("2026-01-02", "m", "i", max, 0.0))
            .unwrap();
        s.record_search_telemetry(&bucket("2026-01-03", "m", "i", max, 0.0))
            .unwrap();
        let err = s.read_search_stats(Some("2026-01-01")).unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        assert_eq!(
            s.read_search_stats(Some("2026-01-03")).unwrap()[0]["count"],
            json!(i32::MAX)
        );
    }

    fn request(token: Option<&str>, op: &str, status: &str, age_days: f64) -> McpRequestLogInput {
        use crate::env::Env;
        let now = crate::env::SystemEnv.now_micros();
        McpRequestLogInput {
            token_name: token.map(str::to_string),
            agent_name: Some("agent-fork".to_string()),
            operation: Some(op.to_string()),
            latency_ms: Some(5.0),
            status: Some(status.to_string()),
            created_at: Some(iso(now - (age_days * 86_400e6) as i64)),
            ..McpRequestLogInput::default()
        }
    }

    #[test]
    fn counts_successful_requests_per_token_and_operation_inside_the_window() {
        let s = store();
        assert!(s.read_client_op_usage(Some(30.0)).unwrap().is_empty());
        for (token, op, status, age) in [
            (Some("token-a"), "search", "success", 1.0),
            (Some("token-a"), "search", "success_with_warnings", 2.0),
            (Some("token-a"), "put_page", "accepted_pending", 3.0),
            (Some("token-a"), "put_page", "denied", 1.0),
            (Some("token-b"), "get_page", "success", 40.0),
            (None, "search", "success", 1.0),
        ] {
            s.log_mcp_request(&request(token, op, status, age)).unwrap();
        }
        let rows = s.read_client_op_usage(Some(30.0)).unwrap();
        let shape: Vec<(String, String, i64)> = rows
            .iter()
            .map(|r| {
                (
                    r["token_name"].as_str().unwrap().to_string(),
                    r["operation"].as_str().unwrap().to_string(),
                    r["n"].as_i64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                ("token-a".into(), "put_page".into(), 1),
                ("token-a".into(), "search".into(), 2)
            ]
        );
        assert_eq!(s.read_client_op_usage(Some(365.0)).unwrap().len(), 3);
        assert!(s.read_client_op_usage(None).unwrap().is_empty());
        assert_eq!(
            s.read_client_op_usage(Some(1.5)).unwrap_err().code,
            INVALID_ARGUMENT
        );
    }

    #[test]
    fn log_refuses_as_postgres_does_and_writes_nothing() {
        let s = store();
        let mut missing = request(Some("t"), "search", "success", 0.0);
        missing.status = None;
        let err = s.log_mcp_request(&missing).unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
        assert!(
            err.message
                .contains("\"status\" of relation \"mcp_request_log\"")
        );
        let mut bad_time = request(Some("t"), "search", "success", 0.0);
        bad_time.created_at = Some("yesterday".into());
        assert_eq!(
            s.log_mcp_request(&bad_time).unwrap_err().code,
            INVALID_ARGUMENT
        );
        let mut bad_latency = request(Some("t"), "search", "success", 0.0);
        bad_latency.latency_ms = Some(2.5);
        assert_eq!(
            s.log_mcp_request(&bad_latency).unwrap_err().code,
            INVALID_ARGUMENT
        );
        let mut nul = request(Some("t"), "search", "success", 0.0);
        nul.params = Some(json!({ "q": "a\u{0}b" }));
        assert_eq!(s.log_mcp_request(&nul).unwrap_err().code, INVALID_ARGUMENT);
        assert!(read_log(&*s.read().unwrap()).unwrap().is_empty());
    }

    #[test]
    fn prune_moves_the_oldest_rows_into_the_tally_and_keeps_audit_rows() {
        let s = store();
        assert_eq!(
            s.read_mcp_rollup_pruned_before().unwrap()["pruned_before"],
            Value::Null
        );
        for (token, op, age) in [
            (Some("token-a"), "search", 40.0),
            (Some("token-a"), "search", 35.0),
            (None, "search", 33.0),
            (Some("token-a"), "surface_change", 50.0),
            (Some("token-b"), "get_page", 31.0),
            (Some("token-b"), "get_page", 1.0),
        ] {
            s.log_mcp_request(&request(token, op, "success", age))
                .unwrap();
        }
        let cutoff = s.read_mcp_log_prune_cutoff(Some(30.0)).unwrap();
        assert_eq!(cutoff["rollup_present"], json!(true));
        let cutoff = cutoff["cutoff"].as_str().unwrap().to_string();
        let keep = vec![Some("surface_change".to_string())];
        let first = s
            .prune_mcp_request_log_batch(Some(&cutoff), Some(&keep), Some(2.0))
            .unwrap();
        assert_eq!(first["deleted"], json!(2));
        let second = s
            .prune_mcp_request_log_batch(Some(&cutoff), Some(&keep), None)
            .unwrap();
        assert_eq!(second["deleted"], json!(2));
        let newest = parse_iso(second["newest"].as_str().unwrap()).unwrap();
        let empty = s
            .prune_mcp_request_log_batch(Some(&cutoff), Some(&keep), None)
            .unwrap();
        assert_eq!(empty, json!({ "deleted": 0, "newest": null }));
        let rollups = read_rollups(&*s.read().unwrap()).unwrap();
        let tally: Vec<(&str, i64)> = rollups
            .iter()
            .map(|r| (r.token_name.as_str(), r.requests))
            .collect();
        assert_eq!(tally, vec![("", 1), ("token-a", 2), ("token-b", 1)]);
        let pruned = s.read_mcp_rollup_pruned_before().unwrap();
        assert_eq!(
            parse_iso(pruned["pruned_before"].as_str().unwrap()).unwrap(),
            newest
        );
        let left: Vec<String> = read_log(&*s.read().unwrap())
            .unwrap()
            .into_iter()
            .map(|(_, r)| r.operation)
            .collect();
        assert_eq!(left, vec!["surface_change", "get_page"]);
        let none: Vec<Option<String>> = vec![None];
        assert_eq!(
            s.prune_mcp_request_log_batch(Some("2999-01-01T00:00:00Z"), Some(&none), None)
                .unwrap()["deleted"],
            json!(0)
        );
        assert_eq!(
            s.prune_mcp_request_log_batch(Some(&cutoff), Some(&keep), Some(-1.0))
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
    }

    #[test]
    fn counts_the_last_day_by_kind_and_by_token() {
        let s = store();
        for (token, op, status, age) in [
            (Some("token-a"), "search", "success", 0.5),
            (Some("token-a"), "search", "error", 0.25),
            (Some("token-a"), "search", "accepted_pending", 0.1),
            (Some("token-b"), "get_page", "auth_failed", 0.5),
            (None, "search", "error", 0.5),
            (Some("token-a"), "surface_change", "success", 0.5),
            (Some("token-a"), "search", "error", 2.0),
            (Some("token-b"), "get_page", "success", 30.0),
        ] {
            s.log_mcp_request(&request(token, op, status, age)).unwrap();
        }
        assert_eq!(s.count_mcp_requests_last_day("all").unwrap(), 6);
        assert_eq!(s.count_mcp_requests_last_day("traffic").unwrap(), 5);
        assert_eq!(s.count_mcp_requests_last_day("errors").unwrap(), 3);
        assert_eq!(
            s.count_mcp_requests_last_day("nope").unwrap_err().code,
            INVALID_ARGUMENT
        );
        let ask = vec![
            Some("token-b".to_string()),
            None,
            Some("token-a".to_string()),
            Some("nobody".to_string()),
        ];
        let rows = s.count_mcp_requests_last_day_by_token(Some(&ask)).unwrap();
        assert_eq!(
            rows,
            vec![
                json!({ "token_name": "token-a", "requests": 4 }),
                json!({ "token_name": "token-b", "requests": 1 })
            ]
        );
        assert!(
            s.count_mcp_requests_last_day_by_token(None)
                .unwrap()
                .is_empty()
        );
        let nul = vec![Some("a\0b".to_string())];
        assert_eq!(
            s.count_mcp_requests_last_day_by_token(Some(&nul))
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
    }

    #[test]
    fn request_log_page_filters_orders_newest_first_and_counts_every_match() {
        let s = store();
        let at = |us: i64| Some(iso(1_786_363_200_000_000 + us));
        for (token, agent, op, status, us) in [
            (Some("token-a"), Some("agent-fork"), "search", "success", 1),
            (Some("token-a"), None, "search", "error", 3),
            (Some("token-b"), None, "get_page", "success", 2),
            (None, None, "search", "success", 4),
        ] {
            s.log_mcp_request(&McpRequestLogInput {
                token_name: token.map(str::to_string),
                agent_name: agent.map(str::to_string),
                operation: Some(op.to_string()),
                status: Some(status.to_string()),
                created_at: at(us),
                ..McpRequestLogInput::default()
            })
            .unwrap();
        }
        // Two rows at the same instant: the higher id comes first.
        for _ in 0..2 {
            s.log_mcp_request(&McpRequestLogInput {
                token_name: Some("token-c".into()),
                operation: Some("query".into()),
                status: Some("success".into()),
                created_at: at(0),
                ..McpRequestLogInput::default()
            })
            .unwrap();
        }
        let page =
            |spec: Value| s.read_mcp_request_log_page(&serde_json::from_value(spec).unwrap());
        let all = page(json!({ "limit": 50, "offset": 0 })).unwrap();
        assert_eq!(all["total"], 6);
        let ids: Vec<u64> = all["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_u64().unwrap())
            .collect();
        assert_eq!(ids, vec![4, 2, 3, 1, 6, 5]);
        assert_eq!(
            all["rows"][2]["agent_name"], "token-b",
            "no agent name falls back to the token"
        );
        assert_eq!(all["rows"][3]["agent_name"], "agent-fork");
        assert_eq!(
            all["rows"][0]["agent_name"],
            Value::Null,
            "no token and no agent stays null"
        );
        assert_eq!(all["rows"][0]["created_at"], "2026-08-10T12:00:00.000004Z");

        let filtered = page(json!({ "tokenName": "token-a", "operation": "search", "status": "error", "limit": 50, "offset": 0 })).unwrap();
        assert_eq!(filtered["total"], 1);
        assert_eq!(filtered["rows"][0]["id"], 2);

        let second = page(json!({ "operation": "search", "limit": 2, "offset": 2 })).unwrap();
        assert_eq!(second["total"], 3, "the total counts past the page");
        assert_eq!(second["rows"].as_array().unwrap().len(), 1);
        assert_eq!(second["rows"][0]["id"], 1);
        assert!(
            page(json!({ "limit": 50, "offset": 100 })).unwrap()["rows"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        for bad in [
            json!({ "limit": 50, "offset": -50 }),
            json!({ "limit": -1, "offset": 0 }),
            json!({ "limit": 50, "offset": 0.5 }),
            json!({ "status": "a\0b", "limit": 50, "offset": 0 }),
        ] {
            assert_eq!(page(bad).unwrap_err().code, INVALID_ARGUMENT);
        }
    }

    #[test]
    fn lifetime_usage_adds_kept_rows_to_the_tally_per_asked_token() {
        let s = store();
        let names = |list: &[Option<&str>]| -> Vec<Option<String>> {
            list.iter().map(|n| n.map(str::to_string)).collect()
        };
        assert!(s.read_mcp_lifetime_usage(None).unwrap().is_empty());
        assert!(s.read_mcp_lifetime_usage(Some(&[])).unwrap().is_empty());
        for (token, status, age) in [
            (Some("token-a"), "success", 40.0),
            (Some("token-a"), "error", 2.0),
            (Some("token-b"), "success", 50.0),
            (None, "auth_failed", 45.0),
        ] {
            s.log_mcp_request(&request(token, "search", status, age))
                .unwrap();
        }
        let cutoff = s.read_mcp_log_prune_cutoff(Some(30.0)).unwrap()["cutoff"]
            .as_str()
            .unwrap()
            .to_string();
        s.prune_mcp_request_log_batch(Some(&cutoff), Some(&[]), None)
            .unwrap();
        let ask = names(&[Some("token-b"), None, Some("token-a"), Some(""), Some("x")]);
        let rows = s.read_mcp_lifetime_usage(Some(&ask)).unwrap();
        let shape: Vec<(&str, i64)> = rows
            .iter()
            .map(|r| {
                (
                    r["token_name"].as_str().unwrap(),
                    r["requests"].as_i64().unwrap(),
                )
            })
            .collect();
        assert_eq!(shape, vec![("", 1), ("token-a", 2), ("token-b", 1)]);
        assert!(rows.iter().all(|r| r["last_used_at"].is_string()));
        // The '' tally row answers only an asked ''.
        let without_empty = s
            .read_mcp_lifetime_usage(Some(&names(&[Some("token-a")])))
            .unwrap();
        assert_eq!(without_empty.len(), 1);
        assert_eq!(
            s.read_mcp_lifetime_usage(Some(&names(&[Some("a\0b")])))
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
        s.write(|tx| {
            let record = RollupRecord {
                token_name: "token-a".to_string(),
                requests: i64::MAX,
                last_used_us: None,
                pruned_through_us: None,
            };
            put_json(tx, &rollup_key("token-a"), &record)
        })
        .unwrap();
        assert_eq!(
            s.read_mcp_lifetime_usage(Some(&names(&[Some("token-a")])))
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
    }

    #[test]
    fn projects_timestamptz_text_as_pglite_does() {
        assert_eq!(pg_timestamptz_text(0), "1970-01-01 00:00:00+00");
        assert_eq!(
            pg_timestamptz_text(1_763_452_000_336_000),
            "2025-11-18 07:46:40.336+00"
        );
        assert_eq!(
            pg_timestamptz_text(1_763_452_000_000_001),
            "2025-11-18 07:46:40.000001+00"
        );
    }
}
