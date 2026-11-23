//! The decide store: the `decide_state`, `decide_spend`, `decision_receipts` and
//! `decide_calibrations` tables of the PGLite engine (src/core/ai/decide/store.ts).
//!
//! Members: readDecideState, upsertDecideState, deleteDecideState, ensureDecideState,
//! insertDecideSpend, dailyDecideSpend, listDecideSpendBySlot; and, in `receipts`, insertDecideReceipts,
//! pruneDecideReceipts, listDecideReceiptStats, decideSlotUsage, decideConflictNoEntityCounts,
//! listDecideReplayReceipts, listDecideResolvedModels, listDecideMixedModelDecisions; and, in
//! `calibrations`, insertDecideCalibration, storeDecideQualification, listDecideCalibrations,
//! getDecideCalibration, setDecideCalibrationRetired.
//!
//! Keys (every record starts with `keys::EVAL_CAPTURE`, `Z`; this family owns sub-tags
//! `0x10..=0x1F`):
//! - `Z 0x10 <state key utf8>` -> `StateRecord` (JSON).
//! - `Z 0x11 <request_id utf8>` -> `SpendRecord` (JSON): one `decide_spend` row, the `request_id`
//!   primary key.
//! - `Z 0x12 <created_at u64 BE><seq u64 BE>` -> the request id: the time index of the spend
//!   rows. Walking it is walking the table in insertion order, which is the order Postgres sums
//!   a float column in.
//! - Counter `M decide_spend_seq`.
//! - `Z 0x13 <id u64 BE>` and `Z 0x14 <created_at u64 BE><id u64 BE>`, counter `M decide_receipt_id`: the
//!   receipts and their time index (see `receipts`).
//! - `Z 0x15 <id u64 BE>`, counter `M decide_calibration_id`: the calibrations (see
//!   `calibrations`).
//!
//! Records are small and read whole. Nothing here has a foreign key, so nothing cascades.
//! Floats are kept as their bit pattern: JSON text would not give every `f64` back exactly.

use super::{not_null, timestamp};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, prefix_end};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

mod calibrations;
mod receipts;
pub(crate) use calibrations::{
    CALIBRATION_ID, CalibrationRecord, remove_calibration, seed_calibration,
};
pub use calibrations::{DecideCalibrationInput, DecideQualificationInput};
pub use receipts::DecideReceiptInput;
pub(crate) use receipts::remove_receipt;
pub(crate) use receipts::{RECEIPT_ID, ReceiptRecord, seed_receipt};

const STATE: u8 = 0x10;
const SPEND: u8 = 0x11;
const SPEND_BY_TIME: u8 = 0x12;
const SPEND_SEQ: &str = "decide_spend_seq";

fn state_key(key: &str) -> Vec<u8> {
    let mut out = vec![keys::EVAL_CAPTURE, STATE];
    out.extend_from_slice(key.as_bytes());
    out
}

/// One `decide_state` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StateRecord {
    value: String,
    updated_at_us: i64,
}

fn load_state(read: &dyn KvRead, key: &str) -> Result<Option<StateRecord>> {
    match read.get(&state_key(key))? {
        Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        None => Ok(None),
    }
}

/// An `INTEGER` column: a whole number inside `i32`. Null is the caller's `NOT NULL` to judge;
/// a string, a fraction or a number outside the range is `invalid_argument` (Postgres refuses
/// the text it would be cast from).
fn int4(value: &Value, member: &str, column: &str) -> Result<Option<i32>> {
    let refused = || {
        StoreError::invalid(format!(
            "{member}: {column} must be an integer in the int4 range, got {value}"
        ))
    };
    match value {
        Value::Null => Ok(None),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return i32::try_from(i).map(Some).map_err(|_| refused());
            }
            let f = n.as_f64().ok_or_else(refused)?;
            if f.fract() != 0.0 || f < f64::from(i32::MIN) || f > f64::from(i32::MAX) {
                return Err(refused());
            }
            // Whole and in range, so the cast is exact.
            Ok(Some(f as i32))
        }
        _ => Err(refused()),
    }
}

/// A `DOUBLE PRECISION` column: any JSON number. Null is the caller's `NOT NULL` to judge.
fn float8(value: &Value, member: &str, column: &str) -> Result<Option<f64>> {
    match value {
        Value::Null => Ok(None),
        Value::Number(n) => n.as_f64().map(Some).ok_or_else(|| {
            StoreError::invalid(format!("{member}: {column} must be a finite number"))
        }),
        _ => Err(StoreError::invalid(format!(
            "{member}: {column} must be a number, got {value}"
        ))),
    }
}

/// The shadow seed (`seed.rs`): stores a `decide_state` row copied from another engine, with its
/// own `updated_at`. `false` when `key` already holds a row.
pub(crate) fn seed_state(
    tx: &mut dyn KvWrite,
    key: &str,
    value: &str,
    updated_at_us: i64,
) -> Result<bool> {
    if load_state(&*tx, key)?.is_some() {
        return Ok(false);
    }
    let record = StateRecord {
        value: value.to_string(),
        updated_at_us,
    };
    put_json(tx, &state_key(key), &record)?;
    Ok(true)
}

fn state_value_required(value: Option<&str>) -> Result<&str> {
    value.ok_or_else(|| not_null("decide_state", "value"))
}

impl Store {
    /// `readDecideState(key)`: the value kept under `key`, or null.
    pub fn read_decide_state(&self, key: &str) -> Result<Option<String>> {
        no_nul("readDecideState", &[("key", key)])?;
        let read = self.read()?;
        Ok(load_state(&*read, key)?.map(|r| r.value))
    }

    /// `upsertDecideState(key, value)`: keeps `value` under `key`, replacing an earlier one. A
    /// null value refuses with `constraint_violation`, a NUL byte with `invalid_argument`.
    pub fn upsert_decide_state(&self, key: &str, value: Option<&str>) -> Result<()> {
        no_nul("upsertDecideState", &[("key", key)])?;
        if let Some(v) = value {
            no_nul("upsertDecideState", &[("value", v)])?;
        }
        let value = state_value_required(value)?;
        self.write(|tx| {
            let record = StateRecord {
                value: value.to_string(),
                updated_at_us: self.env.now_micros(),
            };
            put_json(tx, &state_key(key), &record)
        })
    }

    /// `deleteDecideState(key)`: forgets `key`; an absent key is not an error.
    pub fn delete_decide_state(&self, key: &str) -> Result<()> {
        no_nul("deleteDecideState", &[("key", key)])?;
        self.write(|tx| tx.delete(&state_key(key)))
    }

    /// `ensureDecideState(key, value)`: keeps `value` only when nothing is under `key`, then
    /// answers the stored value, all in one write.
    pub fn ensure_decide_state(&self, key: &str, value: Option<&str>) -> Result<Option<String>> {
        no_nul("ensureDecideState", &[("key", key)])?;
        if let Some(v) = value {
            no_nul("ensureDecideState", &[("value", v)])?;
        }
        let value = state_value_required(value)?;
        self.write(|tx| {
            if let Some(stored) = load_state(&*tx, key)? {
                return Ok(Some(stored.value));
            }
            let record = StateRecord {
                value: value.to_string(),
                updated_at_us: self.env.now_micros(),
            };
            put_json(tx, &state_key(key), &record)?;
            Ok(Some(record.value))
        })
    }
}

fn spend_key(request_id: &str) -> Vec<u8> {
    let mut out = vec![keys::EVAL_CAPTURE, SPEND];
    out.extend_from_slice(request_id.as_bytes());
    out
}

fn spend_time_key(created_at_us: i64, seq: u64) -> Vec<u8> {
    let mut out = vec![keys::EVAL_CAPTURE, SPEND_BY_TIME];
    out.extend_from_slice(&(created_at_us.max(0) as u64).to_be_bytes());
    out.extend_from_slice(&seq.to_be_bytes());
    out
}

/// One `decide_spend` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SpendRecord {
    pub request_id: String,
    pub created_at_us: i64,
    pub source_id: Option<String>,
    pub slot: String,
    pub provider: String,
    pub model_resolved: Option<String>,
    pub lane: String,
    pub remote: bool,
    pub input_tokens: i32,
    /// `cost_usd`, as `f64::to_bits`.
    pub cost_bits: u64,
    pub outcome: String,
}

impl SpendRecord {
    fn cost(&self) -> f64 {
        f64::from_bits(self.cost_bits)
    }
}

/// One row of `insertDecideSpend`. Every column is optional here so a missing one fails as
/// Postgres fails it: a null in a `NOT NULL` column refuses with `constraint_violation`, even
/// where the column has a default (the SQL binds an explicit null).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DecideSpendInput {
    pub request_id: Option<String>,
    pub source_id: Option<String>,
    pub slot: Option<String>,
    pub provider: Option<String>,
    pub model_resolved: Option<String>,
    pub lane: Option<String>,
    pub remote: Option<bool>,
    pub input_tokens: Option<Value>,
    pub cost_usd: Option<Value>,
    pub outcome: Option<String>,
}

impl DecideSpendInput {
    /// The row to keep, or the refusal Postgres would give (columns in table order).
    fn validate(&self, created_at_us: i64) -> Result<SpendRecord> {
        const TABLE: &str = "decide_spend";
        const MEMBER: &str = "insertDecideSpend";
        let mut texts: Vec<(&str, &str)> = Vec::new();
        for (name, value) in [
            ("request_id", &self.request_id),
            ("source_id", &self.source_id),
            ("slot", &self.slot),
            ("provider", &self.provider),
            ("model_resolved", &self.model_resolved),
            ("lane", &self.lane),
            ("outcome", &self.outcome),
        ] {
            if let Some(text) = value.as_deref() {
                texts.push((name, text));
            }
        }
        no_nul(MEMBER, &texts)?;
        let null = Value::Null;
        let tokens = int4(
            self.input_tokens.as_ref().unwrap_or(&null),
            MEMBER,
            "input_tokens",
        )?;
        let cost = float8(self.cost_usd.as_ref().unwrap_or(&null), MEMBER, "cost_usd")?;
        let required = |value: &Option<String>, column: &str| -> Result<String> {
            value.clone().ok_or_else(|| not_null(TABLE, column))
        };
        Ok(SpendRecord {
            request_id: required(&self.request_id, "request_id")?,
            created_at_us,
            source_id: self.source_id.clone(),
            slot: required(&self.slot, "slot")?,
            provider: required(&self.provider, "provider")?,
            model_resolved: self.model_resolved.clone(),
            lane: required(&self.lane, "lane")?,
            remote: self.remote.ok_or_else(|| not_null(TABLE, "remote"))?,
            input_tokens: tokens.ok_or_else(|| not_null(TABLE, "input_tokens"))?,
            cost_bits: cost.ok_or_else(|| not_null(TABLE, "cost_usd"))?.to_bits(),
            outcome: required(&self.outcome, "outcome")?,
        })
    }
}

/// Every spend row from `since_us` on, in insertion order.
fn spend_rows_since(read: &dyn KvRead, since_us: i64) -> Result<Vec<SpendRecord>> {
    let prefix = [keys::EVAL_CAPTURE, SPEND_BY_TIME];
    let mut start = prefix.to_vec();
    start.extend_from_slice(&(since_us.max(0) as u64).to_be_bytes());
    let end = prefix_end(&prefix).expect("the prefix is not all 0xFF");
    let mut ids: Vec<String> = Vec::new();
    read.scan(&start, &end, false, &mut |_, v| {
        ids.push(String::from_utf8_lossy(v).into_owned());
        true
    })?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(bytes) = read.get(&spend_key(&id))? {
            out.push(serde_json::from_slice(&bytes)?);
        }
    }
    Ok(out)
}

/// Drops the spend rows older than `cutoff_us` and their index entries; returns how many.
fn prune_spend_before(tx: &mut dyn KvWrite, cutoff_us: i64) -> Result<u64> {
    let prefix = [keys::EVAL_CAPTURE, SPEND_BY_TIME];
    let end = spend_time_key(cutoff_us, 0);
    let mut doomed: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    tx.scan(&prefix, &end, false, &mut |k, v| {
        doomed.push((k.to_vec(), v.to_vec()));
        true
    })?;
    for (index_key, id) in &doomed {
        tx.delete(&spend_key(&String::from_utf8_lossy(id)))?;
        tx.delete(index_key)?;
    }
    Ok(doomed.len() as u64)
}

/// The shadow seed (`seed.rs`): stores a `decide_spend` row copied from another engine, with its
/// own `created_at`, and its time-index entry as [`Store::insert_decide_spend`] writes it (the
/// sequence number comes from `M decide_spend_seq`, so rows seeded later sort after earlier ones
/// of the same instant). `false` when the request id already holds a row.
pub(crate) fn seed_spend(tx: &mut dyn KvWrite, record: &SpendRecord) -> Result<bool> {
    if tx.get(&spend_key(&record.request_id))?.is_some() {
        return Ok(false);
    }
    let seq = next_id(tx, SPEND_SEQ)?;
    put_json(tx, &spend_key(&record.request_id), record)?;
    tx.put(
        &spend_time_key(record.created_at_us, seq),
        record.request_id.as_bytes(),
    )?;
    Ok(true)
}

impl Store {
    /// `insertDecideSpend(rows)`: records the rows, all stamped now. A request id that is
    /// already recorded, or earlier in the batch, keeps its first row. Every row is checked
    /// before any is written, so a refused row records none (`constraint_violation` for a null
    /// in a `NOT NULL` column, `invalid_argument` for a NUL byte or a number outside `int4`).
    pub fn insert_decide_spend(&self, rows: &[DecideSpendInput]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let now = self.env.now_micros();
        let records = rows
            .iter()
            .map(|r| r.validate(now))
            .collect::<Result<Vec<_>>>()?;
        self.write(|tx| {
            for record in &records {
                if tx.get(&spend_key(&record.request_id))?.is_some() {
                    continue;
                }
                let seq = next_id(tx, SPEND_SEQ)?;
                put_json(tx, &spend_key(&record.request_id), record)?;
                tx.put(
                    &spend_time_key(record.created_at_us, seq),
                    record.request_id.as_bytes(),
                )?;
            }
            Ok(())
        })
    }

    /// `dailyDecideSpend(since)`: the cost of the rows recorded at or after `since` (an ISO
    /// timestamp) whose provider starts with `typesafe:`, in all and the part marked remote.
    /// Resolves `{ total, remote }`, both 0 when nothing matches.
    pub fn daily_decide_spend(&self, since: &str) -> Result<Value> {
        let since_us = timestamp(since, "dailyDecideSpend since")?;
        let read = self.read()?;
        let (mut total, mut remote) = (0.0_f64, 0.0_f64);
        for row in spend_rows_since(&*read, since_us)? {
            if row.provider.starts_with("typesafe:") {
                total += row.cost();
                if row.remote {
                    remote += row.cost();
                }
            }
        }
        Ok(json!({ "total": total, "remote": remote }))
    }

    /// `listDecideSpendBySlot()`: tokens, cost and request count per slot over the whole ledger,
    /// slots in byte order. Costs add up in insertion order, as Postgres adds them.
    pub fn list_decide_spend_by_slot(&self) -> Result<Value> {
        let read = self.read()?;
        let mut by_slot: BTreeMap<String, (i64, f64, i64)> = BTreeMap::new();
        for row in spend_rows_since(&*read, 0)? {
            let entry = by_slot.entry(row.slot.clone()).or_insert((0, 0.0, 0));
            entry.0 += i64::from(row.input_tokens);
            entry.1 += row.cost();
            entry.2 += 1;
        }
        Ok(Value::Array(
            by_slot
                .into_iter()
                .map(|(slot, (tokens, cost, n))| {
                    json!({ "slot": slot, "input_tokens": tokens, "cost_usd": cost, "requests": n })
                })
                .collect(),
        ))
    }
}

/// The shadow follow (`seed/follow.rs`): removes the `decide_state` row `key`. `false` when there
/// is none.
pub(crate) fn remove_state(tx: &mut dyn KvWrite, key: &str) -> Result<bool> {
    if key.contains('\0') || load_state(&*tx, key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&state_key(key))?;
    Ok(true)
}

/// The shadow follow: removes the `decide_spend` row of `request_id` with its time-index entry,
/// which is found by the row's `created_at`. `false` when there is none.
pub(crate) fn remove_spend(tx: &mut dyn KvWrite, request_id: &str) -> Result<bool> {
    let Some(bytes) = tx.get(&spend_key(request_id))? else {
        return Ok(false);
    };
    let record: SpendRecord = serde_json::from_slice(&bytes)?;
    let (start, end) = (
        spend_time_key(record.created_at_us, 0),
        spend_time_key(record.created_at_us.saturating_add(1), 0),
    );
    let mut index = Vec::new();
    tx.scan(&start, &end, false, &mut |k, v| {
        if v == request_id.as_bytes() {
            index.push(k.to_vec());
        }
        true
    })?;
    for key in index {
        tx.delete(&key)?;
    }
    tx.delete(&spend_key(request_id))?;
    Ok(true)
}
