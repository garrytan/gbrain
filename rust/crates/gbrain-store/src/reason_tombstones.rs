//! Purged change-reason tombstones (`reason_purge_tombstones`, the TypeScript
//! `src/core/engine-sql/sources.ts`): the text-free `(commit, path)` pairs a fact purge found the
//! purged claim under, so a later sync, repair or version snapshot never stamps that reason again.
//!
//! Members: readReasonPurgeTombstones, writeReasonPurgeTombstones.
//!
//! Keys (tag `1`, `keys::REASON_TOMBSTONE`): `1 source \0 commit \0 path`, value `{}`. The key is
//! the table's primary key, so a pair is stored once. A source delete removes the source's pairs
//! (`ON DELETE CASCADE` of `sources.id`, `cascade::remove_source_rows`).

use crate::error::{SOURCE_NOT_FOUND, StoreError};
use crate::kv::{KvWrite, scan_prefix};
use crate::sources::read_source;
use crate::{Result, Store, keys};
use serde::{Deserialize, Serialize};

/// One tombstoned pair, as `reason_purge_tombstones` holds it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ReasonTombstone {
    pub commit_sha: String,
    pub path: String,
}

fn key(source_id: &str, commit_sha: &str, path: &str) -> Vec<u8> {
    keys::text(keys::REASON_TOMBSTONE, &[source_id, commit_sha, path])
}

fn no_nul(what: &str, value: &str) -> Result<()> {
    if value.contains('\0') {
        return Err(StoreError::invalid(format!(
            "reason tombstone: a {what} may not hold a NUL byte"
        )));
    }
    Ok(())
}

/// Splits a stored key back into its pair; `None` for a key this family did not write.
fn pair_of(key: &[u8], prefix_len: usize) -> Option<ReasonTombstone> {
    let rest = std::str::from_utf8(key.get(prefix_len..)?).ok()?;
    let (commit_sha, path) = rest.split_once('\0')?;
    Some(ReasonTombstone {
        commit_sha: commit_sha.to_owned(),
        path: path.to_owned(),
    })
}

/// Every pair of one source, in key (byte) order.
fn source_pairs(
    read: &dyn crate::kv::KvRead,
    source_id: &str,
) -> Result<Vec<(Vec<u8>, ReasonTombstone)>> {
    let prefix = keys::text(keys::REASON_TOMBSTONE, &[source_id, ""]);
    let mut out = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        if let Some(pair) = pair_of(k, prefix.len()) {
            out.push((k.to_vec(), pair));
        }
        true
    })?;
    Ok(out)
}

/// Whether the source holds the tombstone of (commit, path): a version snapshot never stamps that
/// pair's reason. A NUL byte in any part matches nothing, as the read member answers.
pub(crate) fn tombstoned(
    read: &dyn crate::kv::KvRead,
    source_id: &str,
    commit_sha: &str,
    path: &str,
) -> Result<bool> {
    if [source_id, commit_sha, path]
        .iter()
        .any(|v| v.contains('\0'))
    {
        return Ok(false);
    }
    Ok(read.get(&key(source_id, commit_sha, path))?.is_some())
}

pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for (k, _) in source_pairs(&*tx, source_id)? {
        tx.delete(&k)?;
    }
    Ok(())
}

impl Store {
    /// `readReasonPurgeTombstones(sourceId, only)`: the source's tombstoned pairs, sorted by commit
    /// then path in byte order; with `only`, that one pair when it is stored, else none.
    pub fn read_reason_purge_tombstones(
        &self,
        source_id: &str,
        only: Option<&ReasonTombstone>,
    ) -> Result<Vec<ReasonTombstone>> {
        if source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        if let Some(pair) = only {
            if pair.commit_sha.contains('\0') || pair.path.contains('\0') {
                return Ok(Vec::new());
            }
            let found = read.get(&key(source_id, &pair.commit_sha, &pair.path))?;
            return Ok(found.map(|_| pair.clone()).into_iter().collect());
        }
        Ok(source_pairs(&*read, source_id)?
            .into_iter()
            .map(|(_, pair)| pair)
            .collect())
    }

    /// `writeReasonPurgeTombstones(sourceId, pairs)`: stores each pair not stored yet and returns
    /// how many it added (`INSERT … ON CONFLICT DO NOTHING RETURNING 1`); a pair listed twice is
    /// added once. No pairs add nothing. An unknown source refuses `source_not_found` and stores
    /// nothing, as the foreign key refuses the insert.
    pub fn write_reason_purge_tombstones(
        &self,
        source_id: &str,
        pairs: &[ReasonTombstone],
    ) -> Result<u64> {
        no_nul("source id", source_id)?;
        for pair in pairs {
            no_nul("commit", &pair.commit_sha)?;
            no_nul("path", &pair.path)?;
        }
        if pairs.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            if read_source(&*tx, source_id)?.is_none() {
                return Err(StoreError::new(
                    SOURCE_NOT_FOUND,
                    format!("reason tombstone: no source '{source_id}'"),
                ));
            }
            let mut added = 0;
            for pair in pairs {
                let k = key(source_id, &pair.commit_sha, &pair.path);
                if tx.get(&k)?.is_none() {
                    tx.put(&k, b"{}")?;
                    added += 1;
                }
            }
            Ok(added)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(commit: &str, path: &str) -> ReasonTombstone {
        ReasonTombstone {
            commit_sha: commit.into(),
            path: path.into(),
        }
    }

    #[test]
    fn a_pair_is_stored_once_and_read_back_by_source() {
        let store = crate::test_support::store();
        let added = store
            .write_reason_purge_tombstones(
                "default",
                &[
                    pair("bbb", "notes/a.md"),
                    pair("aaa", "notes/b.md"),
                    pair("bbb", "notes/a.md"),
                ],
            )
            .unwrap();
        assert_eq!(added, 2);
        assert_eq!(
            store
                .write_reason_purge_tombstones("default", &[pair("aaa", "notes/b.md")])
                .unwrap(),
            0
        );
        assert_eq!(
            store.read_reason_purge_tombstones("default", None).unwrap(),
            vec![pair("aaa", "notes/b.md"), pair("bbb", "notes/a.md")]
        );
        let one = pair("aaa", "notes/b.md");
        assert_eq!(
            store
                .read_reason_purge_tombstones("default", Some(&one))
                .unwrap(),
            vec![one]
        );
        assert!(
            store
                .read_reason_purge_tombstones("default", Some(&pair("aaa", "notes/a.md")))
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .read_reason_purge_tombstones("other", None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn an_unknown_source_refuses_and_stores_nothing() {
        let store = crate::test_support::store();
        let err = store
            .write_reason_purge_tombstones("nope", &[pair("aaa", "a.md")])
            .unwrap_err();
        assert_eq!(err.code, SOURCE_NOT_FOUND);
        assert!(
            store
                .read_reason_purge_tombstones("nope", None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_source_delete_removes_its_pairs_only() {
        let store = crate::test_support::store();
        store
            .write_reason_purge_tombstones("default", &[pair("aaa", "a.md")])
            .unwrap();
        store.write(|tx| remove_source_rows(tx, "default")).unwrap();
        assert!(
            store
                .read_reason_purge_tombstones("default", None)
                .unwrap()
                .is_empty()
        );
    }
}
