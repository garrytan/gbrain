//! Dream verdicts: the `dream_verdicts` table of the PGLite engine, the dream cycle's triage cache.
//!
//! Members: getDreamVerdict, putDreamVerdict, sweepDreamVerdicts.
//!
//! Keys: `Y file_path \0 content_hash -> DreamRecord`, the `(file_path, content_hash)` primary key.
//! Neither part may hold a NUL byte (Postgres `text` refuses one too), so the split is exact.
//!
//! Time: `judged_at` and `expires_at` are UTC microseconds from the store's clock. A read treats a
//! row with `expires_at <= now` as missing; `putDreamVerdict` sets `expires_at = now + 30 days`
//! (`DREAM_VERDICT_TTL_SECONDS`), as PGLite's `now() + make_interval(secs => ...)` does.
//!
//! JSON columns (`reasons`, `segments`, `entities`) are stored as given and read back in Postgres
//! `jsonb` key order (see `jsonb`), which is what a PGLite read returns.

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::jsonb::ordered;
use crate::kv::scan_prefix;
use crate::links::no_nul;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// `DREAM_VERDICT_TTL_SECONDS` (src/core/engine.ts).
pub const DREAM_VERDICT_TTL_SECONDS: i64 = 30 * 86_400;

/// What is stored for one verdict.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DreamRecord {
    worth_processing: bool,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    reasons: Option<Value>,
    judged_at_us: i64,
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    segments: Option<Value>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    entities: Option<Value>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    triage_version: Option<i32>,
    expires_at_us: i64,
}

impl DreamRecord {
    /// The `DreamVerdict` PGLite returns. `judged_at` is microsecond ISO text; the TypeScript
    /// member turns it into `Date#toISOString` form as PGLite's row parser does.
    fn to_json(&self) -> Value {
        let list = |v: &Option<Value>| match v {
            None | Some(Value::Null) => json!([]),
            Some(v) => ordered(v),
        };
        json!({
            "worth_processing": self.worth_processing,
            "reasons": list(&self.reasons),
            "judged_at": iso(self.judged_at_us),
            "score": self.score,
            "content_type": self.content_type,
            "segments": list(&self.segments),
            "entities": list(&self.entities),
            "model": self.model,
            "triage_version": self.triage_version,
        })
    }
}

/// `DreamVerdictInput`. Every field may be missing: PGLite binds a missing one as NULL, and only
/// `worth_processing` is `NOT NULL`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DreamVerdictInput {
    pub worth_processing: Option<bool>,
    pub reasons: Option<Value>,
    pub score: Option<f64>,
    pub content_type: Option<String>,
    pub segments: Option<Value>,
    pub entities: Option<Value>,
    pub model: Option<String>,
    pub triage_version: Option<f64>,
}

/// A JSON value in the key order a Postgres `jsonb` value prints ([`crate::jsonb::ordered`]).
pub(crate) fn jsonb(value: &Value) -> Value {
    ordered(value)
}

/// Refuses a JSON value Postgres `jsonb` refuses: a string or key holding U+0000
/// (`unsupported Unicode escape sequence`).
pub(crate) fn jsonb_check(op: &str, column: &str, value: &Value) -> Result<()> {
    let bad = |s: &str| s.contains('\0');
    let refused = match value {
        Value::String(s) => bad(s),
        Value::Array(items) => {
            for item in items {
                jsonb_check(op, column, item)?;
            }
            false
        }
        Value::Object(map) => {
            for (k, v) in map {
                if bad(k) {
                    return Err(nul_json(op, column));
                }
                jsonb_check(op, column, v)?;
            }
            false
        }
        _ => false,
    };
    if refused {
        return Err(nul_json(op, column));
    }
    Ok(())
}

fn nul_json(op: &str, column: &str) -> StoreError {
    StoreError::new(
        INVALID_ARGUMENT,
        format!(
            "{op}: {column}: unsupported Unicode escape sequence (\\u0000 cannot be converted to text)"
        ),
    )
}

/// A JavaScript number bound to an `INT` column: an integer in the `int4` range, or refused.
pub(crate) fn int4(op: &str, column: &str, value: f64) -> Result<i32> {
    if value.fract() != 0.0 || !value.is_finite() {
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
    // In range and integral, so the cast is exact.
    Ok(value as i32)
}

fn verdict_key(file_path: &str, content_hash: &str) -> Vec<u8> {
    keys::text(keys::DREAM_VERDICT, &[file_path, content_hash])
}

impl Store {
    /// `getDreamVerdict(filePath, contentHash)`: the live verdict, or `None` when there is none or
    /// it expired (`expires_at <= now`).
    pub fn get_dream_verdict(&self, file_path: &str, content_hash: &str) -> Result<Option<Value>> {
        no_nul(
            "getDreamVerdict",
            &[("filePath", file_path), ("contentHash", content_hash)],
        )?;
        let now = self.env.now_micros();
        let read = self.read()?;
        let record: Option<DreamRecord> = get_json(&*read, &verdict_key(file_path, content_hash))?;
        Ok(record
            .filter(|r| r.expires_at_us > now)
            .map(|r| r.to_json()))
    }

    /// `putDreamVerdict(filePath, contentHash, verdict)`: inserts or replaces the verdict, with
    /// `judged_at = now` and `expires_at = now + DREAM_VERDICT_TTL_SECONDS`.
    pub fn put_dream_verdict(
        &self,
        file_path: &str,
        content_hash: &str,
        verdict: &DreamVerdictInput,
    ) -> Result<()> {
        const OP: &str = "putDreamVerdict";
        no_nul(
            OP,
            &[("filePath", file_path), ("contentHash", content_hash)],
        )?;
        for (column, text) in [
            ("content_type", &verdict.content_type),
            ("model", &verdict.model),
        ] {
            if let Some(text) = text {
                no_nul(OP, &[(column, text)])?;
            }
        }
        for (column, value) in [
            ("reasons", &verdict.reasons),
            ("segments", &verdict.segments),
            ("entities", &verdict.entities),
        ] {
            if let Some(value) = value {
                jsonb_check(OP, column, value)?;
            }
        }
        let triage_version = verdict
            .triage_version
            .map(|v| int4(OP, "triage_version", v))
            .transpose()?;
        let Some(worth_processing) = verdict.worth_processing else {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                "null value in column \"worth_processing\" of relation \"dream_verdicts\" violates not-null constraint",
            ));
        };
        let now = self.env.now_micros();
        let record = DreamRecord {
            worth_processing,
            reasons: verdict.reasons.clone(),
            judged_at_us: now,
            score: verdict.score,
            content_type: verdict.content_type.clone(),
            segments: verdict.segments.clone(),
            entities: verdict.entities.clone(),
            model: verdict.model.clone(),
            triage_version,
            expires_at_us: now.saturating_add(DREAM_VERDICT_TTL_SECONDS * 1_000_000),
        };
        self.write(|tx| put_json(tx, &verdict_key(file_path, content_hash), &record))
    }

    /// `sweepDreamVerdicts()`: deletes every verdict with `expires_at <= now` and returns how many.
    pub fn sweep_dream_verdicts(&self) -> Result<u64> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut doomed = Vec::new();
            let mut bad = None;
            scan_prefix(&*tx, &[keys::DREAM_VERDICT], false, &mut |k, v| {
                match serde_json::from_slice::<DreamRecord>(v) {
                    Ok(r) if r.expires_at_us <= now => doomed.push(k.to_vec()),
                    Ok(_) => {}
                    Err(e) => {
                        bad = Some(StoreError::from(e));
                        return false;
                    }
                }
                true
            })?;
            if let Some(e) = bad {
                return Err(e);
            }
            for key in &doomed {
                tx.delete(key)?;
            }
            Ok(doomed.len() as u64)
        })
    }
}

/// The rows a fact purge's inventory probe searches (crate::facts::purge_probe): every verdict, expired or not, as the table holds it.
pub(crate) fn purge_probe_rows(
    read: &dyn crate::kv::KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow, json_rows};
    Ok(json_rows::<DreamRecord>(read, &[keys::DREAM_VERDICT])?
        .into_iter()
        .map(|r| ProbeRow {
            source_id: None,
            cells: vec![
                ("segments", ProbeCell::opt_jsonb(r.segments.as_ref())),
                ("entities", ProbeCell::opt_jsonb(r.entities.as_ref())),
                ("reasons", ProbeCell::opt_jsonb(r.reasons.as_ref())),
            ],
        })
        .collect())
}
