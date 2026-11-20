//! A resumable-op checkpoint whose `completed_keys` holds JSON values rather than path strings
//! (`writeOpCheckpointValues` and `readOpCheckpointValues`, `src/core/engine-sql/collate-identity-downgrades.ts`):
//! the identity-downgrade record and the phantom-redirect rotation are each one JSON object kept
//! as the single element of the array.
//!
//! Keys: none of its own. The row is the checkpoint parent of `persistence/op_checkpoint.rs`:
//! key `d 0x02 <op> 0x00 <fingerprint>`, value `{ completed_keys, updated_at_us }`, the shape a
//! housekeeping turn and `writeOpCheckpointKeys` store, so `readOpCheckpointKeys` reads the same
//! row. This file builds that key and row itself because the persistence tree is not edited.

use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckpointRow {
    completed_keys: Value,
    updated_at_us: i64,
}

fn parent_key(op: &str, fingerprint: &str) -> Result<Vec<u8>> {
    if op.contains('\0') || fingerprint.contains('\0') {
        return Err(StoreError::invalid(
            "an op checkpoint op and fingerprint cannot contain NUL",
        ));
    }
    let mut key = vec![keys::PERSISTENCE, crate::persistence::HOUSEKEEPING];
    key.extend_from_slice(op.as_bytes());
    key.push(0);
    key.extend_from_slice(fingerprint.as_bytes());
    Ok(key)
}

impl Store {
    /// `writeOpCheckpointValues(op, fingerprint, values)`: the parent's `completed_keys` replaced
    /// by the JSON array `values`, its stamp now; the parent is created when missing.
    pub fn write_op_checkpoint_values(
        &self,
        op: &str,
        fingerprint: &str,
        values: &[Value],
    ) -> Result<()> {
        let key = parent_key(op, fingerprint)?;
        let env: &dyn Env = &*self.env;
        let row = CheckpointRow {
            completed_keys: Value::Array(values.to_vec()),
            updated_at_us: env.now_micros(),
        };
        self.write(|tx| put_json(tx, &key, &row))
    }

    /// `readOpCheckpointValues(op, fingerprint)`: the parent's `completed_keys` as stored, or
    /// `null` when there is no parent.
    pub fn read_op_checkpoint_values(&self, op: &str, fingerprint: &str) -> Result<Value> {
        let read = self.read()?;
        Ok(
            get_json::<CheckpointRow>(&*read, &parent_key(op, fingerprint)?)?
                .map_or(Value::Null, |row| row.completed_keys),
        )
    }
}
