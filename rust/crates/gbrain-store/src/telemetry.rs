//! Search telemetry: the `search_telemetry` table of the PGLite engine, written by the search
//! telemetry flush (`src/core/search/telemetry.ts`) and read by `gbrain search stats` and the search
//! tune advisor.
//!
//! Members: recordSearchTelemetry, readSearchStats (`src/core/engine-sql/telemetry.ts`).
//!
//! Keys (every record starts with `keys::TELEMETRY`, `a`, then the table's sub-tag):
//! - `a 0x01 <date> 0x00 <mode> 0x00 <intent>` -> `SearchRecord` (JSON). The text parts are the
//!   table's primary key `(date, mode, intent)`; none may hold a NUL byte, so the key is unique.
//!
//! The other sub-tags of `a` (MCP request log, its tally, retrieval feedback, budget ledger) have
//! no records yet: those tables are not served (rust/docs/store/telemetry.md).
//!
//! The table carries no source and no page: page and source deletes never touch it.

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const TABLE: &str = "search_telemetry";
const OP_RECORD: &str = "recordSearchTelemetry";
const OP_READ: &str = "readSearchStats";

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
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"{TABLE}\" violates not-null constraint"
        ),
    )
}

fn integer_out_of_range(op: &str) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, format!("{op}: integer out of range"))
}

/// A number bound to an `INTEGER` parameter, as Postgres reads its text form: a whole number in
/// the `int4` range, or refused.
fn int4_param(column: &str, value: f64) -> Result<i32> {
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{OP_RECORD}: invalid input syntax for type integer: \"{value}\" ({column})"),
        ));
    }
    if value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{OP_RECORD}: value \"{value}\" is out of range for type integer ({column})"),
        ));
    }
    // Whole and in range, so the cast is exact.
    Ok(value as i32)
}

/// A float8 sum: Postgres refuses a finite sum that overflows to infinity.
fn float_add(a: f64, b: f64, op: &str) -> Result<f64> {
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
                Some(v) => Some(int4_param(column, v)?),
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
                    date,
                    mode,
                    intent,
                    counters: values,
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
