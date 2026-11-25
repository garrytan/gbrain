//! Pinned questions: `pinned_questions` (into main's records, `m 0x2F` / `m 0x30`, `jobs/pinned_questions.rs`) and
//! `question_evidence` (`~q 0x03`; rust/docs/store/questions.md). The auto-think import
//! that fills `pinned_questions` runs inside a SQL schema migration (`src/core/questions/auto-think-migration.ts`), so
//! the seed copies whatever the primary holds.

use super::decode::Row;
use super::{Column::Kept, Losses, Outcome, Relation, duplicate, raise_counter};
use crate::error::{Result, StoreError};
use crate::jobs::{PinRecord, raise_seq, seed_pinned_question};
use crate::kv::KvWrite;
use crate::questions::{EvidenceRecord, NEXT_EVIDENCE_ID};

/// In import order.
pub(super) const RELATIONS: &[(&str, &Relation)] = &[
    ("pinned_questions", &PINS),
    ("question_evidence", &EVIDENCE),
];

fn need<T>(row: &Row, col: &str, value: Option<T>) -> Result<T> {
    value.ok_or_else(|| StoreError::invalid(format!("seed {}.{col}: is NULL", row.relation)))
}

fn outcome(stored: bool) -> Outcome {
    if stored {
        Outcome::Imported
    } else {
        Outcome::Skipped
    }
}

// ---- pinned_questions ----------------------------------------------------------------------

static PINS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("source_id", Kept),
        ("slug", Kept),
        ("question", Kept),
        ("scope_slug_prefix", Kept),
        ("scope_entity", Kept),
        ("state", Kept),
        ("inactive_reason", Kept),
        ("publish_mode", Kept),
        ("model", Kept),
        ("cooldown_days", Kept),
        ("origin", Kept),
        ("created_by", Kept),
        ("revision", Kept),
        ("answer_revision", Kept),
        ("answer", Kept),
        ("answer_model", Kept),
        ("last_refresh_at", Kept),
        ("last_attempt_at", Kept),
        ("last_error", Kept),
        ("watermark_generation", Kept),
        ("watermark_fact_id", Kept),
        ("watermark_at", Kept),
        ("lease_token", Kept),
        ("lease_owner", Kept),
        ("lease_expires_at", Kept),
        ("refresh_attempts", Kept),
        ("spend_usd", Kept),
        ("created_at", Kept),
        ("updated_at", Kept),
        ("archived_at", Kept),
    ],
    import: import_pin,
};

/// The row with the table's defaults for a NULL (`state 'active'`, `publish_mode 'publish'`, `origin 'pin'`, revision 1);
/// raises the `pinned_questions` sequence past the copied id.
fn import_pin(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = need(row, "id", row.i64("id")?)?;
    let created_at = row.req_ts("created_at")?;
    // A REAL is kept as the shortest decimal that names the f32, as both SQL engines print it.
    let cooldown_days = row
        .f32("cooldown_days")?
        .map(|x| format!("{x}").parse::<f64>().unwrap_or(f64::from(x)));
    let pin = PinRecord {
        id,
        source_id: row.req("source_id")?,
        slug: row.req("slug")?,
        question: row.req("question")?,
        scope_slug_prefix: row.text("scope_slug_prefix"),
        scope_entity: row.text("scope_entity"),
        state: row.text_or("state", "active"),
        inactive_reason: row.text("inactive_reason"),
        publish_mode: row.text_or("publish_mode", "publish"),
        model: row.text("model"),
        cooldown_days,
        origin: row.text_or("origin", "pin"),
        created_by: row.req("created_by")?,
        revision: row.i64("revision")?.unwrap_or(1),
        answer_revision: row.i32("answer_revision")?.unwrap_or(0),
        answer: row.text("answer"),
        answer_model: row.text("answer_model"),
        last_refresh_at: row.ts("last_refresh_at")?,
        last_attempt_at: row.ts("last_attempt_at")?,
        last_error: row.text("last_error"),
        watermark_generation: row.i64("watermark_generation")?,
        watermark_fact_id: row.i64("watermark_fact_id")?,
        watermark_at: row.ts("watermark_at")?,
        lease_token: row.text("lease_token"),
        lease_owner: row.text("lease_owner"),
        lease_expires_at: row.ts("lease_expires_at")?,
        refresh_attempts: row.i32("refresh_attempts")?.unwrap_or(0),
        spend_usd: row.f64("spend_usd")?.unwrap_or(0.0),
        created_at,
        archived_at: row.ts("archived_at")?,
    };
    let stored = seed_pinned_question(tx, &pin).map_err(|e| {
        if e.code == crate::error::CONSTRAINT_VIOLATION {
            duplicate("pinned_questions_source_slug_key (source_id, slug)")
        } else {
            e
        }
    })?;
    raise_seq(tx, "pinned_questions", id)?;
    Ok(outcome(stored))
}

// ---- question_evidence ---------------------------------------------------------------------

static EVIDENCE: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("question_id", Kept),
        ("answer_revision", Kept),
        ("sentence_id", Kept),
        ("kind", Kept),
        ("source_id", Kept),
        ("page_id", Kept),
        ("page_slug", Kept),
        ("page_generation", Kept),
        ("page_revision", Kept),
        ("item_id", Kept),
        ("content_hash", Kept),
        ("created_at", Kept),
    ],
    import: import_evidence,
};

fn import_evidence(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    let record = EvidenceRecord {
        id,
        question_id: row.req_id("question_id")?,
        answer_revision: need(row, "answer_revision", row.i32("answer_revision")?)?,
        sentence_id: row.req("sentence_id")?,
        kind: row.req("kind")?,
        source_id: row.req("source_id")?,
        page_id: row.i64("page_id")?,
        page_slug: row.text("page_slug"),
        page_generation: row.i64("page_generation")?,
        page_revision: row.text("page_revision"),
        item_id: row.i64("item_id")?,
        content_hash: row.text("content_hash"),
        created_at_us: row.req_ts("created_at")?,
    };
    let stored = crate::questions::seed_evidence(tx, &record)?;
    raise_counter(tx, NEXT_EVIDENCE_ID, id)?;
    Ok(outcome(stored))
}

#[cfg(test)]
mod tests;
