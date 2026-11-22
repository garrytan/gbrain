//! Chat usage: the `chat_usage_log` table of the PGLite engine. The engine chat usage sink
//! (`src/core/ai/chat-usage.ts`) appends one row per answered chat call; `get_usage`
//! (`src/core/ops/usage.ts`) sums a trailing window per `(model, phase)`.
//!
//! Members: logChatUsage, readChatUsage (`src/core/engine-sql/chat-usage.ts`).
//!
//! Keys (under `keys::TELEMETRY`, `a`):
//! - `a 0x0B <created_at BE8, sign bit flipped> <id BE8>` -> `ChatUsageRecord` (JSON). Key order
//!   is `created_at` order, ties by id. The id comes from the `next_chat_usage_id` counter, as
//!   `BIGSERIAL` does.
//!
//! The table carries no source and no page: page and source deletes never touch it.

use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::telemetry::{
    days_before, float_add, int4_param, not_null_in, parse_timestamp, pg_timestamptz_text,
};
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::BTreeMap;

const TABLE: &str = "chat_usage_log";
const OP_LOG: &str = "logChatUsage";
const OP_READ: &str = "readChatUsage";
const ID_COUNTER: &str = "next_chat_usage_id";

/// The integer token columns, in column order (the order Postgres checks them).
const TOKEN_COLUMNS: [&str; 4] = [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
];

fn prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_CHAT_USAGE]
}

/// `a 0x0B <created_us, sign bit flipped, BE8> <id BE8>`: byte order is `created_at` order.
fn key(created_us: i64, id: u64) -> Vec<u8> {
    let mut key = prefix().to_vec();
    key.extend_from_slice(&((created_us as u64) ^ (1 << 63)).to_be_bytes());
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// One `chat_usage_log` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ChatUsageRecord {
    pub id: u64,
    pub model: String,
    pub provider: Option<String>,
    pub phase: Option<String>,
    /// The token columns, in `TOKEN_COLUMNS` order.
    pub tokens: [i32; 4],
    pub cost_usd: Option<f64>,
    pub created_us: i64,
}

/// One row of `logChatUsage`. Every field is optional here so a missing one fails as Postgres
/// fails it (an explicit null in a `NOT NULL` column refuses; the column default is not used).
/// `created_at` is ISO text; absent, the row takes the store clock (`now()`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ChatUsageInput {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub phase: Option<String>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cache_read_tokens: Option<f64>,
    pub cache_write_tokens: Option<f64>,
    pub cost_usd: Option<f64>,
    pub created_at: Option<String>,
}

impl ChatUsageInput {
    fn tokens(&self) -> [Option<f64>; 4] {
        [
            self.input_tokens,
            self.output_tokens,
            self.cache_read_tokens,
            self.cache_write_tokens,
        ]
    }
}

fn read_rows(read: &dyn KvRead) -> Result<Vec<ChatUsageRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &prefix(), false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

/// The sums of one `(model, phase)` group.
#[derive(Default)]
struct Group {
    calls: i64,
    tokens: [i64; 4],
    cost: Option<f64>,
    unpriced: i64,
}

/// `ORDER BY sum(cost_usd) DESC NULLS LAST`: a null sum sorts after every number.
fn cost_desc(a: Option<f64>, b: Option<f64>) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => b.partial_cmp(&a).unwrap_or(Ordering::Equal),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

impl Store {
    /// `logChatUsage(row)`: appends one ledger row with the next id. As in Postgres, the parameters
    /// are read first (a token count that is not a whole `int4`, a `created_at` that is not ISO
    /// text, or a NUL in text refuses with `invalid_argument`), then a null `model` or token count
    /// refuses with `constraint_violation` in column order. `created_at` absent is now.
    pub fn log_chat_usage(&self, input: &ChatUsageInput) -> Result<()> {
        let mut texts: Vec<(&str, &str)> = Vec::new();
        for (name, value) in [
            ("model", &input.model),
            ("provider", &input.provider),
            ("phase", &input.phase),
        ] {
            if let Some(text) = value.as_deref() {
                texts.push((name, text));
            }
        }
        no_nul(OP_LOG, &texts)?;
        let mut tokens: [Option<i32>; 4] = [None; 4];
        for (i, value) in input.tokens().into_iter().enumerate() {
            if let Some(v) = value {
                tokens[i] = Some(int4_param(OP_LOG, TOKEN_COLUMNS[i], v)?);
            }
        }
        let created_us = match input.created_at.as_deref() {
            Some(text) => parse_timestamp(OP_LOG, text)?,
            None => self.env.now_micros(),
        };
        // NOT NULL, in column order: model, then the token columns.
        let model = input
            .model
            .clone()
            .ok_or_else(|| not_null_in(TABLE, "model"))?;
        let mut counts = [0i32; 4];
        for (i, value) in tokens.iter().enumerate() {
            counts[i] = value.ok_or_else(|| not_null_in(TABLE, TOKEN_COLUMNS[i]))?;
        }
        self.write(|tx| {
            let id = crate::pages::next_id(tx, ID_COUNTER)?;
            let record = ChatUsageRecord {
                id,
                model: model.clone(),
                provider: input.provider.clone(),
                phase: input.phase.clone(),
                tokens: counts,
                cost_usd: input.cost_usd,
                created_us,
            };
            put_json(tx, &key(created_us, id), &record)
        })
    }

    /// `readChatUsage(days)`: per `(model, phase)`, the call count, the token sums and the priced
    /// cost sum (null when every call is unpriced) with the unpriced call count, of the rows logged
    /// at or after `now - days`. Rows come highest cost first, null costs last; equal costs break
    /// on model, then phase, in byte order with a null phase first. `logged_since` is the first
    /// `created_at` of the whole ledger as timestamp text (null when empty). A null day count
    /// matches no row.
    pub fn read_chat_usage(&self, days: Option<f64>) -> Result<Value> {
        let cutoff = days_before(OP_READ, self.env.now_micros(), days)?;
        let read = self.read()?;
        let rows = read_rows(&*read)?;
        let logged_since = rows.iter().map(|r| r.created_us).min();
        let mut groups: BTreeMap<(String, Option<String>), Group> = BTreeMap::new();
        if let Some(cutoff) = cutoff {
            for row in &rows {
                if row.created_us < cutoff {
                    continue;
                }
                let group = groups
                    .entry((row.model.clone(), row.phase.clone()))
                    .or_default();
                group.calls += 1;
                for (sum, add) in group.tokens.iter_mut().zip(row.tokens) {
                    *sum += i64::from(add);
                }
                match row.cost_usd {
                    Some(cost) => {
                        group.cost = Some(float_add(group.cost.unwrap_or(0.0), cost, OP_READ)?);
                    }
                    None => group.unpriced += 1,
                }
            }
        }
        // BTreeMap order is (model, phase) in byte order with None first; a stable sort on the
        // cost keeps it as the tie order.
        let mut ordered: Vec<((String, Option<String>), Group)> = groups.into_iter().collect();
        ordered.sort_by(|a, b| cost_desc(a.1.cost, b.1.cost));
        let mut out = Vec::with_capacity(ordered.len());
        for ((model, phase), group) in ordered {
            let int4 = |n: i64| {
                i32::try_from(n).map_err(|_| {
                    StoreError::new(INVALID_ARGUMENT, format!("{OP_READ}: integer out of range"))
                })
            };
            out.push(json!({
                "model": model,
                "phase": phase,
                "calls": int4(group.calls)?,
                "input_tokens": group.tokens[0] as f64,
                "output_tokens": group.tokens[1] as f64,
                "cache_read_tokens": group.tokens[2] as f64,
                "cache_write_tokens": group.tokens[3] as f64,
                "cost_usd": group.cost,
                "unpriced_calls": int4(group.unpriced)?,
            }));
        }
        Ok(json!({ "rows": out, "logged_since": logged_since.map(pg_timestamptz_text) }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Env;
    use crate::error::CONSTRAINT_VIOLATION;
    use crate::test_support::store;

    const DAY_US: i64 = 86_400_000_000;

    fn row(model: &str, phase: Option<&str>, cost: Option<f64>, age_days: i64) -> ChatUsageInput {
        let created = crate::env::iso(crate::env::SystemEnv.now_micros() - age_days * DAY_US);
        serde_json::from_value(json!({
            "model": model, "provider": "acme", "phase": phase, "input_tokens": 2, "output_tokens": 3,
            "cache_read_tokens": 1, "cache_write_tokens": 0, "cost_usd": cost, "created_at": created,
        }))
        .unwrap()
    }

    #[test]
    fn sums_the_window_per_model_and_phase_in_cost_order() {
        let s = store();
        assert_eq!(
            s.read_chat_usage(Some(30.0)).unwrap(),
            json!({ "rows": [], "logged_since": null })
        );
        s.log_chat_usage(&row("m-b", Some("p"), Some(0.5), 1))
            .unwrap();
        s.log_chat_usage(&row("m-b", Some("p"), None, 2)).unwrap();
        s.log_chat_usage(&row("m-a", None, Some(0.25), 1)).unwrap();
        s.log_chat_usage(&row("m-a", Some("p"), Some(0.25), 1))
            .unwrap();
        s.log_chat_usage(&row("M-a", Some("p"), Some(0.25), 1))
            .unwrap();
        s.log_chat_usage(&row("m-u", None, None, 1)).unwrap();
        s.log_chat_usage(&row("m-old", None, Some(9.0), 20))
            .unwrap();
        let week = s.read_chat_usage(Some(7.0)).unwrap();
        let order: Vec<String> = week["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| format!("{}/{}", r["model"], r["phase"]))
            .collect();
        assert_eq!(
            order,
            [
                "\"m-b\"/\"p\"",
                "\"M-a\"/\"p\"",
                "\"m-a\"/null",
                "\"m-a\"/\"p\"",
                "\"m-u\"/null"
            ]
        );
        assert_eq!(week["rows"][0]["calls"], json!(2));
        assert_eq!(week["rows"][0]["input_tokens"], json!(4.0));
        assert_eq!(week["rows"][0]["cost_usd"], json!(0.5));
        assert_eq!(week["rows"][0]["unpriced_calls"], json!(1));
        assert_eq!(week["rows"][4]["cost_usd"], Value::Null);
        let month = s.read_chat_usage(Some(30.0)).unwrap();
        assert_eq!(month["rows"][0]["model"], json!("m-old"));
        assert_eq!(week["logged_since"], month["logged_since"]);
        assert!(week["logged_since"].as_str().unwrap().ends_with("+00"));
        assert_eq!(s.read_chat_usage(None).unwrap()["rows"], json!([]));
    }

    #[test]
    fn refuses_as_postgres_does_and_writes_nothing() {
        let s = store();
        let mut missing = row("m", None, None, 0);
        missing.model = None;
        let err = s.log_chat_usage(&missing).unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
        assert!(err.message.contains("\"model\""));
        let mut tokens = row("m", None, None, 0);
        tokens.output_tokens = None;
        let err = s.log_chat_usage(&tokens).unwrap_err();
        assert!(err.message.contains("\"output_tokens\""));
        let mut fraction = row("m", None, None, 0);
        fraction.input_tokens = Some(1.5);
        assert_eq!(
            s.log_chat_usage(&fraction).unwrap_err().code,
            INVALID_ARGUMENT
        );
        let mut nul = row("m\0", None, None, 0);
        nul.model = Some("m\0".into());
        assert_eq!(s.log_chat_usage(&nul).unwrap_err().code, INVALID_ARGUMENT);
        assert_eq!(
            s.read_chat_usage(Some(30.0)).unwrap(),
            json!({ "rows": [], "logged_since": null })
        );
    }
}
