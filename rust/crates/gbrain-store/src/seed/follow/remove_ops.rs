//! The follow spec of the spend, decide and wake relations.

use super::remove_core::need;
use super::{Follow, Identity, Mode, Replace, number, text};
use crate::error::Result;
use crate::kv::KvWrite;

const fn follow(identity: &'static [&'static str], remove: super::Remover) -> Follow {
    keyed(identity, &[], remove)
}

/// A relation with unique natural keys besides its primary key: `unique` names the column sets.
const fn keyed(
    identity: &'static [&'static str],
    unique: &'static [&'static [&'static str]],
    remove: super::Remover,
) -> Follow {
    Follow {
        identity,
        unique,
        remove: Some(remove),
        replace: Replace::ByRemove,
    }
}

pub(super) static SPECS: &[(&str, Follow)] = &[
    ("mcp_spend_log", follow(&["id"], remove_spend_log)),
    (
        "mcp_spend_reservations",
        follow(&["reservation_id"], remove_reservation),
    ),
    ("decide_state", follow(&["key"], remove_state)),
    ("decide_spend", follow(&["request_id"], remove_decide_spend)),
    ("decide_calibrations", follow(&["id"], remove_calibration)),
    ("decision_receipts", follow(&["id"], remove_receipt)),
    (
        "decide_proposals",
        keyed(
            &[
                "id",
                "sweep_id",
                "pair_index",
                "source_id",
                "new_fact_id",
                "old_fact_id",
            ],
            &[
                &["sweep_id", "pair_index"],
                &["source_id", "new_fact_id", "old_fact_id"],
            ],
            remove_proposal,
        ),
    ),
    (
        "decide_sweep_deferred",
        follow(&["slot", "source_id", "fact_id"], remove_deferred),
    ),
    (
        "decide_review_proposals",
        keyed(
            &["id", "kind", "source_id", "a_ref", "b_ref", "subject"],
            &[&["kind", "source_id", "a_ref", "b_ref", "subject"]],
            remove_review_proposal,
        ),
    ),
    (
        "decide_review_queue",
        follow(&["kind", "source_id", "a_ref", "b_ref"], remove_queue),
    ),
    ("calibration_profiles", follow(&["id"], remove_profile)),
    (
        "dream_synthesis_completions",
        follow(&["source_id", "idempotency_key"], remove_completion),
    ),
    ("wake_crons", follow(&["name"], remove_cron)),
    ("wake_cron_runs", follow(&["id", "name"], remove_cron_run)),
    (
        "wake_forgets",
        keyed(
            &["id", "wake_user", "state"],
            &[&["wake_user", "state"]],
            remove_forget,
        ),
    ),
    (
        "wake_terms_acceptances",
        follow(&["principal_key", "terms_version"], remove_terms),
    ),
    (
        "mcp_request_log_rollup",
        follow(&["token_name"], remove_rollup),
    ),
];

fn remove_spend_log(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::jobs::remove_log(tx, need!(id, "id", i64))
}

fn remove_reservation(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::jobs::remove_reservation(tx, need!(id, "reservation_id"))
}

fn remove_state(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::eval_capture::decide_store::remove_state(tx, need!(id, "key"))
}

fn remove_decide_spend(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::eval_capture::decide_store::remove_spend(tx, need!(id, "request_id"))
}

fn remove_calibration(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::eval_capture::decide_store::remove_calibration(tx, need!(id, "id", u64))
}

fn remove_receipt(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::eval_capture::decide_store::remove_receipt(tx, need!(id, "id", u64))
}

fn remove_proposal(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::eval_capture::decide_proposals::remove_proposal(tx, need!(id, "id", u64))
}

fn remove_deferred(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::eval_capture::decide_proposals::remove_sweep_deferred(
        tx,
        need!(id, "slot"),
        need!(id, "source_id"),
        need!(id, "fact_id", i64),
    )
}

fn remove_review_proposal(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::eval_capture::decide_proposals::remove_review_proposal(tx, need!(id, "id", u64))
}

fn remove_queue(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::eval_capture::decide_proposals::remove_review_queue(
        tx,
        need!(id, "kind"),
        need!(id, "source_id"),
        need!(id, "a_ref"),
        need!(id, "b_ref"),
    )
}

fn remove_profile(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::eval_capture::calibration_profiles::remove_profile(tx, need!(id, "id", u64))
}

fn remove_completion(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::jobs::synthesis_completions::remove_completion(
        tx,
        need!(id, "source_id"),
        need!(id, "idempotency_key"),
    )
}

fn remove_cron(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::jobs::wake::remove_cron(tx, need!(id, "name"))
}

fn remove_cron_run(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::jobs::wake::remove_cron_run(tx, need!(id, "name"), need!(id, "id", i64))
}

fn remove_forget(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::jobs::wake::remove_forget(tx, need!(id, "id", i64))
}

fn remove_terms(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::jobs::wake::remove_terms(tx, need!(id, "principal_key"), need!(id, "terms_version"))
}

fn remove_rollup(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::telemetry::remove_rollup(tx, need!(id, "token_name"))
}
