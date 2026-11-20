//! The belief ledger's write path (`src/core/engine-sql/collate-belief-writes.ts`): the event
//! insert, the commit marks, the redaction register, and the coverage reads `enableBeliefLedger`
//! makes. PGLite and Postgres run SQL over `belief_events`, `belief_commit_marks` and
//! `belief_redactions`; this answers the same questions from the store's records. What each
//! member answers: rust/docs/store/collate-belief-writes.md.
//!
//! Nothing in a shipped brain calls these yet (`readLedgerSource` reports no coverage, so no batch
//! opens), so the families stay empty until a caller does.
//!
//! The tables have no foreign key to `sources`, so a removed source keeps its events, marks and
//! redactions, and reads that join the source's incarnation answer nothing once it is gone.
//!
//! Keys (under `keys::FACT`, `F`, with sub-tags the facts records do not use; a text part ends
//! with a NUL byte, and no text column may hold one):
//! - `F 0x21 <source> 0x00 <id, 8 bytes big endian>` -> [`EventRecord`] (JSON). A scan of one
//!   source meets its events in id order, which is the order they were inserted in.
//! - `F 0x22 <event key, lower hex>` -> the event's id: the table's `UNIQUE (event_key)`.
//! - `F 0x23 <publication uuid> 0x00 <id, 8 bytes big endian>` -> the event's source id: the
//!   events of one publication.
//! - `F 0x24 <id, 8 bytes big endian>` -> [`RedactionRecord`] (JSON): the redaction register.
//! - `F 0x25 <publication uuid>` -> the commit mark's `observed_at`, 8 bytes big endian micros.
//!
//! Ids come from the counters `M next_belief_event_id` and `M next_belief_redaction_id`, which
//! start at 1 as the `BIGSERIAL` columns do.

use crate::env::{is_uuid, iso};
use crate::error::{Result, StoreError};
use crate::facts::source_rows;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::{all_pages, next_id};
use crate::sources::read_source;
use crate::{Store, keys};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

const EVENT: u8 = 0x21;
const EVENT_KEY: u8 = 0x22;
const PUBLICATION: u8 = 0x23;
const REDACTION: u8 = 0x24;
const MARK: u8 = 0x25;
/// The facts family's purge tombstones (`facts/purge_ledger.rs`): `F 0x0F source 0 visibility 0
/// subject 0 fact_hash 0`.
const FACT_PURGE: u8 = 0x0F;
const NEXT_EVENT_ID: &str = "next_belief_event_id";
const NEXT_REDACTION_ID: &str = "next_belief_redaction_id";

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

/// One event as `appendBeliefEvents` builds it (`BeliefEventRow`): `value` and `cause` are JSON
/// text, `event_key` is hex, the timestamps are text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventRow {
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
    pub source_time: Option<String>,
    pub valid_from: Option<String>,
    pub valid_until: Option<String>,
    pub value: Option<String>,
    pub value_hash: Option<String>,
    pub prior_hash: Option<String>,
    pub state_hash: String,
    pub cause: String,
    pub claim_fp: Option<String>,
    pub purged: bool,
    pub redacted_fields: Option<Vec<String>>,
}

/// A stored event: the row with its id and `recorded_at`, which the SQL column fills with
/// `clock_timestamp()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EventRecord {
    id: u64,
    recorded_at_us: i64,
    row: EventRow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RedactionRecord {
    id: u64,
    source_id: String,
    subject_key: String,
    field: String,
    purge_request: String,
    field_hash: String,
    released_by: Option<String>,
    released_hash: Option<String>,
    created_at_us: i64,
}

/// The newest coverage event of a source (`BeliefCoverageRow`): `recorded_at` is UTC ISO text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BeliefCoverage {
    pub event_type: String,
    pub run: Option<String>,
    pub recorded_at: String,
    pub id: u64,
}

/// A register row as the read returns it (`BeliefRedactionRow`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BeliefRedaction {
    pub id: u64,
    pub subject_key: String,
    pub field: String,
    pub purge_request: String,
    pub field_hash: String,
    pub released_hash: Option<String>,
}

fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut key = vec![keys::FACT, EVENT];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key
}

fn event_key(source_id: &str, id: u64) -> Vec<u8> {
    let mut key = source_prefix(source_id);
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn tagged(tag: u8, text: &str) -> Vec<u8> {
    let mut key = vec![keys::FACT, tag];
    key.extend_from_slice(text.as_bytes());
    key
}

fn publication_prefix(publication: &str) -> Vec<u8> {
    let mut key = tagged(PUBLICATION, publication);
    key.push(0);
    key
}

fn redaction_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::FACT, REDACTION];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// A uuid as the `uuid` type prints it: lower case. Anything else is the cast's refusal.
fn uuid(op: &str, name: &str, text: &str) -> Result<String> {
    if is_uuid(text) {
        Ok(text.to_ascii_lowercase())
    } else {
        Err(StoreError::invalid(format!(
            "{op}: {name} is not a uuid: {text}"
        )))
    }
}

/// `decode(text, 'hex')` as a key: even length, hex digits, lower case.
fn hex_key(op: &str, text: &str) -> Result<String> {
    if text.len().is_multiple_of(2) && text.bytes().all(|c| c.is_ascii_hexdigit()) {
        Ok(text.to_ascii_lowercase())
    } else {
        Err(StoreError::invalid(format!(
            "{op}: event_key is not hex text"
        )))
    }
}

/// `cause->>'run'`: a string as is, any other JSON value as its text, SQL NULL when absent.
fn run_of(cause: &str) -> Option<String> {
    match serde_json::from_str::<Value>(cause).ok()?.get("run")? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn corrupt(e: serde_json::Error) -> StoreError {
    e.into()
}

/// Every event of the source in id order, or until `f` returns false.
fn each_event(
    read: &dyn KvRead,
    source_id: &str,
    reverse: bool,
    f: &mut dyn FnMut(EventRecord) -> bool,
) -> Result<()> {
    let mut failure = None;
    scan_prefix(
        read,
        &source_prefix(source_id),
        reverse,
        &mut |_, v| match serde_json::from_slice::<EventRecord>(v) {
            Ok(record) => f(record),
            Err(e) => {
                failure = Some(e);
                false
            }
        },
    )?;
    failure.map_or(Ok(()), |e| Err(corrupt(e)))
}

/// The distinct `(slug, page_lifetime)` pairs the source's events name (a null lifetime names none), in byte order.
pub(crate) fn event_lifetimes(
    read: &dyn KvRead,
    source_id: &str,
) -> Result<BTreeSet<(String, String)>> {
    let mut named = BTreeSet::new();
    each_event(read, source_id, false, &mut |record| {
        if let Some(lifetime) = record.row.page_lifetime {
            named.insert((record.row.slug, lifetime));
        }
        true
    })?;
    Ok(named)
}

fn check_row(op: &str, row: &EventRow) -> Result<()> {
    no_nul(
        op,
        &[
            ("source_id", &row.source_id),
            ("slug", &row.slug),
            ("subject_key", &row.subject_key),
            ("event_type", &row.event_type),
        ],
    )?;
    for (name, list, value) in [
        ("subject_kind", &SUBJECT_KINDS[..], &row.subject_kind),
        ("origin", &ORIGINS[..], &row.origin),
        ("tier_basis", &TIER_BASES[..], &row.tier_basis),
    ] {
        if !list.contains(&value.as_str()) {
            return Err(StoreError::invalid(format!(
                "{op}: {name} violates its check: {value}"
            )));
        }
    }
    for text in [Some(&row.cause), row.value.as_ref()].into_iter().flatten() {
        serde_json::from_str::<Value>(text)
            .map_err(|e| StoreError::invalid(format!("{op}: a jsonb column is not JSON: {e}")))?;
    }
    Ok(())
}

impl Store {
    /// `readBeliefCoverage(sourceId, coverageKey)`: the newest event of the source's current
    /// incarnation whose subject is the coverage key, other than `coverage.restored`; None when the
    /// source is missing or has none.
    pub fn read_belief_coverage(
        &self,
        source_id: &str,
        coverage_key: &str,
    ) -> Result<Option<BeliefCoverage>> {
        no_nul("readBeliefCoverage", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let Some(source) = read_source(&*read, source_id)? else {
            return Ok(None);
        };
        let mut found = None;
        each_event(&*read, source_id, true, &mut |e| {
            let r = &e.row;
            if r.subject_kind == "coverage"
                && r.subject_key == coverage_key
                && r.event_type != "coverage.restored"
                && r.source_incarnation == source.incarnation
            {
                found = Some(BeliefCoverage {
                    run: run_of(&r.cause),
                    event_type: r.event_type.clone(),
                    recorded_at: iso(e.recorded_at_us),
                    id: e.id,
                });
                return false;
            }
            true
        })?;
        Ok(found)
    }

    /// The slugs of the source's baseline events of the run.
    fn baselined_slugs(
        read: &dyn KvRead,
        source_id: &str,
        run_id: &str,
    ) -> Result<BTreeSet<String>> {
        let mut slugs = BTreeSet::new();
        each_event(read, source_id, false, &mut |e| {
            if e.row.event_type == "baseline" && run_of(&e.row.cause).as_deref() == Some(run_id) {
                slugs.insert(e.row.slug);
            }
            true
        })?;
        Ok(slugs)
    }

    /// `hasBaselineEvent(sourceId, slug, runId)`.
    pub fn has_baseline_event(&self, source_id: &str, slug: &str, run_id: &str) -> Result<bool> {
        no_nul(
            "hasBaselineEvent",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        Ok(Self::baselined_slugs(&*read, source_id, run_id)?.contains(slug))
    }

    /// `countBaselinedSlugs(sourceId, runId)`: the distinct slugs a run has baselined.
    pub fn count_baselined_slugs(&self, source_id: &str, run_id: &str) -> Result<usize> {
        no_nul("countBaselinedSlugs", &[("sourceId", source_id)])?;
        let read = self.read()?;
        Ok(Self::baselined_slugs(&*read, source_id, run_id)?.len())
    }

    /// `listPendingBaselineSlugs(sourceId, runId, after, skip, limit)`: slugs after `after`
    /// (bytewise) not in `skip` that the run has not baselined, in byte order, at most `limit`:
    /// every page of the source (soft-deleted too), the entity of each active fact filed on no
    /// page, and the page of each active dimension fact that has no row number.
    pub fn list_pending_baseline_slugs(
        &self,
        source_id: &str,
        run_id: &str,
        after: &str,
        skip: &[String],
        limit: usize,
    ) -> Result<Vec<String>> {
        no_nul(
            "listPendingBaselineSlugs",
            &[("sourceId", source_id), ("after", after)],
        )?;
        let read = self.read()?;
        let done = Self::baselined_slugs(&*read, source_id, run_id)?;
        let mut slugs: BTreeSet<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id)
            .map(|p| p.slug)
            .collect();
        for f in source_rows(&*read, source_id)? {
            if f.expired_at_us.is_some() {
                continue;
            }
            if f.source_markdown_slug.is_none() {
                slugs.extend(f.entity_slug.clone());
            }
            if f.dimension.is_some() && f.row_num.is_none() {
                slugs.extend(f.source_markdown_slug.clone());
            }
        }
        Ok(slugs
            .into_iter()
            .filter(|s| s.as_bytes() > after.as_bytes() && !skip.contains(s) && !done.contains(s))
            .take(limit.max(1))
            .collect())
    }

    /// `listPurgedFingerprints(sourceId, factFps, takeFps)`: the fingerprints among `fact_fps` that
    /// a fact purge tombstone of the source names, at any visibility and subject. A Rust brain
    /// keeps no take purges (nothing writes one), so `take_fps` match nothing.
    pub fn list_purged_fingerprints(
        &self,
        source_id: &str,
        fact_fps: &[String],
        _take_fps: &[String],
    ) -> Result<Vec<String>> {
        no_nul("listPurgedFingerprints", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut prefix = vec![keys::FACT, FACT_PURGE];
        prefix.extend_from_slice(source_id.as_bytes());
        prefix.push(0);
        let mut found = BTreeSet::new();
        scan_prefix(&*read, &prefix, false, &mut |k, _| {
            // visibility 0 subject 0 fact_hash 0
            let tail = &k[prefix.len()..];
            if let Some(hash) = tail.split(|b| *b == 0).nth(2)
                && let Ok(hash) = std::str::from_utf8(hash)
                && fact_fps.iter().any(|fp| fp == hash)
            {
                found.insert(hash.to_string());
            }
            true
        })?;
        Ok(found.into_iter().collect())
    }

    /// `readBeliefRedactions(sourceId, subjectKeys, fieldHashes)`: the source's register rows under
    /// any of the subject keys or any of the field hashes, in id order.
    pub fn read_belief_redactions(
        &self,
        source_id: &str,
        subject_keys: &[String],
        field_hashes: &[String],
    ) -> Result<Vec<BeliefRedaction>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::FACT, REDACTION], false, &mut |_, v| {
            match serde_json::from_slice::<RedactionRecord>(v) {
                Ok(r) => {
                    if r.source_id == source_id
                        && (subject_keys.contains(&r.subject_key)
                            || field_hashes.contains(&r.field_hash))
                    {
                        rows.push(BeliefRedaction {
                            id: r.id,
                            subject_key: r.subject_key,
                            field: r.field,
                            purge_request: r.purge_request,
                            field_hash: r.field_hash,
                            released_hash: r.released_hash,
                        });
                    }
                    true
                }
                Err(e) => {
                    failure = Some(e);
                    false
                }
            }
        })?;
        failure.map_or(Ok(rows), |e| Err(corrupt(e)))
    }

    /// `insertBeliefRedaction(...)`: registers one suppression; returns its id.
    pub fn insert_belief_redaction(
        &self,
        source_id: &str,
        subject_key: &str,
        field: &str,
        purge_request: &str,
        field_hash: &str,
    ) -> Result<u64> {
        const OP: &str = "insertBeliefRedaction";
        no_nul(
            OP,
            &[
                ("sourceId", source_id),
                ("subjectKey", subject_key),
                ("field", field),
                ("fieldHash", field_hash),
            ],
        )?;
        let purge_request = uuid(OP, "purgeRequest", purge_request)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let id = next_id(tx, NEXT_REDACTION_ID)?;
            let record = RedactionRecord {
                id,
                source_id: source_id.into(),
                subject_key: subject_key.into(),
                field: field.into(),
                purge_request,
                field_hash: field_hash.into(),
                released_by: None,
                released_hash: None,
                created_at_us: now,
            };
            crate::put_json(tx, &redaction_key(id), &record)?;
            Ok(id)
        })
    }

    /// `releaseBeliefRedactions(ids, publicationId, releasedHash)`: marks the registered rows among
    /// `ids` released by the publication, bound to `released_hash`; an unknown id is skipped.
    pub fn release_belief_redactions(
        &self,
        ids: &[u64],
        publication_id: &str,
        released_hash: &str,
    ) -> Result<()> {
        let publication = uuid("releaseBeliefRedactions", "publicationId", publication_id)?;
        self.write(|tx| {
            for id in ids {
                let key = redaction_key(*id);
                let Some(mut record) = crate::get_json::<RedactionRecord>(&*tx, &key)? else {
                    continue;
                };
                record.released_by = Some(publication.clone());
                record.released_hash = Some(released_hash.into());
                crate::put_json(tx, &key, &record)?;
            }
            Ok(())
        })
    }

    /// `insertBeliefEvents(rows)`: inserts the rows in `ord` order, each with the next id and the
    /// transaction's clock as `recorded_at`; a row whose event key exists (also one earlier in
    /// the same call) is skipped. Returns how many it inserted. A row that violates a column check
    /// refuses the whole call, as the statement does.
    pub fn insert_belief_events(&self, rows: Vec<EventRow>) -> Result<usize> {
        const OP: &str = "insertBeliefEvents";
        let mut rows = rows;
        for row in &mut rows {
            check_row(OP, row)?;
            row.event_key = hex_key(OP, &row.event_key)?;
            row.source_incarnation = uuid(OP, "source_incarnation", &row.source_incarnation)?;
            row.publication_id = uuid(OP, "publication_id", &row.publication_id)?;
            if let Some(lifetime) = &row.page_lifetime {
                row.page_lifetime = Some(uuid(OP, "page_lifetime", lifetime)?);
            }
        }
        rows.sort_by_key(|r| r.ord);
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut inserted = 0;
            for row in rows {
                let index = tagged(EVENT_KEY, &row.event_key);
                if tx.get(&index)?.is_some() {
                    continue;
                }
                let id = next_id(tx, NEXT_EVENT_ID)?;
                let mut by_publication = publication_prefix(&row.publication_id);
                by_publication.extend_from_slice(&id.to_be_bytes());
                tx.put(&index, &id.to_be_bytes())?;
                tx.put(&by_publication, row.source_id.as_bytes())?;
                let key = event_key(&row.source_id, id);
                let record = EventRecord {
                    id,
                    recorded_at_us: now,
                    row,
                };
                crate::put_json(tx, &key, &record)?;
                inserted += 1;
            }
            Ok(inserted)
        })
    }

    /// `recordBeliefCommitMarks(publicationIds)`: marks each publication that has events and no
    /// mark yet, all at one instant, provided no event of it was recorded after that instant.
    pub fn record_belief_commit_marks(&self, publication_ids: &[String]) -> Result<()> {
        let mut ids = Vec::new();
        for id in publication_ids {
            ids.push(uuid("recordBeliefCommitMarks", "publicationId", id)?);
        }
        let at = self.env.now_micros();
        self.write(|tx| {
            for publication in ids {
                let mark = tagged(MARK, &publication);
                if tx.get(&mark)?.is_some() {
                    continue;
                }
                let mut members = Vec::new();
                scan_prefix(
                    &*tx,
                    &publication_prefix(&publication),
                    false,
                    &mut |k, v| {
                        members.push((
                            String::from_utf8_lossy(v).into_owned(),
                            k[k.len() - 8..].to_vec(),
                        ));
                        true
                    },
                )?;
                let mut newest: Option<i64> = None;
                for (source_id, id) in members {
                    let key = event_key(&source_id, keys::be8(&id).unwrap_or_default());
                    if let Some(e) = crate::get_json::<EventRecord>(&*tx, &key)? {
                        newest = Some(newest.map_or(e.recorded_at_us, |n| n.max(e.recorded_at_us)));
                    }
                }
                if newest.is_some_and(|n| n <= at) {
                    tx.put(&mark, &at.to_be_bytes())?;
                }
            }
            Ok(())
        })
    }

    /// The `observed_at` (UTC ISO text) of a publication's commit mark, or None. For tests: no
    /// BrainEngine member reads a mark.
    pub fn read_belief_commit_mark(&self, publication_id: &str) -> Result<Option<String>> {
        let publication = uuid("readBeliefCommitMark", "publicationId", publication_id)?;
        let read = self.read()?;
        Ok(read
            .get(&tagged(MARK, &publication))?
            .and_then(|b| keys::be8(&b))
            .map(|at| iso(at as i64)))
    }
}
