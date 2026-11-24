//! `upsertChronicleRow`, `reserveChronicleJudgeSlot`, `pruneChronicleReservations` and `readChronicleLedger`: the guards
//! of an upsert, the 24-hour limit of a reservation, the 48-hour prune, and the rollup's windows and byte order.

mod memory_env;

use gbrain_store::chronicle_ledger::{ChronicleJudgeKey, ChronicleRowInput};
use memory_env::brain;
use serde_json::{Value, json};

const DAY: i64 = 86_400_000_000;

fn row(
    page: i64,
    hash: &str,
    state: &str,
    trigger: &str,
    reason: Option<&str>,
    principal: Option<&str>,
) -> ChronicleRowInput {
    serde_json::from_value(json!({
        "sourceId": "default", "pageId": page, "contentHash": hash, "extractorVersion": 2, "slug": format!("p{page}"),
        "state": state, "reason": reason, "trigger": trigger, "principalKind": principal.map(|_| "client"),
        "principalId": principal,
    }))
    .unwrap()
}

fn key(page: i64, hash: &str) -> ChronicleJudgeKey {
    serde_json::from_value(json!({ "sourceId": "default", "pageId": page, "contentHash": hash }))
        .unwrap()
}

#[test]
fn an_automatic_decision_leaves_a_pending_backfill_row() {
    let b = brain("chronicle-guard-backfill");
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "pending", "backfill", None, None))
            .unwrap()
    );
    assert!(
        !b.upsert_chronicle_row(&row(1, "h", "skipped", "auto", Some("r"), None))
            .unwrap()
    );
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "skipped", "backfill", Some("r"), None))
            .unwrap()
    );
    // The skipped backfill row is no longer guarded.
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "skipped", "auto", Some("r"), None))
            .unwrap()
    );
}

#[test]
fn an_unknown_state_or_trigger_refuses() {
    let b = brain("chronicle-bad-enum");
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "done", "auto", None, None))
            .is_err()
    );
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "pending", "manual", None, None))
            .is_err()
    );
}

#[test]
fn the_rollup_counts_reasons_and_principals_by_byte() {
    let b = brain("chronicle-rollup");
    for (i, name) in ["b", "B", "a", "A"].iter().enumerate() {
        let page = i as i64 + 1;
        b.upsert_chronicle_row(&row(page, "h", "skipped", "auto", Some(name), Some(name)))
            .unwrap();
        assert!(
            b.reserve_chronicle_judge_slot(100, &key(page, "h"))
                .unwrap()
        );
    }
    b.upsert_chronicle_row(&row(9, "h", "pending", "auto", None, None))
        .unwrap();
    b.upsert_chronicle_row(&row(10, "h", "skipped", "backfill", Some("ignored"), None))
        .unwrap();
    let r = b.read_chronicle_ledger().unwrap();
    assert_eq!(r["counts"]["pending"], 1);
    assert_eq!(r["counts"]["skipped"], 4);
    assert_eq!(r["counts"]["known_usd"], Value::Null);
    let reasons: Vec<&str> = r["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["reason"].as_str().unwrap())
        .collect();
    assert_eq!(reasons, ["A", "B", "a", "b"]);
    assert_eq!(r["calls"], 4);
    let principals: Vec<&str> = r["principals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["principal"].as_str().unwrap())
        .collect();
    assert_eq!(principals, ["client:A", "client:B", "client:a", "client:b"]);
}

#[test]
fn a_reservation_stops_at_the_limit_and_ages_out_after_a_day() {
    let b = brain("chronicle-limit");
    assert!(b.reserve_chronicle_judge_slot(2, &key(1, "h")).unwrap());
    assert!(b.reserve_chronicle_judge_slot(2, &key(2, "h")).unwrap());
    assert!(!b.reserve_chronicle_judge_slot(2, &key(3, "h")).unwrap());
    b.clock.advance(DAY + 1);
    assert!(b.reserve_chronicle_judge_slot(2, &key(3, "h")).unwrap());
    let r = b.read_chronicle_ledger().unwrap();
    assert_eq!(r["calls"], 1);
    // A reservation with no ledger row is attributed to no principal.
    assert_eq!(
        r["principals"],
        json!([{ "principal": "unattributed", "calls": 1 }])
    );
}

#[test]
fn a_row_older_than_a_week_leaves_the_counts_and_pending_stays() {
    let b = brain("chronicle-week");
    b.upsert_chronicle_row(&row(1, "h", "skipped", "auto", Some("r"), None))
        .unwrap();
    b.upsert_chronicle_row(&row(2, "h", "pending", "auto", None, None))
        .unwrap();
    b.clock.advance(7 * DAY + 1);
    let r = b.read_chronicle_ledger().unwrap();
    assert_eq!(r["counts"]["skipped"], 0);
    assert_eq!(r["counts"]["pending"], 1);
    assert_eq!(r["reasons"], json!([]));
}

#[test]
fn a_prune_deletes_only_the_reservations_older_than_two_days() {
    let b = brain("chronicle-prune");
    assert!(b.reserve_chronicle_judge_slot(9, &key(1, "h")).unwrap());
    b.clock.advance(DAY);
    assert!(b.reserve_chronicle_judge_slot(9, &key(2, "h")).unwrap());
    b.clock.advance(DAY);
    assert!(b.reserve_chronicle_judge_slot(9, &key(3, "h")).unwrap());
    // At exactly 48 hours the first reservation is not older than the window, as `reserved_at < now() - 48h` reads it.
    assert_eq!(b.prune_chronicle_reservations().unwrap(), 0);
    b.clock.advance(1);
    assert_eq!(b.prune_chronicle_reservations().unwrap(), 1);
    assert_eq!(b.prune_chronicle_reservations().unwrap(), 0);
    // The two newer reservations stay: one is inside the 24-hour window.
    assert_eq!(b.count_recent_chronicle_reservations().unwrap(), 1);
    b.clock.advance(DAY);
    assert_eq!(b.prune_chronicle_reservations().unwrap(), 1);
}

fn tuple(page: i64, hash: &str) -> gbrain_store::chronicle_ledger::ChronicleKeyTuple {
    serde_json::from_value(json!(["default", page, hash, 2])).unwrap()
}

#[test]
fn a_claim_leases_a_row_once_and_a_lapsed_lease_is_claimable_again() {
    let b = brain("chronicle-claim");
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "pending", "auto", None, None))
            .unwrap()
    );
    let first = b
        .chronicle_claim(&tuple(1, "h"), 60_000, "pending", 3)
        .unwrap()
        .unwrap();
    // An automatic row consumes no attempt; its lease is 60 s ahead.
    assert_eq!(first.attempts, 0);
    assert!(first.next_attempt_at.is_some());
    assert!(
        b.chronicle_claim(&tuple(1, "h"), 60_000, "pending", 3)
            .unwrap()
            .is_none()
    );
    b.clock.advance(60_000_001);
    assert!(
        b.chronicle_claim(&tuple(1, "h"), 60_000, "pending", 3)
            .unwrap()
            .is_some()
    );
    // Another state, or no row, claims nothing.
    assert!(
        b.chronicle_claim(&tuple(1, "h"), 60_000, "failed", 3)
            .unwrap()
            .is_none()
    );
    assert!(
        b.chronicle_claim(&tuple(9, "h"), 60_000, "pending", 3)
            .unwrap()
            .is_none()
    );
}

#[test]
fn an_outcome_is_recorded_only_at_the_attempt_it_was_judged_at() {
    let b = brain("chronicle-finish");
    assert!(
        b.upsert_chronicle_row(&row(1, "h", "pending", "auto", None, None))
            .unwrap()
    );
    assert_eq!(
        b.chronicle_add_attempt(&tuple(1, "h")).unwrap(),
        vec![json!({ "attempts": 1 })]
    );
    let outcome = |attempt: i32| -> gbrain_store::chronicle_ledger::ChronicleFinish {
        serde_json::from_value(json!({ "state": "extracted", "reason": null, "nextAttemptAt": null, "unpriced": false,
            "eventSlugs": ["life/events/a"], "eventHashes": ["x"], "attempt": attempt, "judgeInputHash": "i",
            "judgeWindowChars": 10, "judgeWindowHash": "w", "keepJudged": false, "failures": 0 }))
        .unwrap()
    };
    b.chronicle_finish(&tuple(1, "h"), &outcome(0)).unwrap();
    let key = serde_json::from_value(
        json!({ "sourceId": "default", "pageId": 1, "contentHash": "h", "extractorVersion": 2 }),
    )
    .unwrap();
    assert_eq!(
        b.read_chronicle_row(&key).unwrap().unwrap().state,
        "pending"
    );
    b.chronicle_finish(&tuple(1, "h"), &outcome(1)).unwrap();
    let done = b.read_chronicle_row(&key).unwrap().unwrap();
    assert_eq!(
        (
            done.state.as_str(),
            done.event_slugs.clone(),
            done.judge_input_hash.clone()
        ),
        (
            "extracted",
            vec!["life/events/a".to_string()],
            Some("i".to_string())
        )
    );
    // A cost is added once per attempt.
    b.chronicle_add_attempt_cost(&tuple(1, "h"), 0.25, 1)
        .unwrap();
    b.chronicle_add_attempt_cost(&tuple(1, "h"), 0.25, 1)
        .unwrap();
    let costed = b.read_chronicle_row(&key).unwrap().unwrap();
    assert_eq!(
        (costed.cost_usd, costed.cost_attempts),
        (Some(0.25), vec![1])
    );
}
