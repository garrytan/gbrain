//! The connector sync attempt stamp: the statements of `recordConnectorSyncAttempt` in
//! `src/core/engine-sql/connector-attempts.ts` (rust/docs/store/persistence.md, "Checkpoint rows").
//!
//! The managed connector state row is one `managed-connector-state` op checkpoint per source
//! incarnation, keyed `sha256(stableJson({ sourceId, incarnation }))` (`connectorStateKey`). The first
//! attempt writes the caller's seed; a later one sets `first_attempt_at` on the first record only
//! when that record has none, and otherwise changes nothing, its stamp included.
//!
//! `writeConnectorDbCursor(key, record)`: the statement of `src/core/engine-sql/connector-db-cursor.ts`. A new
//! `connector-db-cursor` row holds `record`; an existing row becomes
//! `[{ version: 1, state: record[0].state, last_run: COALESCE(record[0].last_run, stored[0].last_run) }]`, where
//! `->` reads a JSON null as a value, so only a missing `last_run` key keeps the stored one.

use super::op_checkpoint::{op_checkpoint_completed_keys, write_op_checkpoint_record_in};
use crate::Store;
use crate::env::Env;
use crate::error::Result;
use crate::kv::KvWrite;
use crate::sources::read_source;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const CONNECTOR_STATE_OP: &str = "managed-connector-state";
const CONNECTOR_DB_CURSOR_OP: &str = "connector-db-cursor";

/// `connectorStateKey(sourceId, incarnation)`: the SHA-256 hex of `{"incarnation":..,"sourceId":..}`,
/// keys sorted and compact as `stableJson` writes them.
pub(crate) fn connector_state_key(source_id: &str, incarnation: &str) -> String {
    let mut map = Map::new();
    map.insert("incarnation".into(), Value::String(incarnation.into()));
    map.insert("sourceId".into(), Value::String(source_id.into()));
    let text = Value::Object(map).to_string();
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `->0->>'first_attempt_at' IS NULL`: no first record, a first record that is not an object, or no
/// stamp (a missing key or JSON null).
fn has_no_stamp(keys: &Value) -> bool {
    match keys.get(0) {
        Some(Value::Object(record)) => {
            matches!(record.get("first_attempt_at"), None | Some(Value::Null))
        }
        _ => true,
    }
}

/// `recordConnectorSyncAttempt`: false for an unknown source. A missing row is created with `seed`.
/// An existing row with no stamp gets `at` as the first record's `first_attempt_at`, the way
/// `jsonb_set(.., '{0,first_attempt_at}', .., true)` sets it: only into a first record that is an
/// object, so an empty or non-object first element stays as it is.
pub(crate) fn record_connector_sync_attempt_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    source_id: &str,
    at: &str,
    seed: &Value,
) -> Result<bool> {
    let Some(source) = read_source(&*tx, source_id)? else {
        return Ok(false);
    };
    let fingerprint = connector_state_key(source_id, &source.incarnation);
    let next = match op_checkpoint_completed_keys(&*tx, CONNECTOR_STATE_OP, &fingerprint)? {
        None => seed.clone(),
        Some(keys) if !has_no_stamp(&keys) => return Ok(true),
        Some(mut keys) => {
            if let Some(Value::Object(record)) = keys.get_mut(0) {
                record.insert("first_attempt_at".into(), Value::String(at.into()));
            }
            keys
        }
    };
    let next = crate::jsonb::order(next);
    write_op_checkpoint_record_in(tx, env, CONNECTOR_STATE_OP, &fingerprint, Some(&next))?;
    Ok(true)
}

/// `value->0->key` as jsonb `->` reads it: `None` (SQL NULL) for a missing first element, a non-object first element or
/// a missing key; a JSON null is `Some(Null)`.
fn first_field(value: &Value, key: &str) -> Option<Value> {
    value
        .get(0)
        .and_then(Value::as_object)
        .and_then(|record| record.get(key).cloned())
}

/// `writeConnectorDbCursor`: see the module comment.
pub(crate) fn write_connector_db_cursor_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    key: &str,
    record: &Value,
) -> Result<()> {
    let next = match op_checkpoint_completed_keys(&*tx, CONNECTOR_DB_CURSOR_OP, key)? {
        None => record.clone(),
        Some(stored) => {
            let mut object = Map::new();
            object.insert("version".into(), Value::from(1));
            object.insert(
                "state".into(),
                first_field(record, "state").unwrap_or(Value::Null),
            );
            let last_run =
                first_field(record, "last_run").or_else(|| first_field(&stored, "last_run"));
            object.insert("last_run".into(), last_run.unwrap_or(Value::Null));
            Value::Array(vec![Value::Object(object)])
        }
    };
    let next = crate::jsonb::order(next);
    write_op_checkpoint_record_in(tx, env, CONNECTOR_DB_CURSOR_OP, key, Some(&next))
}

impl Store {
    /// `writeConnectorDbCursor(key, record)`.
    pub fn write_connector_db_cursor(&self, key: &str, record: &Value) -> Result<()> {
        self.write(|tx| write_connector_db_cursor_in(tx, &*self.env, key, record))
    }

    /// `recordConnectorSyncAttempt(sourceId, at, seed)`.
    pub fn record_connector_sync_attempt(
        &self,
        source_id: &str,
        at: &str,
        seed: &Value,
    ) -> Result<bool> {
        self.write(|tx| record_connector_sync_attempt_in(tx, &*self.env, source_id, at, seed))
    }
}

#[cfg(test)]
mod tests {
    use super::{connector_state_key, first_field, has_no_stamp};
    use serde_json::json;

    #[test]
    fn the_key_is_the_sha256_of_the_sorted_compact_json() {
        // sha256('{"incarnation":"1","sourceId":"s"}'), as digest({ sourceId: 's', incarnation: '1' }) computes it.
        assert_eq!(connector_state_key("s", "1").len(), 64);
        assert_ne!(connector_state_key("s", "1"), connector_state_key("s", "2"));
    }

    #[test]
    fn a_stamp_is_a_present_non_null_first_attempt_at() {
        assert!(has_no_stamp(&json!([])));
        assert!(has_no_stamp(&json!(["x"])));
        assert!(has_no_stamp(&json!([{ "version": 1 }])));
        assert!(has_no_stamp(&json!([{ "first_attempt_at": null }])));
        assert!(!has_no_stamp(&json!([{ "first_attempt_at": "t" }])));
        assert!(!has_no_stamp(&json!([{ "first_attempt_at": 5 }])));
    }

    #[test]
    fn first_field_reads_like_the_jsonb_arrow() {
        assert_eq!(first_field(&json!([{ "a": null }]), "a"), Some(json!(null)));
        assert_eq!(first_field(&json!([{ "b": 1 }]), "a"), None);
        assert_eq!(first_field(&json!([]), "a"), None);
        assert_eq!(first_field(&json!(["x"]), "a"), None);
    }
}
