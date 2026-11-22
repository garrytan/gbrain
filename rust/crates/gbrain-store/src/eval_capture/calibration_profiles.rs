//! Calibration profiles: the `calibration_profiles` table of the PGLite engine.
//!
//! Members: getLatestCalibrationProfile, isCalibrationProfileUnchanged, insertCalibrationProfile,
//! readVoiceGateHealth, purgeCalibrationProfilesByWave (rust/docs/store/calibration-profiles.md).
//!
//! Keys (under `keys::EVAL_CAPTURE`, `Z`):
//! - `Z 0x20 <id u64 BE>` -> `ProfileRecord` (JSON).
//! - `Z 0x21 <!(generated_at_us ^ 1<<63) BE8> <!id BE8>` -> id BE8: the time index. A forward scan
//!   reads the newest profile first and, on one instant, the highest id first, which is
//!   `ORDER BY generated_at DESC, id DESC`.
//! - Id counter: `M calibration_profile_next_id`.
//!
//! The REAL columns (`brier`, `accuracy`, `partial_rate`, `grade_completion`) are kept as `f32`, as
//! Postgres keeps them, and read back as the shortest decimal that names that `f32` (so 0.3 reads
//! 0.3, not 0.30000001192...), as both SQL engines print them. The "unchanged" check compares as
//! `f32` too, with null equal to null (`IS NOT DISTINCT FROM`).
//!
//! `cost_usd` and `judge_model_agreement` are always NULL (no writer sets them), so they are not
//! stored. `domain_scorecards` is stored as the JSON the writer sent; no member reads it back.
//!
//! A source delete removes the source's profiles (`ON DELETE CASCADE`): `remove_source_rows`.

use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::sources::require_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const NEXT_ID: &str = "calibration_profile_next_id";
const RECORD: u8 = 0x20;
const BY_TIME: u8 = 0x21;
const TABLE: &str = "calibration_profiles";
/// `generated_at >= now() - INTERVAL '7 days'`.
const WINDOW_US: i64 = 7 * 86_400 * 1_000_000;
/// `wave_version` default of the table.
const DEFAULT_WAVE: &str = "v0.36.1.0";

fn record_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::EVAL_CAPTURE, RECORD];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// The index key: newest first, then highest id first, in plain byte order.
fn time_key(generated_at_us: i64, id: u64) -> Vec<u8> {
    let mut key = vec![keys::EVAL_CAPTURE, BY_TIME];
    key.extend_from_slice(&(!((generated_at_us as u64) ^ (1 << 63))).to_be_bytes());
    key.extend_from_slice(&(!id).to_be_bytes());
    key
}

/// The `(generated_at_us, id)` a time-index key names.
fn decode_time_key(key: &[u8]) -> Option<(i64, u64)> {
    let at = keys::be8(key.get(2..10)?)?;
    let id = keys::be8(key.get(10..18)?)?;
    Some((((!at) ^ (1 << 63)) as i64, !id))
}

/// One `calibration_profiles` row (the columns a writer sets).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProfileRecord {
    pub id: u64,
    pub source_id: String,
    pub holder: String,
    pub wave_version: String,
    pub generated_at_us: i64,
    pub published: bool,
    pub total_resolved: i32,
    pub brier: Option<f32>,
    pub accuracy: Option<f32>,
    pub partial_rate: Option<f32>,
    pub grade_completion: f32,
    pub domain_scorecards: Value,
    pub pattern_statements: Vec<String>,
    pub voice_gate_passed: bool,
    pub voice_gate_attempts: i16,
    pub active_bias_tags: Vec<String>,
    pub model_id: String,
}

/// An `f32` as the number both SQL engines print: the shortest decimal that names it.
fn real(x: f32) -> f64 {
    x.to_string().parse().unwrap_or(f64::from(x))
}

fn real_opt(x: Option<f32>) -> Value {
    x.map_or(Value::Null, |x| json!(real(x)))
}

impl ProfileRecord {
    /// The row `gbrain calibration` reads: 16 columns, `id` as text, `generated_at` as ISO.
    fn to_json(&self) -> Value {
        json!({
            "id": self.id.to_string(),
            "source_id": self.source_id,
            "holder": self.holder,
            "wave_version": self.wave_version,
            "generated_at": iso(self.generated_at_us),
            "published": self.published,
            "total_resolved": self.total_resolved,
            "brier": real_opt(self.brier),
            "accuracy": real_opt(self.accuracy),
            "partial_rate": real_opt(self.partial_rate),
            "grade_completion": real(self.grade_completion),
            "pattern_statements": self.pattern_statements,
            "active_bias_tags": self.active_bias_tags,
            "voice_gate_passed": self.voice_gate_passed,
            "voice_gate_attempts": self.voice_gate_attempts,
            "model_id": self.model_id,
        })
    }
}

/// `getLatestCalibrationProfile` filter. `source_ids`, when present (even empty), wins over
/// `source_id`; an empty `source_id` is no filter; an absent `holder` reads any holder.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LatestProfileSpec {
    pub holder: Option<String>,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
}

/// `isCalibrationProfileUnchanged` argument.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UnchangedSpec {
    pub source_id: Option<String>,
    pub holder: Option<String>,
    pub total_resolved: Option<Value>,
    pub brier: Option<f64>,
    pub accuracy: Option<f64>,
    pub partial_rate: Option<f64>,
    pub model_id: Option<String>,
}

/// `insertCalibrationProfile` row. Every field is optional here so a missing one fails as
/// Postgres fails it (a `NOT NULL` column refuses with `constraint_violation`). `generated_at` is
/// an ISO timestamp; the three optional columns default as the table does.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileInput {
    pub source_id: Option<String>,
    pub holder: Option<String>,
    pub total_resolved: Option<Value>,
    pub brier: Option<f64>,
    pub accuracy: Option<f64>,
    pub partial_rate: Option<f64>,
    pub grade_completion: Option<f64>,
    pub domain_scorecards: Option<Value>,
    pub pattern_statements: Option<Vec<String>>,
    pub voice_gate_passed: Option<bool>,
    pub voice_gate_attempts: Option<Value>,
    pub active_bias_tags: Option<Vec<String>>,
    pub model_id: Option<String>,
    pub generated_at: Option<String>,
    pub wave_version: Option<String>,
    pub published: Option<bool>,
}

fn not_null(column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"{TABLE}\" violates not-null constraint"
        ),
    )
}

/// A whole JSON number inside `[min, max]`, else `invalid_argument` (Postgres refuses it before
/// the row is built). Null stays null.
fn whole(value: &Option<Value>, column: &str, min: i64, max: i64) -> Result<Option<i64>> {
    let refused = || {
        StoreError::invalid(format!(
            "insertCalibrationProfile: {column} must be an integer from {min} to {max}"
        ))
    };
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => {
            let i = match n.as_i64() {
                Some(i) => i,
                None => {
                    let f = n.as_f64().ok_or_else(refused)?;
                    if f.fract() != 0.0 || f < min as f64 || f > max as f64 {
                        return Err(refused());
                    }
                    f as i64
                }
            };
            if i < min || i > max {
                return Err(refused());
            }
            Ok(Some(i))
        }
        _ => Err(refused()),
    }
}

/// A `REAL` parameter: a finite number too large for `f32` is out of range, as in Postgres.
fn to_real(x: Option<f64>, column: &str) -> Result<Option<f32>> {
    match x {
        None => Ok(None),
        Some(x) => {
            let r = x as f32;
            // A NaN or infinity (a native caller only) would be stored as null and no longer decode.
            if !x.is_finite() {
                return Err(StoreError::invalid(format!(
                    "insertCalibrationProfile: {column} is not a finite number"
                )));
            }
            if r.is_infinite() {
                return Err(StoreError::invalid(format!(
                    "insertCalibrationProfile: {column} is out of range for type real"
                )));
            }
            Ok(Some(r))
        }
    }
}

/// The ids of the time index, newest first, stopping at the first entry older than `floor_us`.
fn time_index(read: &dyn KvRead, floor_us: Option<i64>) -> Result<Vec<u64>> {
    let mut ids = Vec::new();
    scan_prefix(
        read,
        &[keys::EVAL_CAPTURE, BY_TIME],
        false,
        &mut |k, _| match decode_time_key(k) {
            Some((at, id)) if floor_us.is_none_or(|floor| at >= floor) => {
                ids.push(id);
                true
            }
            _ => false,
        },
    )?;
    Ok(ids)
}

fn read_record(read: &dyn KvRead, id: u64) -> Result<Option<ProfileRecord>> {
    get_json(read, &record_key(id))
}

/// Every profile, in id order.
fn all_records(read: &dyn KvRead) -> Result<Vec<ProfileRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &[keys::EVAL_CAPTURE, RECORD], false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

fn delete_record(tx: &mut dyn KvWrite, record: &ProfileRecord) -> Result<()> {
    tx.delete(&record_key(record.id))?;
    tx.delete(&time_key(record.generated_at_us, record.id))
}

/// A source delete's cascade: removes every profile of `source_id` and its index entries.
// Core's source delete is the first caller (cascade::remove_source_rows); until then tests call it.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for record in all_records(&*tx)? {
        if record.source_id == source_id {
            delete_record(tx, &record)?;
        }
    }
    Ok(())
}

impl Store {
    /// `getLatestCalibrationProfile(spec)`: the newest profile (`generated_at DESC, id DESC`) that
    /// matches the filter, or `None`.
    pub fn get_latest_calibration_profile(
        &self,
        spec: &LatestProfileSpec,
    ) -> Result<Option<Value>> {
        for text in [&spec.holder, &spec.source_id].into_iter().flatten() {
            no_nul("getLatestCalibrationProfile", &[("filter", text)])?;
        }
        for text in spec.source_ids.iter().flatten() {
            no_nul("getLatestCalibrationProfile", &[("sourceIds", text)])?;
        }
        let single = match &spec.source_ids {
            Some(_) => None,
            None => spec.source_id.as_deref().filter(|s| !s.is_empty()),
        };
        let read = self.read()?;
        for id in time_index(&*read, None)? {
            let Some(record) = read_record(&*read, id)? else {
                continue;
            };
            if spec.holder.as_deref().is_some_and(|h| record.holder != h) {
                continue;
            }
            if spec
                .source_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&record.source_id))
            {
                continue;
            }
            if single.is_some_and(|s| record.source_id != s) {
                continue;
            }
            return Ok(Some(record.to_json()));
        }
        Ok(None)
    }

    /// `isCalibrationProfileUnchanged(spec)`: whether the latest profile of the source and holder
    /// holds this scorecard and model. No such profile is false.
    pub fn is_calibration_profile_unchanged(&self, spec: &UnchangedSpec) -> Result<bool> {
        for text in [&spec.source_id, &spec.holder, &spec.model_id]
            .into_iter()
            .flatten()
        {
            no_nul("isCalibrationProfileUnchanged", &[("argument", text)])?;
        }
        let total = whole(
            &spec.total_resolved,
            "total_resolved",
            i64::from(i32::MIN),
            i64::from(i32::MAX),
        )?;
        let brier = to_real(spec.brier, "brier")?;
        let accuracy = to_real(spec.accuracy, "accuracy")?;
        let partial = to_real(spec.partial_rate, "partial_rate")?;
        let (Some(source), Some(holder)) = (spec.source_id.as_deref(), spec.holder.as_deref())
        else {
            return Ok(false);
        };
        let read = self.read()?;
        for id in time_index(&*read, None)? {
            let Some(r) = read_record(&*read, id)? else {
                continue;
            };
            if r.source_id != source || r.holder != holder {
                continue;
            }
            // The latest row of the pair decides; a null argument never equals a number.
            return Ok(total == Some(i64::from(r.total_resolved))
                && brier == r.brier
                && accuracy == r.accuracy
                && partial == r.partial_rate
                && spec.model_id.as_deref() == Some(r.model_id.as_str()));
        }
        Ok(false)
    }

    /// `insertCalibrationProfile(row)`: inserts one profile. Refuses as the table does: a `NOT
    /// NULL` column left null is `constraint_violation`, a number out of range or a bad timestamp
    /// is `invalid_argument`, a source that does not exist is `source_not_found`.
    pub fn insert_calibration_profile(&self, input: &ProfileInput) -> Result<()> {
        let mut texts: Vec<(&str, &str)> = Vec::new();
        for (name, value) in [
            ("source_id", &input.source_id),
            ("holder", &input.holder),
            ("model_id", &input.model_id),
            ("wave_version", &input.wave_version),
        ] {
            if let Some(text) = value.as_deref() {
                texts.push((name, text));
            }
        }
        for list in [&input.pattern_statements, &input.active_bias_tags] {
            for text in list.iter().flatten() {
                texts.push(("array element", text));
            }
        }
        no_nul("insertCalibrationProfile", &texts)?;
        let total = whole(
            &input.total_resolved,
            "total_resolved",
            i64::from(i32::MIN),
            i64::from(i32::MAX),
        )?;
        let attempts = whole(
            &input.voice_gate_attempts,
            "voice_gate_attempts",
            i64::from(i16::MIN),
            i64::from(i16::MAX),
        )?;
        let brier = to_real(input.brier, "brier")?;
        let accuracy = to_real(input.accuracy, "accuracy")?;
        let partial_rate = to_real(input.partial_rate, "partial_rate")?;
        let grade = to_real(input.grade_completion, "grade_completion")?;
        let generated_at = match input.generated_at.as_deref() {
            Some(text) => Some(parse_iso(text).ok_or_else(|| {
                StoreError::invalid(format!(
                    "insertCalibrationProfile: invalid input syntax for type timestamp with time zone: \"{text}\""
                ))
            })?),
            None => None,
        };
        // Constraints, in column order (Postgres reports the first failing column).
        let source_id = input
            .source_id
            .clone()
            .ok_or_else(|| not_null("source_id"))?;
        let holder = input.holder.clone().ok_or_else(|| not_null("holder"))?;
        let total_resolved = total.ok_or_else(|| not_null("total_resolved"))? as i32;
        let grade_completion = grade.ok_or_else(|| not_null("grade_completion"))?;
        let domain_scorecards = match &input.domain_scorecards {
            Some(Value::Null) | None => return Err(not_null("domain_scorecards")),
            Some(v) => v.clone(),
        };
        let pattern_statements = input
            .pattern_statements
            .clone()
            .ok_or_else(|| not_null("pattern_statements"))?;
        let voice_gate_passed = input
            .voice_gate_passed
            .ok_or_else(|| not_null("voice_gate_passed"))?;
        let voice_gate_attempts = attempts.ok_or_else(|| not_null("voice_gate_attempts"))? as i16;
        let active_bias_tags = input
            .active_bias_tags
            .clone()
            .ok_or_else(|| not_null("active_bias_tags"))?;
        let model_id = input.model_id.clone().ok_or_else(|| not_null("model_id"))?;

        self.write(|tx| {
            // The foreign key is judged last, after the column checks.
            require_source(&*tx, &source_id)?;
            let id = next_id(tx, NEXT_ID)?;
            let record = ProfileRecord {
                id,
                source_id: source_id.clone(),
                holder: holder.clone(),
                wave_version: input
                    .wave_version
                    .clone()
                    .unwrap_or_else(|| DEFAULT_WAVE.to_string()),
                generated_at_us: generated_at.unwrap_or_else(|| self.env.now_micros()),
                published: input.published.unwrap_or(false),
                total_resolved,
                brier,
                accuracy,
                partial_rate,
                grade_completion,
                domain_scorecards: domain_scorecards.clone(),
                pattern_statements: pattern_statements.clone(),
                voice_gate_passed,
                voice_gate_attempts,
                active_bias_tags: active_bias_tags.clone(),
                model_id: model_id.clone(),
            };
            put_json(tx, &record_key(id), &record)?;
            tx.put(&time_key(record.generated_at_us, id), &id.to_be_bytes())?;
            Ok(())
        })
    }

    /// `readVoiceGateHealth({ sourceIds? })`: profiles generated in the last 7 days (no upper
    /// bound) of `source_ids` (all when absent, none when empty), and how many failed the voice
    /// gate. Returns `{ total, failures }`.
    pub fn read_voice_gate_health(&self, source_ids: Option<&[String]>) -> Result<Value> {
        let read = self.read()?;
        let floor = self.env.now_micros() - WINDOW_US;
        let (mut total, mut failures) = (0u64, 0u64);
        for id in time_index(&*read, Some(floor))? {
            let Some(record) = read_record(&*read, id)? else {
                continue;
            };
            if source_ids.is_some_and(|ids| !ids.contains(&record.source_id)) {
                continue;
            }
            total += 1;
            if !record.voice_gate_passed {
                failures += 1;
            }
        }
        Ok(json!({ "total": total, "failures": failures }))
    }

    /// `purgeCalibrationProfilesByWave({ waveVersion, dryRun })`: how many profiles that wave
    /// wrote; unless `dry_run`, deletes them. Returns the count.
    pub fn purge_calibration_profiles_by_wave(
        &self,
        wave_version: &str,
        dry_run: bool,
    ) -> Result<u64> {
        no_nul(
            "purgeCalibrationProfilesByWave",
            &[("waveVersion", wave_version)],
        )?;
        if dry_run {
            let read = self.read()?;
            let count = all_records(&*read)?
                .iter()
                .filter(|r| r.wave_version == wave_version)
                .count();
            return Ok(count as u64);
        }
        self.write(|tx| {
            let doomed: Vec<ProfileRecord> = all_records(&*tx)?
                .into_iter()
                .filter(|r| r.wave_version == wave_version)
                .collect();
            for record in &doomed {
                delete_record(tx, record)?;
            }
            Ok(doomed.len() as u64)
        })
    }
}

#[cfg(test)]
mod tests {
    //! `remove_source_rows` and the stored `domain_scorecards` are not reachable through a public
    //! member (the Rust store serves no source delete, and no member returns the scorecards), so
    //! their contract is tested here. The members are tested through the public API in
    //! `tests/calibration_profiles.rs`.
    use super::*;
    use crate::sources::SourceInput;
    use crate::test_support::store;

    fn input(source: &str, at: &str, extra: Value) -> ProfileInput {
        let mut base = json!({
            "sourceId": source, "holder": "self", "totalResolved": 3, "brier": 0.25,
            "accuracy": 0.5, "partialRate": null, "gradeCompletion": 1,
            "domainScorecards": {"people": {"n": 2}}, "patternStatements": ["a"],
            "voiceGatePassed": true, "voiceGateAttempts": 1, "activeBiasTags": [],
            "modelId": "m", "generatedAt": at,
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn add_source(store: &Store, id: &str) {
        let source: SourceInput = serde_json::from_value(json!({"id": id})).unwrap();
        store.upsert_source(&source).unwrap();
    }

    fn latest(store: &Store, source: &str) -> Option<Value> {
        let spec = LatestProfileSpec {
            source_id: Some(source.into()),
            ..Default::default()
        };
        store.get_latest_calibration_profile(&spec).unwrap()
    }

    #[test]
    fn time_key_orders_newest_first_then_highest_id_and_round_trips() {
        let mut keys = [
            time_key(-5, 1),
            time_key(0, 1),
            time_key(10, 2),
            time_key(10, 7),
            time_key(i64::MAX, 3),
        ];
        keys.sort();
        // Newest first; on one instant the higher id first.
        assert_eq!(
            keys.iter()
                .map(|k| decode_time_key(k).unwrap())
                .collect::<Vec<_>>(),
            vec![(i64::MAX, 3), (10, 7), (10, 2), (0, 1), (-5, 1)]
        );
    }

    #[test]
    fn source_delete_removes_that_sources_profiles_and_their_index_entries() {
        let store = store();
        add_source(&store, "a");
        add_source(&store, "b");
        for (source, at) in [
            ("a", "2026-03-01T00:00:00.000000Z"),
            ("a", "2026-03-02T00:00:00.000000Z"),
            ("b", "2026-03-03T00:00:00.000000Z"),
        ] {
            store
                .insert_calibration_profile(&input(source, at, json!({})))
                .unwrap();
        }
        store.write(|tx| remove_source_rows(tx, "a")).unwrap();
        assert!(latest(&store, "a").is_none());
        assert_eq!(
            latest(&store, "b").unwrap()["generated_at"],
            "2026-03-03T00:00:00.000000Z"
        );
        // No stray record or index entry is left for the removed rows.
        let read = store.read().unwrap();
        assert_eq!(all_records(&*read).unwrap().len(), 1);
        assert_eq!(time_index(&*read, None).unwrap().len(), 1);
        // The cascade reaches the profiles through the shared one.
        drop(read);
        store
            .write(|tx| crate::cascade::remove_source_rows(tx, "b"))
            .unwrap();
        assert!(latest(&store, "b").is_none());
    }

    #[test]
    fn domain_scorecards_are_stored_as_sent_and_real_columns_as_f32() {
        let store = store();
        let scorecards = json!({"people": {"n": 2, "brier": 0.2}, "日本": [1, null]});
        store
            .insert_calibration_profile(&input(
                "default",
                "2026-03-01T00:00:00.000000Z",
                json!({"domainScorecards": scorecards, "brier": 0.123456789}),
            ))
            .unwrap();
        let read = store.read().unwrap();
        let record = all_records(&*read).unwrap().remove(0);
        assert_eq!(record.domain_scorecards, scorecards);
        assert_eq!(record.brier, Some(0.123_456_79_f32));
        assert_eq!(record.wave_version, "v0.36.1.0");
        assert!(!record.published);
        // The row reads back the shortest decimal of the f32, not the widened double.
        let row = record.to_json();
        assert_eq!(row["brier"], json!(0.12345679));
        assert_eq!(row["accuracy"], json!(0.5));
    }
}
