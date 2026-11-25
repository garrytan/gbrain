//! Pinned questions: the `pinned_questions` and `question_evidence` tables as the members of
//! `src/core/engine-sql/question-store.ts` run them (rust/docs/store/questions.md): the idempotent pin insert, the reads
//! of one pin and of a listing, a state change, the refresh lease, spend, the blocked record, and a publication's answer
//! write and evidence rewrite. The two reads of the records (`questions/join.rs`) join the evidence to the rows it cites.
//!
//! Members: readPinRow, listPinRows, insertPinRow, updatePinRowState, acquirePinLease, releasePinLease, addPinSpend,
//! recordPinBlocked, lockPinRowForPublish, publishPinAnswer, deleteQuestionEvidence, insertQuestionEvidence,
//! listQuestionEvidenceJoin, listPublishedQuestionAnswers.
//!
//! Keys, all under the two-byte family tag `keys::QUESTIONS` (`~q`):
//! - `~q 0x01 id(BE8) -> PinRecord`: one `pinned_questions` row, every column, with the table's defaults; the id is the
//!   `BIGSERIAL` (`M next_pinned_question_id`).
//! - `~q 0x02 source_id 0x00 slug -> id(BE8)`: the unique `(source_id, slug)` index (`pinned_questions_source_slug_key`).
//! - `~q 0x03 question_id(BE8) evidence_id(BE8) -> EvidenceRecord`: one `question_evidence` row under the pin it
//!   belongs to, so the publication's `DELETE ... WHERE question_id` and the read of one pin's evidence are one prefix
//!   scan; the id is the `BIGSERIAL` (`M next_question_evidence_id`).
//! - `~q 0x04` is kept for a `question_evidence` index and unused.
//!
//! No text part holds a NUL byte (Postgres `text` refuses one too), so the `0x02` split is exact.
//!
//! Time: `now()` is the store clock at the write; inside a transaction it is the transaction's clock, as Postgres
//! `now()` is the transaction start (`transactions.rs`, "Time"). Every write reads it once.
//!
//! Columns: `REAL` `cooldown_days` is kept as `f32` bits and `DOUBLE PRECISION` `spend_usd` as `f64` bits (arithmetic as
//! Postgres does it; NaN and the infinities survive, which a JSON number cannot carry: a non-finite value crosses the
//! binding as its Postgres text, `NaN`, `Infinity`, `-Infinity`). Times come back as ISO text; the TypeScript member
//! turns them into `Date`s. Not kept: the secondary index `pinned_questions_state_idx` (a listing scans the table).
//! A duplicate insert does not burn an id, which Postgres' `nextval` does; no member returns the number of ids used.

use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::keys::{self, QUESTIONS};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::{Store, get_json, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

mod join;
#[cfg(test)]
mod tests;

const PIN: u8 = 0x01;
const PIN_SLUG: u8 = 0x02;
const EVIDENCE: u8 = 0x03;

pub(crate) const NEXT_PIN_ID: &str = "next_pinned_question_id";
pub(crate) const NEXT_EVIDENCE_ID: &str = "next_question_evidence_id";

fn family(sub: u8) -> Vec<u8> {
    let mut k = QUESTIONS.to_vec();
    k.push(sub);
    k
}

fn pin_key(id: u64) -> Vec<u8> {
    let mut k = family(PIN);
    k.extend_from_slice(&id.to_be_bytes());
    k
}

fn slug_key(source_id: &str, slug: &str) -> Vec<u8> {
    let mut k = family(PIN_SLUG);
    k.extend_from_slice(source_id.as_bytes());
    k.push(0);
    k.extend_from_slice(slug.as_bytes());
    k
}

fn evidence_prefix(question_id: u64) -> Vec<u8> {
    let mut k = family(EVIDENCE);
    k.extend_from_slice(&question_id.to_be_bytes());
    k
}

fn evidence_key(question_id: u64, evidence_id: u64) -> Vec<u8> {
    let mut k = evidence_prefix(question_id);
    k.extend_from_slice(&evidence_id.to_be_bytes());
    k
}

/// One `pinned_questions` row. Times are microseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PinRecord {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub question: String,
    pub scope_slug_prefix: Option<String>,
    pub scope_entity: Option<String>,
    pub state: String,
    pub inactive_reason: Option<String>,
    pub publish_mode: String,
    pub model: Option<String>,
    /// `REAL`, as `f32::to_bits`.
    pub cooldown_bits: Option<u32>,
    pub origin: String,
    pub created_by: String,
    pub revision: i64,
    pub answer_revision: i32,
    pub answer: Option<String>,
    pub answer_model: Option<String>,
    pub last_refresh_at_us: Option<i64>,
    pub last_attempt_at_us: Option<i64>,
    pub last_error: Option<String>,
    pub watermark_generation: Option<i64>,
    pub watermark_fact_id: Option<i64>,
    pub watermark_at_us: Option<i64>,
    pub lease_token: Option<String>,
    pub lease_owner: Option<String>,
    pub lease_expires_at_us: Option<i64>,
    pub refresh_attempts: i32,
    /// `DOUBLE PRECISION`, as `f64::to_bits`.
    pub spend_bits: u64,
    pub created_at_us: i64,
    pub updated_at_us: i64,
    pub archived_at_us: Option<i64>,
}

impl PinRecord {
    pub(crate) fn spend(&self) -> f64 {
        f64::from_bits(self.spend_bits)
    }

    /// The row as `SELECT <columns>` returns it on the SQL engines: times as ISO text, `answer` as the stored text.
    fn to_row(&self) -> Value {
        let t = |m: Option<i64>| m.map(iso);
        json!({
            "id": self.id,
            "source_id": self.source_id,
            "slug": self.slug,
            "question": self.question,
            "scope_slug_prefix": self.scope_slug_prefix,
            "scope_entity": self.scope_entity,
            "state": self.state,
            "inactive_reason": self.inactive_reason,
            "publish_mode": self.publish_mode,
            "model": self.model,
            "cooldown_days": self.cooldown_bits.map(|b| real_json(f32::from_bits(b))),
            "origin": self.origin,
            "created_by": self.created_by,
            "revision": self.revision,
            "answer_revision": self.answer_revision,
            "answer": self.answer,
            "answer_model": self.answer_model,
            "last_refresh_at": t(self.last_refresh_at_us),
            "last_attempt_at": t(self.last_attempt_at_us),
            "last_error": self.last_error,
            "watermark_generation": self.watermark_generation,
            "watermark_fact_id": self.watermark_fact_id,
            "watermark_at": t(self.watermark_at_us),
            "lease_token": self.lease_token,
            "lease_owner": self.lease_owner,
            "lease_expires_at": t(self.lease_expires_at_us),
            "refresh_attempts": self.refresh_attempts,
            "spend_usd": float8_out(self.spend()),
            "created_at": iso(self.created_at_us),
            "archived_at": t(self.archived_at_us),
        })
    }
}

/// One `question_evidence` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EvidenceRecord {
    pub id: u64,
    pub question_id: u64,
    pub answer_revision: i32,
    pub sentence_id: String,
    pub kind: String,
    pub source_id: String,
    pub page_id: Option<i64>,
    pub page_slug: Option<String>,
    pub page_generation: Option<i64>,
    pub page_revision: Option<String>,
    pub item_id: Option<i64>,
    pub content_hash: Option<String>,
    pub created_at_us: i64,
}

/// A `REAL` as the number both SQL engines print: the shortest decimal that names the `f32`. NaN and the infinities
/// cross as their Postgres text.
fn real_json(x: f32) -> Value {
    if x.is_finite() {
        json!(format!("{x}").parse::<f64>().unwrap_or(f64::from(x)))
    } else {
        json!(non_finite(f64::from(x)))
    }
}

/// A `DOUBLE PRECISION` as a JSON number, or as its Postgres text when it is not finite.
fn float8_out(x: f64) -> Value {
    if x.is_finite() {
        json!(x)
    } else {
        json!(non_finite(x))
    }
}

fn non_finite(x: f64) -> &'static str {
    if x.is_nan() {
        "NaN"
    } else if x > 0.0 {
        "Infinity"
    } else {
        "-Infinity"
    }
}

/// A `double precision` argument: a number, or the text of a non-finite one (`NaN`, `Infinity`, `-Infinity`).
#[derive(Debug, Clone, Copy)]
pub struct Float8(pub f64);

impl<'de> Deserialize<'de> for Float8 {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        match Value::deserialize(d)? {
            Value::Number(n) => n
                .as_f64()
                .map(Float8)
                .ok_or_else(|| serde::de::Error::custom("a number outside the double range")),
            Value::String(s) => match s.as_str() {
                "NaN" => Ok(Float8(f64::NAN)),
                "Infinity" => Ok(Float8(f64::INFINITY)),
                "-Infinity" => Ok(Float8(f64::NEG_INFINITY)),
                other => Err(serde::de::Error::custom(format!(
                    "expected a number, got the text {other:?}"
                ))),
            },
            other => Err(serde::de::Error::custom(format!(
                "expected a number, got {other}"
            ))),
        }
    }
}

/// `insertPinRow(row)`: the columns `insertPin` writes; the others take the table's defaults.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinInsert {
    pub source_id: String,
    pub slug: String,
    pub question: String,
    #[serde(default)]
    pub scope_slug_prefix: Option<String>,
    #[serde(default)]
    pub scope_entity: Option<String>,
    pub state: String,
    #[serde(default)]
    pub inactive_reason: Option<String>,
    pub publish_mode: String,
    pub created_by: String,
}

/// `listPinRows(filter)`: `sourceIds` and `states` are `= ANY(...)` lists when present (an empty list matches nothing);
/// without `states`, archived pins show only when `includeArchived`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinFilter {
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    #[serde(default)]
    pub states: Option<Vec<String>>,
    #[serde(default)]
    pub include_archived: bool,
}

/// `updatePinRowState(id, patch)`: each null field is kept; `setInactiveReason` false keeps the reason too.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinStatePatch {
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub set_inactive_reason: bool,
    #[serde(default)]
    pub inactive_reason: Option<String>,
    #[serde(default)]
    pub publish_mode: Option<String>,
}

/// `publishPinAnswer(id, publish)`: what a publication writes on the pin row.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinAnswerPublish {
    pub answer: String,
    pub answer_model: String,
    pub watermark_generation: i64,
    pub watermark_fact_id: i64,
    pub spend_usd: Float8,
}

/// One row of `insertQuestionEvidence(rows)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceInsert {
    pub question_id: i64,
    pub answer_revision: i32,
    pub sentence_id: String,
    pub kind: String,
    pub source_id: String,
    #[serde(default)]
    pub page_id: Option<i64>,
    #[serde(default)]
    pub page_slug: Option<String>,
    #[serde(default)]
    pub page_generation: Option<i64>,
    #[serde(default)]
    pub page_revision: Option<String>,
    #[serde(default)]
    pub item_id: Option<i64>,
    #[serde(default)]
    pub content_hash: Option<String>,
}

fn read_pin(read: &dyn KvRead, id: u64) -> Result<Option<PinRecord>> {
    get_json(read, &pin_key(id))
}

fn read_pin_by_slug(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Option<PinRecord>> {
    if source_id.contains('\0') || slug.contains('\0') {
        return Ok(None);
    }
    let Some(bytes) = read.get(&slug_key(source_id, slug))? else {
        return Ok(None);
    };
    let id = keys::be8(&bytes)
        .ok_or_else(|| StoreError::new(crate::error::STORE_CORRUPT, "bad pinned question index"))?;
    read_pin(read, id)
}

/// Every pin, by id.
pub(crate) fn all_pins(read: &dyn KvRead) -> Result<Vec<PinRecord>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(read, &family(PIN), false, &mut |_, v| {
        match serde_json::from_slice::<PinRecord>(v) {
            Ok(r) => rows.push(r),
            Err(e) => {
                bad = Some(StoreError::from(e));
                return false;
            }
        }
        true
    })?;
    bad.map_or(Ok(rows), Err)
}

/// The evidence rows of one pin, by id.
pub(crate) fn evidence_of(read: &dyn KvRead, question_id: u64) -> Result<Vec<EvidenceRecord>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(read, &evidence_prefix(question_id), false, &mut |_, v| {
        match serde_json::from_slice::<EvidenceRecord>(v) {
            Ok(r) => rows.push(r),
            Err(e) => {
                bad = Some(StoreError::from(e));
                return false;
            }
        }
        true
    })?;
    bad.map_or(Ok(rows), Err)
}

/// The pin `id` names, or `None` for an id that is not a stored one (negative, too large, unknown).
fn pin_by_id(read: &dyn KvRead, id: i64) -> Result<Option<PinRecord>> {
    match u64::try_from(id) {
        Ok(id) => read_pin(read, id),
        Err(_) => Ok(None),
    }
}

fn put_pin(tx: &mut dyn KvWrite, pin: &PinRecord) -> Result<()> {
    put_json(tx, &pin_key(pin.id), pin)
}

/// A `now() + ttl * interval '1 millisecond'` in microseconds: the interval is rounded to the microsecond, halves to the even one.
fn lease_micros(now: i64, ttl_ms: f64) -> Result<i64> {
    let span = (ttl_ms * 1000.0).round_ties_even();
    if !span.is_finite() || span.abs() >= 9.0e18 {
        return Err(StoreError::invalid(
            "acquirePinLease: ttlMs is outside the interval range",
        ));
    }
    now.checked_add(span as i64)
        .ok_or_else(|| StoreError::invalid("acquirePinLease: the lease expiry is out of range"))
}

impl Store {
    /// `readPinRow(sourceId, slug, forUpdate)`: the row of the pin, or None. `forUpdate` reads the same row: a write
    /// transaction already holds the store's one writer, so nothing else changes it before the transaction ends.
    pub fn read_pin_row(
        &self,
        source_id: &str,
        slug: &str,
        _for_update: bool,
    ) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(read_pin_by_slug(&*read, source_id, slug)?.map(|p| p.to_row()))
    }

    /// `listPinRows(filter)`: the rows by source id in byte order (`ORDER BY source_id COLLATE "C"`), then by creation
    /// time, then by id.
    pub fn list_pin_rows(&self, filter: &PinFilter) -> Result<Value> {
        let read = self.read()?;
        let mut pins: Vec<PinRecord> = all_pins(&*read)?
            .into_iter()
            .filter(|p| {
                filter
                    .source_ids
                    .as_ref()
                    .is_none_or(|s| s.contains(&p.source_id))
            })
            .filter(|p| match &filter.states {
                Some(states) => states.contains(&p.state),
                None => filter.include_archived || p.state != "archived",
            })
            .collect();
        pins.sort_by(|a, b| {
            a.source_id
                .as_bytes()
                .cmp(b.source_id.as_bytes())
                .then(a.created_at_us.cmp(&b.created_at_us))
                .then(a.id.cmp(&b.id))
        });
        Ok(Value::Array(pins.iter().map(PinRecord::to_row).collect()))
    }

    /// `insertPinRow(row)`: the new pin's row, or None when `(source_id, slug)` has one (`ON CONFLICT DO NOTHING`).
    /// A NUL byte in a text refuses with `invalid_argument`.
    pub fn insert_pin_row(&self, row: &PinInsert) -> Result<Option<Value>> {
        let mut texts: Vec<(&str, &str)> = vec![
            ("source_id", &row.source_id),
            ("slug", &row.slug),
            ("question", &row.question),
            ("created_by", &row.created_by),
            ("state", &row.state),
            ("publish_mode", &row.publish_mode),
        ];
        for (name, value) in [
            ("scope_slug_prefix", &row.scope_slug_prefix),
            ("scope_entity", &row.scope_entity),
            ("inactive_reason", &row.inactive_reason),
        ] {
            if let Some(v) = value.as_deref() {
                texts.push((name, v));
            }
        }
        no_nul("insertPinRow", &texts)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            if tx.get(&slug_key(&row.source_id, &row.slug))?.is_some() {
                return Ok(None);
            }
            let id = next_id(tx, NEXT_PIN_ID)?;
            let pin = PinRecord {
                id,
                source_id: row.source_id.clone(),
                slug: row.slug.clone(),
                question: row.question.clone(),
                scope_slug_prefix: row.scope_slug_prefix.clone(),
                scope_entity: row.scope_entity.clone(),
                state: row.state.clone(),
                inactive_reason: row.inactive_reason.clone(),
                publish_mode: row.publish_mode.clone(),
                model: None,
                cooldown_bits: None,
                origin: "pin".to_string(),
                created_by: row.created_by.clone(),
                revision: 1,
                answer_revision: 0,
                answer: None,
                answer_model: None,
                last_refresh_at_us: None,
                last_attempt_at_us: None,
                last_error: None,
                watermark_generation: None,
                watermark_fact_id: None,
                watermark_at_us: None,
                lease_token: None,
                lease_owner: None,
                lease_expires_at_us: None,
                refresh_attempts: 0,
                spend_bits: 0.0f64.to_bits(),
                created_at_us: now,
                updated_at_us: now,
                archived_at_us: None,
            };
            put_pin(tx, &pin)?;
            tx.put(&slug_key(&row.source_id, &row.slug), &id.to_be_bytes())?;
            Ok(Some(pin.to_row()))
        })
    }

    /// `updatePinRowState(id, patch)`: the changed row, or None for an unknown id. The revision goes up by one;
    /// archiving stamps `archived_at` once and drops the lease token and expiry, any other state clears `archived_at`.
    pub fn update_pin_row_state(&self, id: i64, patch: &PinStatePatch) -> Result<Option<Value>> {
        let texts: Vec<(&str, &str)> = [
            ("state", &patch.state),
            ("inactive_reason", &patch.inactive_reason),
            ("publish_mode", &patch.publish_mode),
        ]
        .into_iter()
        .filter_map(|(n, v)| v.as_deref().map(|v| (n, v)))
        .collect();
        no_nul("updatePinRowState", &texts)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut pin) = pin_by_id(&*tx, id)? else {
                return Ok(None);
            };
            if let Some(state) = &patch.state {
                pin.state.clone_from(state);
            }
            if patch.set_inactive_reason {
                pin.inactive_reason.clone_from(&patch.inactive_reason);
            }
            if let Some(mode) = &patch.publish_mode {
                pin.publish_mode.clone_from(mode);
            }
            if pin.state == "archived" {
                pin.archived_at_us = Some(pin.archived_at_us.unwrap_or(now));
                pin.lease_token = None;
                pin.lease_expires_at_us = None;
            } else {
                pin.archived_at_us = None;
            }
            pin.revision += 1;
            pin.updated_at_us = now;
            put_pin(tx, &pin)?;
            Ok(Some(pin.to_row()))
        })
    }

    /// `acquirePinLease(id, token, owner, ttlMs)`: the leased row when the pin is not archived and holds no live lease
    /// (no token, no expiry, or an expiry before now), else None. Counts the attempt; leaves `updated_at` alone.
    pub fn acquire_pin_lease(
        &self,
        id: i64,
        token: &str,
        owner: &str,
        ttl_ms: Float8,
    ) -> Result<Option<Value>> {
        no_nul("acquirePinLease", &[("token", token), ("owner", owner)])?;
        let now = self.env.now_micros();
        let expires = lease_micros(now, ttl_ms.0)?;
        self.write(|tx| {
            let Some(mut pin) = pin_by_id(&*tx, id)? else {
                return Ok(None);
            };
            let free = pin.lease_token.is_none() || pin.lease_expires_at_us.is_none_or(|e| e < now);
            if pin.state == "archived" || !free {
                return Ok(None);
            }
            pin.lease_token = Some(token.to_string());
            pin.lease_owner = Some(owner.to_string());
            pin.lease_expires_at_us = Some(expires);
            pin.last_attempt_at_us = Some(now);
            pin.refresh_attempts += 1;
            put_pin(tx, &pin)?;
            Ok(Some(pin.to_row()))
        })
    }

    /// `releasePinLease(id, token, error, spendUsd)`: drops the lease `token` holds, records `error` and adds the spend;
    /// nothing when another lease (or none) holds the pin.
    pub fn release_pin_lease(
        &self,
        id: i64,
        token: &str,
        error: Option<String>,
        spend_usd: Float8,
    ) -> Result<()> {
        no_nul("releasePinLease", &[("token", token)])?;
        if let Some(e) = error.as_deref() {
            no_nul("releasePinLease", &[("error", e)])?;
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut pin) = pin_by_id(&*tx, id)? else {
                return Ok(());
            };
            if pin.lease_token.as_deref() != Some(token) {
                return Ok(());
            }
            pin.lease_token = None;
            pin.lease_owner = None;
            pin.lease_expires_at_us = None;
            pin.last_error.clone_from(&error);
            pin.spend_bits = (pin.spend() + spend_usd.0).to_bits();
            pin.updated_at_us = now;
            put_pin(tx, &pin)
        })
    }

    /// `addPinSpend(id, usd)`: adds `usd` to the pin's spend.
    pub fn add_pin_spend(&self, id: i64, usd: Float8) -> Result<()> {
        self.write(|tx| {
            let Some(mut pin) = pin_by_id(&*tx, id)? else {
                return Ok(());
            };
            pin.spend_bits = (pin.spend() + usd.0).to_bits();
            put_pin(tx, &pin)
        })
    }

    /// `recordPinBlocked(id, code)`: stamps the attempt and the cause unless a live lease holds the pin. A lease with a
    /// token and no expiry counts as live here (`lease_expires_at < now()` is NULL, not true).
    pub fn record_pin_blocked(&self, id: i64, code: &str) -> Result<()> {
        no_nul("recordPinBlocked", &[("code", code)])?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut pin) = pin_by_id(&*tx, id)? else {
                return Ok(());
            };
            if pin.lease_token.is_some() && !pin.lease_expires_at_us.is_some_and(|e| e < now) {
                return Ok(());
            }
            pin.last_attempt_at_us = Some(now);
            pin.last_error = Some(code.to_string());
            pin.updated_at_us = now;
            put_pin(tx, &pin)
        })
    }

    /// `lockPinRowForPublish(id)`: `{ revision, lease_token, state }` of the pin, or None. The row lock of
    /// `SELECT ... FOR UPDATE` is the store's one writer, which the publication's transaction already holds.
    pub fn lock_pin_row_for_publish(&self, id: i64) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(pin_by_id(&*read, id)?.map(
            |p| json!({ "revision": p.revision, "lease_token": p.lease_token, "state": p.state }),
        ))
    }

    /// `publishPinAnswer(id, publish)`: the next answer revision with its watermark and spend, the lease dropped and the
    /// last error cleared.
    pub fn publish_pin_answer(&self, id: i64, publish: &PinAnswerPublish) -> Result<()> {
        no_nul(
            "publishPinAnswer",
            &[
                ("answer", &publish.answer),
                ("answerModel", &publish.answer_model),
            ],
        )?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut pin) = pin_by_id(&*tx, id)? else {
                return Ok(());
            };
            pin.answer = Some(publish.answer.clone());
            pin.answer_revision += 1;
            pin.revision += 1;
            pin.answer_model = Some(publish.answer_model.clone());
            pin.last_refresh_at_us = Some(now);
            pin.last_error = None;
            pin.watermark_generation = Some(publish.watermark_generation);
            pin.watermark_fact_id = Some(publish.watermark_fact_id);
            pin.watermark_at_us = Some(now);
            pin.lease_token = None;
            pin.lease_owner = None;
            pin.lease_expires_at_us = None;
            pin.spend_bits = (pin.spend() + publish.spend_usd.0).to_bits();
            pin.updated_at_us = now;
            put_pin(tx, &pin)
        })
    }

    /// `deleteQuestionEvidence(questionId)`: deletes every evidence row of the pin.
    pub fn delete_question_evidence(&self, question_id: i64) -> Result<()> {
        let Ok(question_id) = u64::try_from(question_id) else {
            return Ok(());
        };
        self.write(|tx| remove_evidence_of(tx, question_id))
    }

    /// `insertQuestionEvidence(rows)`: inserts the rows in order, each under the next evidence id.
    pub fn insert_question_evidence(&self, rows: &[EvidenceInsert]) -> Result<()> {
        for r in rows {
            let mut texts: Vec<(&str, &str)> = vec![
                ("sentence_id", &r.sentence_id),
                ("kind", &r.kind),
                ("source_id", &r.source_id),
            ];
            for (name, value) in [
                ("page_slug", &r.page_slug),
                ("page_revision", &r.page_revision),
                ("content_hash", &r.content_hash),
            ] {
                if let Some(v) = value.as_deref() {
                    texts.push((name, v));
                }
            }
            no_nul("insertQuestionEvidence", &texts)?;
        }
        let question_ids = rows
            .iter()
            .map(|r| {
                u64::try_from(r.question_id).map_err(|_| {
                    StoreError::invalid("insertQuestionEvidence: questionId must not be negative")
                })
            })
            .collect::<Result<Vec<u64>>>()?;
        let now = self.env.now_micros();
        self.write(|tx| {
            for (r, &question_id) in rows.iter().zip(&question_ids) {
                let id = next_id(tx, NEXT_EVIDENCE_ID)?;
                let record = EvidenceRecord {
                    id,
                    question_id,
                    answer_revision: r.answer_revision,
                    sentence_id: r.sentence_id.clone(),
                    kind: r.kind.clone(),
                    source_id: r.source_id.clone(),
                    page_id: r.page_id,
                    page_slug: r.page_slug.clone(),
                    page_generation: r.page_generation,
                    page_revision: r.page_revision.clone(),
                    item_id: r.item_id,
                    content_hash: r.content_hash.clone(),
                    created_at_us: now,
                };
                put_json(tx, &evidence_key(question_id, id), &record)?;
            }
            Ok(())
        })
    }
}

/// Deletes every evidence row of `question_id`.
fn remove_evidence_of(tx: &mut dyn KvWrite, question_id: u64) -> Result<()> {
    let mut found = Vec::new();
    scan_prefix(&*tx, &evidence_prefix(question_id), false, &mut |k, _| {
        found.push(k.to_vec());
        true
    })?;
    for key in found {
        tx.delete(&key)?;
    }
    Ok(())
}

// ---- the shadow seed and its follow (seed/questions.rs) ----------------------------------------

/// The shadow seed: stores a pin copied from another engine with its own id and times. `false` when the id already
/// holds a row; a different pin on the same `(source_id, slug)` is the unique-index error. Raises the id counter.
pub(crate) fn seed_pin(tx: &mut dyn KvWrite, pin: &PinRecord) -> Result<bool> {
    if read_pin(&*tx, pin.id)?.is_some() {
        return Ok(false);
    }
    if tx.get(&slug_key(&pin.source_id, &pin.slug))?.is_some() {
        return Err(StoreError::new(
            crate::error::CONSTRAINT_VIOLATION,
            "duplicate key value violates unique constraint \"pinned_questions_source_slug_key\"",
        ));
    }
    put_pin(tx, pin)?;
    tx.put(&slug_key(&pin.source_id, &pin.slug), &pin.id.to_be_bytes())?;
    Ok(true)
}

/// The shadow follow: removes pin `id` and its `(source_id, slug)` key (when that key still names it). The evidence
/// rows stay: `question_evidence` has no foreign key, and the follow removes them as their own relation. `false` when
/// there is no such pin.
pub(crate) fn remove_pin(tx: &mut dyn KvWrite, id: u64) -> Result<bool> {
    let Some(old) = read_pin(&*tx, id)? else {
        return Ok(false);
    };
    let slug = slug_key(&old.source_id, &old.slug);
    if tx.get(&slug)?.is_some_and(|b| keys::be8(&b) == Some(id)) {
        tx.delete(&slug)?;
    }
    tx.delete(&pin_key(id))?;
    Ok(true)
}

/// The shadow seed: stores an evidence row copied from another engine with its own id and time. `false` when it exists.
pub(crate) fn seed_evidence(tx: &mut dyn KvWrite, row: &EvidenceRecord) -> Result<bool> {
    let key = evidence_key(row.question_id, row.id);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    put_json(tx, &key, row)?;
    Ok(true)
}

/// The shadow follow: removes evidence row `id` of `question_id`. `false` when there is none.
pub(crate) fn remove_evidence(tx: &mut dyn KvWrite, question_id: u64, id: u64) -> Result<bool> {
    let key = evidence_key(question_id, id);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}
