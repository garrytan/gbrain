//! The `decide_calibrations` table of the decide store: one row per calibration run, listed by
//! slot, qualified once, retired and un-retired.
//!
//! Keys (see the parent module for the family's sub-tags):
//! - `Z 0x15 <id u64 BE>` -> `CalibrationRecord` (JSON): one row; ids come from
//!   `M decide_calibration_id` and count up from 1 (`BIGSERIAL`).
//!
//! A calibration list is short (one row per qualification run), so reads walk the whole table.
//! `REAL` columns are kept as `f32` bits and read back as Postgres prints them (see `receipts`).

use super::receipts::{opt_int4, real_value, real4};
use crate::error::{Result, StoreError};
use crate::eval_capture::not_null;
use crate::kv::{KvRead, KvWrite, prefix_end};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const CALIBRATION: u8 = 0x15;
pub(crate) const CALIBRATION_ID: &str = "decide_calibration_id";

fn calibration_key(id: u64) -> Vec<u8> {
    let mut out = vec![keys::EVAL_CAPTURE, CALIBRATION];
    out.extend_from_slice(&id.to_be_bytes());
    out
}

/// One `decide_calibrations` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CalibrationRecord {
    pub id: u64,
    pub slot: String,
    pub call_site: String,
    pub provider: String,
    pub model_resolved: String,
    /// `REAL`, as `f32::to_bits`.
    pub threshold: u32,
    pub min_keep: Option<i32>,
    pub metric: String,
    pub metric_value: Option<u32>,
    pub ece: Option<u32>,
    pub retest_sd: Option<u32>,
    pub repack_sd: Option<u32>,
    pub action_precision_lb: Option<u32>,
    pub qualification: Option<String>,
    pub qualified_at_us: Option<i64>,
    pub policy_fingerprint: Option<String>,
    pub n: i32,
    pub dataset_hash: Option<String>,
    pub split_hash: Option<String>,
    pub calibrate_ids_hash: Option<String>,
    pub calibrate_only: bool,
    pub pack_shape: String,
    pub created_at_us: i64,
    pub retired_at_us: Option<i64>,
    pub notes: Option<String>,
}

impl CalibrationRecord {
    fn to_json(&self) -> Value {
        let real = |bits: Option<u32>| bits.map(real_value);
        let at = |us: Option<i64>| us.map(crate::env::iso);
        json!({
            "id": self.id,
            "slot": self.slot,
            "call_site": self.call_site,
            "provider": self.provider,
            "model_resolved": self.model_resolved,
            "threshold": real_value(self.threshold),
            "min_keep": self.min_keep,
            "metric": self.metric,
            "metric_value": real(self.metric_value),
            "ece": real(self.ece),
            "retest_sd": real(self.retest_sd),
            "repack_sd": real(self.repack_sd),
            "action_precision_lb": real(self.action_precision_lb),
            "qualification": self.qualification,
            "qualified_at": at(self.qualified_at_us),
            "policy_fingerprint": self.policy_fingerprint,
            "n": self.n,
            "dataset_hash": self.dataset_hash,
            "split_hash": self.split_hash,
            "calibrate_ids_hash": self.calibrate_ids_hash,
            "calibrate_only": self.calibrate_only,
            "pack_shape": self.pack_shape,
            "created_at": crate::env::iso(self.created_at_us),
            "retired_at": at(self.retired_at_us),
            "notes": self.notes,
        })
    }
}

/// One row of `insertDecideCalibration`. Every column is optional here so a missing one fails as
/// Postgres fails it (see `DecideSpendInput`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DecideCalibrationInput {
    pub slot: Option<String>,
    pub call_site: Option<String>,
    pub provider: Option<String>,
    pub model_resolved: Option<String>,
    pub threshold: Option<Value>,
    pub min_keep: Option<Value>,
    pub metric: Option<String>,
    pub metric_value: Option<Value>,
    pub ece: Option<Value>,
    pub retest_sd: Option<Value>,
    pub repack_sd: Option<Value>,
    pub n: Option<Value>,
    pub dataset_hash: Option<String>,
    pub split_hash: Option<String>,
    pub calibrate_ids_hash: Option<String>,
    pub calibrate_only: Option<bool>,
    pub pack_shape: Option<String>,
    pub notes: Option<String>,
}

/// The arguments of `storeDecideQualification` besides the id: all three columns are replaced,
/// null included.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DecideQualificationInput {
    pub action_precision_lb: Option<Value>,
    pub qualification: Option<String>,
    pub policy_fingerprint: Option<String>,
}

/// A `BIGINT` id from a JavaScript number: a whole number inside `i64` (Postgres refuses the
/// text of anything else when it binds the parameter).
fn whole_id(id: f64, member: &str) -> Result<i64> {
    // 2^63 is the first value past `i64::MAX`, and exactly representable.
    if !id.is_finite()
        || id.fract() != 0.0
        || id < -9_223_372_036_854_775_808.0
        || id >= 9_223_372_036_854_775_808.0
    {
        return Err(StoreError::invalid(format!(
            "{member}: id must be an integer in the int8 range, got {id}"
        )));
    }
    Ok(id as i64)
}

fn load<R: KvRead + ?Sized>(read: &R, id: i64) -> Result<Option<CalibrationRecord>> {
    let Ok(id) = u64::try_from(id) else {
        return Ok(None);
    };
    match read.get(&calibration_key(id))? {
        Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        None => Ok(None),
    }
}

/// The shadow seed (`seed.rs`): stores a `decide_calibrations` row copied from another engine with
/// its own id and times. `false` when the id already holds a row.
pub(crate) fn seed_calibration(tx: &mut dyn KvWrite, record: &CalibrationRecord) -> Result<bool> {
    if tx.get(&calibration_key(record.id))?.is_some() {
        return Ok(false);
    }
    put_json(tx, &calibration_key(record.id), record)?;
    Ok(true)
}

impl Store {
    /// `insertDecideCalibration(row)`: records the row, stamped now, and resolves its id.
    /// `constraint_violation` for a null in a `NOT NULL` column; `invalid_argument` for a NUL
    /// byte, a number outside `int4` or `real`.
    pub fn insert_decide_calibration(&self, row: &DecideCalibrationInput) -> Result<u64> {
        const TABLE: &str = "decide_calibrations";
        const MEMBER: &str = "insertDecideCalibration";
        let mut texts: Vec<(&str, &str)> = Vec::new();
        for (name, value) in [
            ("slot", &row.slot),
            ("call_site", &row.call_site),
            ("provider", &row.provider),
            ("model_resolved", &row.model_resolved),
            ("metric", &row.metric),
            ("dataset_hash", &row.dataset_hash),
            ("split_hash", &row.split_hash),
            ("calibrate_ids_hash", &row.calibrate_ids_hash),
            ("pack_shape", &row.pack_shape),
            ("notes", &row.notes),
        ] {
            if let Some(text) = value.as_deref() {
                texts.push((name, text));
            }
        }
        no_nul(MEMBER, &texts)?;
        let threshold = real4(&row.threshold, MEMBER, "threshold")?;
        let metric_value = real4(&row.metric_value, MEMBER, "metric_value")?;
        let ece = real4(&row.ece, MEMBER, "ece")?;
        let retest_sd = real4(&row.retest_sd, MEMBER, "retest_sd")?;
        let repack_sd = real4(&row.repack_sd, MEMBER, "repack_sd")?;
        let min_keep = opt_int4(&row.min_keep, MEMBER, "min_keep")?;
        let n = opt_int4(&row.n, MEMBER, "n")?;
        let required = |value: &Option<String>, column: &str| -> Result<String> {
            value.clone().ok_or_else(|| not_null(TABLE, column))
        };
        let record = CalibrationRecord {
            id: 0,
            slot: required(&row.slot, "slot")?,
            call_site: required(&row.call_site, "call_site")?,
            provider: required(&row.provider, "provider")?,
            model_resolved: required(&row.model_resolved, "model_resolved")?,
            threshold: threshold.ok_or_else(|| not_null(TABLE, "threshold"))?,
            min_keep,
            metric: required(&row.metric, "metric")?,
            metric_value,
            ece,
            retest_sd,
            repack_sd,
            action_precision_lb: None,
            qualification: None,
            qualified_at_us: None,
            policy_fingerprint: None,
            n: n.ok_or_else(|| not_null(TABLE, "n"))?,
            dataset_hash: row.dataset_hash.clone(),
            split_hash: row.split_hash.clone(),
            calibrate_ids_hash: row.calibrate_ids_hash.clone(),
            calibrate_only: row
                .calibrate_only
                .ok_or_else(|| not_null(TABLE, "calibrate_only"))?,
            pack_shape: required(&row.pack_shape, "pack_shape")?,
            created_at_us: self.env.now_micros(),
            retired_at_us: None,
            notes: row.notes.clone(),
        };
        self.write(|tx| {
            let id = next_id(tx, CALIBRATION_ID)?;
            put_json(
                tx,
                &calibration_key(id),
                &CalibrationRecord {
                    id,
                    ..record.clone()
                },
            )?;
            Ok(id)
        })
    }

    /// `storeDecideQualification(id, q)`: replaces the three qualification columns of the row
    /// and stamps `qualified_at` now. An id with no row is not an error.
    pub fn store_decide_qualification(&self, id: f64, q: &DecideQualificationInput) -> Result<()> {
        const MEMBER: &str = "storeDecideQualification";
        let id = whole_id(id, MEMBER)?;
        let texts: Vec<(&str, &str)> = [
            ("qualification", &q.qualification),
            ("policy_fingerprint", &q.policy_fingerprint),
        ]
        .into_iter()
        .filter_map(|(name, value)| value.as_deref().map(|text| (name, text)))
        .collect();
        no_nul(MEMBER, &texts)?;
        let action_precision_lb = real4(&q.action_precision_lb, MEMBER, "action_precision_lb")?;
        let now = self.env.now_micros();
        self.write(|tx| {
            if let Some(mut record) = load(tx, id)? {
                record.action_precision_lb = action_precision_lb;
                record.qualification = q.qualification.clone();
                record.policy_fingerprint = q.policy_fingerprint.clone();
                record.qualified_at_us = Some(now);
                put_json(tx, &calibration_key(record.id), &record)?;
            }
            Ok(())
        })
    }

    /// `listDecideCalibrations({ slot?, includeRetired? })`: the rows, by slot (byte order), then
    /// newest first, then highest id first. Retired rows only when asked for.
    pub fn list_decide_calibrations(
        &self,
        slot: Option<&str>,
        include_retired: bool,
    ) -> Result<Value> {
        const MEMBER: &str = "listDecideCalibrations";
        if let Some(slot) = slot {
            no_nul(MEMBER, &[("slot", slot)])?;
        }
        let read = self.read()?;
        let prefix = [keys::EVAL_CAPTURE, CALIBRATION];
        let end = prefix_end(&prefix).expect("the prefix is not all 0xFF");
        let mut rows: Vec<CalibrationRecord> = Vec::new();
        let mut failure = None;
        read.scan(&prefix, &end, false, &mut |_, bytes| {
            match serde_json::from_slice::<CalibrationRecord>(bytes) {
                Ok(record) => rows.push(record),
                Err(e) => {
                    failure = Some(e);
                    return false;
                }
            }
            true
        })?;
        if let Some(e) = failure {
            return Err(e.into());
        }
        rows.retain(|r| {
            slot.is_none_or(|s| r.slot == s) && (include_retired || r.retired_at_us.is_none())
        });
        rows.sort_by(|a, b| {
            a.slot
                .cmp(&b.slot)
                .then(b.created_at_us.cmp(&a.created_at_us))
                .then(b.id.cmp(&a.id))
        });
        Ok(Value::Array(
            rows.iter().map(CalibrationRecord::to_json).collect(),
        ))
    }

    /// `getDecideCalibration(id)`: the row, or null.
    pub fn get_decide_calibration(&self, id: f64) -> Result<Value> {
        let id = whole_id(id, "getDecideCalibration")?;
        let read = self.read()?;
        Ok(load(&*read, id)?.map_or(Value::Null, |r| r.to_json()))
    }

    /// `setDecideCalibrationRetired(id, retired)`: stamps `retired_at` now, or clears it. Resolves
    /// whether the row exists (a retired row retired again gets a fresh stamp).
    pub fn set_decide_calibration_retired(&self, id: f64, retired: bool) -> Result<bool> {
        let id = whole_id(id, "setDecideCalibrationRetired")?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut record) = load(tx, id)? else {
                return Ok(false);
            };
            record.retired_at_us = retired.then_some(now);
            put_json(tx, &calibration_key(record.id), &record)?;
            Ok(true)
        })
    }
}

/// The shadow follow (`seed/follow.rs`): removes the calibration `id`. `false` when there is none.
pub(crate) fn remove_calibration(tx: &mut dyn KvWrite, id: u64) -> Result<bool> {
    if tx.get(&calibration_key(id))?.is_none() {
        return Ok(false);
    }
    tx.delete(&calibration_key(id))?;
    Ok(true)
}
