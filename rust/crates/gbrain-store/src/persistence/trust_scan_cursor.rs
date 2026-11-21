//! The trust scan's resumable cursor: the statements `readTrustScanCursor` and
//! `writeTrustScanCursor` of `src/core/engine-sql/trust-scan.ts` (rust/docs/store/trust.md,
//! "Trust scan state").
//!
//! The cursor is the `op_checkpoints` row (`trust_scan`, `v1`). It lives under the key of
//! `op_checkpoint.rs`'s parent row, `d 0x02 <op> 0x00 <fingerprint>`, with the same
//! `housekeeping::HousekeepingRow` value, so `readOpCheckpointKeys` and `purgeStaleCheckpoints`
//! see the one row Postgres keeps. Unlike `writeOpCheckpointKeys`, the write takes any JSON
//! array (the cursor is an object, not a key string) and stores it in jsonb key order, so the
//! read answers the object as Postgres returns it.

use super::housekeeping::HousekeepingRow;
use crate::env::Env;
use crate::error::Result;
use crate::kv::{KvRead, KvWrite};
use crate::raw_files::jsonb_order;
use crate::{Store, get_json, keys, put_json};
use serde_json::Value;

/// The cursor row's `(op, fingerprint)`, as scan.ts names it.
const OP: &str = "trust_scan";
const FINGERPRINT: &str = "v1";

/// `d 0x02 trust_scan 0x00 v1`: `op_checkpoint.rs`'s parent key of the cursor row.
fn cursor_key() -> Vec<u8> {
    let mut key = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
    key.extend_from_slice(OP.as_bytes());
    key.push(0);
    key.extend_from_slice(FINGERPRINT.as_bytes());
    key
}

/// `readTrustScanCursor()`: the row's `completed_keys`, or JSON null when there is no row.
pub(crate) fn read_trust_scan_cursor_in(read: &dyn KvRead) -> Result<Value> {
    Ok(get_json::<HousekeepingRow>(read, &cursor_key())?
        .map_or(Value::Null, |row| row.completed_keys))
}

/// `writeTrustScanCursor(completedKeys)`: the row's keys replaced, its stamp now (the insert
/// takes `updated_at`'s default, the conflict sets it to `now()`).
pub(crate) fn write_trust_scan_cursor_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    completed: Vec<Value>,
) -> Result<()> {
    put_json(
        tx,
        &cursor_key(),
        &HousekeepingRow {
            completed_keys: jsonb_order(Value::Array(completed)),
            updated_at_us: env.now_micros(),
        },
    )
}

impl Store {
    /// `readTrustScanCursor()`.
    pub fn read_trust_scan_cursor(&self) -> Result<Value> {
        read_trust_scan_cursor_in(&*self.read()?)
    }

    /// `writeTrustScanCursor(completedKeys)`.
    pub fn write_trust_scan_cursor(&self, completed: Vec<Value>) -> Result<()> {
        self.write(|tx| write_trust_scan_cursor_in(tx, &*self.env, completed.clone()))
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::store;
    use serde_json::json;

    #[test]
    fn the_cursor_reads_null_until_written_then_the_object_in_jsonb_key_order() {
        let store = store();
        assert_eq!(store.read_trust_scan_cursor().unwrap(), json!(null));
        store
            .write_trust_scan_cursor(vec![
                json!({ "until": { "pages": 3 }, "ids": { "pages": 1 }, "detector_version": 2 }),
            ])
            .unwrap();
        let read = store.read_trust_scan_cursor().unwrap();
        assert_eq!(
            read,
            json!([{ "ids": { "pages": 1 }, "until": { "pages": 3 }, "detector_version": 2 }])
        );
        let keys: Vec<&String> = read[0].as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            ["ids", "until", "detector_version"],
            "jsonb orders keys by length, then bytes"
        );
        store
            .write_trust_scan_cursor(vec![json!({ "detector_version": 3 })])
            .unwrap();
        assert_eq!(
            store.read_trust_scan_cursor().unwrap(),
            json!([{ "detector_version": 3 }])
        );
    }

    #[test]
    fn the_cursor_is_the_op_checkpoint_row_lane_members_read_and_write() {
        let store = store();
        store
            .write_trust_scan_cursor(vec![json!("a"), json!(1)])
            .unwrap();
        assert_eq!(
            store.read_op_checkpoint_keys("trust_scan", "v1").unwrap(),
            json!({ "keys": ["a", "1"], "corruptParent": false })
        );
        store
            .write_op_checkpoint_keys("trust_scan", "v1", &[String::from("b")])
            .unwrap();
        assert_eq!(store.read_trust_scan_cursor().unwrap(), json!(["b"]));
        store.delete_op_checkpoint("trust_scan", "v1").unwrap();
        assert_eq!(store.read_trust_scan_cursor().unwrap(), json!(null));
    }
}
