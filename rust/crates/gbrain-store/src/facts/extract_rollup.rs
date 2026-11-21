//! The 7-day extract rollup (`extract_rollup_7d`, migrations v106, v141 and v239): the writer
//! `upsertExtractRollup` (src/core/engine-sql/extract-bookkeeping.ts) and the two doctor reads of
//! it, `readExtractRollup7d` and `listRecordedHaltReasons7d` (doctor's `extract_health` check).
//!
//! Key: `F 0x11 kind\0 source_id\0 day\0` (`day` as `YYYY-MM-DD`), one [`RollupRecord`] per
//! `(kind, source_id, day)`, the table's primary key. The table has no foreign key, so deleting a
//! source keeps its rows, as in Postgres.
//!
//! The writer is the SQL's `INSERT ... ON CONFLICT DO UPDATE`: a new row takes the event's deltas,
//! an existing one adds them. `cost_usd` is `REAL`, so it is kept and added as a 4-byte float; a
//! value that does not fit refuses, as Postgres's `value out of range: overflow` does. The counts
//! are `INT`: a sum past 2^31 - 1 refuses, as `integer out of range` does. `halt_reasons` is `{}`
//! with no reason and `{reason: halts}` on insert; on conflict a reason adds `halts` to its
//! bucket and no reason keeps the buckets. `updated_at` is the write time. The `pre_v141` form is
//! the statement of a brain behind v141: it adds the expected-limit stops to `halt_count` and
//! touches neither `expected_limit_count` nor `halt_reasons`.
//!
//! The reads take the rows whose day is on or after `CURRENT_DATE - 7`, with `CURRENT_DATE` the
//! UTC date (the writer's own default day is the UTC date too). `readExtractRollup7d` groups by
//! kind in byte order (Postgres uses the database collation, which can differ for punctuation): the
//! `REAL` sum is a 4-byte float sum, the `INT` sums are 8-byte integers, `last_updated_at` is the
//! newest write time as ISO text, and `last_halt_age_days` is the days since the newest day with
//! a halt (null without one). `withExpected: false` answers 0 for `expected_limit_count`.
//! `listRecordedHaltReasons7d` sums each kind's recorded reason buckets, in (kind, reason) order.

use crate::env::{days_from_civil, iso};
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::timeline::parse_date;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The byte after `keys::FACT` that marks an extract rollup row.
const EXTRACT_ROLLUP: u8 = 0x11;
const MICROS_PER_DAY: i64 = 86_400_000_000;

/// One `extract_rollup_7d` row besides its key.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct RollupRecord {
    cost_usd: f32,
    halt_count: i32,
    eval_fail_count: i32,
    eval_pass_count: i32,
    round_completed_count: i32,
    expected_limit_count: i32,
    rollup_write_failures: i32,
    halt_reasons: BTreeMap<String, i32>,
    updated_at_us: i64,
}

/// `upsertExtractRollup(row, form?)`: one event, its deltas already defaulted to 0.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractRollupEvent {
    pub kind: String,
    pub source_id: String,
    pub day: String,
    pub cost: f64,
    pub halts: i32,
    pub eval_fails: i32,
    pub eval_passes: i32,
    pub completed: i32,
    pub expected_limits: i32,
    pub failures: i32,
    pub reason: Option<String>,
    /// `Some("pre_v141")` for the statement of a brain behind migration v141.
    pub form: Option<String>,
}

/// `readExtractRollup7d(withExpected)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractRollupQuery {
    pub with_expected: bool,
}

fn rollup_key(kind: &str, source_id: &str, day: &str) -> Vec<u8> {
    let mut key = vec![keys::FACT, EXTRACT_ROLLUP];
    for part in [kind, source_id, day] {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key
}

/// Splits a rollup key into its kind and day.
fn key_parts(key: &[u8]) -> Option<(String, String)> {
    let mut parts = key.get(2..)?.split(|b| *b == 0);
    let kind = String::from_utf8(parts.next()?.to_vec()).ok()?;
    let _source = parts.next()?;
    let day = String::from_utf8(parts.next()?.to_vec()).ok()?;
    Some((kind, day))
}

fn out_of_range(what: &str) -> StoreError {
    StoreError::new(
        INVALID_ARGUMENT,
        format!("upsertExtractRollup: {what} out of range"),
    )
}

/// `INT + INT`, refusing past the 4-byte range.
fn add_int(a: i32, b: i32) -> Result<i32> {
    a.checked_add(b).ok_or_else(|| out_of_range("integer"))
}

/// A `REAL`: refuses a value a 4-byte float cannot hold.
fn real(value: f64) -> Result<f32> {
    let narrowed = value as f32;
    if narrowed.is_finite() {
        Ok(narrowed)
    } else {
        Err(out_of_range("value"))
    }
}

/// Days since the epoch of a `YYYY-MM-DD` day.
fn day_number(day: &str) -> Option<i64> {
    let y = day.get(0..4)?.parse().ok()?;
    let m = day.get(5..7)?.parse().ok()?;
    let d = day.get(8..10)?.parse().ok()?;
    Some(days_from_civil(y, m, d))
}

/// A 4-byte float as the JSON number its shortest text reads as, as a driver parses `real` text.
fn real_json(value: f32) -> Value {
    format!("{value}")
        .parse::<f64>()
        .map_or(Value::Null, |v| json!(v))
}

/// The rows of the last 7 days (`day >= CURRENT_DATE - 7`), in key order.
fn recent_rows(read: &dyn KvRead, today: i64) -> Result<Vec<(String, i64, RollupRecord)>> {
    let mut keys_seen = Vec::new();
    scan_prefix(read, &[keys::FACT, EXTRACT_ROLLUP], false, &mut |k, _| {
        keys_seen.push(k.to_vec());
        true
    })?;
    let mut out = Vec::new();
    for key in keys_seen {
        let Some((kind, day)) = key_parts(&key) else {
            continue;
        };
        let Some(n) = day_number(&day) else {
            continue;
        };
        if n < today - 7 {
            continue;
        }
        if let Some(record) = get_json::<RollupRecord>(read, &key)? {
            out.push((kind, n, record));
        }
    }
    Ok(out)
}

impl Store {
    fn utc_day_number(&self) -> i64 {
        self.env.now_micros().div_euclid(MICROS_PER_DAY)
    }

    /// `upsertExtractRollup(row, form?)`.
    pub fn upsert_extract_rollup(&self, e: &ExtractRollupEvent) -> Result<()> {
        let op = "upsertExtractRollup";
        no_nul(
            op,
            &[
                ("kind", &e.kind),
                ("sourceId", &e.source_id),
                ("reason", e.reason.as_deref().unwrap_or("")),
            ],
        )?;
        let pre_v141 = match e.form.as_deref() {
            None => false,
            Some("pre_v141") => true,
            Some(other) => {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("{op}: unknown statement form \"{other}\""),
                ));
            }
        };
        let day = parse_date(&e.day)?;
        let cost = real(e.cost)?;
        let (halts, reason) = if pre_v141 {
            (add_int(e.halts, e.expected_limits)?, None)
        } else {
            (e.halts, e.reason.clone())
        };
        let expected = if pre_v141 { 0 } else { e.expected_limits };
        let now = self.env.now_micros();
        let key = rollup_key(&e.kind, &e.source_id, &day);
        self.write(|tx| {
            let record = match get_json::<RollupRecord>(tx, &key)? {
                None => RollupRecord {
                    cost_usd: cost,
                    halt_count: halts,
                    eval_fail_count: e.eval_fails,
                    eval_pass_count: e.eval_passes,
                    round_completed_count: e.completed,
                    expected_limit_count: expected,
                    rollup_write_failures: e.failures,
                    halt_reasons: reason.iter().map(|r| (r.clone(), halts)).collect(),
                    updated_at_us: now,
                },
                Some(mut row) => {
                    row.cost_usd = real(f64::from(row.cost_usd + cost))?;
                    row.halt_count = add_int(row.halt_count, halts)?;
                    row.eval_fail_count = add_int(row.eval_fail_count, e.eval_fails)?;
                    row.eval_pass_count = add_int(row.eval_pass_count, e.eval_passes)?;
                    row.round_completed_count = add_int(row.round_completed_count, e.completed)?;
                    row.expected_limit_count = add_int(row.expected_limit_count, expected)?;
                    row.rollup_write_failures = add_int(row.rollup_write_failures, e.failures)?;
                    if let Some(r) = &reason {
                        let bucket = row.halt_reasons.get(r).copied().unwrap_or(0);
                        row.halt_reasons.insert(r.clone(), add_int(bucket, halts)?);
                    }
                    row.updated_at_us = now;
                    row
                }
            };
            put_json(tx, &key, &record)
        })
    }

    /// `readExtractRollup7d(withExpected)`.
    pub fn read_extract_rollup_7d(&self, q: &ExtractRollupQuery) -> Result<Value> {
        let today = self.utc_day_number();
        let read = self.read()?;
        #[derive(Default)]
        struct Sum {
            cost: f32,
            pass: i64,
            fail: i64,
            halt: i64,
            completed: i64,
            expected: i64,
            failures: i64,
            updated: i64,
            last_halt: Option<i64>,
        }
        let mut by_kind: BTreeMap<String, Sum> = BTreeMap::new();
        for (kind, day, r) in recent_rows(&*read, today)? {
            let s = by_kind.entry(kind).or_default();
            s.cost += r.cost_usd;
            s.pass += i64::from(r.eval_pass_count);
            s.fail += i64::from(r.eval_fail_count);
            s.halt += i64::from(r.halt_count);
            s.completed += i64::from(r.round_completed_count);
            s.expected += i64::from(r.expected_limit_count);
            s.failures += i64::from(r.rollup_write_failures);
            s.updated = s.updated.max(r.updated_at_us);
            if r.halt_count > 0 {
                s.last_halt = Some(s.last_halt.map_or(day, |d| d.max(day)));
            }
        }
        let rows: Vec<Value> = by_kind
            .into_iter()
            .map(|(kind, s)| {
                json!({
                    "kind": kind,
                    "cost_7d_usd": real_json(s.cost),
                    "eval_pass_count": s.pass,
                    "eval_fail_count": s.fail,
                    "halt_count": s.halt,
                    "round_completed_count": s.completed,
                    "expected_limit_count": if q.with_expected { s.expected } else { 0 },
                    "rollup_write_failures": s.failures,
                    "last_updated_at": iso(s.updated),
                    "last_halt_age_days": s.last_halt.map(|d| today - d),
                })
            })
            .collect();
        Ok(Value::Array(rows))
    }

    /// `listRecordedHaltReasons7d()`.
    pub fn list_recorded_halt_reasons_7d(&self) -> Result<Value> {
        let today = self.utc_day_number();
        let read = self.read()?;
        let mut sums: BTreeMap<(String, String), i64> = BTreeMap::new();
        for (kind, _, r) in recent_rows(&*read, today)? {
            for (reason, n) in r.halt_reasons {
                *sums.entry((kind.clone(), reason)).or_default() += i64::from(n);
            }
        }
        Ok(Value::Array(
            sums.into_iter()
                .map(|((kind, reason), n)| json!({ "kind": kind, "reason": reason, "n": n }))
                .collect(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OpenOptions;
    use crate::env::civil_from_days;
    use std::path::PathBuf;

    /// A store in a directory removed when the guard drops.
    struct Brain(Store, PathBuf);
    impl Drop for Brain {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.1);
        }
    }

    fn brain(name: &str) -> Brain {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/unit-tmp")
            .join(format!("extract-rollup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Brain(
            Store::open_dir(&dir.join("brain"), OpenOptions::default()).unwrap(),
            dir,
        )
    }

    /// `CURRENT_DATE` as `YYYY-MM-DD` for a day number.
    fn day_text(n: i64) -> String {
        let (y, m, d) = civil_from_days(n);
        format!("{y:04}-{m:02}-{d:02}")
    }

    fn event(kind: &str, day: &str) -> ExtractRollupEvent {
        ExtractRollupEvent {
            kind: kind.into(),
            source_id: "default".into(),
            day: day.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_rollup_key_ends_each_part_with_a_nul_and_splits_back() {
        let key = rollup_key("facts", "default", "2026-11-20");
        assert_eq!(&key[..2], &[keys::FACT, EXTRACT_ROLLUP]);
        assert_eq!(key_parts(&key), Some(("facts".into(), "2026-11-20".into())));
    }

    #[test]
    fn events_add_up_and_the_reads_sum_the_last_seven_days() {
        let guard = brain("sums");
        let store = &guard.0;
        let today = store.utc_day_number();
        let (d0, d3, d8) = (day_text(today), day_text(today - 3), day_text(today - 8));
        let halt = |kind: &str, day: &str, halts, reason: Option<&str>| ExtractRollupEvent {
            halts,
            reason: reason.map(Into::into),
            cost: 0.1,
            ..event(kind, day)
        };
        store
            .upsert_extract_rollup(&halt("facts", &d0, 2, Some("auth")))
            .unwrap();
        store
            .upsert_extract_rollup(&halt("facts", &d0, 1, Some("auth")))
            .unwrap();
        store
            .upsert_extract_rollup(&halt("facts", &d3, 1, None))
            .unwrap();
        store
            .upsert_extract_rollup(&ExtractRollupEvent {
                eval_passes: 4,
                expected_limits: 2,
                ..event("facts", &d0)
            })
            .unwrap();
        store
            .upsert_extract_rollup(&halt("facts", &d8, 5, Some("billing")))
            .unwrap();
        store
            .upsert_extract_rollup(&ExtractRollupEvent {
                completed: 1,
                ..event("takes", &d3)
            })
            .unwrap();
        store
            .upsert_extract_rollup(&ExtractRollupEvent {
                halts: 1,
                expected_limits: 2,
                reason: Some("auth".into()),
                form: Some("pre_v141".into()),
                ..event("takes", &d3)
            })
            .unwrap();

        let rows = store
            .read_extract_rollup_7d(&ExtractRollupQuery {
                with_expected: true,
            })
            .unwrap();
        let facts = &rows[0];
        assert_eq!(facts["kind"], "facts");
        assert_eq!(facts["halt_count"], 4);
        assert_eq!(facts["eval_pass_count"], 4);
        assert_eq!(facts["expected_limit_count"], 2);
        assert_eq!(facts["last_halt_age_days"], 0);
        assert_eq!(facts["cost_7d_usd"], json!(0.3));
        let takes = &rows[1];
        assert_eq!(
            (
                takes["halt_count"].clone(),
                takes["expected_limit_count"].clone()
            ),
            (json!(3), json!(0))
        );
        assert_eq!(takes["last_halt_age_days"], 3);
        let no_expected = store
            .read_extract_rollup_7d(&ExtractRollupQuery {
                with_expected: false,
            })
            .unwrap();
        assert_eq!(no_expected[0]["expected_limit_count"], 0);

        let reasons = store.list_recorded_halt_reasons_7d().unwrap();
        assert_eq!(
            reasons,
            json!([{ "kind": "facts", "reason": "auth", "n": 3 }])
        );
    }

    #[test]
    fn a_count_past_the_int_range_and_a_bad_day_refuse() {
        let guard = brain("range");
        let store = &guard.0;
        let day = day_text(store.utc_day_number());
        store
            .upsert_extract_rollup(&ExtractRollupEvent {
                halts: i32::MAX,
                ..event("facts", &day)
            })
            .unwrap();
        let err = store
            .upsert_extract_rollup(&ExtractRollupEvent {
                halts: 1,
                ..event("facts", &day)
            })
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        assert!(
            store
                .upsert_extract_rollup(&event("facts", "2026-02-30"))
                .is_err()
        );
        assert!(
            store
                .upsert_extract_rollup(&ExtractRollupEvent {
                    cost: 1e39,
                    ..event("facts", &day)
                })
                .is_err()
        );
    }
}
