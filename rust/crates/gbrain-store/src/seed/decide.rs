//! Decide and dream: decide state, spend, calibrations, receipts, proposals, the sweep retry rows,
//! the review queue, calibration profiles and dream synthesis completions.

use super::decode::Row;
use super::{
    Column::{Kept, Unmapped},
    Losses, Outcome, Relation, duplicate, raise_counter, require_source,
};
use crate::error::{Result, StoreError};
use crate::eval_capture::calibration_profiles::{self, ProfileRecord};
use crate::eval_capture::decide_proposals::{
    self, DeferredRecord, ProposalRecord, QueueRecord, ReviewProposalRecord, Seeded,
};
use crate::eval_capture::decide_store::{
    self, CALIBRATION_ID, CalibrationRecord, RECEIPT_ID, ReceiptRecord, SpendRecord,
};
use crate::jobs::synthesis_completions;
use crate::kv::KvWrite;

/// In import order.
pub(super) const RELATIONS: &[(&str, &Relation)] = &[
    ("decide_state", &STATE),
    ("decide_spend", &SPEND),
    ("decide_calibrations", &CALIBRATIONS),
    ("decision_receipts", &RECEIPTS),
    ("decide_proposals", &PROPOSALS),
    ("decide_sweep_deferred", &SWEEP_DEFERRED),
    ("decide_review_proposals", &REVIEW_PROPOSALS),
    ("decide_review_queue", &REVIEW_QUEUE),
    ("calibration_profiles", &PROFILES),
    ("dream_synthesis_completions", &COMPLETIONS),
];

/// A `NOT NULL` column's value: NULL is an error that names the column.
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

// ---- decide_state --------------------------------------------------------------------------

static STATE: Relation = Relation {
    key: &["key"],
    columns: &[("key", Kept), ("value", Kept), ("updated_at", Kept)],
    import: import_state,
};

fn import_state(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let stored = decide_store::seed_state(
        tx,
        &row.req("key")?,
        &row.req("value")?,
        row.req_ts("updated_at")?,
    )?;
    Ok(outcome(stored))
}

// ---- decide_spend --------------------------------------------------------------------------

static SPEND: Relation = Relation {
    key: &["request_id"],
    columns: &[
        ("request_id", Kept),
        ("created_at", Kept),
        ("source_id", Kept),
        ("slot", Kept),
        ("provider", Kept),
        ("model_resolved", Kept),
        ("lane", Kept),
        ("remote", Kept),
        ("input_tokens", Kept),
        ("cost_usd", Kept),
        ("outcome", Kept),
    ],
    import: import_spend,
};

/// Raises `decide_spend_seq` by one per stored row, as the family's own writer does.
fn import_spend(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let record = SpendRecord {
        request_id: row.req("request_id")?,
        created_at_us: row.req_ts("created_at")?,
        source_id: row.text("source_id"),
        slot: row.req("slot")?,
        provider: row.req("provider")?,
        model_resolved: row.text("model_resolved"),
        lane: row.req("lane")?,
        remote: row.bool("remote")?.unwrap_or(false),
        input_tokens: row.i32("input_tokens")?.unwrap_or(0),
        cost_bits: row.f64("cost_usd")?.unwrap_or(0.0).to_bits(),
        outcome: row.req("outcome")?,
    };
    Ok(outcome(decide_store::seed_spend(tx, &record)?))
}

// ---- decide_calibrations -------------------------------------------------------------------

static CALIBRATIONS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("slot", Kept),
        ("call_site", Kept),
        ("provider", Kept),
        ("model_resolved", Kept),
        ("threshold", Kept),
        ("min_keep", Kept),
        ("metric", Kept),
        ("metric_value", Kept),
        ("ece", Kept),
        ("retest_sd", Kept),
        ("repack_sd", Kept),
        ("action_precision_lb", Kept),
        ("qualification", Kept),
        ("qualified_at", Kept),
        ("policy_fingerprint", Kept),
        ("n", Kept),
        ("dataset_hash", Kept),
        ("split_hash", Kept),
        ("calibrate_ids_hash", Kept),
        ("calibrate_only", Kept),
        ("pack_shape", Kept),
        ("created_at", Kept),
        ("retired_at", Kept),
        ("notes", Kept),
    ],
    import: import_calibration,
};

fn import_calibration(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let real = |col: &str| -> Result<Option<u32>> { Ok(row.f32(col)?.map(f32::to_bits)) };
    let id = row.req_id("id")?;
    let record = CalibrationRecord {
        id,
        slot: row.req("slot")?,
        call_site: row.req("call_site")?,
        provider: row.req("provider")?,
        model_resolved: row.req("model_resolved")?,
        threshold: need(row, "threshold", real("threshold")?)?,
        min_keep: row.i32("min_keep")?,
        metric: row.req("metric")?,
        metric_value: real("metric_value")?,
        ece: real("ece")?,
        retest_sd: real("retest_sd")?,
        repack_sd: real("repack_sd")?,
        action_precision_lb: real("action_precision_lb")?,
        qualification: row.text("qualification"),
        qualified_at_us: row.ts("qualified_at")?,
        policy_fingerprint: row.text("policy_fingerprint"),
        n: need(row, "n", row.i32("n")?)?,
        dataset_hash: row.text("dataset_hash"),
        split_hash: row.text("split_hash"),
        calibrate_ids_hash: row.text("calibrate_ids_hash"),
        calibrate_only: row.bool("calibrate_only")?.unwrap_or(true),
        pack_shape: row.req("pack_shape")?,
        created_at_us: row.req_ts("created_at")?,
        retired_at_us: row.ts("retired_at")?,
        notes: row.text("notes"),
    };
    let stored = decide_store::seed_calibration(tx, &record)?;
    raise_counter(tx, CALIBRATION_ID, id)?;
    Ok(outcome(stored))
}

// ---- decision_receipts ---------------------------------------------------------------------

static RECEIPTS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("decision_id", Kept),
        ("created_at", Kept),
        ("source_id", Kept),
        ("slot", Kept),
        ("mode", Kept),
        ("provider", Kept),
        ("model_alias", Kept),
        ("model_resolved", Kept),
        ("question_kind", Kept),
        ("state_hash", Kept),
        ("question_hash", Kept),
        ("answer_value", Kept),
        ("answer_choice", Kept),
        ("confidence", Kept),
        ("threshold", Kept),
        ("outcome", Kept),
        ("subject_ref", Kept),
        ("call_site", Kept),
        ("lane", Kept),
        ("policy_fingerprint", Kept),
        ("calibration_ref", Kept),
        ("latency_ms", Kept),
        ("input_tokens", Kept),
        ("error_reason", Kept),
        ("protected", Kept),
        ("min_keep", Kept),
        ("rank", Kept),
        ("k_used", Kept),
        ("remote", Kept),
        ("run_meta", Kept),
    ],
    import: import_receipt,
};

fn import_receipt(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let real = |col: &str| -> Result<Option<u32>> { Ok(row.f32(col)?.map(f32::to_bits)) };
    let id = row.req_id("id")?;
    let record = ReceiptRecord {
        id,
        created_at_us: row.req_ts("created_at")?,
        decision_id: row.req("decision_id")?,
        source_id: row.text("source_id"),
        slot: row.req("slot")?,
        mode: row.req("mode")?,
        provider: row.req("provider")?,
        model_alias: row.text("model_alias"),
        model_resolved: row.text("model_resolved"),
        question_kind: row.text("question_kind"),
        state_hash: row.text("state_hash"),
        question_hash: row.text("question_hash"),
        answer_value: real("answer_value")?,
        answer_choice: row.text("answer_choice"),
        confidence: real("confidence")?,
        threshold: real("threshold")?,
        outcome: row.req("outcome")?,
        subject_ref: row.text("subject_ref"),
        call_site: row.req("call_site")?,
        lane: row.req("lane")?,
        policy_fingerprint: row.text("policy_fingerprint"),
        calibration_ref: row.text("calibration_ref"),
        latency_ms: row.i32("latency_ms")?,
        input_tokens: row.i32("input_tokens")?,
        error_reason: row.text("error_reason"),
        protected: row.bool("protected")?.unwrap_or(false),
        min_keep: row.i32("min_keep")?,
        rank: row.i32("rank")?,
        k_used: row.i32("k_used")?,
        remote: row.bool("remote")?.unwrap_or(false),
        run_meta: row.text("run_meta"),
    };
    let stored = decide_store::seed_receipt(tx, &record)?;
    raise_counter(tx, RECEIPT_ID, id)?;
    Ok(outcome(stored))
}

// ---- decide_proposals ----------------------------------------------------------------------

static PROPOSALS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("created_at", Kept),
        ("source_id", Kept),
        ("sweep_id", Kept),
        ("pair_index", Kept),
        ("new_fact_id", Kept),
        ("old_fact_id", Kept),
        ("direction", Kept),
        ("p_supersede", Kept),
        ("threshold", Kept),
        ("proposal_floor", Kept),
        ("model_resolved", Kept),
        ("status", Kept),
        ("decided_at", Kept),
        ("before_state", Kept),
        ("after_state", Kept),
    ],
    import: import_proposal,
};

fn import_proposal(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    let record = ProposalRecord {
        id,
        created_at_us: row.req_ts("created_at")?,
        source_id: row.req("source_id")?,
        sweep_id: row.req("sweep_id")?,
        pair_index: need(row, "pair_index", row.i32("pair_index")?)?,
        new_fact_id: need(row, "new_fact_id", row.i64("new_fact_id")?)?,
        old_fact_id: need(row, "old_fact_id", row.i64("old_fact_id")?)?,
        direction: row.text_or("direction", "new_supersedes_old"),
        p_supersede: need(row, "p_supersede", row.f32("p_supersede")?)?,
        threshold: row.f32("threshold")?,
        proposal_floor: need(row, "proposal_floor", row.f32("proposal_floor")?)?,
        model_resolved: row.text("model_resolved"),
        status: row.text_or("status", "pending"),
        decided_at_us: row.ts("decided_at")?,
        before_state: row.text("before_state"),
        after_state: row.text("after_state"),
    };
    let seeded = decide_proposals::seed_proposal(tx, &record)?;
    raise_counter(tx, decide_proposals::NEXT_PROPOSAL_ID, id)?;
    seeded_outcome(seeded)
}

fn seeded_outcome(seeded: Seeded) -> Result<Outcome> {
    match seeded {
        Seeded::Stored => Ok(Outcome::Imported),
        Seeded::Present => Ok(Outcome::Skipped),
        Seeded::Conflict(key) => Err(duplicate(key)),
    }
}

// ---- decide_sweep_deferred -----------------------------------------------------------------

static SWEEP_DEFERRED: Relation = Relation {
    key: &["slot", "source_id", "fact_id"],
    columns: &[
        ("source_id", Kept),
        ("fact_id", Kept),
        ("slot", Kept),
        ("reason", Kept),
        ("attempts", Kept),
        ("next_attempt_at", Kept),
        ("created_at", Kept),
    ],
    import: import_sweep_deferred,
};

fn import_sweep_deferred(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let record = DeferredRecord {
        source_id: row.req("source_id")?,
        fact_id: need(row, "fact_id", row.i64("fact_id")?)?,
        slot: row.req("slot")?,
        reason: row.req("reason")?,
        attempts: row.i32("attempts")?.unwrap_or(0),
        next_attempt_us: row.req_ts("next_attempt_at")?,
        created_at_us: row.req_ts("created_at")?,
    };
    Ok(outcome(decide_proposals::seed_sweep_deferred(tx, &record)?))
}

// ---- decide_review_proposals ---------------------------------------------------------------

static REVIEW_PROPOSALS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("created_at", Kept),
        ("kind", Kept),
        ("source_id", Kept),
        ("sweep_id", Kept),
        ("a_ref", Kept),
        ("b_ref", Kept),
        ("subject", Kept),
        ("visibility", Kept),
        ("p_action", Kept),
        ("threshold", Kept),
        ("model_resolved", Kept),
        ("question_version", Kept),
        ("status", Kept),
        ("decided_at", Kept),
        ("receipt", Kept),
    ],
    import: import_review_proposal,
};

fn import_review_proposal(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    let record = ReviewProposalRecord {
        id,
        created_at_us: row.req_ts("created_at")?,
        kind: row.req("kind")?,
        source_id: row.req("source_id")?,
        sweep_id: row.req("sweep_id")?,
        a_ref: row.req("a_ref")?,
        b_ref: row.req("b_ref")?,
        subject: row.text_or("subject", "*"),
        visibility: row.text("visibility"),
        p_action: need(row, "p_action", row.f32("p_action")?)?,
        threshold: row.f32("threshold")?,
        model_resolved: row.text("model_resolved"),
        question_version: row.text("question_version"),
        status: row.text_or("status", "pending"),
        decided_at_us: row.ts("decided_at")?,
        receipt: row.text("receipt"),
    };
    let seeded = decide_proposals::seed_review_proposal(tx, &record)?;
    raise_counter(tx, decide_proposals::NEXT_REVIEW_PROPOSAL_ID, id)?;
    seeded_outcome(seeded)
}

// ---- decide_review_queue -------------------------------------------------------------------

static REVIEW_QUEUE: Relation = Relation {
    key: &["kind", "source_id", "a_ref", "b_ref"],
    columns: &[
        ("kind", Kept),
        ("source_id", Kept),
        ("a_ref", Kept),
        ("b_ref", Kept),
        ("evidence", Kept),
        ("reason", Kept),
        ("attempts", Kept),
        ("next_attempt_at", Kept),
        ("created_at", Kept),
    ],
    import: import_review_queue,
};

fn import_review_queue(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let record = QueueRecord {
        kind: row.req("kind")?,
        source_id: row.req("source_id")?,
        a_ref: row.req("a_ref")?,
        b_ref: row.text_or("b_ref", "*"),
        evidence: row.text("evidence"),
        reason: row.text_or("reason", "queued"),
        attempts: row.i32("attempts")?.unwrap_or(0),
        next_attempt_us: row.req_ts("next_attempt_at")?,
        created_at_us: row.req_ts("created_at")?,
    };
    Ok(outcome(decide_proposals::seed_review_queue(tx, &record)?))
}

// ---- calibration_profiles ------------------------------------------------------------------

static PROFILES: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("source_id", Kept),
        ("holder", Kept),
        ("wave_version", Kept),
        ("generated_at", Kept),
        ("published", Kept),
        ("total_resolved", Kept),
        ("brier", Kept),
        ("accuracy", Kept),
        ("partial_rate", Kept),
        ("grade_completion", Kept),
        ("domain_scorecards", Kept),
        ("pattern_statements", Kept),
        ("voice_gate_passed", Kept),
        ("voice_gate_attempts", Kept),
        ("active_bias_tags", Kept),
        ("model_id", Kept),
        ("cost_usd", Unmapped(None)),
        ("judge_model_agreement", Unmapped(None)),
    ],
    import: import_profile,
};

fn import_profile(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    let source_id = row.req("source_id")?;
    require_source(&*tx, &source_id)?;
    let attempts = need(row, "voice_gate_attempts", row.i64("voice_gate_attempts")?)?;
    let record = ProfileRecord {
        id,
        source_id,
        holder: row.req("holder")?,
        wave_version: row.text_or("wave_version", "v0.36.1.0"),
        generated_at_us: row.req_ts("generated_at")?,
        published: row.bool("published")?.unwrap_or(false),
        total_resolved: need(row, "total_resolved", row.i32("total_resolved")?)?,
        brier: row.f32("brier")?,
        accuracy: row.f32("accuracy")?,
        partial_rate: row.f32("partial_rate")?,
        grade_completion: row.f32("grade_completion")?.unwrap_or(1.0),
        domain_scorecards: need(row, "domain_scorecards", row.json("domain_scorecards")?)?,
        pattern_statements: need(
            row,
            "pattern_statements",
            row.text_array("pattern_statements")?,
        )?,
        voice_gate_passed: need(row, "voice_gate_passed", row.bool("voice_gate_passed")?)?,
        voice_gate_attempts: i16::try_from(attempts).map_err(|_| {
            StoreError::invalid("seed calibration_profiles.voice_gate_attempts: out of range")
        })?,
        active_bias_tags: need(row, "active_bias_tags", row.text_array("active_bias_tags")?)?,
        model_id: row.req("model_id")?,
    };
    let stored = calibration_profiles::seed_profile(tx, &record)?;
    raise_counter(tx, calibration_profiles::NEXT_ID, id)?;
    Ok(outcome(stored))
}

// ---- dream_synthesis_completions -----------------------------------------------------------

static COMPLETIONS: Relation = Relation {
    key: &["source_id", "idempotency_key"],
    columns: &[
        ("source_id", Kept),
        ("idempotency_key", Kept),
        ("completed_at", Kept),
    ],
    import: import_completion,
};

fn import_completion(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let stored = synthesis_completions::seed_completion(
        tx,
        &row.req("source_id")?,
        &row.req("idempotency_key")?,
        row.req_ts("completed_at")?,
    )?;
    Ok(outcome(stored))
}

#[cfg(test)]
mod tests;
