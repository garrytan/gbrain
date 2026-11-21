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
//! - `listBeliefEventsForPurgeProbe` answers the next 1000 events of the source after an id that
//!   have a recorded value, in id order, across every incarnation (the purge receipt's
//!   `belief_events` report reads them). Each incarnation's events are one id-ordered key range
//!   under `t 0x09 0x00 source \0 incarnation \0`, so the read seeks each range to the id after
//!   the cursor, takes at most 1000 from it, and keeps the 1000 lowest ids of all of them.
//!
//! The restore replay's tombstones (`replayPagePurges`) live with the page purge ledger
//! (facts/page_purges.rs); its schema probes (`readPurgeReplaySchema`) have no store call, since
//! the store always has the live schema.

use super::belief_events::{EVENT, EVENTS, EventRecord, part_key};
use super::belief_history::id_range;
use super::belief_lifetimes::canonical_uuid;
use super::belief_redactions::{
    BY_FIELD_HASH, BY_SUBJECT, RedactionRecord, TABLE, ids_under, index_key, index_prefix,
    record_key,
};
use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::kv::{prefix_end, scan_prefix};
use crate::pages::next_id;
use crate::sources::{read_source, source_key};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

/// How many events one `listBeliefEventsForPurgeProbe` page answers (`LIMIT 1000`).
pub const PURGE_PROBE_PAGE: usize = 1000;

/// One `listBeliefEventsForPurgeProbe` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PurgeProbeEvent {
    pub id: u64,
    pub subject_kind: String,
    pub subject_key: String,
    pub value: Value,
}

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

    /// `listBeliefEventsForPurgeProbe`: the next [`PURGE_PROBE_PAGE`] events of the source with
    /// `id > after` and a recorded value, in id order (`WHERE source_id = $1 AND id > $2 AND value
    /// IS NOT NULL ORDER BY id LIMIT 1000`). A NaN `after` compares greater than every id.
    pub fn list_belief_events_for_purge_probe(
        &self,
        source_id: &str,
        after: f64,
    ) -> Result<Vec<PurgeProbeEvent>> {
        // The first id `id > after` admits; None when no id can.
        let from = if after.is_nan() || after >= u64::MAX as f64 {
            return Ok(Vec::new());
        } else if after < 0.0 {
            0
        } else {
            after.floor() as u64 + 1
        };
        let read = self.read()?;
        let source = part_key(&[keys::TRUST, EVENTS, EVENT], &[source_id], None);
        let source_end = prefix_end(&source).ok_or_else(corrupt_event_key)?;
        let mut out: Vec<PurgeProbeEvent> = Vec::new();
        let mut cursor = source.clone();
        loop {
            // The next incarnation: the first event key at or after the cursor.
            let mut next = None;
            read.scan(&cursor, &source_end, false, &mut |k, _| {
                next = Some(k.to_vec());
                false
            })?;
            let Some(key) = next else { break };
            let nul = key[source.len()..]
                .iter()
                .position(|b| *b == 0)
                .ok_or_else(corrupt_event_key)?;
            let incarnation = key[..source.len() + nul + 1].to_vec();
            let (start, end) = id_range(&incarnation, from, None);
            let (mut taken, mut failure) = (0usize, None);
            read.scan(&start, &end, false, &mut |_, v| {
                match serde_json::from_slice::<EventRecord>(v) {
                    Ok(e) => {
                        if let Some(value) = e.value {
                            out.push(PurgeProbeEvent {
                                id: e.id,
                                subject_kind: e.subject_kind,
                                subject_key: e.subject_key,
                                value,
                            });
                            taken += 1;
                        }
                    }
                    Err(e) => failure = Some(StoreError::from(e)),
                }
                failure.is_none() && taken < PURGE_PROBE_PAGE
            })?;
            if let Some(e) = failure {
                return Err(e);
            }
            match prefix_end(&incarnation) {
                Some(after_incarnation) => cursor = after_incarnation,
                None => break,
            }
        }
        out.sort_by_key(|e| e.id);
        out.truncate(PURGE_PROBE_PAGE);
        Ok(out)
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

/// An event key under the source prefix with no incarnation terminator.
fn corrupt_event_key() -> StoreError {
    StoreError::new(
        STORE_CORRUPT,
        "belief_events: an event key has no incarnation terminator",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;
    use crate::trust::belief_events::EventInsert;

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

    /// One event of `source` in `incarnation`; `value` is the jsonb text, None for SQL NULL.
    fn event(n: usize, source: &str, incarnation: &str, value: Option<&str>) -> EventInsert {
        serde_json::from_value(serde_json::json!({
            "event_key": format!("{n:04x}"), "source_id": source, "source_incarnation": incarnation,
            "page_lifetime": null, "slug": "people/a", "subject_kind": "fact", "subject_key": format!("k{n}"),
            "event_type": "asserted", "origin": "live", "trust_tier": "owner", "writer_tier": null,
            "tier_basis": "row", "visibility": "world", "publication_id": PUB, "ord": 1,
            "source_time": null, "valid_from": null, "valid_until": null, "value": value,
            "value_hash": null, "prior_hash": null, "state_hash": "s", "cause": "{}", "claim_fp": null,
            "purged": false, "redacted_fields": null,
        }))
        .unwrap()
    }

    #[test]
    fn purge_probe_reads_every_incarnation_in_id_order_after_the_cursor() {
        let store = store();
        // Ids 1..=6, one call each: incarnations interleave, one value is NULL, one event is
        // another source's (and "defaul" is a byte prefix of "default", not the same source).
        let rows = [
            event(1, "default", REQ, Some(r#"{"fact":"one"}"#)),
            event(2, "default", REQ2, Some(r#"{"fact":"two"}"#)),
            event(3, "default", REQ, None),
            event(4, "defaul", REQ, Some(r#"{"fact":"elsewhere"}"#)),
            event(5, "default", REQ2, Some(r#"{"fact":"five"}"#)),
            event(6, "default", REQ, Some(r#"{"fact":"six"}"#)),
        ];
        for row in &rows {
            store
                .insert_belief_events(std::slice::from_ref(row))
                .unwrap();
        }
        let ids = |after: f64| -> Vec<u64> {
            store
                .list_belief_events_for_purge_probe("default", after)
                .unwrap()
                .iter()
                .map(|e| e.id)
                .collect()
        };
        assert_eq!(ids(0.0), [1, 2, 5, 6]);
        assert_eq!(ids(2.0), [5, 6]);
        assert_eq!(ids(2.5), [5, 6]);
        assert_eq!(ids(-7.0), [1, 2, 5, 6]);
        assert_eq!(ids(6.0), Vec::<u64>::new());
        assert_eq!(ids(f64::NAN), Vec::<u64>::new());
        let first = &store
            .list_belief_events_for_purge_probe("default", 0.0)
            .unwrap()[0];
        assert_eq!(
            (
                first.subject_kind.as_str(),
                first.subject_key.as_str(),
                &first.value
            ),
            ("fact", "k1", &serde_json::json!({"fact": "one"}))
        );
        assert_eq!(
            store
                .list_belief_events_for_purge_probe("defaul", 0.0)
                .unwrap()
                .len(),
            1
        );
        assert!(
            store
                .list_belief_events_for_purge_probe("nobody", 0.0)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn purge_probe_pages_are_1000_lowest_ids_across_incarnations() {
        let store = store();
        // 1500 events alternate between two incarnations: ids 1..=1500.
        let rows: Vec<EventInsert> = (0..1500)
            .map(|n| {
                event(
                    n,
                    "default",
                    if n % 2 == 0 { REQ } else { REQ2 },
                    Some("{}"),
                )
            })
            .collect();
        store.insert_belief_events(&rows).unwrap();
        let page = store
            .list_belief_events_for_purge_probe("default", 0.0)
            .unwrap();
        assert_eq!(page.len(), PURGE_PROBE_PAGE);
        assert!(page.iter().map(|e| e.id).eq(1..=1000));
        let rest = store
            .list_belief_events_for_purge_probe("default", 1000.0)
            .unwrap();
        assert!(rest.iter().map(|e| e.id).eq(1001..=1500));
    }
}
