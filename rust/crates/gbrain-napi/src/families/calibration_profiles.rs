//! Calibration profiles (`calibration_profiles`): the latest-profile read, the "unchanged" check,
//! the insert, the voice-gate health read and the wave purge.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON. Timestamps travel as ISO strings both ways; the shell makes them `Date`s.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `getLatestCalibrationProfile({ holder?, sourceId?, sourceIds? })`: the row or null.
    #[napi]
    pub fn get_latest_calibration_profile<'env>(
        &self,
        env: &'env Env,
        spec: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_latest_calibration_profile(&arg(spec, "getLatestCalibrationProfile spec")?)
        })
    }

    /// `isCalibrationProfileUnchanged(spec)`: resolves a boolean.
    #[napi]
    pub fn is_calibration_profile_unchanged<'env>(
        &self,
        env: &'env Env,
        spec: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.is_calibration_profile_unchanged(&arg(spec, "isCalibrationProfileUnchanged spec")?)
        })
    }

    /// `insertCalibrationProfile(row)`: resolves null. `generatedAt` is an ISO string.
    #[napi]
    pub fn insert_calibration_profile<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: gbrain_store::eval_capture::calibration_profiles::ProfileInput =
                required(row, "insertCalibrationProfile row")?;
            s.insert_calibration_profile(&row)
        })
    }

    /// `readVoiceGateHealth({ sourceIds? })`: resolves `{ total, failures }`.
    #[napi]
    pub fn read_voice_gate_health<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_voice_gate_health(source_ids.as_deref())
        })
    }

    /// `purgeCalibrationProfilesByWave({ waveVersion, dryRun })`: resolves the count.
    #[napi]
    pub fn purge_calibration_profiles_by_wave<'env>(
        &self,
        env: &'env Env,
        wave_version: String,
        dry_run: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.purge_calibration_profiles_by_wave(&wave_version, dry_run)
        })
    }
}
