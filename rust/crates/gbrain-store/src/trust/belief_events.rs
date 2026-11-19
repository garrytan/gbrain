//! The belief ledger's events and commit marks: `belief_events` and `belief_commit_marks`
//! (src/core/belief/schema.ts, engine-sql/belief-ledger.ts).
//!
//! Keys, all under `t 0x09` (the byte after it names the record kind) and `t 0x0b`:
//! - `t 0x09 0x00 source \0 incarnation \0 id` (id 8 bytes, big-endian) -> [`EventRecord`]: one
//!   event. The history read walks one source incarnation in id order.
//! - `t 0x09 0x01 event_key` (the key's raw bytes) -> the event's `0x00` key: the `UNIQUE` index.
//! - `t 0x09 0x02 publication_id` -> [`CommitMark`]: one `belief_commit_marks` row.
//! - `t 0x09 0x03 source \0 subject_kind \0 subject_key \0 id` -> the event's incarnation: the
//!   `belief_events_subject` index (the take holder and `derived.hidden` reads).
//! - `t 0x09 0x04 publication_id \0 id` -> the event's `recorded_at_us`: the
//!   `belief_events_publication` index, for the commit mark.
//! - `t 0x0b source \0 claim_fp \0 id` -> the event's incarnation: the `belief_events_claim_fp`
//!   index (the `later_private` read), for an event with a claim fingerprint.
//!
//! Ids come from the `belief_events` counter and start at 1. A row whose event key is already
//! recorded still takes an id, as the `BIGSERIAL` default does before `ON CONFLICT DO NOTHING`
//! decides. `recorded_at` is the store clock at each row (`clock_timestamp()`). The table has no
//! foreign key: deleting a source keeps its events, and a source created again has another
//! incarnation, so its reads never see them.

use super::belief_lifetimes::{canonical_uuid, cast_uuid};
use crate::env::parse_iso;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::next_id;
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const EVENTS: u8 = 0x09;
pub(crate) const CLAIMS: u8 = 0x0b;
const EVENT: u8 = 0x00;
const EVENT_KEY: u8 = 0x01;
const COMMIT_MARK: u8 = 0x02;
const SUBJECT: u8 = 0x03;
const PUBLICATION: u8 = 0x04;

const TABLE: &str = "belief_events";
const SUBJECT_KINDS: [&str; 6] = [
    "page",
    "fact",
    "take",
    "link",
    "link_transition",
    "coverage",
];
const ORIGINS: [&str; 5] = ["live", "unmanaged", "baseline", "backfill", "reconcile"];
const TIER_BASES: [&str; 3] = ["row", "writer", "unknown"];

/// One `BeliefEventInsertRow`. Every column is optional here so a null in a NOT NULL column
/// fails as the insert does, not as a decode error.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventInsert {
    pub event_key: Option<String>,
    pub source_id: Option<String>,
    pub source_incarnation: Option<String>,
    pub page_lifetime: Option<String>,
    pub slug: Option<String>,
    pub subject_kind: Option<String>,
    pub subject_key: Option<String>,
    pub event_type: Option<String>,
    pub origin: Option<String>,
    pub trust_tier: Option<String>,
    pub writer_tier: Option<String>,
    pub tier_basis: Option<String>,
    pub visibility: Option<String>,
    pub publication_id: Option<String>,
    pub ord: Option<i32>,
    pub source_time: Option<String>,
    pub valid_from: Option<String>,
    pub valid_until: Option<String>,
    pub value: Option<String>,
    pub value_hash: Option<String>,
    pub prior_hash: Option<String>,
    pub state_hash: Option<String>,
    pub cause: Option<String>,
    pub claim_fp: Option<String>,
    pub purged: Option<bool>,
    pub redacted_fields: Option<Vec<String>>,
}

/// What is stored for an event. Times are microseconds; `value` and `cause` are the parsed jsonb.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EventRecord {
    pub id: u64,
    pub event_key: String,
    pub source_id: String,
    pub source_incarnation: String,
    pub page_lifetime: Option<String>,
    pub slug: String,
    pub subject_kind: String,
    pub subject_key: String,
    pub event_type: String,
    pub origin: String,
    pub trust_tier: String,
    pub writer_tier: Option<String>,
    pub tier_basis: String,
    pub visibility: String,
    pub publication_id: String,
    pub ord: i32,
    pub recorded_at_us: i64,
    pub source_time_us: Option<i64>,
    pub valid_from_us: Option<i64>,
    pub valid_until_us: Option<i64>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub value: Option<Value>,
    pub value_hash: Option<String>,
    pub prior_hash: Option<String>,
    pub state_hash: String,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    pub cause: Value,
    pub claim_fp: Option<String>,
    pub purged: bool,
    pub redacted_fields: Option<Vec<String>>,
}

/// One `belief_commit_marks` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CommitMark {
    observed_at_us: i64,
}

/// `readBeliefTombstones`' arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TombstoneQuery {
    pub source_id: String,
    pub fact_fps: Vec<String>,
    pub take_fps: Vec<String>,
}

/// `readBeliefTombstones`' answer: the take fingerprints found, and whether the fact half was
/// left unread (fact fingerprints were asked and the source has a fact purge tombstone), which the
/// member refuses.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tombstones {
    pub fps: Vec<String>,
    pub fact_path_unread: bool,
}

fn part_key(head: &[u8], parts: &[&str], id: Option<u64>) -> Vec<u8> {
    let mut key = head.to_vec();
    for part in parts {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    if let Some(id) = id {
        key.extend_from_slice(&id.to_be_bytes());
    }
    key
}

fn event_key_of(source: &str, incarnation: &str, id: u64) -> Vec<u8> {
    part_key(
        &[keys::TRUST, EVENTS, EVENT],
        &[source, incarnation],
        Some(id),
    )
}

fn not_null(column: &str) -> StoreError {
    crate::takes::not_null(TABLE, column)
}

fn need<T: Clone>(value: &Option<T>, column: &str) -> Result<T> {
    value.clone().ok_or_else(|| not_null(column))
}

fn check(ok: bool, constraint: &str) -> Result<()> {
    if ok {
        return Ok(());
    }
    Err(StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("new row for relation \"{TABLE}\" violates check constraint \"{constraint}\""),
    ))
}

/// `decode(text, 'hex')`.
fn decode_hex(text: &str) -> Result<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return Err(StoreError::invalid(
            "invalid hexadecimal data: odd number of digits",
        ));
    }
    (0..text.len())
        .step_by(2)
        .map(|i| {
            text.get(i..i + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| StoreError::invalid("invalid hexadecimal digit"))
        })
        .collect()
}

fn cast_time(text: &Option<String>) -> Result<Option<i64>> {
    text.as_deref()
        .map(|t| {
            parse_iso(t).ok_or_else(|| {
                StoreError::invalid(format!(
                    "invalid input syntax for type timestamp with time zone: \"{t}\""
                ))
            })
        })
        .transpose()
}

fn cast_json(text: &Option<String>) -> Result<Option<Value>> {
    text.as_deref()
        .map(|t| {
            serde_json::from_str::<Value>(t)
                .map(crate::jsonb::order)
                .map_err(|_| StoreError::invalid("invalid input syntax for type json"))
        })
        .transpose()
}

/// A row after the SELECT's casts, before the insert's constraints.
#[derive(Clone)]
struct Cast {
    row: EventInsert,
    key: Option<Vec<u8>>,
    incarnation: Option<String>,
    lifetime: Option<String>,
    publication: Option<String>,
    times: [Option<i64>; 3],
    value: Option<Value>,
    cause: Option<Value>,
}

fn cast(row: &EventInsert) -> Result<Cast> {
    Ok(Cast {
        row: row.clone(),
        key: row.event_key.as_deref().map(decode_hex).transpose()?,
        incarnation: cast_uuid(&row.source_incarnation)?,
        lifetime: cast_uuid(&row.page_lifetime)?,
        publication: cast_uuid(&row.publication_id)?,
        times: [
            cast_time(&row.source_time)?,
            cast_time(&row.valid_from)?,
            cast_time(&row.valid_until)?,
        ],
        value: cast_json(&row.value)?,
        cause: cast_json(&row.cause)?,
    })
}

/// The row's constraints, in the order Postgres checks them: every NOT NULL, then the CHECKs.
fn record(c: Cast, id: u64, recorded_at_us: i64) -> Result<(Vec<u8>, EventRecord)> {
    let r = &c.row;
    let key = c.key.clone().ok_or_else(|| not_null("event_key"))?;
    let rec = EventRecord {
        id,
        event_key: r.event_key.clone().unwrap_or_default().to_lowercase(),
        source_id: need(&r.source_id, "source_id")?,
        source_incarnation: need(&c.incarnation, "source_incarnation")?,
        page_lifetime: c.lifetime,
        slug: need(&r.slug, "slug")?,
        subject_kind: need(&r.subject_kind, "subject_kind")?,
        subject_key: need(&r.subject_key, "subject_key")?,
        event_type: need(&r.event_type, "event_type")?,
        origin: need(&r.origin, "origin")?,
        trust_tier: need(&r.trust_tier, "trust_tier")?,
        writer_tier: r.writer_tier.clone(),
        tier_basis: need(&r.tier_basis, "tier_basis")?,
        visibility: need(&r.visibility, "visibility")?,
        publication_id: need(&c.publication, "publication_id")?,
        ord: need(&r.ord, "ord")?,
        recorded_at_us,
        source_time_us: c.times[0],
        valid_from_us: c.times[1],
        valid_until_us: c.times[2],
        value: c.value,
        value_hash: r.value_hash.clone(),
        prior_hash: r.prior_hash.clone(),
        state_hash: need(&r.state_hash, "state_hash")?,
        cause: need(&c.cause, "cause")?,
        claim_fp: r.claim_fp.clone(),
        purged: need(&r.purged, "purged")?,
        redacted_fields: r.redacted_fields.clone(),
    };
    check(
        SUBJECT_KINDS.contains(&rec.subject_kind.as_str()),
        "belief_events_subject_kind_check",
    )?;
    check(
        ORIGINS.contains(&rec.origin.as_str()),
        "belief_events_origin_check",
    )?;
    check(
        TIER_BASES.contains(&rec.tier_basis.as_str()),
        "belief_events_tier_basis_check",
    )?;
    Ok((key, rec))
}

fn store_event(tx: &mut dyn KvWrite, unique: &[u8], rec: &EventRecord) -> Result<()> {
    let primary = event_key_of(&rec.source_id, &rec.source_incarnation, rec.id);
    put_json(tx, &primary, rec)?;
    let mut by_key = vec![keys::TRUST, EVENTS, EVENT_KEY];
    by_key.extend_from_slice(unique);
    tx.put(&by_key, &primary)?;
    let incarnation = rec.source_incarnation.as_bytes();
    let subject = [&rec.source_id, &rec.subject_kind, &rec.subject_key].map(String::as_str);
    tx.put(
        &part_key(&[keys::TRUST, EVENTS, SUBJECT], &subject, Some(rec.id)),
        incarnation,
    )?;
    put_json(
        tx,
        &part_key(
            &[keys::TRUST, EVENTS, PUBLICATION],
            &[&rec.publication_id],
            Some(rec.id),
        ),
        &rec.recorded_at_us,
    )?;
    if let Some(fp) = &rec.claim_fp {
        tx.put(
            &part_key(&[keys::TRUST, CLAIMS], &[&rec.source_id, fp], Some(rec.id)),
            incarnation,
        )?;
    }
    Ok(())
}

impl Store {
    /// `insertBeliefEvents`: casts every row, then inserts them in `ord` order (ties in the given
    /// order), skipping a row whose event key is recorded, an earlier row of the call included.
    /// Answers how many were inserted.
    pub fn insert_belief_events(&self, rows: &[EventInsert]) -> Result<u64> {
        let mut cast_rows = rows.iter().map(cast).collect::<Result<Vec<_>>>()?;
        // `ORDER BY r.ord`: a null ord sorts last (and then fails NOT NULL).
        cast_rows.sort_by_key(|c| (c.row.ord.is_none(), c.row.ord));
        self.write(|tx| {
            let mut inserted = 0;
            for c in cast_rows.iter().cloned() {
                let id = next_id(tx, TABLE)?;
                let (unique, rec) = record(c, id, self.env.now_micros())?;
                let mut by_key = vec![keys::TRUST, EVENTS, EVENT_KEY];
                by_key.extend_from_slice(&unique);
                if tx.get(&by_key)?.is_some() {
                    continue;
                }
                store_event(tx, &unique, &rec)?;
                inserted += 1;
            }
            Ok(inserted)
        })
    }

    /// `markBeliefCommits`: one clock reading for the call; each listed publication with an event
    /// whose newest `recorded_at` is not after it gets a mark, unless it has one.
    pub fn mark_belief_commits(&self, publication_ids: &[String]) -> Result<()> {
        let ids = publication_ids
            .iter()
            .map(|p| canonical_uuid(p))
            .collect::<Result<BTreeSet<_>>>()?;
        self.write(|tx| {
            let at = self.env.now_micros();
            for publication in &ids {
                let mut newest: Option<i64> = None;
                let prefix = part_key(&[keys::TRUST, EVENTS, PUBLICATION], &[publication], None);
                let mut failure = None;
                scan_prefix(tx, &prefix, false, &mut |_, v| {
                    match serde_json::from_slice::<i64>(v) {
                        Ok(t) => newest = Some(newest.map_or(t, |n| n.max(t))),
                        Err(e) => failure = Some(StoreError::from(e)),
                    }
                    failure.is_none()
                })?;
                if let Some(e) = failure {
                    return Err(e);
                }
                let mark = part_key(&[keys::TRUST, EVENTS, COMMIT_MARK], &[publication], None);
                if newest.is_some_and(|n| n <= at) && tx.get(&mark)?.is_none() {
                    put_json(tx, &mark, &CommitMark { observed_at_us: at })?;
                }
            }
            Ok(())
        })
    }

    /// `readBeliefTombstones`: the take fingerprints among `takeFps` that a take purge tombstone
    /// of the source names (any subject), each once. The fact half is answered only when no fact
    /// fingerprint is asked or the source has no fact purge tombstone; otherwise
    /// `fact_path_unread` is set (rust/docs/store/trust.md).
    pub fn read_belief_tombstones(&self, q: &TombstoneQuery) -> Result<Tombstones> {
        let read = self.read()?;
        let fact_path_unread = !q.fact_fps.is_empty()
            && crate::facts::purge_ledger::has_fact_purges(&*read, &q.source_id)?;
        let fps = crate::facts::take_purges::tombstoned_hashes(&*read, &q.source_id, &q.take_fps)?;
        Ok(Tombstones {
            fps: fps.into_iter().collect(),
            fact_path_unread,
        })
    }
}

/// The events of one source incarnation in id order (for the history read and the tests).
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "readBeliefHistoryRows reads it in push 3")
)]
pub(crate) fn source_events(
    read: &dyn KvRead,
    source: &str,
    incarnation: &str,
) -> Result<BTreeMap<u64, EventRecord>> {
    let mut out = BTreeMap::new();
    let mut failure = None;
    let prefix = part_key(&[keys::TRUST, EVENTS, EVENT], &[source, incarnation], None);
    scan_prefix(read, &prefix, false, &mut |_, v| {
        match serde_json::from_slice::<EventRecord>(v) {
            Ok(r) => {
                out.insert(r.id, r);
            }
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// Whether the publication has a commit mark (for the tests).
#[cfg(test)]
pub(crate) fn commit_mark_at(read: &dyn KvRead, publication: &str) -> Result<Option<i64>> {
    let key = part_key(&[keys::TRUST, EVENTS, COMMIT_MARK], &[publication], None);
    Ok(crate::get_json::<CommitMark>(read, &key)?.map(|m| m.observed_at_us))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;
    use serde_json::json;

    const INC: &str = "11111111-1111-1111-1111-111111111111";
    const PUB: &str = "22222222-2222-2222-2222-222222222222";

    fn row(key: &str, ord: i32, extra: Value) -> EventInsert {
        let mut base = json!({
            "event_key": key, "source_id": "default", "source_incarnation": INC.to_uppercase(),
            "page_lifetime": null, "slug": "people/a", "subject_kind": "take", "subject_key": "k",
            "event_type": "asserted", "origin": "live", "trust_tier": "owner", "writer_tier": null,
            "tier_basis": "row", "visibility": "world", "publication_id": PUB, "ord": ord,
            "source_time": null, "valid_from": "2026-01-02T03:04:05.000006Z", "valid_until": null,
            "value": "{\"bb\":1,\"a\":2}", "value_hash": "v", "prior_hash": null, "state_hash": "s",
            "cause": "{}", "claim_fp": "fp1", "purged": false, "redacted_fields": ["f"],
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn events_insert_in_ord_order_skip_a_recorded_key_and_check_their_columns() {
        let store = store();
        let rows = [
            row("0b", 2, json!({})),
            row("0a", 1, json!({})),
            row("0A", 3, json!({})),
        ];
        assert_eq!(store.insert_belief_events(&rows).unwrap(), 2);
        assert_eq!(
            store
                .insert_belief_events(&[row("0b", 4, json!({}))])
                .unwrap(),
            0
        );
        let read = store.read().unwrap();
        let events = source_events(&*read, "default", INC).unwrap();
        let got: Vec<(u64, &str, i32)> = events
            .values()
            .map(|e| (e.id, e.event_key.as_str(), e.ord))
            .collect();
        // Ids are taken by skipped rows too (id 3 for the in-call duplicate, 4 for the re-sent key).
        assert_eq!(got, vec![(1, "0a", 1), (2, "0b", 2)]);
        let first = &events[&1];
        assert_eq!(
            serde_json::to_string(&first.value).unwrap(),
            r#"{"a":2,"bb":1}"#
        );
        assert_eq!(
            first.valid_from_us,
            parse_iso("2026-01-02T03:04:05.000006Z")
        );
        drop(read);
        let code = |extra: Value| {
            let e = store
                .insert_belief_events(&[row("ff", 1, extra)])
                .unwrap_err();
            (e.code, e.message)
        };
        assert!(
            code(json!({"origin": "nope"}))
                .1
                .contains("belief_events_origin_check")
        );
        assert!(
            code(json!({"subject_kind": "x"}))
                .1
                .contains("subject_kind_check")
        );
        assert!(
            code(json!({"tier_basis": "x"}))
                .1
                .contains("tier_basis_check")
        );
        assert!(code(json!({"origin": null})).1.contains("\"origin\""));
        assert!(
            code(json!({"cause": null, "origin": "x"}))
                .1
                .contains("\"cause\"")
        );
        assert!(
            code(json!({"source_incarnation": "x"}))
                .1
                .contains("type uuid")
        );
        assert!(code(json!({"event_key": "f"})).1.contains("hexadecimal"));
        let read = store.read().unwrap();
        assert_eq!(source_events(&*read, "default", INC).unwrap().len(), 2);
    }

    #[test]
    fn a_commit_mark_is_written_once_for_a_publication_with_events() {
        let store = store();
        let other = "33333333-3333-3333-3333-333333333333".to_string();
        store.mark_belief_commits(&[PUB.into()]).unwrap();
        assert_eq!(commit_mark_at(&*store.read().unwrap(), PUB).unwrap(), None);
        store
            .insert_belief_events(&[row("01", 1, json!({}))])
            .unwrap();
        store
            .mark_belief_commits(&[PUB.to_uppercase(), other.clone()])
            .unwrap();
        let first = commit_mark_at(&*store.read().unwrap(), PUB)
            .unwrap()
            .unwrap();
        let read = store.read().unwrap();
        let recorded = source_events(&*read, "default", INC).unwrap()[&1].recorded_at_us;
        assert!(first >= recorded);
        assert_eq!(commit_mark_at(&*read, &other).unwrap(), None);
        drop(read);
        store.mark_belief_commits(&[PUB.into()]).unwrap();
        assert_eq!(
            commit_mark_at(&*store.read().unwrap(), PUB).unwrap(),
            Some(first)
        );
        assert!(store.mark_belief_commits(&["nope".into()]).is_err());
    }

    #[test]
    fn tombstones_answer_take_fingerprints_and_flag_an_unread_fact_half() {
        use crate::facts::take_purges::TakePurgeInsert;
        let store = store();
        let purge = TakePurgeInsert {
            source_id: "default".into(),
            subject: "*".into(),
            claim_hash: "tp1".into(),
            request_id: None,
        };
        store.insert_take_purge(&purge).unwrap();
        let q = |facts: &[&str]| TombstoneQuery {
            source_id: "default".into(),
            fact_fps: facts.iter().map(|s| s.to_string()).collect(),
            take_fps: vec!["tp1".into(), "tp2".into(), "tp1".into()],
        };
        let want = Tombstones {
            fps: vec!["tp1".into()],
            fact_path_unread: false,
        };
        assert_eq!(store.read_belief_tombstones(&q(&[])).unwrap(), want);
        // No fact purge tombstone: the fact half is empty, so it is answered.
        assert_eq!(store.read_belief_tombstones(&q(&["ff1"])).unwrap(), want);
        let fact = crate::facts::purge_ledger::FactPurgeInsert {
            source_id: "default".into(),
            visibility: "world".into(),
            subject: "*".into(),
            fact_hash: "ff1".into(),
            request_id: None,
            actor: None,
            reason: None,
        };
        store.insert_fact_purge(&fact).unwrap();
        let unread = Tombstones {
            fact_path_unread: true,
            ..want.clone()
        };
        assert_eq!(store.read_belief_tombstones(&q(&["ff1"])).unwrap(), unread);
        assert_eq!(store.read_belief_tombstones(&q(&[])).unwrap(), want);
    }
}
