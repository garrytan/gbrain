//! Whole checkpoint rows: the `op_checkpoints` parents whose `completed_keys` hold a JSON record
//! rather than a list of keys (rust/docs/store/persistence.md, "Checkpoint rows").
//!
//! The git sync holds, their per-incarnation summary and the managed sync pass rows are such
//! rows (`src/core/engine-sql/sync-hold-store.ts`). The store keeps them as the other checkpoint
//! parents (`op_checkpoint.rs`, key `d 0x02 <op> 0x00 <fingerprint>`, the same JSON row), so the
//! seven-day purge and the key reads see them as Postgres does, in one table.
//!
//! The hold semantics (the summary counters, the escalation stamps) stay in the TypeScript
//! store members; these are the row primitives they compose:
//!
//! - `readOpCheckpointRow(op, fingerprint)`: the row, or null.
//! - `putOpCheckpointRow(op, fingerprint, completedKeys)`: the row created or replaced, stamped now.
//! - `replaceOpCheckpointRow(op, fingerprint, expected, completedKeys)`: replaced only while it
//!   still holds `expected` (JSON equality, as `jsonb` compares), else nothing; true when it landed.
//! - `listOpCheckpointRows(op, fingerprintPrefix)`: the op's rows in fingerprint byte order
//!   (PGLite's C collation; Postgres orders by its database collation).

use super::housekeeping::HousekeepingRow;
use super::op_checkpoint::parent_key;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde_json::{Value, json};

fn row_json(fingerprint: &str, row: &HousekeepingRow) -> Value {
    json!({
        "fingerprint": fingerprint,
        "completed_keys": row.completed_keys,
        "updated_at": iso(row.updated_at_us),
    })
}

fn op_prefix(op: &str) -> Result<Vec<u8>> {
    if op.contains('\0') {
        return Err(StoreError::invalid(
            "an op checkpoint op cannot contain NUL",
        ));
    }
    let mut key = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
    key.extend_from_slice(op.as_bytes());
    key.push(0);
    Ok(key)
}

fn list_in(read: &dyn KvRead, op: &str, fingerprint_prefix: &str) -> Result<Vec<Value>> {
    let base = op_prefix(op)?;
    if fingerprint_prefix.contains('\0') {
        return Ok(Vec::new());
    }
    let mut prefix = base.clone();
    prefix.extend_from_slice(fingerprint_prefix.as_bytes());
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let fingerprint = String::from_utf8_lossy(&k[base.len()..]).into_owned();
        match serde_json::from_slice::<HousekeepingRow>(v) {
            Ok(row) => out.push(row_json(&fingerprint, &row)),
            Err(e) => {
                bad = Some(e);
                return false;
            }
        }
        true
    })?;
    match bad {
        Some(e) => Err(e.into()),
        None => Ok(out),
    }
}

impl Store {
    /// `readOpCheckpointRow(op, fingerprint)`: `{ fingerprint, completed_keys, updated_at }`, or
    /// null when no row exists (a key with NUL never exists).
    pub fn read_op_checkpoint_row(&self, op: &str, fingerprint: &str) -> Result<Option<Value>> {
        if op.contains('\0') || fingerprint.contains('\0') {
            return Ok(None);
        }
        let row: Option<HousekeepingRow> = get_json(&*self.read()?, &parent_key(op, fingerprint)?)?;
        Ok(row.map(|row| row_json(fingerprint, &row)))
    }

    /// `putOpCheckpointRow(op, fingerprint, completedKeys)`: the row created or replaced, its
    /// stamp now. The row's paths stay.
    pub fn put_op_checkpoint_row(
        &self,
        op: &str,
        fingerprint: &str,
        completed_keys: Value,
    ) -> Result<()> {
        let key = parent_key(op, fingerprint)?;
        self.write(|tx| {
            put_json(
                tx,
                &key,
                &HousekeepingRow {
                    completed_keys: completed_keys.clone(),
                    updated_at_us: self.env.now_micros(),
                },
            )
        })
    }

    /// `replaceOpCheckpointRow(op, fingerprint, expected, completedKeys)`: true when the row held
    /// `expected` and now holds `completedKeys` (stamped now); false, writing nothing, when the
    /// row is gone or holds anything else.
    pub fn replace_op_checkpoint_row(
        &self,
        op: &str,
        fingerprint: &str,
        expected: &Value,
        completed_keys: Value,
    ) -> Result<bool> {
        let key = parent_key(op, fingerprint)?;
        self.write(|tx| {
            let current: Option<HousekeepingRow> = get_json(&*tx, &key)?;
            match current {
                Some(row) if &row.completed_keys == expected => {
                    put_json(
                        tx,
                        &key,
                        &HousekeepingRow {
                            completed_keys: completed_keys.clone(),
                            updated_at_us: self.env.now_micros(),
                        },
                    )?;
                    Ok(true)
                }
                _ => Ok(false),
            }
        })
    }

    /// `listOpCheckpointRows(op, fingerprintPrefix)`: the op's rows whose fingerprint starts with
    /// `fingerprintPrefix` (every row for `""`), in fingerprint byte order.
    pub fn list_op_checkpoint_rows(
        &self,
        op: &str,
        fingerprint_prefix: &str,
    ) -> Result<Vec<Value>> {
        list_in(&*self.read()?, op, fingerprint_prefix)
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::store;
    use serde_json::json;

    #[test]
    fn rows_round_trip_and_list_in_fingerprint_order() {
        let s = store();
        assert_eq!(
            s.read_op_checkpoint_row("sync-hold", "default:1:a.md")
                .unwrap(),
            None
        );
        s.put_op_checkpoint_row("sync-hold", "default:1:b.md", json!([{ "path": "b.md" }]))
            .unwrap();
        s.put_op_checkpoint_row("sync-hold", "default:1:a.md", json!([{ "path": "a.md" }]))
            .unwrap();
        s.put_op_checkpoint_row("sync-hold", "other:1:a.md", json!([{ "path": "a.md" }]))
            .unwrap();
        s.put_op_checkpoint_row("sync-hold-summary", "default:1", json!([{ "count": 2 }]))
            .unwrap();
        let row = s
            .read_op_checkpoint_row("sync-hold", "default:1:a.md")
            .unwrap()
            .unwrap();
        assert_eq!(row["completed_keys"], json!([{ "path": "a.md" }]));
        assert_eq!(row["fingerprint"], json!("default:1:a.md"));
        let listed: Vec<String> = s
            .list_op_checkpoint_rows("sync-hold", "default:")
            .unwrap()
            .iter()
            .map(|r| r["fingerprint"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(listed, vec!["default:1:a.md", "default:1:b.md"]);
        assert_eq!(s.list_op_checkpoint_rows("sync-hold", "").unwrap().len(), 3);
        assert_eq!(
            s.list_op_checkpoint_rows("sync-hold-summary", "")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn replace_lands_only_on_the_expected_row() {
        let s = store();
        assert!(
            !s.replace_op_checkpoint_row("op", "fp", &json!([1]), json!([2]))
                .unwrap()
        );
        assert_eq!(s.read_op_checkpoint_row("op", "fp").unwrap(), None);
        s.put_op_checkpoint_row("op", "fp", json!([{ "a": 1, "b": 2 }]))
            .unwrap();
        assert!(
            !s.replace_op_checkpoint_row("op", "fp", &json!([{ "a": 1 }]), json!([3]))
                .unwrap()
        );
        // Key order does not matter, as jsonb equality ignores it.
        assert!(
            s.replace_op_checkpoint_row("op", "fp", &json!([{ "b": 2, "a": 1 }]), json!([3]))
                .unwrap()
        );
        assert_eq!(
            s.read_op_checkpoint_row("op", "fp").unwrap().unwrap()["completed_keys"],
            json!([3])
        );
    }

    #[test]
    fn page_revisions_answer_known_ids_once() {
        use crate::pages::{PageInput, PutPageOptions};
        let s = store();
        assert!(s.read_page_revisions(&[1, -1, 99]).unwrap().is_empty());
        let input = PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        s.put_page("a", &input, &PutPageOptions::default()).unwrap();
        let page = crate::pages::read_page(&*s.read().unwrap(), "default", "a")
            .unwrap()
            .unwrap();
        let id = i64::try_from(page.id).unwrap();
        let rows = s.read_page_revisions(&[id, id, -1, id + 1]).unwrap();
        assert_eq!(
            rows,
            vec![
                json!({ "id": page.id, "slug": "a", "knowledge_revision": page.knowledge_revision })
            ]
        );
    }

    #[test]
    fn nul_keys_read_nothing_and_writes_refuse() {
        let s = store();
        assert_eq!(s.read_op_checkpoint_row("op", "a\0b").unwrap(), None);
        assert!(s.list_op_checkpoint_rows("op", "a\0").unwrap().is_empty());
        assert!(s.put_op_checkpoint_row("op", "a\0b", json!([])).is_err());
    }
}
