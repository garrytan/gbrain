//! Operation checkpoints: the statements of `src/core/engine-sql/op-checkpoint.ts` that
//! `src/core/op-checkpoint.ts` sends for a resumable operation such as sync
//! (rust/docs/store/persistence.md, "Operation checkpoints").
//!
//! - The parent `op_checkpoints` row is the record the housekeeping turn also keeps
//!   (`housekeeping.rs`): key `d 0x02 <op> 0x00 <fingerprint>`, JSON `{completed_keys,
//!   updated_at_us}`. Both files read and write the same row shape.
//! - One `op_checkpoint_paths` row per banked path: key
//!   `d 0x05 <op> 0x00 <fingerprint> 0x00 <path>`, empty value. No part holds NUL (Postgres text
//!   cannot), so the prefix `d 0x05 <op> 0x00 <fingerprint> 0x00` holds one checkpoint's paths
//!   and no other.
//!
//! Deleting the parent deletes its paths, as the foreign key's `ON DELETE CASCADE` does.

use crate::cli_reads::pg_text::jsonb_text;
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The byte after `keys::PERSISTENCE` of an `op_checkpoint_paths` row.
pub(crate) const PATH: u8 = 0x05;

/// One `op_checkpoints` row, as `housekeeping.rs` stores it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckpointRow {
    completed_keys: Value,
    updated_at_us: i64,
}

/// `loadOpCheckpoint`'s read: every banked path, then the legacy `completed_keys` elements, and
/// whether the parent's `completed_keys` is not an array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpCheckpointRead {
    pub keys: Vec<String>,
    pub corrupt_parent: bool,
}

fn no_nul(part: &str) -> Result<()> {
    if part.contains('\0') {
        return Err(StoreError::invalid(
            "an operation checkpoint key cannot contain NUL",
        ));
    }
    Ok(())
}

fn parent_key(op: &str, fingerprint: &str) -> Result<Vec<u8>> {
    no_nul(op)?;
    no_nul(fingerprint)?;
    let mut key = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
    key.extend_from_slice(op.as_bytes());
    key.push(0);
    key.extend_from_slice(fingerprint.as_bytes());
    Ok(key)
}

fn paths_prefix(op: &str, fingerprint: &str) -> Result<Vec<u8>> {
    no_nul(op)?;
    no_nul(fingerprint)?;
    let mut key = vec![keys::PERSISTENCE, PATH];
    key.extend_from_slice(op.as_bytes());
    key.push(0);
    key.extend_from_slice(fingerprint.as_bytes());
    key.push(0);
    Ok(key)
}

fn path_keys(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    scan_prefix(read, prefix, false, &mut |k, _| {
        out.push(k.to_vec());
        true
    })?;
    Ok(out)
}

pub(crate) fn read_op_checkpoint_in(
    read: &dyn KvRead,
    op: &str,
    fingerprint: &str,
) -> Result<OpCheckpointRead> {
    let prefix = paths_prefix(op, fingerprint)?;
    let mut keys = Vec::new();
    for key in path_keys(read, &prefix)? {
        keys.push(String::from_utf8_lossy(&key[prefix.len()..]).into_owned());
    }
    let mut corrupt_parent = false;
    if let Some(row) = get_json::<CheckpointRow>(read, &parent_key(op, fingerprint)?)? {
        match row.completed_keys {
            // jsonb_array_elements_text: a string element is its text, a JSON null is SQL NULL
            // (dropped by the caller's string check), any other element is its jsonb text.
            Value::Array(items) => keys.extend(items.iter().filter_map(|v| match v {
                Value::Null => None,
                Value::String(s) => Some(s.clone()),
                other => Some(jsonb_text(other)),
            })),
            _ => corrupt_parent = true,
        }
    }
    Ok(OpCheckpointRead {
        keys,
        corrupt_parent,
    })
}

/// `recordCompleted`: the parent's `completed_keys` becomes `keys` (replace, not append).
pub(crate) fn write_op_checkpoint_keys_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    keys: &[String],
) -> Result<()> {
    let key = parent_key(op, fingerprint)?;
    put_json(
        tx,
        &key,
        &CheckpointRow {
            completed_keys: json!(keys),
            updated_at_us: env.now_micros(),
        },
    )
}

/// `appendCompleted`: make sure the parent exists and stamp it, then bank each new path.
pub(crate) fn append_op_checkpoint_paths_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    paths: &[String],
) -> Result<()> {
    for path in paths {
        no_nul(path)?;
    }
    let key = parent_key(op, fingerprint)?;
    let completed_keys =
        get_json::<CheckpointRow>(&*tx, &key)?.map_or_else(|| json!([]), |row| row.completed_keys);
    put_json(
        tx,
        &key,
        &CheckpointRow {
            completed_keys,
            updated_at_us: env.now_micros(),
        },
    )?;
    let prefix = paths_prefix(op, fingerprint)?;
    for path in paths {
        let mut child = prefix.clone();
        child.extend_from_slice(path.as_bytes());
        tx.put(&child, b"")?;
    }
    Ok(())
}

/// `clearOpCheckpoint`: delete the parent and every banked path.
pub(crate) fn delete_op_checkpoint_in(
    tx: &mut dyn KvWrite,
    op: &str,
    fingerprint: &str,
) -> Result<()> {
    tx.delete(&parent_key(op, fingerprint)?)?;
    for key in path_keys(&*tx, &paths_prefix(op, fingerprint)?)? {
        tx.delete(&key)?;
    }
    Ok(())
}

impl Store {
    /// `readOpCheckpoint(op, fingerprint)`.
    pub fn read_op_checkpoint(&self, op: &str, fingerprint: &str) -> Result<OpCheckpointRead> {
        read_op_checkpoint_in(&*self.read()?, op, fingerprint)
    }

    /// `writeOpCheckpointKeys(op, fingerprint, keys)`.
    pub fn write_op_checkpoint_keys(
        &self,
        op: &str,
        fingerprint: &str,
        keys: &[String],
    ) -> Result<()> {
        self.write(|tx| write_op_checkpoint_keys_in(tx, &*self.env, op, fingerprint, keys))
    }

    /// `appendOpCheckpointPaths(op, fingerprint, paths)`.
    pub fn append_op_checkpoint_paths(
        &self,
        op: &str,
        fingerprint: &str,
        paths: &[String],
    ) -> Result<()> {
        self.write(|tx| append_op_checkpoint_paths_in(tx, &*self.env, op, fingerprint, paths))
    }

    /// `deleteOpCheckpoint(op, fingerprint)`.
    pub fn delete_op_checkpoint(&self, op: &str, fingerprint: &str) -> Result<()> {
        self.write(|tx| delete_op_checkpoint_in(tx, op, fingerprint))
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::store;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn appended_paths_and_recorded_keys_read_back_and_clear_together() {
        let s = store();
        assert_eq!(
            s.read_op_checkpoint("sync", "f1").unwrap().keys,
            Vec::<String>::new()
        );
        s.append_op_checkpoint_paths("sync", "f1", &v(&["b.md", "a.md"]))
            .unwrap();
        s.append_op_checkpoint_paths("sync", "f1", &v(&["a.md"]))
            .unwrap();
        s.append_op_checkpoint_paths("sync", "f2", &v(&["other.md"]))
            .unwrap();
        // A same-op checkpoint whose fingerprint starts with f1 is not read with f1.
        s.append_op_checkpoint_paths("sync", "f10", &v(&["ten.md"]))
            .unwrap();
        let read = s.read_op_checkpoint("sync", "f1").unwrap();
        assert_eq!(read.keys, v(&["a.md", "b.md"]));
        assert!(!read.corrupt_parent);
        s.write_op_checkpoint_keys("sync", "f1", &v(&["legacy"]))
            .unwrap();
        assert_eq!(
            s.read_op_checkpoint("sync", "f1").unwrap().keys,
            v(&["a.md", "b.md", "legacy"])
        );
        s.delete_op_checkpoint("sync", "f1").unwrap();
        assert_eq!(
            s.read_op_checkpoint("sync", "f1").unwrap().keys,
            Vec::<String>::new()
        );
        assert_eq!(
            s.read_op_checkpoint("sync", "f2").unwrap().keys,
            v(&["other.md"])
        );
        assert_eq!(
            s.read_op_checkpoint("sync", "f10").unwrap().keys,
            v(&["ten.md"])
        );
        assert!(
            s.append_op_checkpoint_paths("sync", "f1", &v(&["bad\0path"]))
                .is_err()
        );
    }
}
