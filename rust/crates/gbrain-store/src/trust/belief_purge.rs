//! The belief side of a purge (src/core/belief/purge.ts, facts/purge.ts, persistence/page-purge.ts,
//! engine-sql/belief-purge.ts): the source purge epoch, the ledger presence probe and the purge's
//! own suppression writes.
//!
//! - `bumpSourcePurgeEpoch` raises `sources.purge_epoch` by one and answers the new value, `None`
//!   for an unknown source (the `UPDATE ... RETURNING` finds no row).
//! - `hasBeliefEvents` answers whether any belief event of the source exists, of any incarnation:
//!   the first key under `t 0x09 0x00 source \0`.
//! - `registerPurgeRedaction` adds a suppression to `belief_redactions` (the keys of
//!   [`super::belief_redactions`]) unless one with the same source, subject, field, purge request
//!   and field hash exists (`INSERT ... SELECT ... WHERE NOT EXISTS`).
//! - `releasePurgeRedactionsForField` binds each suppression of one field of one subject to the
//!   releasing publication and hash, skipping one already released to that hash and one whose
//!   redacted text has that hash; it answers the purge request of each released row.
//!
//! The restore replay's tombstones (`replayPagePurges`) live with the page purge ledger
//! (facts/page_purges.rs); its schema probes (`readPurgeReplaySchema`) have no store call, since
//! the store always has the live schema.

use super::belief_events::{EVENT, EVENTS, part_key};
use super::belief_lifetimes::canonical_uuid;
use super::belief_redactions::{
    BY_FIELD_HASH, BY_SUBJECT, RedactionRecord, TABLE, ids_under, index_key, index_prefix,
    record_key,
};
use crate::error::Result;
use crate::kv::scan_prefix;
use crate::pages::next_id;
use crate::sources::{read_source, source_key};
use crate::{Store, get_json, keys, put_json};
use serde::Deserialize;
use std::collections::BTreeSet;

/// `registerPurgeRedaction`'s argument.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PurgeRedactionInsert {
    pub source_id: String,
    pub subject_key: String,
    pub field: String,
    pub purge_request: String,
    pub field_hash: String,
}

/// `releasePurgeRedactionsForField`'s argument.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PurgeRedactionRelease {
    pub source_id: String,
    pub subject_key: String,
    pub field: String,
    pub released_by: String,
    pub released_hash: String,
}

impl Store {
    /// `bumpSourcePurgeEpoch`: the source's purge epoch plus one, stored; `None` for an unknown
    /// source.
    pub fn bump_source_purge_epoch(&self, source_id: &str) -> Result<Option<i64>> {
        self.write(|tx| {
            let Some(mut source) = read_source(tx, source_id)? else {
                return Ok(None);
            };
            source.purge_epoch += 1;
            put_json(tx, &source_key(source_id), &source)?;
            Ok(Some(source.purge_epoch))
        })
    }

    /// `hasBeliefEvents`: whether the source has any belief event.
    pub fn has_belief_events(&self, source_id: &str) -> Result<bool> {
        let read = self.read()?;
        let prefix = part_key(&[keys::TRUST, EVENTS, EVENT], &[source_id], None);
        let mut found = false;
        scan_prefix(&*read, &prefix, false, &mut |_, _| {
            found = true;
            false
        })?;
        Ok(found)
    }

    /// `registerPurgeRedaction`: one suppression, unless the same one is recorded.
    pub fn register_purge_redaction(&self, row: &PurgeRedactionInsert) -> Result<()> {
        let purge_request = canonical_uuid(&row.purge_request)?;
        self.write(|tx| {
            let mut ids = BTreeSet::new();
            ids_under(
                tx,
                &index_prefix(BY_SUBJECT, &row.source_id, &row.subject_key),
                &mut ids,
            )?;
            for id in ids {
                if let Some(r) = get_json::<RedactionRecord>(tx, &record_key(id))?
                    && r.field == row.field
                    && r.purge_request == purge_request
                    && r.field_hash == row.field_hash
                {
                    return Ok(());
                }
            }
            let id = next_id(tx, TABLE)?;
            let rec = RedactionRecord {
                source_id: row.source_id.clone(),
                subject_key: row.subject_key.clone(),
                field: row.field.clone(),
                purge_request: purge_request.clone(),
                field_hash: row.field_hash.clone(),
                released_by: None,
                released_hash: None,
                created_at_us: crate::env::transaction_clock::transaction_now()
                    .unwrap_or_else(|| self.env.now_micros()),
            };
            put_json(tx, &record_key(id), &rec)?;
            tx.put(
                &index_key(BY_SUBJECT, &rec.source_id, &rec.subject_key, id),
                &[],
            )?;
            tx.put(
                &index_key(BY_FIELD_HASH, &rec.source_id, &rec.field_hash, id),
                &[],
            )?;
            Ok(())
        })
    }

    /// `releasePurgeRedactionsForField`: releases the field's suppressions on the subject to
    /// `released_hash`; answers each released row's purge request, in id order.
    pub fn release_purge_redactions_for_field(
        &self,
        row: &PurgeRedactionRelease,
    ) -> Result<Vec<String>> {
        let released_by = canonical_uuid(&row.released_by)?;
        self.write(|tx| {
            let mut ids = BTreeSet::new();
            ids_under(
                tx,
                &index_prefix(BY_SUBJECT, &row.source_id, &row.subject_key),
                &mut ids,
            )?;
            let mut out = Vec::new();
            for id in ids {
                let key = record_key(id);
                let Some(mut rec) = get_json::<RedactionRecord>(tx, &key)? else {
                    continue;
                };
                if rec.field != row.field
                    || rec.released_hash.as_deref() == Some(row.released_hash.as_str())
                    || rec.field_hash == row.released_hash
                {
                    continue;
                }
                rec.released_by = Some(released_by.clone());
                rec.released_hash = Some(row.released_hash.clone());
                put_json(tx, &key, &rec)?;
                out.push(rec.purge_request);
            }
            Ok(out)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    const REQ: &str = "11111111-1111-1111-1111-111111111111";
    const REQ2: &str = "33333333-3333-3333-3333-333333333333";
    const PUB: &str = "22222222-2222-2222-2222-222222222222";

    fn register(store: &Store, subject: &str, field: &str, request: &str, hash: &str) {
        store
            .register_purge_redaction(&PurgeRedactionInsert {
                source_id: "default".into(),
                subject_key: subject.into(),
                field: field.into(),
                purge_request: request.to_uppercase(),
                field_hash: hash.into(),
            })
            .unwrap();
    }

    fn release(store: &Store, hash: &str) -> Vec<String> {
        store
            .release_purge_redactions_for_field(&PurgeRedactionRelease {
                source_id: "default".into(),
                subject_key: "s1".into(),
                field: "value".into(),
                released_by: PUB.into(),
                released_hash: hash.into(),
            })
            .unwrap()
    }

    #[test]
    fn the_epoch_rises_by_one_and_an_unknown_source_answers_none() {
        let store = store();
        assert_eq!(store.bump_source_purge_epoch("default").unwrap(), Some(1));
        assert_eq!(store.bump_source_purge_epoch("default").unwrap(), Some(2));
        assert_eq!(store.read_source_purge_epoch("default").unwrap(), Some(2));
        assert_eq!(store.bump_source_purge_epoch("missing").unwrap(), None);
        assert!(!store.has_belief_events("default").unwrap());
    }

    #[test]
    fn a_suppression_is_recorded_once_and_a_release_skips_its_own_hash() {
        let store = store();
        register(&store, "s1", "value", REQ, "h-old");
        register(&store, "s1", "value", REQ, "h-old");
        register(&store, "s1", "value", REQ2, "h-new");
        register(&store, "s1", "context", REQ, "h-ctx");
        let read = store.read().unwrap();
        let mut ids = BTreeSet::new();
        ids_under(&*read, &index_prefix(BY_SUBJECT, "default", "s1"), &mut ids).unwrap();
        drop(read);
        assert_eq!(ids.len(), 3);
        assert_eq!(release(&store, "h-new"), [REQ]);
        assert!(release(&store, "h-new").is_empty());
        assert_eq!(release(&store, "h-later"), [REQ, REQ2]);
    }
}
