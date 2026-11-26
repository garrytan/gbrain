//! The belief ledger's reads: the history page (`readBeliefHistoryRows`) and the visible page
//! lifetimes (`listVisibleBeliefLifetimes`) of src/core/engine-sql/trust-tier-reads.ts, and the
//! source probes `readLedgerSource` and `listCoveredSources` of engine-sql/belief.ts.
//!
//! They read the keys of belief_events.rs and belief_lifetimes.rs. The history read walks the
//! `0x00` keys of the source's current incarnation by id between the cursors, in batches, and
//! stops at the limit. Each row's visibility facts come from the indexes:
//! - `stream_visible`: the open lifetime and its live page (same source and slug, the page id when
//!   the lifetime has one) under the remote read floor ([`PrivacyPolicy`]), and for a fact or take
//!   the page not quarantined; null when there is no such page.
//! - `later_private`: the claim index, a later private event of the same claim and subject kind.
//! - `take_holder`: the event's `value->>'holder'`, else the newest earlier take event of the same
//!   subject that names one (the subject index).
//! - the `derived.hidden` test: the subject index under every incarnation of the source.
//!
//! Text order is byte order, as PGLite's `C` collation gives it.

use super::belief_events::{CLAIMS, EVENT, EVENTS, EventRecord, SUBJECT, event_key_of, part_key};
use super::belief_lifetimes::{LifetimeRecord, canonical_uuid, record_key};
use crate::cli_reads::entities::arrow_text;
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::facts::purge_ledger::has_fact_purges;
use crate::facts::take_purges::has_take_purges;
use crate::facts::{OwnerOnlySources, PrivacyPolicy, has_page_purges, page_hidden_with};
use crate::kv::{KvRead, prefix_end, scan_prefix};
use crate::links::no_nul;
use crate::pages::{PageRecord, read_page};
use crate::sources::{all_sources, read_source};
use crate::{Store, get_json, keys};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};

/// The frontmatter key that hides a fact or take stream (`quarantineFilterFragment`).
const QUARANTINE_KEY: &str = "quarantine";
/// The event type that hides the earlier events of its subject.
const HIDDEN: &str = "derived.hidden";
/// `COVERAGE_KEY` (src/core/belief/keys.ts).
pub(super) const COVERAGE_KEY: &str = "[\"coverage\"]";
/// How many candidate events the history read takes per scan.
const BATCH: usize = 256;

/// `readBeliefHistoryRows`' query (`BeliefHistoryRowQuery`) and the floor the member read.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HistoryQuery {
    pub source_id: String,
    pub slug: Option<String>,
    pub subject_key: Option<String>,
    pub after_id: i64,
    pub limit: i64,
    pub recorded_after: Option<String>,
    pub recorded_until: Option<String>,
    pub subject_keys: Option<Vec<String>>,
    pub before_id: Option<i64>,
    pub descending: bool,
    /// The remote read floor over `p` (`remoteReadFloorSql`).
    pub floor: PrivacyPolicy,
}

/// `listVisibleBeliefLifetimes`' arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VisibleLifetimesQuery {
    pub lifetimes: Vec<String>,
    /// The remote read floor over `p` (`remoteReadFloorSql`).
    pub floor: PrivacyPolicy,
}

/// `readLedgerSource`'s answer without the batch fields, which the member adds.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSource {
    pub incarnation: String,
    pub purge_epoch: i64,
    pub coverage: Option<String>,
    pub purges_possible: bool,
}

fn corrupt(op: &str) -> StoreError {
    StoreError::invalid(format!("{op}: a belief event index names no event"))
}

fn timestamptz(text: &Option<String>) -> Result<Option<i64>> {
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

/// `prefix` and the id range `[from, to)` after it.
pub(super) fn id_range(prefix: &[u8], from: u64, to: Option<u64>) -> (Vec<u8>, Vec<u8>) {
    let at = |id: u64| [prefix, &id.to_be_bytes()[..]].concat();
    let end = match to {
        Some(to) => at(to),
        None => prefix_end(prefix).unwrap_or_else(|| at(u64::MAX)),
    };
    (at(from), end)
}

/// The id at the end of an index key.
fn key_id(key: &[u8]) -> Option<u64> {
    let tail: [u8; 8] = key.get(key.len().checked_sub(8)?..)?.try_into().ok()?;
    Some(u64::from_be_bytes(tail))
}

/// The `(incarnation, id)` of every entry of an index range, read before any event is loaded.
pub(super) fn index_entries(
    read: &dyn KvRead,
    (start, end): (Vec<u8>, Vec<u8>),
    reverse: bool,
) -> Result<Vec<(String, u64)>> {
    let mut out = Vec::new();
    read.scan(&start, &end, reverse, &mut |k, v| {
        if let Some(id) = key_id(k) {
            out.push((String::from_utf8_lossy(v).into_owned(), id));
        }
        true
    })?;
    Ok(out)
}

pub(super) fn load_event(
    read: &dyn KvRead,
    op: &str,
    source: &str,
    inc: &str,
    id: u64,
) -> Result<EventRecord> {
    get_json::<EventRecord>(read, &event_key_of(source, inc, id))?.ok_or_else(|| corrupt(op))
}

pub(super) fn subject_prefix(source: &str, kind: &str, key: &str) -> Vec<u8> {
    part_key(&[keys::TRUST, EVENTS, SUBJECT], &[source, kind, key], None)
}

/// `value->>'holder'`.
fn holder(value: &Option<Value>) -> Option<String> {
    value
        .as_ref()?
        .as_object()?
        .get("holder")
        .and_then(arrow_text)
}

/// The live page of an open lifetime: same source and slug, not soft-deleted, and the lifetime's
/// page id when it has one.
fn live_page(read: &dyn KvRead, lifetime: &str) -> Result<Option<PageRecord>> {
    let Some(l) = get_json::<LifetimeRecord>(read, &record_key(lifetime))? else {
        return Ok(None);
    };
    if l.ended_at_us.is_some() {
        return Ok(None);
    }
    let page = read_page(read, &l.source_id, &l.slug)?.filter(|p| {
        p.deleted_at_us.is_none() && l.page_id.is_none_or(|id| u64::try_from(id) == Ok(p.id))
    });
    Ok(page)
}

/// Per-call caches for the history read's row facts.
struct RowFacts<'a> {
    read: &'a dyn KvRead,
    floor: &'a PrivacyPolicy,
    owner_only: OwnerOnlySources,
    /// The open lifetime's page judged: `None` with no live page, else `(passes floor, quarantined)`.
    streams: HashMap<String, Option<(bool, bool)>>,
    /// The `derived.hidden` event ids of each `(subject_kind, subject_key)`, every incarnation.
    hidden: HashMap<(String, String), Vec<u64>>,
}

const OP: &str = "readBeliefHistoryRows";

impl RowFacts<'_> {
    fn stream_visible(&mut self, e: &EventRecord) -> Result<Option<bool>> {
        let Some(lifetime) = &e.page_lifetime else {
            return Ok(None);
        };
        if !self.streams.contains_key(lifetime) {
            let judged = match live_page(self.read, lifetime)? {
                Some(page) => Some((
                    !page_hidden_with(self.read, &page, self.floor, &self.owner_only)?,
                    page.frontmatter.contains_key(QUARANTINE_KEY),
                )),
                None => None,
            };
            self.streams.insert(lifetime.clone(), judged);
        }
        Ok(self.streams[lifetime].map(|(floor, quarantined)| {
            floor && (!matches!(e.subject_kind.as_str(), "fact" | "take") || !quarantined)
        }))
    }

    fn hidden_by_later(&mut self, e: &EventRecord) -> Result<bool> {
        let subject = (e.subject_kind.clone(), e.subject_key.clone());
        if !self.hidden.contains_key(&subject) {
            let prefix = subject_prefix(&e.source_id, &e.subject_kind, &e.subject_key);
            let mut ids = Vec::new();
            for (inc, id) in index_entries(self.read, id_range(&prefix, 0, None), false)? {
                if load_event(self.read, OP, &e.source_id, &inc, id)?.event_type == HIDDEN {
                    ids.push(id);
                }
            }
            self.hidden.insert(subject.clone(), ids);
        }
        Ok(self.hidden[&subject]
            .iter()
            .any(|&h| h != e.id && (h > e.id || e.origin == "backfill")))
    }

    fn later_private(&self, e: &EventRecord) -> Result<bool> {
        let Some(fp) = &e.claim_fp else {
            return Ok(false);
        };
        let prefix = part_key(&[keys::TRUST, CLAIMS], &[&e.source_id, fp], None);
        let range = id_range(&prefix, e.id.saturating_add(1), None);
        for (inc, id) in index_entries(self.read, range, false)? {
            if inc != e.source_incarnation {
                continue;
            }
            let v = load_event(self.read, OP, &e.source_id, &inc, id)?;
            if v.subject_kind == e.subject_kind && v.visibility == "private" {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn take_holder(&self, e: &EventRecord) -> Result<Option<String>> {
        if e.subject_kind != "take" {
            return Ok(None);
        }
        if let Some(h) = holder(&e.value) {
            return Ok(Some(h));
        }
        let prefix = subject_prefix(&e.source_id, "take", &e.subject_key);
        for (inc, id) in index_entries(self.read, id_range(&prefix, 0, Some(e.id)), true)? {
            if inc != e.source_incarnation {
                continue;
            }
            if let Some(h) = holder(&load_event(self.read, OP, &e.source_id, &inc, id)?.value) {
                return Ok(Some(h));
            }
        }
        Ok(None)
    }

    fn row(&mut self, e: EventRecord) -> Result<Value> {
        let stream_visible = self.stream_visible(&e)?;
        let later_private = self.later_private(&e)?;
        let take_holder = self.take_holder(&e)?;
        Ok(json!({
            "id": e.id,
            "slug": e.slug,
            "page_lifetime": e.page_lifetime,
            "subject_kind": e.subject_kind,
            "subject_key": e.subject_key,
            "event_type": e.event_type,
            "origin": e.origin,
            "trust_tier": e.trust_tier,
            "writer_tier": e.writer_tier,
            "tier_basis": e.tier_basis,
            "visibility": e.visibility,
            "recorded_at": iso(e.recorded_at_us),
            "source_time": e.source_time_us.map(iso),
            "value": e.value,
            "value_hash": e.value_hash,
            "prior_hash": e.prior_hash,
            "state_hash": e.state_hash,
            "cause": e.cause,
            "purged": e.purged,
            "redacted_fields": e.redacted_fields,
            "stream_visible": stream_visible,
            "later_private": later_private,
            "take_holder": take_holder,
        }))
    }
}

/// The history read's filters that need no other key.
fn admits(q: &HistoryQuery, after: Option<i64>, until: Option<i64>, e: &EventRecord) -> bool {
    q.slug.as_ref().is_none_or(|s| *s == e.slug)
        && q.subject_key.as_ref().is_none_or(|k| *k == e.subject_key)
        && after.is_none_or(|t| e.recorded_at_us > t)
        && until.is_none_or(|t| e.recorded_at_us <= t)
        && q.subject_keys
            .as_ref()
            .is_none_or(|ks| ks.contains(&e.subject_key))
}

impl Store {
    /// `readBeliefHistoryRows`: one page of the source's current-incarnation events by id (after
    /// `afterId`, before `beforeId`, under the slug, subject and recorded-time filters), less the
    /// events a `derived.hidden` event of their subject hides, each with its visibility facts
    /// (module doc). Nothing for an unknown source.
    pub fn read_belief_history_rows(&self, q: &HistoryQuery) -> Result<Vec<Value>> {
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        for (name, text) in [("slug", &q.slug), ("subjectKey", &q.subject_key)] {
            if let Some(t) = text {
                no_nul(OP, &[(name, t)])?;
            }
        }
        for k in q.subject_keys.iter().flatten() {
            no_nul(OP, &[("subjectKeys", k)])?;
        }
        if q.limit < 0 {
            return Err(StoreError::invalid("LIMIT must not be negative"));
        }
        let after = timestamptz(&q.recorded_after)?;
        let until = timestamptz(&q.recorded_until)?;
        let read = self.read()?;
        let Some(source) = read_source(&*read, &q.source_id)? else {
            return Ok(Vec::new());
        };
        let limit = usize::try_from(q.limit).unwrap_or(usize::MAX);
        let prefix = part_key(
            &[keys::TRUST, EVENTS, EVENT],
            &[&q.source_id, &source.incarnation],
            None,
        );
        let mut low = u64::try_from(q.after_id.max(0))
            .unwrap_or(0)
            .saturating_add(1);
        let mut high = match q.before_id {
            Some(b) if b <= 1 => return Ok(Vec::new()),
            Some(b) => Some(u64::try_from(b).unwrap_or(u64::MAX)),
            None => None,
        };
        let mut facts = RowFacts {
            read: &*read,
            floor: &q.floor,
            owner_only: OwnerOnlySources::read(&*read)?,
            streams: HashMap::new(),
            hidden: HashMap::new(),
        };
        let mut out = Vec::new();
        while out.len() < limit && high.is_none_or(|h| low < h) {
            let (start, end) = id_range(&prefix, low, high);
            let mut batch: Vec<EventRecord> = Vec::new();
            let mut failure = None;
            let mut scanned = 0usize;
            let mut last = None;
            read.scan(&start, &end, q.descending, &mut |_, v| {
                scanned += 1;
                match serde_json::from_slice::<EventRecord>(v) {
                    Ok(e) => {
                        last = Some(e.id);
                        if admits(q, after, until, &e) {
                            batch.push(e);
                        }
                    }
                    Err(e) => failure = Some(StoreError::from(e)),
                }
                failure.is_none() && scanned < BATCH
            })?;
            if let Some(e) = failure {
                return Err(e);
            }
            for e in batch {
                if out.len() == limit {
                    break;
                }
                if !facts.hidden_by_later(&e)? {
                    out.push(facts.row(e)?);
                }
            }
            match last {
                Some(id) if scanned == BATCH => {
                    if q.descending {
                        high = Some(id);
                    } else {
                        low = id.saturating_add(1);
                    }
                }
                _ => break,
            }
        }
        Ok(out)
    }

    /// `listVisibleBeliefLifetimes`: the listed lifetimes (each a `uuid`) that are open and whose
    /// live page passes the floor, each once, in text order.
    pub fn list_visible_belief_lifetimes(&self, q: &VisibleLifetimesQuery) -> Result<Vec<String>> {
        let lifetimes = q
            .lifetimes
            .iter()
            .map(|l| canonical_uuid(l))
            .collect::<Result<BTreeSet<_>>>()?;
        let read = self.read()?;
        let owner_only = OwnerOnlySources::read(&*read)?;
        let mut out = Vec::new();
        for lifetime in lifetimes {
            if let Some(page) = live_page(&*read, &lifetime)?
                && !page_hidden_with(&*read, &page, &q.floor, &owner_only)?
            {
                out.push(lifetime);
            }
        }
        Ok(out)
    }

    /// `readLedgerSource`: the source's incarnation and purge epoch, its newest coverage event
    /// other than `coverage.restored` in that incarnation, and whether a purge is possible (a
    /// raised epoch or any fact, take or page purge tombstone). Null for an unknown source.
    pub fn read_ledger_source(&self, source_id: &str) -> Result<Option<LedgerSource>> {
        const OP: &str = "readLedgerSource";
        no_nul(OP, &[("sourceId", source_id)])?;
        let read = self.read()?;
        let Some(source) = read_source(&*read, source_id)? else {
            return Ok(None);
        };
        let prefix = subject_prefix(source_id, "coverage", COVERAGE_KEY);
        let mut coverage = None;
        for (inc, id) in index_entries(&*read, id_range(&prefix, 0, None), true)? {
            if inc != source.incarnation {
                continue;
            }
            let e = load_event(&*read, OP, source_id, &inc, id)?;
            if e.event_type != "coverage.restored" {
                coverage = Some(e.event_type);
                break;
            }
        }
        let purges_possible = source.purge_epoch > 0
            || has_fact_purges(&*read, source_id)?
            || has_take_purges(&*read, source_id)?
            || has_page_purges(&*read, source_id)?;
        Ok(Some(LedgerSource {
            incarnation: source.incarnation,
            purge_epoch: source.purge_epoch,
            coverage,
            purges_possible,
        }))
    }

    /// `listCoveredSources`: the sources with a coverage event about `subject_key` in their
    /// current incarnation, by id.
    pub fn list_covered_sources(&self, subject_key: &str) -> Result<Vec<String>> {
        no_nul("listCoveredSources", &[("subjectKey", subject_key)])?;
        let read = self.read()?;
        let mut out = Vec::new();
        for source in all_sources(&*read)? {
            let prefix = subject_prefix(&source.id, "coverage", subject_key);
            let mut found = false;
            scan_prefix(&*read, &prefix, false, &mut |_, v| {
                found = v == source.incarnation.as_bytes();
                !found
            })?;
            if found {
                out.push(source.id);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;
    use crate::trust::belief_events::EventInsert;
    use crate::trust::belief_lifetimes::LifetimeMint;

    const PUB: &str = "22222222-2222-2222-2222-222222222222";
    const L1: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const L2: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    fn incarnation(store: &Store) -> String {
        read_source(&*store.read().unwrap(), "default")
            .unwrap()
            .unwrap()
            .incarnation
    }

    fn page(store: &Store, slug: &str, frontmatter: Value) -> i32 {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": "body", "timeline": "",
            "frontmatter": frontmatter,
        }))
        .unwrap();
        let got = store
            .put_page(slug, &input, &crate::pages::PutPageOptions::default())
            .unwrap();
        i32::try_from(got["id"].as_u64().unwrap()).unwrap()
    }

    fn mint(store: &Store, lifetime: &str, slug: &str, page_id: i32) {
        store
            .mint_belief_lifetime(&LifetimeMint {
                lifetime: Some(lifetime.into()),
                source_id: Some("default".into()),
                incarnation: Some(incarnation(store)),
                slug: Some(slug.into()),
                page_id: Some(page_id),
            })
            .unwrap();
    }

    fn event(store: &Store, key: &str, extra: Value) {
        let mut base = json!({
            "event_key": key, "source_id": "default", "source_incarnation": incarnation(store),
            "page_lifetime": null, "slug": "people/a", "subject_kind": "take", "subject_key": "k",
            "event_type": "asserted", "origin": "live", "trust_tier": "owner", "writer_tier": null,
            "tier_basis": "row", "visibility": "world", "publication_id": PUB, "ord": 0,
            "source_time": null, "valid_from": null, "valid_until": null,
            "value": null, "value_hash": null, "prior_hash": null, "state_hash": "s",
            "cause": "{}", "claim_fp": null, "purged": false, "redacted_fields": null,
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        let row: EventInsert = serde_json::from_value(base).unwrap();
        assert_eq!(store.insert_belief_events(&[row]).unwrap(), 1);
    }

    fn floor() -> PrivacyPolicy {
        PrivacyPolicy {
            entity_privacy: true,
            ..PrivacyPolicy::default()
        }
    }

    fn query(extra: Value) -> HistoryQuery {
        let mut base = json!({
            "sourceId": "default", "slug": null, "subjectKey": null, "afterId": 0, "limit": 100,
            "recordedAfter": null, "recordedUntil": null, "subjectKeys": null, "beforeId": null,
            "descending": false, "floor": {"honorAliases": false, "entityPrivacy": true},
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn pick(rows: &[Value], field: &str) -> Vec<Value> {
        rows.iter().map(|r| r[field].clone()).collect()
    }

    #[test]
    fn history_rows_carry_their_visibility_facts_and_skip_hidden_events() {
        let store = store();
        let open = page(&store, "people/a", json!({}));
        let quarantined = page(&store, "people/q", json!({"quarantine": "x"}));
        mint(&store, L1, "people/a", open);
        mint(&store, L2, "people/q", quarantined);
        let holder =
            json!({"value": "{\"holder\": \"alice\"}", "claim_fp": "fp", "page_lifetime": L1});
        event(&store, "e1", holder);
        event(
            &store,
            "e2",
            json!({"claim_fp": "fp", "visibility": "private", "page_lifetime": L1}),
        );
        event(
            &store,
            "e3",
            json!({"subject_kind": "fact", "subject_key": "f", "page_lifetime": L2}),
        );
        event(
            &store,
            "e4",
            json!({"subject_kind": "fact", "subject_key": "f", "event_type": HIDDEN}),
        );
        event(
            &store,
            "e5",
            json!({"subject_kind": "page", "subject_key": "p", "page_lifetime": L2}),
        );
        let rows = store.read_belief_history_rows(&query(json!({}))).unwrap();
        assert_eq!(pick(&rows, "id"), [1, 2, 4, 5].map(Value::from));
        assert_eq!(
            pick(&rows, "later_private"),
            [true, false, false, false].map(Value::from)
        );
        assert_eq!(
            pick(&rows, "take_holder"),
            [json!("alice"), json!("alice"), Value::Null, Value::Null]
        );
        // A quarantined page hides its fact and take streams only.
        assert_eq!(
            pick(&rows, "stream_visible"),
            [json!(true), json!(true), Value::Null, json!(true)]
        );
        assert_eq!(rows[0]["value"], json!({"holder": "alice"}));
        let desc = store
            .read_belief_history_rows(&query(
                json!({"descending": true, "limit": 2, "beforeId": 5}),
            ))
            .unwrap();
        assert_eq!(pick(&desc, "id"), [4, 2].map(Value::from));
        let after = store
            .read_belief_history_rows(&query(json!({"afterId": 1, "subjectKeys": ["k"]})))
            .unwrap();
        assert_eq!(pick(&after, "id"), [Value::from(2)]);
        let none = store.read_belief_history_rows(&query(json!({"sourceId": "nope"})));
        assert!(none.unwrap().is_empty());
        let bad = store.read_belief_history_rows(&query(json!({"recordedAfter": "x"})));
        assert!(
            bad.unwrap_err()
                .message
                .contains("timestamp with time zone")
        );
    }

    #[test]
    fn visible_lifetimes_are_open_live_and_pass_the_floor() {
        let store = store();
        let open = page(&store, "people/a", json!({}));
        let private = page(&store, "people/p", json!({"visibility": "private"}));
        mint(&store, L1, "people/a", open);
        mint(&store, L2, "people/p", private);
        let q = |lifetimes: &[&str]| VisibleLifetimesQuery {
            lifetimes: lifetimes.iter().map(|l| l.to_string()).collect(),
            floor: floor(),
        };
        let upper = L1.to_uppercase();
        let got = store
            .list_visible_belief_lifetimes(&q(&[L2, &upper, L1]))
            .unwrap();
        assert_eq!(got, vec![L1.to_string()]);
        assert!(store.list_visible_belief_lifetimes(&q(&["x"])).is_err());
        store.soft_delete_page("people/a", Some("default")).unwrap();
        assert!(
            store
                .list_visible_belief_lifetimes(&q(&[L1]))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_ledger_source_reads_coverage_and_the_covered_sources() {
        let store = store();
        let before = store.read_ledger_source("default").unwrap().unwrap();
        assert_eq!((before.coverage, before.purges_possible), (None, false));
        assert_eq!(
            store.list_covered_sources(COVERAGE_KEY).unwrap(),
            Vec::<String>::new()
        );
        let coverage = |key: &str, kind: &str| json!({"subject_kind": "coverage", "subject_key": COVERAGE_KEY, "event_type": kind, "event_key": key});
        event(&store, "c1", coverage("c1", "coverage.started"));
        event(&store, "c2", coverage("c2", "coverage.restored"));
        let got = store.read_ledger_source("default").unwrap().unwrap();
        assert_eq!(got.coverage.as_deref(), Some("coverage.started"));
        assert_eq!(got.incarnation, incarnation(&store));
        assert_eq!(
            store.list_covered_sources(COVERAGE_KEY).unwrap(),
            vec!["default"]
        );
        assert!(store.read_ledger_source("nope").unwrap().is_none());
    }
}
