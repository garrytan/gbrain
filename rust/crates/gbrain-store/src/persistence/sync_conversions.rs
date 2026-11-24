//! The managed sync conversion log: the statement of `recordSyncConversion` in
//! `src/core/engine-sql/sync-hold-store.ts` (rust/docs/store/persistence.md, "Checkpoint rows").
//!
//! The log is one `sync-conversions` op checkpoint per (source, incarnation) holding
//! `[{ source_id, incarnation, conversions }]`, newest conversion first. The SQL upsert builds the
//! record with jsonb operators; this module applies the same operators to the stored record, and
//! writes it in jsonb key order, so the record reads back byte for byte as PGLite and Postgres
//! return it.

use super::op_checkpoint::{op_checkpoint_completed_keys, write_op_checkpoint_record_in};
use crate::Store;
use crate::env::Env;
use crate::error::Result;
use crate::kv::KvWrite;
use serde_json::{Value, json};

const SYNC_CONVERSION_OP: &str = "sync-conversions";

/// `a || b` on two jsonb values: two objects merge (the right side's keys win), two arrays
/// concatenate, an array takes the other value as one more element, and any other pair becomes a
/// two-element array.
fn jsonb_concat(a: Value, b: Value) -> Value {
    match (a, b) {
        (Value::Object(mut left), Value::Object(right)) => {
            left.extend(right);
            Value::Object(left)
        }
        (Value::Array(mut left), Value::Array(right)) => {
            left.extend(right);
            Value::Array(left)
        }
        (Value::Array(mut left), right) => {
            left.push(right);
            Value::Array(left)
        }
        (left, Value::Array(right)) => {
            let mut items = Vec::with_capacity(right.len() + 1);
            items.push(left);
            items.extend(right);
            Value::Array(items)
        }
        (left, right) => Value::Array(vec![left, right]),
    }
}

/// `recordSyncConversion`: the first write stores `[{ source_id, incarnation, conversions: [conversion] }]`.
/// A later write keeps the stored record's other keys and sets `conversions` to `conversion`
/// followed by the stored log, cut to the first `keep` entries. A record that is not the first
/// element of an array (`completed_keys->0` is SQL NULL) becomes `[null]`, as `jsonb_build_array(NULL)` does.
pub(crate) fn record_sync_conversion_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    source_id: &str,
    incarnation: &str,
    conversion: &Value,
    keep: usize,
) -> Result<()> {
    let fingerprint = format!("{source_id}:{incarnation}");
    let record = match op_checkpoint_completed_keys(&*tx, SYNC_CONVERSION_OP, &fingerprint)? {
        None => json!([{
            "source_id": source_id,
            "incarnation": incarnation,
            "conversions": [conversion],
        }]),
        Some(keys) => match keys.get(0).cloned() {
            None => json!([null]),
            Some(first) => {
                let prior = first
                    .get("conversions")
                    .filter(|_| first.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                let log = match jsonb_concat(json!([conversion]), prior) {
                    Value::Array(items) => items.into_iter().take(keep).collect::<Vec<_>>(),
                    _ => unreachable!("an array concatenated with any value is an array"),
                };
                json!([jsonb_concat(first, json!({ "conversions": log }))])
            }
        },
    };
    let record = crate::jsonb::order(record);
    write_op_checkpoint_record_in(tx, env, SYNC_CONVERSION_OP, &fingerprint, Some(&record))
}

impl Store {
    /// `recordSyncConversion(sourceId, incarnation, conversion)`, keeping the newest `keep`.
    pub fn record_sync_conversion(
        &self,
        source_id: &str,
        incarnation: &str,
        conversion: &Value,
        keep: usize,
    ) -> Result<()> {
        self.write(|tx| {
            record_sync_conversion_in(tx, &*self.env, source_id, incarnation, conversion, keep)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::jsonb_concat;
    use serde_json::json;

    #[test]
    fn jsonb_concat_follows_the_postgres_operator() {
        assert_eq!(
            jsonb_concat(json!({"a": 1, "b": 2}), json!({"b": 3})),
            json!({"a": 1, "b": 3})
        );
        assert_eq!(jsonb_concat(json!([1]), json!([2, 3])), json!([1, 2, 3]));
        assert_eq!(
            jsonb_concat(json!([1]), json!({"x": 1})),
            json!([1, {"x": 1}])
        );
        assert_eq!(jsonb_concat(json!("s"), json!([1])), json!(["s", 1]));
        assert_eq!(
            jsonb_concat(json!(null), json!({"x": 1})),
            json!([null, {"x": 1}])
        );
    }
}
