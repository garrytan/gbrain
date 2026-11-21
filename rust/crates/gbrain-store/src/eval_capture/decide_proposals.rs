//! The decide proposal tables: `decide_proposals` (supersede proposals the conflict sweep leaves
//! for the owner), `decide_review_proposals` (the review lane's), the review lane's work queue
//! `decide_review_queue` and the conflict sweep's retry table `decide_sweep_deferred`.
//! Contract: rust/docs/store/decide-proposals.md; SQL twin: src/core/engine-sql/decide-proposals.ts.
//!
//! Members: insertDecideProposal, getDecideProposal, listDecideProposalIds, listDecideProposals,
//! transitionDecideProposal, listDecideProposedPairs, insertDecideReviewProposal,
//! listDecideReviewProposals, getDecideReviewProposal, transitionDecideReviewProposal,
//! listDecideReviewProposalIds, readProposalReviewRates, listDueDecideReviewQueue,
//! applyDecideReviewQueue, listDueDecideSweepDeferred, applyDecideSweepDeferred.
//!
//! Keys (every record starts with `keys::EVAL_CAPTURE`, `Z`, then the sub-tag):
//! - `Z 0x30 <id u64 BE>` -> `ProposalRecord` (JSON), a supersede proposal.
//! - `Z 0x31 <sweep_id> 0 <pair_index i32, sign-flipped BE>` -> id: `UNIQUE (sweep_id, pair_index)`;
//!   a prefix scan on the sweep is its proposals in pair-index order.
//! - `Z 0x32 <source_id> 0 <lo i64 flipped BE> <hi i64 flipped BE>` -> id: the partial unique index
//!   `decide_proposals_claim_pair_uidx`, kept only for sweeps named `claim_conflicts:%`.
//! - `Z 0x38 <id u64 BE>` -> `ReviewProposalRecord`, a review proposal.
//! - `Z 0x39 <kind> 0 <source_id> 0 <a_ref> 0 <b_ref> 0 <subject>` -> id: the table's unique key.
//! - `Z 0x3C <kind> 0 <source_id> 0 <a_ref> 0 <b_ref>` -> `QueueRecord`, a review-queue row.
//! - `Z 0x3D <slot> 0 <source_id> 0 <fact_id i64 flipped BE>` -> `DeferredRecord`, a retry row.
//! - Id counters: `M decide_proposal_next_id`, `M decide_review_proposal_next_id`.
//!
//! An insert takes its id first and then meets the unique keys, as a BIGSERIAL does: a conflicting
//! insert returns `None` and the id is gone. Lists scan a whole table (or the prefix a key names),
//! filter, and sort in memory: proposals are owner-reviewed rows, a few hundred at most.
//! The status filter of the rates, the 30-day window and the retry back-off read the store clock
//! once per call (`now()` of the Postgres statement). REAL columns are stored as `f32` and read
//! back as the shortest decimal that names that `f32`, as Postgres prints a `real`.
//!
//! `listDecideProposals` reads the fact text from the facts store without touching it. A row lock
//! (`FOR UPDATE`) has no meaning here: one writer runs at a time, so a read inside a transaction
//! already holds the row.

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::facts::{like, read_fact, real};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::timeline_queries::timestamptz_text;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(crate) const NEXT_PROPOSAL_ID: &str = "decide_proposal_next_id";
pub(crate) const NEXT_REVIEW_PROPOSAL_ID: &str = "decide_review_proposal_next_id";

/// A supersede proposal.
const PROPOSAL: u8 = 0x30;
/// `UNIQUE (sweep_id, pair_index)` of the supersede proposals.
const PROPOSAL_SWEEP: u8 = 0x31;
/// The claim-sweep fact-pair index of the supersede proposals.
const PROPOSAL_CLAIM_PAIR: u8 = 0x32;
/// A review proposal.
const REVIEW_PROPOSAL: u8 = 0x38;
/// `UNIQUE (kind, source_id, a_ref, b_ref, subject)` of the review proposals.
const REVIEW_PROPOSAL_KEY: u8 = 0x39;
/// A review-queue row.
const REVIEW_QUEUE: u8 = 0x3C;
/// A conflict-sweep retry row.
const SWEEP_DEFERRED: u8 = 0x3D;

/// `attempts < 5` of both retry tables.
const MAX_ATTEMPTS: i32 = 5;
/// The conflict sweep's back-off unit: `now() + 30 minutes * attempts`.
const DEFERRED_BACKOFF_US: i64 = 30 * 60 * 1_000_000;
/// The review queue's back-off unit: `now() + 10 minutes * attempts`.
const QUEUE_BACKOFF_US: i64 = 10 * 60 * 1_000_000;
/// `interval '30 days'` of the review rates.
const RATE_WINDOW_US: i64 = 30 * 86_400 * 1_000_000;
/// `listDecideProposals` without a usable limit.
const DEFAULT_LIST_LIMIT: usize = 200;
/// The only slot the sweep's retry rows are written under.
const CONFLICT_SLOT: &str = "conflict";

fn tagged(tag: u8) -> Vec<u8> {
    vec![keys::EVAL_CAPTURE, tag]
}

fn id_key(tag: u8, id: u64) -> Vec<u8> {
    let mut key = tagged(tag);
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// An `i64` as eight bytes that sort in numeric order.
fn ordered_i64(v: i64) -> [u8; 8] {
    ((v as u64) ^ (1 << 63)).to_be_bytes()
}

/// An `i32` as four bytes that sort in numeric order.
fn ordered_i32(v: i32) -> [u8; 4] {
    ((v as u32) ^ (1 << 31)).to_be_bytes()
}

/// A key of `tag` and the text parts joined (and ended) with NUL bytes, then `tail`.
fn text_key(tag: u8, parts: &[&str], tail: &[u8]) -> Vec<u8> {
    let mut key = tagged(tag);
    for part in parts {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key.extend_from_slice(tail);
    key
}

fn sweep_slot_key(sweep_id: &str, pair_index: i32) -> Vec<u8> {
    text_key(PROPOSAL_SWEEP, &[sweep_id], &ordered_i32(pair_index))
}

fn claim_pair_key(source_id: &str, a: i64, b: i64) -> Vec<u8> {
    let (lo, hi) = (a.min(b), a.max(b));
    let mut tail = ordered_i64(lo).to_vec();
    tail.extend_from_slice(&ordered_i64(hi));
    text_key(PROPOSAL_CLAIM_PAIR, &[source_id], &tail)
}

fn queue_key(kind: &str, source_id: &str, a_ref: &str, b_ref: &str) -> Vec<u8> {
    text_key(REVIEW_QUEUE, &[kind, source_id, a_ref, b_ref], &[])
}

fn deferred_key(slot: &str, source_id: &str, fact_id: i64) -> Vec<u8> {
    text_key(SWEEP_DEFERRED, &[slot, source_id], &ordered_i64(fact_id))
}

fn read_all<T: serde::de::DeserializeOwned>(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<T>> {
    let mut raw = Vec::new();
    scan_prefix(read, prefix, false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

fn id_at(bytes: &[u8]) -> Result<u64> {
    keys::be8(bytes).ok_or_else(|| StoreError::new(crate::error::STORE_CORRUPT, "bad proposal id"))
}

fn not_null(table: &str, column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"{table}\" violates not-null constraint"
        ),
    )
}

/// A required text column: null or absent is the `NOT NULL` violation.
fn text_column(value: &Option<String>, table: &str, column: &str) -> Result<String> {
    value.clone().ok_or_else(|| not_null(table, column))
}

/// A whole number argument: a JSON integer, or a float with no fraction, inside `[min, max]`.
fn whole(value: &Value, what: &str, min: i64, max: i64) -> Result<i64> {
    let refused = || {
        StoreError::invalid(format!(
            "{what} must be an integer between {min} and {max}, got {value}"
        ))
    };
    let n = match value {
        Value::Number(n) => match n.as_i64() {
            Some(i) => i,
            None => {
                let f = n.as_f64().ok_or_else(refused)?;
                if f.fract() != 0.0 || f < -9.0e15 || f > 9.0e15 {
                    return Err(refused());
                }
                f as i64
            }
        },
        _ => return Err(refused()),
    };
    if n < min || n > max {
        return Err(refused());
    }
    Ok(n)
}

/// A `real` parameter as `f32`; a number beyond the `f32` range is the Postgres error.
fn real_arg(value: f64, what: &str) -> Result<f32> {
    let narrowed = value as f32;
    // A NaN or infinity (a native caller only; JSON cannot carry one) would be stored as null in a required field.
    if !value.is_finite() {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{what}: \"{value}\" is not a finite number"),
        ));
    }
    if narrowed.is_infinite() {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{what}: \"{value}\" is out of range for type real"),
        ));
    }
    Ok(narrowed)
}

/// `LIMIT n`: a negative limit is the Postgres error.
fn limit_of(limit: i64) -> Result<usize> {
    if limit < 0 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            "LIMIT must not be negative",
        ));
    }
    Ok(usize::try_from(limit).unwrap_or(usize::MAX))
}

/// A row id from the caller; one no row can have (negative, or past the sequence) matches nothing.
fn row_id(id: i64) -> Option<u64> {
    u64::try_from(id).ok()
}

/// What [`seed_proposal`] and [`seed_review_proposal`] did with a row.
pub(crate) enum Seeded {
    Stored,
    /// The id already holds a row: a retried batch.
    Present,
    /// Another row holds the unique key named here.
    Conflict(&'static str),
}

// ------------------------------------------------------------------ supersede proposals

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ProposalRecord {
    pub id: u64,
    pub created_at_us: i64,
    pub source_id: String,
    pub sweep_id: String,
    pub pair_index: i32,
    pub new_fact_id: i64,
    pub old_fact_id: i64,
    pub direction: String,
    pub p_supersede: f32,
    pub threshold: Option<f32>,
    pub proposal_floor: f32,
    pub model_resolved: Option<String>,
    pub status: String,
    pub decided_at_us: Option<i64>,
    pub before_state: Option<String>,
    pub after_state: Option<String>,
}

impl ProposalRecord {
    /// The `SELECT *` row: timestamps as microsecond ISO text, REALs as their shortest decimal.
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "created_at": iso(self.created_at_us),
            "source_id": self.source_id,
            "sweep_id": self.sweep_id,
            "pair_index": self.pair_index,
            "new_fact_id": self.new_fact_id,
            "old_fact_id": self.old_fact_id,
            "direction": self.direction,
            "p_supersede": real(self.p_supersede),
            "threshold": self.threshold.map(real),
            "proposal_floor": real(self.proposal_floor),
            "model_resolved": self.model_resolved,
            "status": self.status,
            "decided_at": self.decided_at_us.map(iso),
            "before_state": self.before_state,
            "after_state": self.after_state,
        })
    }
}

/// The shadow seed (`seed.rs`): stores a supersede proposal copied from another engine with its
/// own id and times, and its sweep-slot key and (for a `claim_conflicts:%` sweep) its claim-pair
/// key as [`Store::insert_decide_proposal`] writes them.
pub(crate) fn seed_proposal(tx: &mut dyn KvWrite, record: &ProposalRecord) -> Result<Seeded> {
    if tx.get(&id_key(PROPOSAL, record.id))?.is_some() {
        return Ok(Seeded::Present);
    }
    let slot = sweep_slot_key(&record.sweep_id, record.pair_index);
    if tx.get(&slot)?.is_some() {
        return Ok(Seeded::Conflict("decide_proposals (sweep_id, pair_index)"));
    }
    let claim = like(&record.sweep_id, "claim_conflicts:%", false)?;
    let pair = claim_pair_key(&record.source_id, record.new_fact_id, record.old_fact_id);
    if claim && tx.get(&pair)?.is_some() {
        return Ok(Seeded::Conflict("decide_proposals_claim_pair_uidx"));
    }
    put_json(tx, &id_key(PROPOSAL, record.id), record)?;
    tx.put(&slot, &record.id.to_be_bytes())?;
    if claim {
        tx.put(&pair, &record.id.to_be_bytes())?;
    }
    Ok(Seeded::Stored)
}

/// `NewProposal`. Every field is optional here so a missing one fails as Postgres fails it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DecideProposalInput {
    pub source_id: Option<String>,
    pub sweep_id: Option<String>,
    pub pair_index: Option<Value>,
    pub new_fact_id: Option<Value>,
    pub old_fact_id: Option<Value>,
    pub direction: Option<String>,
    pub p_supersede: Option<f64>,
    pub threshold: Option<f64>,
    pub proposal_floor: Option<f64>,
    pub model_resolved: Option<String>,
}

/// The filter of `listDecideProposals`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ListDecideProposalsOptions {
    pub status: Option<String>,
    pub limit: Option<i64>,
}

/// `transitionDecideProposal`: a status change and the state it records.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DecideProposalTransition {
    pub id: i64,
    pub from: String,
    pub to: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

fn fact_text(read: &dyn KvRead, id: i64) -> Result<Option<(String, Option<String>)>> {
    let Some(id) = row_id(id) else {
        return Ok(None);
    };
    Ok(read_fact(read, id)?.map(|f| (f.fact, f.entity_slug)))
}

impl Store {
    /// `insertDecideProposal(p)`: the new proposal's id, or `None` when its `(sweep_id,
    /// pair_index)` slot, or (for a `claim_conflicts:%` sweep) its unordered fact pair of the same
    /// source, is taken. The id is used up either way.
    pub fn insert_decide_proposal(&self, input: &DecideProposalInput) -> Result<Option<u64>> {
        const TABLE: &str = "decide_proposals";
        no_nul(
            "insertDecideProposal",
            &[
                ("source_id", input.source_id.as_deref().unwrap_or("")),
                ("sweep_id", input.sweep_id.as_deref().unwrap_or("")),
                ("direction", input.direction.as_deref().unwrap_or("")),
                (
                    "model_resolved",
                    input.model_resolved.as_deref().unwrap_or(""),
                ),
            ],
        )?;
        let int = |value: &Option<Value>, column: &str, min: i64, max: i64| -> Result<i64> {
            match value {
                Some(v) if !v.is_null() => {
                    whole(v, &format!("insertDecideProposal {column}"), min, max)
                }
                _ => Err(not_null(TABLE, column)),
            }
        };
        let source_id = text_column(&input.source_id, TABLE, "source_id")?;
        let sweep_id = text_column(&input.sweep_id, TABLE, "sweep_id")?;
        let pair_index = int(
            &input.pair_index,
            "pair_index",
            i64::from(i32::MIN),
            i64::from(i32::MAX),
        )? as i32;
        let new_fact_id = int(&input.new_fact_id, "new_fact_id", i64::MIN, i64::MAX)?;
        let old_fact_id = int(&input.old_fact_id, "old_fact_id", i64::MIN, i64::MAX)?;
        let direction = text_column(&input.direction, TABLE, "direction")?;
        let p_supersede = real_arg(
            input
                .p_supersede
                .ok_or_else(|| not_null(TABLE, "p_supersede"))?,
            "p_supersede",
        )?;
        let threshold = input
            .threshold
            .map(|v| real_arg(v, "threshold"))
            .transpose()?;
        let proposal_floor = real_arg(
            input
                .proposal_floor
                .ok_or_else(|| not_null(TABLE, "proposal_floor"))?,
            "proposal_floor",
        )?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let id = next_id(tx, NEXT_PROPOSAL_ID)?;
            if tx.get(&sweep_slot_key(&sweep_id, pair_index))?.is_some() {
                return Ok(None);
            }
            let claim = like(&sweep_id, "claim_conflicts:%", false)?;
            let pair_key = claim_pair_key(&source_id, new_fact_id, old_fact_id);
            if claim && tx.get(&pair_key)?.is_some() {
                return Ok(None);
            }
            let record = ProposalRecord {
                id,
                created_at_us: now,
                source_id: source_id.clone(),
                sweep_id: sweep_id.clone(),
                pair_index,
                new_fact_id,
                old_fact_id,
                direction: direction.clone(),
                p_supersede,
                threshold,
                proposal_floor,
                model_resolved: input.model_resolved.clone(),
                status: "pending".to_string(),
                decided_at_us: None,
                before_state: None,
                after_state: None,
            };
            put_json(tx, &id_key(PROPOSAL, id), &record)?;
            tx.put(&sweep_slot_key(&sweep_id, pair_index), &id.to_be_bytes())?;
            if claim {
                tx.put(&pair_key, &id.to_be_bytes())?;
            }
            Ok(Some(id))
        })
    }

    /// `getDecideProposal(id)`: the proposal row, or `None`.
    pub fn get_decide_proposal(&self, id: i64) -> Result<Option<Value>> {
        let Some(id) = row_id(id) else {
            return Ok(None);
        };
        let read = self.read()?;
        let record: Option<ProposalRecord> = get_json(&*read, &id_key(PROPOSAL, id))?;
        Ok(record.map(|r| r.to_json()))
    }

    /// `listDecideProposalIds(sweepId, status)`: the ids of one sweep's proposals in a status, by
    /// pair index.
    pub fn list_decide_proposal_ids(&self, sweep_id: &str, status: &str) -> Result<Vec<u64>> {
        no_nul("listDecideProposalIds", &[("sweep_id", sweep_id)])?;
        let read = self.read()?;
        let mut ids = Vec::new();
        scan_prefix(
            &*read,
            &text_key(PROPOSAL_SWEEP, &[sweep_id], &[]),
            false,
            &mut |_, v| {
                ids.push(v.to_vec());
                true
            },
        )?;
        let mut out = Vec::new();
        for raw in ids {
            let id = id_at(&raw)?;
            let record: Option<ProposalRecord> = get_json(&*read, &id_key(PROPOSAL, id))?;
            if let Some(r) = record.filter(|r| r.status == status) {
                out.push(r.id);
            }
        }
        Ok(out)
    }

    /// `listDecideProposals({ status?, limit? })`: proposals with both facts' text and the entity
    /// (the new fact's, else the old fact's), `created_at, id` order. Status `all` lists every one.
    pub fn list_decide_proposals(
        &self,
        options: &ListDecideProposalsOptions,
    ) -> Result<Vec<Value>> {
        let status = options.status.as_deref().unwrap_or("pending");
        let limit = match options.limit {
            Some(n) => limit_of(n)?,
            None => DEFAULT_LIST_LIMIT,
        };
        let read = self.read()?;
        let mut rows: Vec<ProposalRecord> = read_all(&*read, &tagged(PROPOSAL))?;
        rows.retain(|r| status == "all" || r.status == status);
        rows.sort_by_key(|r| (r.created_at_us, r.id));
        let mut out = Vec::new();
        for record in rows.into_iter().take(limit) {
            let new = fact_text(&*read, record.new_fact_id)?;
            let old = fact_text(&*read, record.old_fact_id)?;
            let entity = new
                .as_ref()
                .and_then(|(_, e)| e.clone())
                .or_else(|| old.as_ref().and_then(|(_, e)| e.clone()));
            let mut row = record.to_json();
            row["new_fact"] = json!(new.map(|(t, _)| t));
            row["old_fact"] = json!(old.map(|(t, _)| t));
            row["entity_slug"] = json!(entity);
            out.push(row);
        }
        Ok(out)
    }

    /// `transitionDecideProposal(id, from, to, state?)`: moves the proposal from `from` to `to`,
    /// stamps the decision time and records the states given (a null keeps the stored one).
    /// `false` when the proposal does not exist or is not in `from`.
    pub fn transition_decide_proposal(&self, input: &DecideProposalTransition) -> Result<bool> {
        no_nul(
            "transitionDecideProposal",
            &[
                ("from", &input.from),
                ("to", &input.to),
                ("before", input.before.as_deref().unwrap_or("")),
                ("after", input.after.as_deref().unwrap_or("")),
            ],
        )?;
        let Some(id) = row_id(input.id) else {
            return Ok(false);
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            let key = id_key(PROPOSAL, id);
            let Some(mut record) = get_json::<ProposalRecord>(&*tx, &key)? else {
                return Ok(false);
            };
            if record.status != input.from {
                return Ok(false);
            }
            record.status = input.to.clone();
            record.decided_at_us = Some(now);
            if input.before.is_some() {
                record.before_state = input.before.clone();
            }
            if input.after.is_some() {
                record.after_state = input.after.clone();
            }
            put_json(tx, &key, &record)?;
            Ok(true)
        })
    }

    /// `listDecideProposedPairs(sourceId, factId)`: the `{a, b}` pairs (`a <= b`) of the source's
    /// proposals, in any status, that name the fact on either side.
    pub fn list_decide_proposed_pairs(&self, source_id: &str, fact_id: i64) -> Result<Vec<Value>> {
        let read = self.read()?;
        let rows: Vec<ProposalRecord> = read_all(&*read, &tagged(PROPOSAL))?;
        Ok(rows
            .into_iter()
            .filter(|r| r.source_id == source_id && (r.new_fact_id == fact_id || r.old_fact_id == fact_id))
            .map(|r| {
                json!({ "a": r.new_fact_id.min(r.old_fact_id), "b": r.new_fact_id.max(r.old_fact_id) })
            })
            .collect())
    }
}

// ------------------------------------------------------------------ review proposals

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ReviewProposalRecord {
    pub id: u64,
    pub created_at_us: i64,
    pub kind: String,
    pub source_id: String,
    pub sweep_id: String,
    pub a_ref: String,
    pub b_ref: String,
    pub subject: String,
    pub visibility: Option<String>,
    pub p_action: f32,
    pub threshold: Option<f32>,
    pub model_resolved: Option<String>,
    pub question_version: Option<String>,
    pub status: String,
    pub decided_at_us: Option<i64>,
    pub receipt: Option<String>,
}

impl ReviewProposalRecord {
    /// The listing columns, timestamps as `timestamptz::text`.
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind,
            "source_id": self.source_id,
            "sweep_id": self.sweep_id,
            "a_ref": self.a_ref,
            "b_ref": self.b_ref,
            "subject": self.subject,
            "visibility": self.visibility,
            "p_action": real(self.p_action),
            "threshold": self.threshold.map(real),
            "model_resolved": self.model_resolved,
            "status": self.status,
            "created_at": timestamptz_text(self.created_at_us),
            "decided_at": self.decided_at_us.map(timestamptz_text),
            "receipt": self.receipt,
        })
    }
}

/// The shadow seed (`seed.rs`): stores a review proposal copied from another engine with its own
/// id and times, and its unique key as [`Store::insert_decide_review_proposal`] writes it.
pub(crate) fn seed_review_proposal(
    tx: &mut dyn KvWrite,
    record: &ReviewProposalRecord,
) -> Result<Seeded> {
    if tx.get(&id_key(REVIEW_PROPOSAL, record.id))?.is_some() {
        return Ok(Seeded::Present);
    }
    let unique = review_key(
        &record.kind,
        &record.source_id,
        &record.a_ref,
        &record.b_ref,
        &record.subject,
    );
    if tx.get(&unique)?.is_some() {
        return Ok(Seeded::Conflict(
            "decide_review_proposals (kind, source_id, a_ref, b_ref, subject)",
        ));
    }
    put_json(tx, &id_key(REVIEW_PROPOSAL, record.id), record)?;
    tx.put(&unique, &record.id.to_be_bytes())?;
    Ok(Seeded::Stored)
}

/// `NewReviewProposal`. Every field is optional here so a missing one fails as Postgres fails it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DecideReviewProposalInput {
    pub kind: Option<String>,
    pub source_id: Option<String>,
    pub sweep_id: Option<String>,
    pub a_ref: Option<String>,
    pub b_ref: Option<String>,
    pub subject: Option<String>,
    pub visibility: Option<String>,
    pub p_action: Option<f64>,
    pub threshold: Option<f64>,
    pub model_resolved: Option<String>,
    pub question_version: Option<String>,
    pub receipt: Option<String>,
}

/// `transitionDecideReviewProposal`: a status change.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DecideReviewProposalTransition {
    pub id: i64,
    pub from: String,
    pub to: String,
}

fn review_key(kind: &str, source_id: &str, a_ref: &str, b_ref: &str, subject: &str) -> Vec<u8> {
    text_key(
        REVIEW_PROPOSAL_KEY,
        &[kind, source_id, a_ref, b_ref, subject],
        &[],
    )
}

impl Store {
    /// `insertDecideReviewProposal(p)`: the new proposal's id, or `None` when a proposal with the
    /// same `(kind, source_id, a_ref, b_ref, subject)` exists. The id is used up either way.
    pub fn insert_decide_review_proposal(
        &self,
        input: &DecideReviewProposalInput,
    ) -> Result<Option<u64>> {
        const TABLE: &str = "decide_review_proposals";
        let optional = |value: &Option<String>| value.clone().unwrap_or_default();
        no_nul(
            "insertDecideReviewProposal",
            &[
                ("kind", &optional(&input.kind)),
                ("source_id", &optional(&input.source_id)),
                ("sweep_id", &optional(&input.sweep_id)),
                ("a_ref", &optional(&input.a_ref)),
                ("b_ref", &optional(&input.b_ref)),
                ("subject", &optional(&input.subject)),
                ("visibility", &optional(&input.visibility)),
                ("model_resolved", &optional(&input.model_resolved)),
                ("question_version", &optional(&input.question_version)),
                ("receipt", &optional(&input.receipt)),
            ],
        )?;
        let kind = text_column(&input.kind, TABLE, "kind")?;
        let source_id = text_column(&input.source_id, TABLE, "source_id")?;
        let sweep_id = text_column(&input.sweep_id, TABLE, "sweep_id")?;
        let a_ref = text_column(&input.a_ref, TABLE, "a_ref")?;
        let b_ref = text_column(&input.b_ref, TABLE, "b_ref")?;
        let subject = text_column(&input.subject, TABLE, "subject")?;
        let p_action = real_arg(
            input.p_action.ok_or_else(|| not_null(TABLE, "p_action"))?,
            "p_action",
        )?;
        let threshold = input
            .threshold
            .map(|v| real_arg(v, "threshold"))
            .transpose()?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let id = next_id(tx, NEXT_REVIEW_PROPOSAL_ID)?;
            let unique = review_key(&kind, &source_id, &a_ref, &b_ref, &subject);
            if tx.get(&unique)?.is_some() {
                return Ok(None);
            }
            let record = ReviewProposalRecord {
                id,
                created_at_us: now,
                kind: kind.clone(),
                source_id: source_id.clone(),
                sweep_id: sweep_id.clone(),
                a_ref: a_ref.clone(),
                b_ref: b_ref.clone(),
                subject: subject.clone(),
                visibility: input.visibility.clone(),
                p_action,
                threshold,
                model_resolved: input.model_resolved.clone(),
                question_version: input.question_version.clone(),
                status: "pending".to_string(),
                decided_at_us: None,
                receipt: input.receipt.clone(),
            };
            put_json(tx, &id_key(REVIEW_PROPOSAL, id), &record)?;
            tx.put(&unique, &id.to_be_bytes())?;
            Ok(Some(id))
        })
    }

    /// `listDecideReviewProposals(status)`: the proposals in a status (`all` for every one), by id.
    pub fn list_decide_review_proposals(&self, status: &str) -> Result<Vec<Value>> {
        let read = self.read()?;
        let rows: Vec<ReviewProposalRecord> = read_all(&*read, &tagged(REVIEW_PROPOSAL))?;
        Ok(rows
            .iter()
            .filter(|r| status == "all" || r.status == status)
            .map(|r| r.to_json())
            .collect())
    }

    /// `getDecideReviewProposal(id)`: the proposal row, or `None`.
    pub fn get_decide_review_proposal(&self, id: i64) -> Result<Option<Value>> {
        let Some(id) = row_id(id) else {
            return Ok(None);
        };
        let read = self.read()?;
        let record: Option<ReviewProposalRecord> = get_json(&*read, &id_key(REVIEW_PROPOSAL, id))?;
        Ok(record.map(|r| r.to_json()))
    }

    /// `transitionDecideReviewProposal(id, from, to)`: moves the proposal from `from` to `to` and
    /// stamps the decision time. `false` when the proposal does not exist or is not in `from`.
    pub fn transition_decide_review_proposal(
        &self,
        input: &DecideReviewProposalTransition,
    ) -> Result<bool> {
        no_nul(
            "transitionDecideReviewProposal",
            &[("from", &input.from), ("to", &input.to)],
        )?;
        let Some(id) = row_id(input.id) else {
            return Ok(false);
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            let key = id_key(REVIEW_PROPOSAL, id);
            let Some(mut record) = get_json::<ReviewProposalRecord>(&*tx, &key)? else {
                return Ok(false);
            };
            if record.status != input.from {
                return Ok(false);
            }
            record.status = input.to.clone();
            record.decided_at_us = Some(now);
            put_json(tx, &key, &record)?;
            Ok(true)
        })
    }

    /// `listDecideReviewProposalIds(sweepId, includeWithdrawals)`: the pending proposals of one
    /// sweep, by id; `withdraw` ones only when asked.
    pub fn list_decide_review_proposal_ids(
        &self,
        sweep_id: &str,
        include_withdrawals: bool,
    ) -> Result<Vec<u64>> {
        let read = self.read()?;
        let rows: Vec<ReviewProposalRecord> = read_all(&*read, &tagged(REVIEW_PROPOSAL))?;
        Ok(rows
            .iter()
            .filter(|r| {
                r.sweep_id == sweep_id
                    && r.status == "pending"
                    && (include_withdrawals || r.kind != "withdraw")
            })
            .map(|r| r.id)
            .collect())
    }

    /// `readProposalReviewRates()`: per kind (`supersede` for the supersede proposals, the review
    /// kind for the review ones), the pending count, the age in days of the oldest pending
    /// proposal and the accepted (also `accepted_no_action`) and rejected counts of the last 30
    /// days. A kind with no proposal has no row. Supersede first, then the review kinds by name.
    pub fn read_proposal_review_rates(&self) -> Result<Vec<Value>> {
        let now = self.env.now_micros();
        let read = self.read()?;
        let supersede: Vec<ProposalRecord> = read_all(&*read, &tagged(PROPOSAL))?;
        let review: Vec<ReviewProposalRecord> = read_all(&*read, &tagged(REVIEW_PROPOSAL))?;
        let mut groups: Vec<(String, Vec<Rated>)> = Vec::new();
        if !supersede.is_empty() {
            let rows = supersede.iter().map(Rated::of_supersede).collect();
            groups.push(("supersede".to_string(), rows));
        }
        let mut kinds: Vec<&str> = review.iter().map(|r| r.kind.as_str()).collect();
        kinds.sort_unstable();
        kinds.dedup();
        for kind in kinds {
            let rows = review
                .iter()
                .filter(|r| r.kind == kind)
                .map(Rated::of_review)
                .collect();
            groups.push((kind.to_string(), rows));
        }
        Ok(groups
            .into_iter()
            .map(|(kind, rows)| {
                let pending = rows.iter().filter(|r| r.status == "pending").count();
                let oldest = rows
                    .iter()
                    .filter(|r| r.status == "pending")
                    .map(|r| r.created_at_us)
                    .min()
                    .map(|created| (now - created) as f64 / 1_000_000.0 / 86_400.0);
                let decided = |statuses: &[&str]| {
                    rows.iter()
                        .filter(|r| statuses.contains(&r.status.as_str()))
                        .filter(|r| r.decided_at_us.is_some_and(|d| d > now - RATE_WINDOW_US))
                        .count()
                };
                json!({
                    "kind": kind,
                    "pending": pending,
                    "oldest": oldest,
                    "accepted": decided(&["accepted", "accepted_no_action"]),
                    "rejected": decided(&["rejected"]),
                })
            })
            .collect())
    }
}

/// The columns of a proposal that the rates read, from either table.
struct Rated {
    status: String,
    created_at_us: i64,
    decided_at_us: Option<i64>,
}

impl Rated {
    fn of_supersede(r: &ProposalRecord) -> Rated {
        Rated {
            status: r.status.clone(),
            created_at_us: r.created_at_us,
            decided_at_us: r.decided_at_us,
        }
    }

    fn of_review(r: &ReviewProposalRecord) -> Rated {
        Rated {
            status: r.status.clone(),
            created_at_us: r.created_at_us,
            decided_at_us: r.decided_at_us,
        }
    }
}

// ------------------------------------------------------------------ review queue

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct QueueRecord {
    pub kind: String,
    pub source_id: String,
    pub a_ref: String,
    pub b_ref: String,
    pub evidence: Option<String>,
    pub reason: String,
    pub attempts: i32,
    pub next_attempt_us: i64,
    pub created_at_us: i64,
}

/// The shadow seed (`seed.rs`): stores a review-queue row copied from another engine with its own
/// attempts and times. `false` when the pair is already queued.
pub(crate) fn seed_review_queue(tx: &mut dyn KvWrite, record: &QueueRecord) -> Result<bool> {
    let key = queue_key(
        &record.kind,
        &record.source_id,
        &record.a_ref,
        &record.b_ref,
    );
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    put_json(tx, &key, record)?;
    Ok(true)
}

/// What `applyDecideReviewQueue` runs: queue a pair, drop a row, or push a row back.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum ReviewQueueOp {
    Enqueue {
        kind: String,
        source_id: String,
        a_ref: String,
        b_ref: String,
        #[serde(default)]
        evidence: Option<String>,
    },
    Clear {
        kind: String,
        source_id: String,
        a_ref: String,
        b_ref: String,
    },
    Defer {
        kind: String,
        source_id: String,
        a_ref: String,
        b_ref: String,
        reason: String,
    },
}

impl Store {
    /// `listDueDecideReviewQueue(kind, sourceId, limit)`: the rows of one kind and source with
    /// fewer than five attempts whose time has come, by due time, creation time, `a_ref`, `b_ref`
    /// (bytewise, as `COLLATE "C"`).
    pub fn list_due_decide_review_queue(
        &self,
        kind: &str,
        source_id: &str,
        limit: i64,
    ) -> Result<Vec<Value>> {
        no_nul(
            "listDueDecideReviewQueue",
            &[("kind", kind), ("source_id", source_id)],
        )?;
        let limit = limit_of(limit)?;
        let now = self.env.now_micros();
        let read = self.read()?;
        let mut rows: Vec<QueueRecord> =
            read_all(&*read, &text_key(REVIEW_QUEUE, &[kind, source_id], &[]))?;
        rows.retain(|r| r.attempts < MAX_ATTEMPTS && r.next_attempt_us <= now);
        rows.sort_by(|a, b| {
            (
                a.next_attempt_us,
                a.created_at_us,
                a.a_ref.as_bytes(),
                a.b_ref.as_bytes(),
            )
                .cmp(&(
                    b.next_attempt_us,
                    b.created_at_us,
                    b.a_ref.as_bytes(),
                    b.b_ref.as_bytes(),
                ))
        });
        Ok(rows
            .into_iter()
            .take(limit)
            .map(|r| {
                json!({
                    "kind": r.kind, "source_id": r.source_id, "a_ref": r.a_ref,
                    "b_ref": r.b_ref, "attempts": r.attempts,
                })
            })
            .collect())
    }

    /// `applyDecideReviewQueue(op)`: queues a pair (nothing when it is queued), deletes a row, or
    /// defers it (one more attempt, the reason, and ten minutes per attempt). The number of rows
    /// touched, 0 or 1.
    pub fn apply_decide_review_queue(&self, op: &ReviewQueueOp) -> Result<u64> {
        let now = self.env.now_micros();
        let (kind, source_id, a_ref, b_ref) = match op {
            ReviewQueueOp::Enqueue {
                kind,
                source_id,
                a_ref,
                b_ref,
                ..
            }
            | ReviewQueueOp::Clear {
                kind,
                source_id,
                a_ref,
                b_ref,
            }
            | ReviewQueueOp::Defer {
                kind,
                source_id,
                a_ref,
                b_ref,
                ..
            } => (kind, source_id, a_ref, b_ref),
        };
        no_nul(
            "applyDecideReviewQueue",
            &[
                ("kind", kind),
                ("source_id", source_id),
                ("a_ref", a_ref),
                ("b_ref", b_ref),
            ],
        )?;
        let key = queue_key(kind, source_id, a_ref, b_ref);
        self.write(|tx| match op {
            ReviewQueueOp::Enqueue { evidence, .. } => {
                if tx.get(&key)?.is_some() {
                    return Ok(0);
                }
                let record = QueueRecord {
                    kind: kind.clone(),
                    source_id: source_id.clone(),
                    a_ref: a_ref.clone(),
                    b_ref: b_ref.clone(),
                    evidence: evidence.clone(),
                    reason: "queued".to_string(),
                    attempts: 0,
                    next_attempt_us: now,
                    created_at_us: now,
                };
                put_json(tx, &key, &record)?;
                Ok(1)
            }
            ReviewQueueOp::Clear { .. } => {
                if tx.get(&key)?.is_none() {
                    return Ok(0);
                }
                tx.delete(&key)?;
                Ok(1)
            }
            ReviewQueueOp::Defer { reason, .. } => {
                let Some(mut record) = get_json::<QueueRecord>(&*tx, &key)? else {
                    return Ok(0);
                };
                record.attempts = record.attempts.saturating_add(1);
                record.reason = reason.clone();
                record.next_attempt_us = now + i64::from(record.attempts) * QUEUE_BACKOFF_US;
                put_json(tx, &key, &record)?;
                Ok(1)
            }
        })
    }
}

// ------------------------------------------------------------------ sweep retries

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DeferredRecord {
    pub source_id: String,
    pub fact_id: i64,
    pub slot: String,
    pub reason: String,
    pub attempts: i32,
    pub next_attempt_us: i64,
    pub created_at_us: i64,
}

/// The shadow seed (`seed.rs`): stores a conflict-sweep retry row copied from another engine with
/// its own attempts and times. `false` when `(slot, source_id, fact_id)` already holds a row.
pub(crate) fn seed_sweep_deferred(tx: &mut dyn KvWrite, record: &DeferredRecord) -> Result<bool> {
    let key = deferred_key(&record.slot, &record.source_id, record.fact_id);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    put_json(tx, &key, record)?;
    Ok(true)
}

/// What `applyDecideSweepDeferred` runs: back a fact off, hand over relinked facts, or drop a row.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum SweepDeferredOp {
    Defer { fact_id: Value, reason: String },
    Relinked { fact_ids: Vec<Value> },
    Clear { fact_id: Value },
}

impl Store {
    /// `listDueDecideSweepDeferred(sourceId, limit)`: the source's conflict retries with fewer than
    /// five attempts whose time has come, by due time and fact id.
    pub fn list_due_decide_sweep_deferred(
        &self,
        source_id: &str,
        limit: i64,
    ) -> Result<Vec<Value>> {
        no_nul("listDueDecideSweepDeferred", &[("source_id", source_id)])?;
        let limit = limit_of(limit)?;
        let now = self.env.now_micros();
        let read = self.read()?;
        let mut rows: Vec<DeferredRecord> = read_all(
            &*read,
            &text_key(SWEEP_DEFERRED, &[CONFLICT_SLOT, source_id], &[]),
        )?;
        rows.retain(|r| r.attempts < MAX_ATTEMPTS && r.next_attempt_us <= now);
        rows.sort_by_key(|r| (r.next_attempt_us, r.fact_id));
        Ok(rows
            .into_iter()
            .take(limit)
            .map(|r| json!({ "fact_id": r.fact_id, "attempts": r.attempts }))
            .collect())
    }

    /// `applyDecideSweepDeferred(sourceId, op)`: `defer` backs the fact off 30 minutes times its
    /// attempts so far (a new row: 30 minutes, one attempt) and keeps the reason; `relinked` queues
    /// each fact that has no row (attempts 0, due now, reason `relinked`); `clear` drops the row.
    /// The number of rows written or deleted.
    pub fn apply_decide_sweep_deferred(
        &self,
        source_id: &str,
        op: &SweepDeferredOp,
    ) -> Result<u64> {
        no_nul("applyDecideSweepDeferred", &[("source_id", source_id)])?;
        let fact = |value: &Value| {
            whole(
                value,
                "applyDecideSweepDeferred fact id",
                i64::MIN,
                i64::MAX,
            )
        };
        let now = self.env.now_micros();
        match op {
            SweepDeferredOp::Defer { fact_id, reason } => {
                no_nul("applyDecideSweepDeferred", &[("reason", reason)])?;
                let fact_id = fact(fact_id)?;
                self.write(|tx| {
                    let key = deferred_key(CONFLICT_SLOT, source_id, fact_id);
                    let record = match get_json::<DeferredRecord>(&*tx, &key)? {
                        Some(mut old) => {
                            old.reason = reason.clone();
                            old.attempts = old.attempts.saturating_add(1);
                            old.next_attempt_us =
                                now + i64::from(old.attempts) * DEFERRED_BACKOFF_US;
                            old
                        }
                        None => DeferredRecord {
                            source_id: source_id.to_string(),
                            fact_id,
                            slot: CONFLICT_SLOT.to_string(),
                            reason: reason.clone(),
                            attempts: 1,
                            next_attempt_us: now + DEFERRED_BACKOFF_US,
                            created_at_us: now,
                        },
                    };
                    put_json(tx, &key, &record)?;
                    Ok(1)
                })
            }
            SweepDeferredOp::Relinked { fact_ids } => {
                let ids = fact_ids.iter().map(&fact).collect::<Result<Vec<i64>>>()?;
                if ids.is_empty() {
                    return Ok(0);
                }
                self.write(|tx| {
                    let mut queued = 0;
                    for &fact_id in &ids {
                        let key = deferred_key(CONFLICT_SLOT, source_id, fact_id);
                        if tx.get(&key)?.is_some() {
                            continue;
                        }
                        let record = DeferredRecord {
                            source_id: source_id.to_string(),
                            fact_id,
                            slot: CONFLICT_SLOT.to_string(),
                            reason: "relinked".to_string(),
                            attempts: 0,
                            next_attempt_us: now,
                            created_at_us: now,
                        };
                        put_json(tx, &key, &record)?;
                        queued += 1;
                    }
                    Ok(queued)
                })
            }
            SweepDeferredOp::Clear { fact_id } => {
                let key = deferred_key(CONFLICT_SLOT, source_id, fact(fact_id)?);
                self.write(|tx| {
                    if tx.get(&key)?.is_none() {
                        return Ok(0);
                    }
                    tx.delete(&key)?;
                    Ok(1)
                })
            }
        }
    }
}

// ------------------------------------------------------------------ the shadow follow

/// The shadow follow (`seed/follow.rs`): removes the supersede proposal `id` with its sweep-slot
/// key and claim-pair key, each only when it names the proposal. `false` when there is none.
pub(crate) fn remove_proposal(tx: &mut dyn KvWrite, id: u64) -> Result<bool> {
    let Some(record) = get_json::<ProposalRecord>(&*tx, &id_key(PROPOSAL, id))? else {
        return Ok(false);
    };
    let slot = sweep_slot_key(&record.sweep_id, record.pair_index);
    let pair = claim_pair_key(&record.source_id, record.new_fact_id, record.old_fact_id);
    for key in [slot, pair] {
        if tx.get(&key)?.as_deref() == Some(&id.to_be_bytes()[..]) {
            tx.delete(&key)?;
        }
    }
    tx.delete(&id_key(PROPOSAL, id))?;
    Ok(true)
}

/// The shadow follow: removes the review proposal `id` with its unique key. `false` when there is
/// none.
pub(crate) fn remove_review_proposal(tx: &mut dyn KvWrite, id: u64) -> Result<bool> {
    let Some(record) = get_json::<ReviewProposalRecord>(&*tx, &id_key(REVIEW_PROPOSAL, id))? else {
        return Ok(false);
    };
    let unique = review_key(
        &record.kind,
        &record.source_id,
        &record.a_ref,
        &record.b_ref,
        &record.subject,
    );
    if tx.get(&unique)?.as_deref() == Some(&id.to_be_bytes()[..]) {
        tx.delete(&unique)?;
    }
    tx.delete(&id_key(REVIEW_PROPOSAL, id))?;
    Ok(true)
}

/// The shadow follow: removes the review-queue row of a pair. `false` when it is not queued.
pub(crate) fn remove_review_queue(
    tx: &mut dyn KvWrite,
    kind: &str,
    source_id: &str,
    a_ref: &str,
    b_ref: &str,
) -> Result<bool> {
    if [kind, source_id, a_ref, b_ref]
        .iter()
        .any(|t| t.contains('\0'))
    {
        return Ok(false);
    }
    let key = queue_key(kind, source_id, a_ref, b_ref);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}

/// The shadow follow: removes the conflict-sweep retry row `(slot, source_id, fact_id)`. `false`
/// when there is none.
pub(crate) fn remove_sweep_deferred(
    tx: &mut dyn KvWrite,
    slot: &str,
    source_id: &str,
    fact_id: i64,
) -> Result<bool> {
    if slot.contains('\0') || source_id.contains('\0') {
        return Ok(false);
    }
    let key = deferred_key(slot, source_id, fact_id);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}
