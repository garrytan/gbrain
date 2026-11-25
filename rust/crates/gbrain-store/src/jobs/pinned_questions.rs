//! Jobs: the `pinned_questions` table as the members of `src/core/engine-sql/pinned-questions.ts` run it
//! (rust/docs/store/pinned-questions.md): the idempotent pin insert, the read of one pin and the listing the question
//! refresh cycle walks.
//!
//! Members: insertPinnedQuestion, readPinnedQuestion, listPinnedQuestions, and the pin writes of
//! `src/core/engine-sql/question-store.ts`: readPinnedQuestionForUpdate, lockPinRowForPublish, updatePinRowState,
//! acquirePinLease, releasePinLease, addPinSpend, recordPinBlocked, publishPinAnswer. The evidence rows
//! (`question_evidence`) and the two reads that join them to these pins are `questions.rs` (`~q 0x03`).
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tags 0x2F and 0x30 (this file only):
//! - `m 0x2F id -> PinRecord`: one pin, the whole row (30 columns, with the defaults the table gives them), the id the
//!   `BIGSERIAL` of the `pinned_questions_id` sequence (`m 0x00 pinned_questions`).
//! - `m 0x30 source_id \0 slug -> id`: the unique `(source_id, slug)` index (`pinned_questions_source_slug_key`).
//!
//! `~q 0x01` and `~q 0x02` (the `questions` family) are reserved and unused: the pin rows live here.
//!
//! Kept: every column the TypeScript row reads. Not kept: `updated_at` (no member reads it, so the writes that set it have
//! nothing to store) and the secondary index `pinned_questions_state_idx` (a listing scans the table). `spend_usd` is a
//! `DOUBLE PRECISION`: a finite value is stored as the JSON number it always was, NaN and the infinities as their Postgres
//! text (`float8`), and a record that holds null reads as NaN. `now()` is the store clock at the write; inside a
//! transaction it is the transaction's clock (`transactions.rs`, "Time").

use super::*;
use crate::env::iso;
use crate::links::no_nul;
use crate::questions::{Float8, PinAnswerPublish, PinStatePatch};

const PIN: u8 = 0x2F;
const PIN_SLUG: u8 = 0x30;
const SEQUENCE: &str = "pinned_questions";
const OP_INSERT: &str = "insertPinnedQuestion";

fn pin_key(id: i64) -> Vec<u8> {
    let mut k = prefix(PIN);
    k.extend_from_slice(&signed_key(id));
    k
}

fn slug_key(source_id: &str, slug: &str) -> Vec<u8> {
    let mut k = prefix(PIN_SLUG);
    k.extend_from_slice(source_id.as_bytes());
    k.push(0);
    k.extend_from_slice(slug.as_bytes());
    k
}

/// One `pinned_questions` row. Times are microseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PinRecord {
    pub(crate) id: i64,
    pub(crate) source_id: String,
    pub(crate) slug: String,
    pub(crate) question: String,
    pub(crate) scope_slug_prefix: Option<String>,
    pub(crate) scope_entity: Option<String>,
    pub(crate) state: String,
    pub(crate) inactive_reason: Option<String>,
    pub(crate) publish_mode: String,
    pub(crate) model: Option<String>,
    pub(crate) cooldown_days: Option<f64>,
    pub(crate) origin: String,
    pub(crate) created_by: String,
    pub(crate) revision: i64,
    pub(crate) answer_revision: i32,
    pub(crate) answer: Option<String>,
    pub(crate) answer_model: Option<String>,
    pub(crate) last_refresh_at: Option<i64>,
    pub(crate) last_attempt_at: Option<i64>,
    pub(crate) last_error: Option<String>,
    pub(crate) watermark_generation: Option<i64>,
    pub(crate) watermark_fact_id: Option<i64>,
    pub(crate) watermark_at: Option<i64>,
    pub(crate) lease_token: Option<String>,
    pub(crate) lease_owner: Option<String>,
    pub(crate) lease_expires_at: Option<i64>,
    pub(crate) refresh_attempts: i32,
    #[serde(with = "float8")]
    pub(crate) spend_usd: f64,
    pub(crate) created_at: i64,
    pub(crate) archived_at: Option<i64>,
}

/// `DOUBLE PRECISION` as a JSON value: a finite number is a number (as every record already holds it), NaN and the
/// infinities their Postgres text; null (a non-finite value an older build wrote as a number) reads as NaN.
mod float8 {
    use serde::{Deserialize, Deserializer, Serializer};
    use serde_json::Value;

    pub fn serialize<S: Serializer>(x: &f64, s: S) -> Result<S::Ok, S::Error> {
        if x.is_finite() {
            s.serialize_f64(*x)
        } else {
            s.serialize_str(super::non_finite(*x))
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        match Value::deserialize(d)? {
            Value::Number(n) => n
                .as_f64()
                .ok_or_else(|| serde::de::Error::custom("a number outside the double range")),
            Value::Null => Ok(f64::NAN),
            Value::String(t) => match t.as_str() {
                "NaN" => Ok(f64::NAN),
                "Infinity" => Ok(f64::INFINITY),
                "-Infinity" => Ok(f64::NEG_INFINITY),
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

/// The Postgres text of a non-finite double.
fn non_finite(x: f64) -> &'static str {
    if x.is_nan() {
        "NaN"
    } else if x > 0.0 {
        "Infinity"
    } else {
        "-Infinity"
    }
}

/// A `DOUBLE PRECISION` as a JSON number, or as its Postgres text when it is not finite (a JSON number cannot hold it).
fn float8_out(x: f64) -> Value {
    if x.is_finite() {
        json!(x)
    } else {
        json!(non_finite(x))
    }
}

impl PinRecord {
    /// The row as `SELECT <columns>` returns it on the SQL engines: times as ISO text.
    pub(crate) fn to_row(&self) -> Value {
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
            "cooldown_days": self.cooldown_days,
            "origin": self.origin,
            "created_by": self.created_by,
            "revision": self.revision,
            "answer_revision": self.answer_revision,
            "answer": self.answer,
            "answer_model": self.answer_model,
            "last_refresh_at": t(self.last_refresh_at),
            "last_attempt_at": t(self.last_attempt_at),
            "last_error": self.last_error,
            "watermark_generation": self.watermark_generation,
            "watermark_fact_id": self.watermark_fact_id,
            "watermark_at": t(self.watermark_at),
            "lease_token": self.lease_token,
            "lease_owner": self.lease_owner,
            "lease_expires_at": t(self.lease_expires_at),
            "refresh_attempts": self.refresh_attempts,
            "spend_usd": float8_out(self.spend_usd),
            "created_at": iso(self.created_at),
            "archived_at": t(self.archived_at),
        })
    }
}

/// `insertPinnedQuestion(row)`: the columns `insertPin` writes; the others take the table's defaults.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinInsert {
    pub source_id: Option<String>,
    pub slug: Option<String>,
    pub question: Option<String>,
    #[serde(default)]
    pub scope_slug_prefix: Option<String>,
    #[serde(default)]
    pub scope_entity: Option<String>,
    pub state: Option<String>,
    #[serde(default)]
    pub inactive_reason: Option<String>,
    pub publish_mode: Option<String>,
    pub created_by: Option<String>,
}

/// `listPinnedQuestions(filter)`: `sourceIds` and `states` are `= ANY(...)` lists; `states` absent keeps every pin but the
/// archived ones unless `includeArchived`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinFilter {
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    #[serde(default)]
    pub states: Option<Vec<String>>,
    #[serde(default)]
    pub include_archived: bool,
}

fn not_null(column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"pinned_questions\" violates not-null constraint"
        ),
    )
}

pub(crate) fn all_pins(read: &dyn KvRead) -> Result<Vec<PinRecord>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(read, &prefix(PIN), false, &mut |_, v| {
        match serde_json::from_slice::<PinRecord>(v) {
            Ok(r) => rows.push(r),
            Err(e) => {
                bad = Some(StoreError::invalid(format!("unreadable pin record: {e}")));
                return false;
            }
        }
        true
    })?;
    bad.map_or(Ok(rows), Err)
}

impl Store {
    /// `insertPinnedQuestion(row)`: the new pin's row, or None when `(source_id, slug)` has one (`ON CONFLICT DO NOTHING`).
    /// A null `source_id`, `slug`, `question`, `state`, `publish_mode` or `created_by` refuses with
    /// `constraint_violation`; a NUL byte in a text with `invalid_argument`.
    pub fn insert_pinned_question(&self, row: &PinInsert) -> Result<Option<Value>> {
        let source_id = row.source_id.clone().ok_or_else(|| not_null("source_id"))?;
        let slug = row.slug.clone().ok_or_else(|| not_null("slug"))?;
        let question = row.question.clone().ok_or_else(|| not_null("question"))?;
        let created_by = row
            .created_by
            .clone()
            .ok_or_else(|| not_null("created_by"))?;
        let state = row.state.clone().ok_or_else(|| not_null("state"))?;
        let publish_mode = row
            .publish_mode
            .clone()
            .ok_or_else(|| not_null("publish_mode"))?;
        let mut texts: Vec<(&str, &str)> = vec![
            ("source_id", &source_id),
            ("slug", &slug),
            ("question", &question),
            ("created_by", &created_by),
            ("state", &state),
            ("publish_mode", &publish_mode),
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
        no_nul(OP_INSERT, &texts)?;
        self.write(|tx| {
            if get_json::<i64>(tx, &slug_key(&source_id, &slug))?.is_some() {
                return Ok(None);
            }
            let id = next_seq(tx, SEQUENCE)?;
            let record = PinRecord {
                id,
                source_id: source_id.clone(),
                slug: slug.clone(),
                question: question.clone(),
                scope_slug_prefix: row.scope_slug_prefix.clone(),
                scope_entity: row.scope_entity.clone(),
                state: state.clone(),
                inactive_reason: row.inactive_reason.clone(),
                publish_mode: publish_mode.clone(),
                model: None,
                cooldown_days: None,
                origin: "pin".to_string(),
                created_by: created_by.clone(),
                revision: 1,
                answer_revision: 0,
                answer: None,
                answer_model: None,
                last_refresh_at: None,
                last_attempt_at: None,
                last_error: None,
                watermark_generation: None,
                watermark_fact_id: None,
                watermark_at: None,
                lease_token: None,
                lease_owner: None,
                lease_expires_at: None,
                refresh_attempts: 0,
                spend_usd: 0.0,
                created_at: self.env.now_micros(),
                archived_at: None,
            };
            put_json(tx, &pin_key(id), &record)?;
            put_json(tx, &slug_key(&source_id, &slug), &id)?;
            Ok(Some(record.to_row()))
        })
    }

    /// `readPinnedQuestion(sourceId, slug)`: the row of the pin, or None.
    pub fn read_pinned_question(&self, source_id: &str, slug: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        let Some(id) = get_json::<i64>(&*read, &slug_key(source_id, slug))? else {
            return Ok(None);
        };
        Ok(get_json::<PinRecord>(&*read, &pin_key(id))?.map(|p| p.to_row()))
    }

    /// `listPinnedQuestions(filter)`: the rows by source id in byte order (`ORDER BY source_id COLLATE "C"`), then by
    /// creation time, then by id.
    pub fn list_pinned_questions(&self, filter: &PinFilter) -> Result<Value> {
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
                .then(a.created_at.cmp(&b.created_at))
                .then(a.id.cmp(&b.id))
        });
        Ok(Value::Array(pins.iter().map(PinRecord::to_row).collect()))
    }
}

/// The pin `id` names, or `None` for an id that holds no pin.
fn pin_by_id(read: &dyn KvRead, id: i64) -> Result<Option<PinRecord>> {
    get_json::<PinRecord>(read, &pin_key(id))
}

fn put_pin(tx: &mut dyn KvWrite, pin: &PinRecord) -> Result<()> {
    put_json(tx, &pin_key(pin.id), pin)
}

/// `now() + ttl * interval '1 millisecond'` in microseconds: the interval rounds to the microsecond, halves to even.
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
    /// `readPinnedQuestionForUpdate(sourceId, slug)`: the row of the pin, or None. The row lock of `SELECT ... FOR UPDATE`
    /// is the store's one writer, which the caller's transaction already holds, so it reads the same row.
    pub fn read_pinned_question_for_update(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Option<Value>> {
        self.read_pinned_question(source_id, slug)
    }

    /// `lockPinRowForPublish(id)`: `{ revision, lease_token, state }` of the pin, or None.
    pub fn lock_pin_row_for_publish(&self, id: i64) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(pin_by_id(&*read, id)?.map(
            |p| json!({ "revision": p.revision, "lease_token": p.lease_token, "state": p.state }),
        ))
    }

    /// `updatePinRowState(id, patch)`: the changed row, or None for an unknown id. Each null field is kept; the revision
    /// goes up by one; archiving stamps `archived_at` once (`COALESCE(archived_at, now())`) and drops the lease token and
    /// expiry (the owner stays), any other state clears `archived_at`.
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
                pin.archived_at = Some(pin.archived_at.unwrap_or(now));
                pin.lease_token = None;
                pin.lease_expires_at = None;
            } else {
                pin.archived_at = None;
            }
            pin.revision += 1;
            put_pin(tx, &pin)?;
            Ok(Some(pin.to_row()))
        })
    }

    /// `acquirePinLease(id, token, owner, ttlMs)`: the leased row when the pin is not archived and has no live lease (no
    /// token, no expiry, or an expiry before now), else None. Sets the token, owner and expiry, stamps `last_attempt_at`
    /// and counts the attempt.
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
            let free = pin.lease_token.is_none() || pin.lease_expires_at.is_none_or(|e| e < now);
            if pin.state == "archived" || !free {
                return Ok(None);
            }
            pin.lease_token = Some(token.to_string());
            pin.lease_owner = Some(owner.to_string());
            pin.lease_expires_at = Some(expires);
            pin.last_attempt_at = Some(now);
            pin.refresh_attempts += 1;
            put_pin(tx, &pin)?;
            Ok(Some(pin.to_row()))
        })
    }

    /// `releasePinLease(id, token, error, spendUsd)`: drops the lease the token holds, records `error` and adds the spend;
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
        self.write(|tx| {
            let Some(mut pin) = pin_by_id(&*tx, id)? else {
                return Ok(());
            };
            if pin.lease_token.as_deref() != Some(token) {
                return Ok(());
            }
            pin.lease_token = None;
            pin.lease_owner = None;
            pin.lease_expires_at = None;
            pin.last_error.clone_from(&error);
            pin.spend_usd += spend_usd.0;
            put_pin(tx, &pin)
        })
    }

    /// `addPinSpend(id, usd)`: adds `usd` to the spend (`double` arithmetic); an unknown pin changes nothing.
    pub fn add_pin_spend(&self, id: i64, usd: Float8) -> Result<()> {
        self.write(|tx| {
            let Some(mut pin) = pin_by_id(&*tx, id)? else {
                return Ok(());
            };
            pin.spend_usd += usd.0;
            put_pin(tx, &pin)
        })
    }

    /// `recordPinBlocked(id, code)`: stamps `last_attempt_at` and `last_error` unless a live lease holds the pin. A token
    /// with no expiry holds it here (`lease_expires_at < now()` is NULL, not true), unlike the lease statement.
    pub fn record_pin_blocked(&self, id: i64, code: &str) -> Result<()> {
        no_nul("recordPinBlocked", &[("code", code)])?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut pin) = pin_by_id(&*tx, id)? else {
                return Ok(());
            };
            if pin.lease_token.is_some() && !pin.lease_expires_at.is_some_and(|e| e < now) {
                return Ok(());
            }
            pin.last_attempt_at = Some(now);
            pin.last_error = Some(code.to_string());
            put_pin(tx, &pin)
        })
    }

    /// `publishPinAnswer(id, publish)`: the answer text, the next answer revision, `last_refresh_at` and `watermark_at`
    /// now, the watermark, the spend added, the lease dropped and `last_error` cleared.
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
            pin.last_refresh_at = Some(now);
            pin.last_error = None;
            pin.watermark_generation = Some(publish.watermark_generation);
            pin.watermark_fact_id = Some(publish.watermark_fact_id);
            pin.watermark_at = Some(now);
            pin.lease_token = None;
            pin.lease_owner = None;
            pin.lease_expires_at = None;
            pin.spend_usd += publish.spend_usd.0;
            put_pin(tx, &pin)
        })
    }
}

/// The shadow seed: stores a pin copied from another engine with its own id and times. `false` when the id already holds
/// a row; a different pin on the same `(source_id, slug)` is the unique-index error. The caller raises the sequence.
pub(crate) fn seed_pin(tx: &mut dyn KvWrite, pin: &PinRecord) -> Result<bool> {
    if pin_by_id(&*tx, pin.id)?.is_some() {
        return Ok(false);
    }
    if tx.get(&slug_key(&pin.source_id, &pin.slug))?.is_some() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "duplicate key value violates unique constraint \"pinned_questions_source_slug_key\"",
        ));
    }
    put_pin(tx, pin)?;
    put_json(tx, &slug_key(&pin.source_id, &pin.slug), &pin.id)?;
    Ok(true)
}

/// The shadow follow: removes pin `id` and its `(source_id, slug)` key (when that key still names it). The evidence rows
/// stay: `question_evidence` has no foreign key, and the follow removes them as their own relation. `false` when there
/// is no such pin.
pub(crate) fn remove_pin(tx: &mut dyn KvWrite, id: i64) -> Result<bool> {
    let Some(old) = pin_by_id(&*tx, id)? else {
        return Ok(false);
    };
    let slug = slug_key(&old.source_id, &old.slug);
    if get_json::<i64>(&*tx, &slug)? == Some(id) {
        tx.delete(&slug)?;
    }
    tx.delete(&pin_key(id))?;
    Ok(true)
}

/// A pin of `source_id` that holds an answer, as `listPublishedQuestionAnswers` reads it: the pin id, its answer revision,
/// the answer text and when it was last refreshed (microseconds).
pub(crate) struct AnsweredPin {
    pub(crate) id: i64,
    pub(crate) answer_revision: i32,
    pub(crate) answer: String,
    pub(crate) last_refresh_at: Option<i64>,
}

/// The pins of `source_id` that hold an answer, by id.
pub(crate) fn answered_pins(read: &dyn KvRead, source_id: &str) -> Result<Vec<AnsweredPin>> {
    Ok(all_pins(read)?
        .into_iter()
        .filter(|p| p.source_id == source_id)
        .filter_map(|p| {
            Some(AnsweredPin {
                id: p.id,
                answer_revision: p.answer_revision,
                answer: p.answer?,
                last_refresh_at: p.last_refresh_at,
            })
        })
        .collect())
}

/// The `pinned_questions` rows a purge probe searches (`countPurgeProbe`, src/core/deletion-inventory.ts): every text
/// column, as `col::text` prints it.
pub(crate) fn purge_probe_rows(
    read: &dyn KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow};
    Ok(all_pins(read)?
        .into_iter()
        .map(|p| ProbeRow {
            cells: vec![
                ("source_id", ProbeCell::text(&p.source_id)),
                ("slug", ProbeCell::text(&p.slug)),
                ("question", ProbeCell::text(&p.question)),
                (
                    "scope_slug_prefix",
                    ProbeCell::opt_text(p.scope_slug_prefix.as_deref()),
                ),
                (
                    "scope_entity",
                    ProbeCell::opt_text(p.scope_entity.as_deref()),
                ),
                ("state", ProbeCell::text(&p.state)),
                (
                    "inactive_reason",
                    ProbeCell::opt_text(p.inactive_reason.as_deref()),
                ),
                ("publish_mode", ProbeCell::text(&p.publish_mode)),
                ("model", ProbeCell::opt_text(p.model.as_deref())),
                ("origin", ProbeCell::text(&p.origin)),
                ("created_by", ProbeCell::text(&p.created_by)),
                ("answer", ProbeCell::opt_text(p.answer.as_deref())),
                (
                    "answer_model",
                    ProbeCell::opt_text(p.answer_model.as_deref()),
                ),
                ("last_error", ProbeCell::opt_text(p.last_error.as_deref())),
                ("lease_token", ProbeCell::opt_text(p.lease_token.as_deref())),
                ("lease_owner", ProbeCell::opt_text(p.lease_owner.as_deref())),
            ],
            source_id: Some(p.source_id),
        })
        .collect())
}

#[cfg(test)]
mod tests;
