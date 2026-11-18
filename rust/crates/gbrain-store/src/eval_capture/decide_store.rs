//! The decide store: the `decide_state`, `decide_spend`, `decision_receipts` and
//! `decide_calibrations` tables of the PGLite engine (src/core/ai/decide/store.ts).
//!
//! Members: readDecideState, upsertDecideState, deleteDecideState, ensureDecideState.
//!
//! Keys (every record starts with `keys::EVAL_CAPTURE`, `Z`; this family owns sub-tags
//! `0x10..=0x1F`):
//! - `Z 0x10 <state key utf8>` -> `StateRecord` (JSON).
//!
//! Records are small and read whole. Nothing here has a foreign key, so nothing cascades.

use super::not_null;
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::{keys, put_json, Store};
use serde::{Deserialize, Serialize};

const STATE: u8 = 0x10;

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
