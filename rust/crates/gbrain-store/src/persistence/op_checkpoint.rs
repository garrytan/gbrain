//! Resumable-op checkpoints: the statements of `src/core/engine-sql/op-checkpoint.ts` and the
//! read `readOpCheckpointKeys` of `engine-sql/write-misc.ts` (rust/docs/store/persistence.md,
//! "Op checkpoints").
//!
//! - The parent: one `op_checkpoints` row per (op, fingerprint), key
//!   `d 0x02 <op> 0x00 <fingerprint>`, the same JSON row as a housekeeping turn
//!   (`housekeeping::HousekeepingRow`), as Postgres keeps both in one table.
//! - The children: one `op_checkpoint_paths` row per (op, fingerprint, path), key
//!   `d 0x07 <op> 0x00 <fingerprint> 0x00 <path>`, empty value. Not `d 0x05` or `d 0x06`: those
//!   hold the `persistence_effects` rows (`d 0x05 <request id> 0x00 <kind>`) and their claim-order
//!   index.
//!
//! Deleting a parent deletes its children, as the Postgres foreign key does (`ON DELETE
//! CASCADE`). The read lists the children in path order and then the parent's array; Postgres
//! lists them in no stated order, and the caller deduplicates them into a set.

use super::housekeeping::HousekeepingRow;
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde_json::{Value, json};

/// Refuses NUL, which Postgres text cannot hold, so a key part cannot run into the next one.
fn text<'a>(value: &'a str, what: &str) -> Result<&'a str> {
    if value.contains('\0') {
        return Err(StoreError::invalid(format!(
            "an op checkpoint {what} cannot contain NUL"
        )));
    }
    Ok(value)
}

fn parent_key(op: &str, fingerprint: &str) -> Result<Vec<u8>> {
    let mut key = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
    key.extend_from_slice(text(op, "op")?.as_bytes());
    key.push(0);
    key.extend_from_slice(text(fingerprint, "fingerprint")?.as_bytes());
    Ok(key)
}

/// `d 0x07 <op> 0x00 <fingerprint> 0x00`: the prefix of one checkpoint's paths.
fn paths_prefix(op: &str, fingerprint: &str) -> Result<Vec<u8>> {
    let mut key = vec![keys::PERSISTENCE, super::CHECKPOINT_PATH];
    key.extend_from_slice(text(op, "op")?.as_bytes());
    key.push(0);
    key.extend_from_slice(text(fingerprint, "fingerprint")?.as_bytes());
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

/// `readOpCheckpointKeys(op, fingerprint)`: `{ keys, corruptParent }`. The children, then the
/// parent's array, deduplicated in first-seen order; a parent whose keys are not an array is
/// skipped and reported, so the children still load.
pub(crate) fn read_op_checkpoint_keys_in(
    read: &dyn KvRead,
    op: &str,
    fingerprint: &str,
) -> Result<Value> {
    let prefix = paths_prefix(op, fingerprint)?;
    let mut keys: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |key: String| {
        if seen.insert(key.clone()) {
            keys.push(key);
        }
    };
    for k in path_keys(read, &prefix)? {
        push(String::from_utf8_lossy(&k[prefix.len()..]).into_owned());
    }
    let mut corrupt_parent = false;
    if let Some(row) = get_json::<HousekeepingRow>(read, &parent_key(op, fingerprint)?)? {
        match &row.completed_keys {
            Value::Array(items) => {
                // `jsonb_array_elements_text`: a string element is its text; any other element is
                // its JSON text, and a JSON null is SQL NULL, which the caller skips.
                for item in items {
                    match item {
                        Value::String(s) => push(s.clone()),
                        Value::Null => {}
                        other => push(other.to_string()),
                    }
                }
            }
            _ => corrupt_parent = true,
        }
    }
    Ok(json!({ "keys": keys, "corruptParent": corrupt_parent }))
}

/// `writeOpCheckpointKeys(op, fingerprint, keys)`: the parent's keys replaced by `keys`, its
/// stamp now. The children stay.
pub(crate) fn write_op_checkpoint_keys_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    completed: &[String],
) -> Result<()> {
    for key in completed {
        text(key, "key")?;
    }
    put_json(
        tx,
        &parent_key(op, fingerprint)?,
        &HousekeepingRow {
            completed_keys: json!(completed),
            updated_at_us: env.now_micros(),
        },
    )
}

/// `appendOpCheckpointPaths(op, fingerprint, paths)`: the parent created with no keys or its
/// stamp moved to now, then each path not yet banked added.
pub(crate) fn append_op_checkpoint_paths_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    paths: &[String],
) -> Result<()> {
    let parent = parent_key(op, fingerprint)?;
    let prefix = paths_prefix(op, fingerprint)?;
    for path in paths {
        text(path, "path")?;
    }
    let completed_keys = get_json::<HousekeepingRow>(&*tx, &parent)?
        .map_or_else(|| json!([]), |row| row.completed_keys);
    put_json(
        tx,
        &parent,
        &HousekeepingRow {
            completed_keys,
            updated_at_us: env.now_micros(),
        },
    )?;
    for path in paths {
        let mut key = prefix.clone();
        key.extend_from_slice(path.as_bytes());
        tx.put(&key, &[])?;
    }
    Ok(())
}

/// `deleteOpCheckpoint(op, fingerprint)`: the parent and, as the foreign key cascades, its paths.
pub(crate) fn delete_op_checkpoint_in(
    tx: &mut dyn KvWrite,
    op: &str,
    fingerprint: &str,
) -> Result<()> {
    tx.delete(&parent_key(op, fingerprint)?)?;
    delete_op_checkpoint_paths_in(tx, op, fingerprint)
}

/// `deleteOpCheckpointPaths(op, fingerprint)`: the paths only.
pub(crate) fn delete_op_checkpoint_paths_in(
    tx: &mut dyn KvWrite,
    op: &str,
    fingerprint: &str,
) -> Result<()> {
    let prefix = paths_prefix(op, fingerprint)?;
    for key in path_keys(&*tx, &prefix)? {
        tx.delete(&key)?;
    }
    Ok(())
}

impl Store {
    /// `readOpCheckpointKeys(op, fingerprint)`.
    pub fn read_op_checkpoint_keys(&self, op: &str, fingerprint: &str) -> Result<Value> {
        read_op_checkpoint_keys_in(&*self.read()?, op, fingerprint)
    }

    /// `writeOpCheckpointKeys(op, fingerprint, keys)`.
    pub fn write_op_checkpoint_keys(
        &self,
        op: &str,
        fingerprint: &str,
        completed: &[String],
    ) -> Result<()> {
        self.write(|tx| write_op_checkpoint_keys_in(tx, &*self.env, op, fingerprint, completed))
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

    /// `deleteOpCheckpointPaths(op, fingerprint)`.
    pub fn delete_op_checkpoint_paths(&self, op: &str, fingerprint: &str) -> Result<()> {
        self.write(|tx| delete_op_checkpoint_paths_in(tx, op, fingerprint))
    }
}

#[cfg(test)]
mod tests {
    use crate::keys;
    use crate::kv::scan_prefix;
    use crate::test_support::store;
    use serde_json::json;

    /// The bytes after `keys::PERSISTENCE` of the `persistence_effects` rows (`d 0x05 <request id>
    /// 0x00 <kind>`) and their claim-order index (`d 0x06 <id>`), `effects.rs`.
    const EFFECT_FAMILIES: [u8; 2] = [0x05, 0x06];

    #[test]
    fn a_checkpoint_path_key_never_falls_in_the_effect_key_range() {
        // An op and fingerprint spelled as an effect's request id and kind: the path key then has
        // the same bytes after its family byte as that effect's key.
        let (op, fingerprint) = ("8f14e45f-ceea-467f-a0e6-f3c1c4a5b6d7", "page_write");
        let path = super::paths_prefix(op, fingerprint).unwrap();
        for family in EFFECT_FAMILIES {
            let mut effect = vec![keys::PERSISTENCE, family];
            effect.extend_from_slice(op.as_bytes());
            effect.push(0);
            effect.extend_from_slice(fingerprint.as_bytes());
            assert!(
                !path.starts_with(&[keys::PERSISTENCE, family]),
                "a checkpoint path key uses the effect family byte {family:#04x}"
            );
            assert!(!path.starts_with(&effect) && !effect.starts_with(&path));
        }
        let store = store();
        store
            .append_op_checkpoint_paths(op, fingerprint, &[String::from("a.md")])
            .unwrap();
        let read = store.read().unwrap();
        for family in EFFECT_FAMILIES {
            let mut seen = 0;
            scan_prefix(&*read, &[keys::PERSISTENCE, family], false, &mut |_, _| {
                seen += 1;
                true
            })
            .unwrap();
            assert_eq!(
                seen, 0,
                "an effect scan of {family:#04x} reads a checkpoint path"
            );
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_stopped_op_reads_back_its_paths_and_keys_and_a_clear_leaves_nothing() {
        let store = store();
        let none = json!({ "keys": [], "corruptParent": false });
        assert_eq!(store.read_op_checkpoint_keys("embed", "f1").unwrap(), none);
        store
            .append_op_checkpoint_paths("embed", "f1", &strings(&["b", "a"]))
            .unwrap();
        // A banked path appended again is a no-op.
        store
            .append_op_checkpoint_paths("embed", "f1", &strings(&["a"]))
            .unwrap();
        store
            .write_op_checkpoint_keys("embed", "f1", &strings(&["b", "c"]))
            .unwrap();
        assert_eq!(
            store.read_op_checkpoint_keys("embed", "f1").unwrap(),
            json!({ "keys": ["a", "b", "c"], "corruptParent": false })
        );
        // Another fingerprint, and another op with this fingerprint, read nothing of it.
        assert_eq!(store.read_op_checkpoint_keys("embed", "f").unwrap(), none);
        assert_eq!(
            store.read_op_checkpoint_keys("extract", "f1").unwrap(),
            none
        );
        // An append keeps the parent's keys.
        store
            .append_op_checkpoint_paths("embed", "f1", &strings(&["d"]))
            .unwrap();
        assert_eq!(
            store.read_op_checkpoint_keys("embed", "f1").unwrap()["keys"],
            json!(["a", "b", "d", "c"])
        );
        store.delete_op_checkpoint_paths("embed", "f1").unwrap();
        assert_eq!(
            store.read_op_checkpoint_keys("embed", "f1").unwrap()["keys"],
            json!(["b", "c"])
        );
        store
            .append_op_checkpoint_paths("embed", "f1", &strings(&["e"]))
            .unwrap();
        store.delete_op_checkpoint("embed", "f1").unwrap();
        assert_eq!(store.read_op_checkpoint_keys("embed", "f1").unwrap(), none);
    }

    #[test]
    fn a_checkpoint_part_with_nul_is_refused() {
        let store = store();
        assert!(store.read_op_checkpoint_keys("embed\0x", "f").is_err());
        assert!(
            store
                .append_op_checkpoint_paths("embed", "f", &strings(&["a\0b"]))
                .is_err()
        );
        assert!(
            store
                .write_op_checkpoint_keys("embed", "f", &strings(&["a\0b"]))
                .is_err()
        );
    }
}
