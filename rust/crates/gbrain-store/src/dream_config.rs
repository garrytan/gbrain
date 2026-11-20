//! The config rows the dream breaker and the dream write deferrals keep their maps in
//! (`src/core/engine-sql/dream-cycle.ts`): `ensureDreamMapConfigRow`, `lockDreamMapConfigRow`,
//! `writeDreamMapConfigRow` and `recordDreamBreakerReset`.
//!
//! - `ensure` inserts `{}` only when the key has no row. `write` updates only a row that exists.
//! - `lock` returns the row's value and the store clock as `YYYY-MM-DDTHH:MM:SS.mmmZ` (`now()`, which a bound store
//!   reads as the transaction's start), or `None` for a missing row. PGLite's `FOR UPDATE` keeps other writers off
//!   the row for the rest of the transaction; the store admits one write transaction at a time, so a transaction
//!   that has read the row already holds it and there is nothing more to take (as `lockSourceRow` does).
//! - `recordDreamBreakerReset` rewrites the map at `resetsKey`: it keeps the other entries whose value starts with
//!   four digits and `-` and is newer than 24 hours, reads a value that is not a JSON object (or not JSON) as `{}`,
//!   and sets `baseKey` to now plus one millisecond. The map is written in jsonb text form.
//!
//! A kept entry whose value starts with four digits and `-` but is not an ISO instant ends in
//! `invalid_argument`, as the `::timestamptz` cast raises on it. See rust/docs/store/config.md.

use crate::cli_reads::pg_text::jsonb_text;
use crate::config::read_config;
use crate::env::{iso, parse_iso};
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::links::no_nul;
use crate::{Store, keys};
use serde::Deserialize;
use serde_json::{Map, Value, json};

const DAY_MICROS: i64 = 86_400_000_000;

/// `ensureDreamMapConfigRow(key)` and `lockDreamMapConfigRow(key)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DreamMapKeyArgs {
    pub key: String,
}

/// `writeDreamMapConfigRow(key, value)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DreamMapWriteArgs {
    pub key: String,
    pub value: String,
}

/// `recordDreamBreakerReset(resetsKey, baseKey)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DreamBreakerResetArgs {
    pub resets_key: String,
    pub base_key: String,
}

/// The `config` record key of `key`, after the NUL check Postgres makes for text.
fn row_key(op: &str, key: &str) -> Result<Vec<u8>> {
    no_nul(op, &[("key", key)])?;
    Ok(keys::text(keys::CONFIG, &[key]))
}

/// `to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`: milliseconds, truncated.
fn millis_stamp(micros: i64) -> String {
    let full = iso(micros);
    format!("{}Z", &full[..full.len() - 4])
}

/// The map `gbrain_try_jsonb(value)` holds when it is a JSON object, else empty. jsonb refuses a `\u0000` escape, so
/// a value that holds one is not jsonb either.
fn map_of(text: &str) -> Map<String, Value> {
    fn has_nul(v: &Value) -> bool {
        match v {
            Value::String(s) => s.contains('\0'),
            Value::Array(a) => a.iter().any(has_nul),
            Value::Object(m) => m.iter().any(|(k, v)| k.contains('\0') || has_nul(v)),
            _ => false,
        }
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map))
            if !map.values().any(has_nul) && !map.keys().any(|k| k.contains('\0')) =>
        {
            map
        }
        _ => Map::new(),
    }
}

/// `entry.value::timestamptz` for an entry that starts with four digits and `-`.
fn stamp_micros(value: &str) -> Result<i64> {
    parse_iso(value).ok_or_else(|| {
        StoreError::new(
            INVALID_ARGUMENT,
            format!("recordDreamBreakerReset: invalid input syntax for type timestamp with time zone: \"{value}\""),
        )
    })
}

fn dated(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() >= 5 && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-'
}

impl Store {
    /// `ensureDreamMapConfigRow`: `INSERT ... '{}' ON CONFLICT (key) DO NOTHING`.
    pub fn ensure_dream_map_config_row(&self, args: &DreamMapKeyArgs) -> Result<()> {
        let key = row_key("ensureDreamMapConfigRow", &args.key)?;
        self.write(|tx| {
            if tx.get(&key)?.is_none() {
                tx.put(&key, b"{}")?;
            }
            Ok(())
        })
    }

    /// `lockDreamMapConfigRow`: `{ value, now }`, or `None` when the row is missing.
    pub fn lock_dream_map_config_row(&self, args: &DreamMapKeyArgs) -> Result<Option<Value>> {
        row_key("lockDreamMapConfigRow", &args.key)?;
        let now = self.env.now_micros();
        let read = self.read()?;
        Ok(read_config(&*read, &args.key)?
            .map(|value| json!({ "value": value, "now": millis_stamp(now) })))
    }

    /// `writeDreamMapConfigRow`: `UPDATE config SET value = $2 WHERE key = $1`.
    pub fn write_dream_map_config_row(&self, args: &DreamMapWriteArgs) -> Result<()> {
        let key = row_key("writeDreamMapConfigRow", &args.key)?;
        no_nul("writeDreamMapConfigRow", &[("value", &args.value)])?;
        self.write(|tx| {
            if tx.get(&key)?.is_some() {
                tx.put(&key, args.value.as_bytes())?;
            }
            Ok(())
        })
    }

    /// `recordDreamBreakerReset`: the 24 hour window of resets with `baseKey` set to now plus one millisecond.
    pub fn record_dream_breaker_reset(&self, args: &DreamBreakerResetArgs) -> Result<()> {
        const OP: &str = "recordDreamBreakerReset";
        let key = row_key(OP, &args.resets_key)?;
        no_nul(OP, &[("baseKey", &args.base_key)])?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let current = match tx.get(&key)? {
                Some(bytes) => map_of(&String::from_utf8_lossy(&bytes)),
                None => Map::new(),
            };
            let mut window = Map::new();
            for (name, value) in current {
                let Value::String(text) = &value else {
                    continue;
                };
                if name != args.base_key && dated(text) && stamp_micros(text)? > now - DAY_MICROS {
                    window.insert(name, value);
                }
            }
            window.insert(
                args.base_key.clone(),
                Value::String(millis_stamp(now + 1_000)),
            );
            tx.put(&key, jsonb_text(&Value::Object(window)).as_bytes())
        })
    }
}
