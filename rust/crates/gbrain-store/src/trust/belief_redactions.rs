//! The belief ledger's suppressions: `belief_redactions` (src/core/belief/schema.ts,
//! engine-sql/belief-ledger.ts). A row names a redacted field by the hash of its text, never the
//! text.
//!
//! Keys, all under `t 0x0c`:
//! - `t 0x0c 0x00 id` (8 bytes, big-endian) -> [`RedactionRecord`]. Keyed by id alone, since a
//!   release names ids across every source.
//! - `t 0x0c 0x01 source \0 subject_key \0 id` -> empty: the `belief_redactions_subject` index.
//! - `t 0x0c 0x02 source \0 field_hash \0 id` -> empty: the `belief_redactions_field_hash` index.
//!
//! Ids come from the `belief_redactions` counter and start at 1. `created_at` is the transaction
//! clock (`now()`). The table has no foreign key: a source delete keeps its rows.

use super::belief_lifetimes::canonical_uuid;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::next_id;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub(crate) const REDACTIONS: u8 = 0x0c;
const RECORD: u8 = 0x00;
pub(super) const BY_SUBJECT: u8 = 0x01;
pub(super) const BY_FIELD_HASH: u8 = 0x02;
pub(super) const TABLE: &str = "belief_redactions";

/// What is stored for one suppression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RedactionRecord {
    pub source_id: String,
    pub subject_key: String,
    pub field: String,
    pub purge_request: String,
    pub field_hash: String,
    pub released_by: Option<String>,
    pub released_hash: Option<String>,
    pub created_at_us: i64,
}

/// One suppression, as `readBeliefRedactions` answers it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Suppression {
    pub id: u64,
    pub subject_key: String,
    pub field: String,
    pub purge_request: String,
    pub field_hash: String,
    pub released_hash: Option<String>,
}

/// `insertBeliefRedaction`'s argument.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedactionInsert {
    pub source_id: Option<String>,
    pub subject_key: Option<String>,
    pub field: Option<String>,
    pub purge_request: Option<String>,
    pub field_hash: Option<String>,
}

/// `readBeliefRedactions`' arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedactionQuery {
    pub source_id: String,
    pub subject_keys: Vec<String>,
    pub field_hashes: Vec<String>,
}

/// `releaseBeliefRedactions`' arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedactionRelease {
    pub ids: Vec<i64>,
    pub publication_id: String,
    pub released_hash: Option<String>,
}

pub(super) fn record_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::TRUST, REDACTIONS, RECORD];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

pub(super) fn index_prefix(kind: u8, source: &str, value: &str) -> Vec<u8> {
    let mut key = vec![keys::TRUST, REDACTIONS, kind];
    for part in [source, value] {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key
}

pub(super) fn index_key(kind: u8, source: &str, value: &str, id: u64) -> Vec<u8> {
    let mut key = index_prefix(kind, source, value);
    key.extend_from_slice(&id.to_be_bytes());
    key
}

pub(super) fn ids_under(read: &dyn KvRead, prefix: &[u8], into: &mut BTreeSet<u64>) -> Result<()> {
    scan_prefix(read, prefix, false, &mut |k, _| {
        if let Some(tail) = k
            .get(prefix.len()..)
            .and_then(|t| <[u8; 8]>::try_from(t).ok())
        {
            into.insert(u64::from_be_bytes(tail));
        }
        true
    })
}

fn not_null(column: &str) -> StoreError {
    crate::takes::not_null(TABLE, column)
}

fn need(value: &Option<String>, column: &str) -> Result<String> {
    value.clone().ok_or_else(|| not_null(column))
}

impl Store {
    /// `readBeliefRedactions`: the source's suppressions on any of the subject keys or field
    /// hashes, each once, in id order.
    pub fn read_belief_redactions(&self, q: &RedactionQuery) -> Result<Vec<Suppression>> {
        let read = self.read()?;
        let mut ids = BTreeSet::new();
        for subject in &q.subject_keys {
            ids_under(
                &*read,
                &index_prefix(BY_SUBJECT, &q.source_id, subject),
                &mut ids,
            )?;
        }
        for hash in &q.field_hashes {
            ids_under(
                &*read,
                &index_prefix(BY_FIELD_HASH, &q.source_id, hash),
                &mut ids,
            )?;
        }
        let mut out = Vec::new();
        for id in ids {
            if let Some(r) = get_json::<RedactionRecord>(&*read, &record_key(id))? {
                out.push(Suppression {
                    id,
                    subject_key: r.subject_key,
                    field: r.field,
                    purge_request: r.purge_request,
                    field_hash: r.field_hash,
                    released_hash: r.released_hash,
                });
            }
        }
        Ok(out)
    }

    /// `insertBeliefRedaction`: one suppression; answers its id.
    pub fn insert_belief_redaction(&self, row: &RedactionInsert) -> Result<u64> {
        let purge_request = row
            .purge_request
            .as_deref()
            .map(canonical_uuid)
            .transpose()?;
        self.write(|tx| {
            let id = next_id(tx, TABLE)?;
            let rec = RedactionRecord {
                source_id: need(&row.source_id, "source_id")?,
                subject_key: need(&row.subject_key, "subject_key")?,
                field: need(&row.field, "field")?,
                purge_request: need(&purge_request, "purge_request")?,
                field_hash: need(&row.field_hash, "field_hash")?,
                released_by: None,
                released_hash: None,
                created_at_us: crate::env::transaction_clock::transaction_now()
                    .unwrap_or_else(|| self.env.now_micros()),
            };
            put_json(tx, &record_key(id), &rec)?;
            let subject = index_key(BY_SUBJECT, &rec.source_id, &rec.subject_key, id);
            tx.put(&subject, &[])?;
            let hash = index_key(BY_FIELD_HASH, &rec.source_id, &rec.field_hash, id);
            tx.put(&hash, &[])?;
            Ok(id)
        })
    }

    /// `releaseBeliefRedactions`: binds the listed suppressions (any source) to the publication
    /// and the hash of the value that replaced the redacted text.
    pub fn release_belief_redactions(&self, r: &RedactionRelease) -> Result<()> {
        let publication = canonical_uuid(&r.publication_id)?;
        self.write(|tx| {
            for id in r.ids.iter().filter_map(|&id| u64::try_from(id).ok()) {
                let key = record_key(id);
                if let Some(mut rec) = get_json::<RedactionRecord>(tx, &key)? {
                    rec.released_by = Some(publication.clone());
                    rec.released_hash = r.released_hash.clone();
                    put_json(tx, &key, &rec)?;
                }
            }
            Ok(())
        })
    }
}

/// A suppression's stored record (for the tests).
#[cfg(test)]
pub(crate) fn redaction(read: &dyn KvRead, id: u64) -> Result<Option<RedactionRecord>> {
    get_json(read, &record_key(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    const REQ: &str = "11111111-1111-1111-1111-111111111111";
    const PUB: &str = "22222222-2222-2222-2222-222222222222";

    fn insert(store: &Store, source: &str, subject: &str, hash: &str) -> u64 {
        store
            .insert_belief_redaction(&RedactionInsert {
                source_id: Some(source.into()),
                subject_key: Some(subject.into()),
                field: Some("value".into()),
                purge_request: Some(REQ.to_uppercase()),
                field_hash: Some(hash.into()),
            })
            .unwrap()
    }

    #[test]
    fn suppressions_read_by_subject_or_hash_once_and_release_across_sources() {
        let store = store();
        assert_eq!(insert(&store, "default", "s1", "h1"), 1);
        assert_eq!(insert(&store, "default", "s2", "h2"), 2);
        assert_eq!(insert(&store, "other", "s1", "h1"), 3);
        let q = |subjects: &[&str], hashes: &[&str]| RedactionQuery {
            source_id: "default".into(),
            subject_keys: subjects.iter().map(|s| s.to_string()).collect(),
            field_hashes: hashes.iter().map(|s| s.to_string()).collect(),
        };
        let ids = |rows: Vec<Suppression>| rows.into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(
            ids(store
                .read_belief_redactions(&q(&["s1"], &["h1", "h2"]))
                .unwrap()),
            vec![1, 2]
        );
        let first = &store.read_belief_redactions(&q(&["s1"], &[])).unwrap()[0];
        assert_eq!(first.purge_request, REQ);
        assert_eq!(first.released_hash, None);
        let release = RedactionRelease {
            ids: vec![1, 3, 77, -1],
            publication_id: PUB.into(),
            released_hash: Some("r".into()),
        };
        store.release_belief_redactions(&release).unwrap();
        let read = store.read().unwrap();
        let other = redaction(&*read, 3).unwrap().unwrap();
        assert_eq!(
            (other.released_by.as_deref(), other.released_hash.as_deref()),
            (Some(PUB), Some("r"))
        );
        assert_eq!(redaction(&*read, 2).unwrap().unwrap().released_by, None);
        drop(read);
        let bad = RedactionRelease {
            ids: vec![],
            publication_id: "x".into(),
            released_hash: None,
        };
        assert!(store.release_belief_redactions(&bad).is_err());
        let null = RedactionInsert {
            source_id: None,
            subject_key: None,
            field: None,
            purge_request: Some(REQ.into()),
            field_hash: None,
        };
        assert!(
            store
                .insert_belief_redaction(&null)
                .unwrap_err()
                .message
                .contains("\"source_id\"")
        );
    }
}
