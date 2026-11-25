//! Pinned questions, the evidence side: the `question_evidence` rows (a publication's rewrite) and the two reads that join
//! them to the pins and to what they cite (`questions/join.rs`). The `pinned_questions` rows are main's records
//! (`jobs/pinned_questions.rs`, `m 0x2F` / `m 0x30`), which also serves the pin writes of
//! `src/core/engine-sql/question-store.ts`: state change, lease, spend, blocked record and the answer publish
//! (rust/docs/store/questions.md).
//!
//! Members: deleteQuestionEvidence, insertQuestionEvidence, listQuestionEvidenceJoin, listPublishedQuestionAnswers.
//!
//! Keys, all under the two-byte family tag `keys::QUESTIONS` (`~q`):
//! - `~q 0x01` and `~q 0x02` are reserved and unused, never to be reused: the pin rows and their `(source_id, slug)`
//!   index live at `m 0x2F` and `m 0x30` on main.
//! - `~q 0x03 question_id(BE8) evidence_id(BE8) -> EvidenceRecord`: one `question_evidence` row under the pin it
//!   belongs to, so the publication's `DELETE ... WHERE question_id` and the read of one pin's evidence are one prefix
//!   scan; the id is the `BIGSERIAL` (`M next_question_evidence_id`).
//! - `~q 0x04` is kept for a `question_evidence` index and unused.
//!
//! No text part holds a NUL byte (Postgres `text` refuses one too).
//!
//! Time: `now()` is the store clock at the write; inside a transaction it is the transaction's clock, as Postgres
//! `now()` is the transaction start (`transactions.rs`, "Time"). Every write reads it once.

use crate::error::{Result, StoreError};
use crate::keys::QUESTIONS;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::{Store, put_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod join;
#[cfg(test)]
mod tests;

const EVIDENCE: u8 = 0x03;

pub(crate) const NEXT_EVIDENCE_ID: &str = "next_question_evidence_id";

fn family(sub: u8) -> Vec<u8> {
    let mut k = QUESTIONS.to_vec();
    k.push(sub);
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

impl Store {
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
