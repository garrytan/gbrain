//! Worktree rows: the one place the write claim, the effect claim, the idle probe and the
//! admission read a `persistence_worktrees` or `persistence_source_bindings` row
//! (rust/docs/store/persistence.md, "Worktree rows").
//!
//! The rows belong to the worktree binding (`worktrees.rs`, keys under `d 0x09`): a worktree
//! at `d 0x09 0x01 <worktree id>` and a source binding at `d 0x09 0x03 <source id>`, each one
//! JSON record. This module reads only the columns its callers join on, with the binding's
//! column defaults for a field a record leaves out, so a claim term asks the row the binding
//! wrote and never answers "no row" for one it cannot parse: a record that is not valid JSON
//! refuses `store_corrupt`.

use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::keys;
use crate::kv::KvRead;
use serde::Deserialize;

use super::WORKTREES;
/// `d 0x09 0x01`: one `persistence_worktrees` row.
const WORKTREE: u8 = 0x01;
/// `d 0x09 0x03`: one `persistence_source_bindings` row.
const SOURCE_BINDING: u8 = 0x03;

/// The columns of a `persistence_worktrees` row that the claims, scans and admission read.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct WorktreeRow {
    /// `owner_host_id`: the host whose consumers publish the worktree's writes; null when no
    /// host owns it, which no `owner_host_id=$host` term matches.
    #[serde(default)]
    pub owner_host_id: Option<String>,
    /// `owner_epoch` (bigint, default 0).
    #[serde(default)]
    pub owner_epoch: i64,
    /// `state` (default `active`): only an `active` worktree's writes are claimed.
    #[serde(default = "active")]
    pub state: String,
}

impl WorktreeRow {
    /// `w.owner_host_id=$host::uuid`: false when no host owns the row. Both sides are uuids, so
    /// the comparison ignores case.
    pub(crate) fn owned_by(&self, host: Option<&str>) -> bool {
        match (&self.owner_host_id, host) {
            (Some(owner), Some(host)) => owner.eq_ignore_ascii_case(host),
            _ => false,
        }
    }
}

/// The columns of a `persistence_source_bindings` row that admission compares.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct SourceBindingRow {
    pub source_incarnation: String,
    pub worktree_id: String,
    /// `topology_generation` (default 1).
    #[serde(default = "one")]
    pub topology_generation: i64,
}

fn active() -> String {
    "active".into()
}

fn one() -> i64 {
    1
}

fn key(tag: u8, id: &str) -> Vec<u8> {
    let mut key = vec![keys::PERSISTENCE, WORKTREES, tag];
    key.extend_from_slice(id.to_lowercase().as_bytes());
    key
}

fn read_row<T: for<'de> Deserialize<'de>>(
    read: &dyn KvRead,
    key: &[u8],
    table: &str,
) -> Result<Option<T>> {
    match read.get(key)? {
        None => Ok(None),
        Some(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| {
            StoreError::new(STORE_CORRUPT, format!("a {table} record is not valid JSON"))
        }),
    }
}

/// The `persistence_worktrees` row with id `id`, or `None` when no row has that id (the
/// `LEFT JOIN persistence_worktrees w ON w.id=...` that finds none). Ids are uuids: the key is
/// the lower-case text the binding stores.
pub(crate) fn read_worktree_row(read: &dyn KvRead, id: &str) -> Result<Option<WorktreeRow>> {
    read_row(read, &key(WORKTREE, id), "persistence_worktrees")
}

/// The `persistence_source_bindings` row of source `source_id`, or `None`.
pub(crate) fn read_source_binding(
    read: &dyn KvRead,
    source_id: &str,
) -> Result<Option<SourceBindingRow>> {
    let mut k = vec![keys::PERSISTENCE, WORKTREES, SOURCE_BINDING];
    k.extend_from_slice(source_id.as_bytes());
    read_row(read, &k, "persistence_source_bindings")
}

/// Test rows at the binding's keys, as `worktrees.rs` writes them.
#[cfg(test)]
pub(crate) mod rows {
    use super::*;
    use crate::kv::KvWrite;
    use serde_json::{Value, json};

    pub(crate) fn put_worktree(
        tx: &mut dyn KvWrite,
        id: &str,
        owner: Option<&str>,
        state: &str,
    ) -> Result<()> {
        put(
            tx,
            &key(WORKTREE, id),
            json!({ "id": id, "owner_host_id": owner, "owner_epoch": 3, "state": state, "created_at_us": 0 }),
        )
    }

    pub(crate) fn put_source_binding(
        tx: &mut dyn KvWrite,
        source_id: &str,
        incarnation: &str,
        worktree: &str,
        generation: i64,
    ) -> Result<()> {
        let mut k = vec![keys::PERSISTENCE, WORKTREES, SOURCE_BINDING];
        k.extend_from_slice(source_id.as_bytes());
        put(
            tx,
            &k,
            json!({ "source_id": source_id, "source_incarnation": incarnation, "worktree_id": worktree, "relative_path": "", "topology_generation": generation }),
        )
    }

    fn put(tx: &mut dyn KvWrite, key: &[u8], v: Value) -> Result<()> {
        crate::put_json(tx, key, &v)
    }
}

#[cfg(test)]
mod tests {
    use super::rows::{put_source_binding, put_worktree};
    use super::*;
    use crate::test_support::store;

    const WORKTREE: &str = "f0000000-0000-4000-8000-0000000000a1";
    const HOST: &str = "a0000000-0000-4000-8000-0000000000a1";

    #[test]
    fn a_missing_row_reads_none() {
        let s = store();
        let read = s.read().unwrap();
        assert_eq!(read_worktree_row(&*read, WORKTREE).unwrap(), None);
        assert_eq!(read_source_binding(&*read, "default").unwrap(), None);
    }

    #[test]
    fn a_stored_row_reads_its_owner_epoch_and_state_by_any_case_of_its_id() {
        let s = store();
        s.write(|tx| {
            put_worktree(tx, WORKTREE, Some(HOST), "active")?;
            put_source_binding(tx, "default", "7", WORKTREE, 2)
        })
        .unwrap();
        let read = s.read().unwrap();
        let row = read_worktree_row(&*read, &WORKTREE.to_uppercase())
            .unwrap()
            .unwrap();
        assert_eq!(row.owner_epoch, 3);
        assert_eq!(row.state, "active");
        assert!(row.owned_by(Some(&HOST.to_uppercase())));
        assert!(!row.owned_by(Some("b0000000-0000-4000-8000-0000000000a1")));
        assert!(!row.owned_by(None));
        let binding = read_source_binding(&*read, "default").unwrap().unwrap();
        assert_eq!(
            binding,
            SourceBindingRow {
                source_incarnation: "7".into(),
                worktree_id: WORKTREE.into(),
                topology_generation: 2
            }
        );
    }

    #[test]
    fn an_unowned_row_takes_the_column_defaults_and_matches_no_host() {
        let s = store();
        s.write(|tx| {
            crate::put_json(
                tx,
                &key(super::WORKTREE, WORKTREE),
                &serde_json::json!({ "id": WORKTREE }),
            )
        })
        .unwrap();
        let row = read_worktree_row(&*s.read().unwrap(), WORKTREE)
            .unwrap()
            .unwrap();
        assert_eq!(
            row,
            WorktreeRow {
                owner_host_id: None,
                owner_epoch: 0,
                state: "active".into()
            }
        );
        assert!(!row.owned_by(Some(HOST)));
    }

    #[test]
    fn a_record_that_is_not_json_refuses_store_corrupt() {
        let s = store();
        s.write(|tx| tx.put(&key(super::WORKTREE, WORKTREE), b"{"))
            .unwrap();
        let err = read_worktree_row(&*s.read().unwrap(), WORKTREE).unwrap_err();
        assert_eq!(err.code, STORE_CORRUPT);
        assert_eq!(
            err.message,
            "a persistence_worktrees record is not valid JSON"
        );
    }

    /// The reader reads what the binding's own inserts (`worktrees.rs`) write, at the keys they
    /// choose: an upper-case id is stored lower-case and read back by either case.
    #[test]
    fn the_reader_reads_the_rows_the_binding_inserts_write() {
        let s = store();
        let up = WORKTREE.to_uppercase();
        let insert: crate::persistence::WorktreeInsert =
            serde_json::from_value(serde_json::json!({
                "id": up, "ownerHostId": HOST.to_uppercase(), "ownerEpoch": 7, "state": "draining",
            }))
            .unwrap();
        s.insert_worktree(&insert).unwrap();
        let bare: crate::persistence::WorktreeInsert = serde_json::from_value(serde_json::json!({
            "id": "f0000000-0000-4000-8000-0000000000b2",
        }))
        .unwrap();
        s.insert_worktree(&bare).unwrap();
        let inc = s.read_source_membership("default").unwrap().unwrap()["incarnation"]
            .as_str()
            .unwrap()
            .to_string();
        let binding: crate::persistence::SourceBindingInsert =
            serde_json::from_value(serde_json::json!({
                "sourceId": "default", "incarnation": inc.to_uppercase(), "worktreeId": up,
                "relativePath": "notes",
            }))
            .unwrap();
        s.insert_source_binding(&binding).unwrap();
        let read = s.read().unwrap();
        for id in [WORKTREE.to_string(), up.clone()] {
            let row = read_worktree_row(&*read, &id).unwrap().unwrap();
            assert_eq!(row.owner_host_id.as_deref(), Some(HOST));
            assert_eq!((row.owner_epoch, row.state.as_str()), (7, "draining"));
            assert!(row.owned_by(Some(HOST)) && !row.owned_by(None));
        }
        let unowned = read_worktree_row(&*read, "f0000000-0000-4000-8000-0000000000b2")
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                unowned.owner_host_id.clone(),
                unowned.owner_epoch,
                unowned.state.as_str()
            ),
            (None, 0, "active")
        );
        let b = read_source_binding(&*read, "default").unwrap().unwrap();
        assert_eq!(b.worktree_id, WORKTREE);
        assert_eq!(b.source_incarnation, inc.to_lowercase());
    }
}
