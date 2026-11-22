//! The decide proposal tables (`eval_capture/decide_proposals.rs`): supersede proposals, review
//! proposals, the review queue and the conflict sweep's retry rows, on a clock the test moves.

mod memory_env;

use gbrain_store::env::iso;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::eval_capture::decide_proposals::{
    DecideProposalInput, DecideProposalTransition, DecideReviewProposalInput,
    DecideReviewProposalTransition, ListDecideProposalsOptions, ReviewQueueOp, SweepDeferredOp,
};
use memory_env::{T0, brain};
use serde_json::{Value, json};

const MINUTE: i64 = 60 * 1_000_000;
const DAY: i64 = 24 * 60 * MINUTE;

fn proposal(sweep: &str, index: i64, new_fact: i64, old_fact: i64) -> DecideProposalInput {
    serde_json::from_value(json!({
        "source_id": "default", "sweep_id": sweep, "pair_index": index,
        "new_fact_id": new_fact, "old_fact_id": old_fact, "direction": "new_supersedes_old",
        "p_supersede": 0.9, "threshold": 0.8, "proposal_floor": 0.5, "model_resolved": "m",
    }))
    .unwrap()
}

fn review(kind: &str, a: &str, b: &str, subject: &str) -> DecideReviewProposalInput {
    serde_json::from_value(json!({
        "kind": kind, "source_id": "default", "sweep_id": "s1", "a_ref": a, "b_ref": b,
        "subject": subject, "visibility": null, "p_action": 0.7, "threshold": 0.6,
        "model_resolved": null, "question_version": "q1", "receipt": "{}",
    }))
    .unwrap()
}

fn moved(id: i64, from: &str, to: &str) -> DecideProposalTransition {
    DecideProposalTransition {
        id,
        from: from.into(),
        to: to.into(),
        before: None,
        after: None,
    }
}

fn review_moved(id: i64, from: &str, to: &str) -> DecideReviewProposalTransition {
    DecideReviewProposalTransition {
        id,
        from: from.into(),
        to: to.into(),
    }
}

fn enqueue(kind: &str, a: &str, b: &str) -> ReviewQueueOp {
    ReviewQueueOp::Enqueue {
        kind: kind.into(),
        source_id: "default".into(),
        a_ref: a.into(),
        b_ref: b.into(),
        evidence: None,
    }
}

fn defer_queue(kind: &str, a: &str, b: &str) -> ReviewQueueOp {
    ReviewQueueOp::Defer {
        kind: kind.into(),
        source_id: "default".into(),
        a_ref: a.into(),
        b_ref: b.into(),
        reason: "busy".into(),
    }
}

fn defer_fact(fact: i64) -> SweepDeferredOp {
    SweepDeferredOp::Defer {
        fact_id: json!(fact),
        reason: "model busy".into(),
    }
}

fn ids(rows: &[Value], column: &str) -> Vec<i64> {
    rows.iter().map(|r| r[column].as_i64().unwrap()).collect()
}

#[test]
fn a_taken_slot_or_claim_pair_returns_none_and_uses_up_an_id() {
    let b = brain("dp-insert");
    assert_eq!(
        b.insert_decide_proposal(&proposal("s1", 0, 1, 2)).unwrap(),
        Some(1)
    );
    // The same slot, then the next free one: the refused insert took id 2.
    assert_eq!(
        b.insert_decide_proposal(&proposal("s1", 0, 3, 4)).unwrap(),
        None
    );
    assert_eq!(
        b.insert_decide_proposal(&proposal("s1", 1, 3, 4)).unwrap(),
        Some(3)
    );
    // A claim sweep also takes the unordered pair once per source, whichever sweep or order.
    assert_eq!(
        b.insert_decide_proposal(&proposal("claim_conflicts:a", 0, 10, 20))
            .unwrap(),
        Some(4)
    );
    assert_eq!(
        b.insert_decide_proposal(&proposal("claim_conflicts:b", 0, 20, 10))
            .unwrap(),
        None
    );
    assert_eq!(
        b.insert_decide_proposal(&proposal("claim_conflicts:b", 1, 20, 11))
            .unwrap(),
        Some(6)
    );
    // The sweep name is matched with `LIKE 'claim_conflicts:%'`, so `_` is a wildcard: `claimXconflicts:`
    // is a claim sweep too, and its pair (10, 20) is taken.
    assert_eq!(
        b.insert_decide_proposal(&proposal("claimXconflicts:a", 0, 10, 20))
            .unwrap(),
        None
    );
    // A name that does not match (one character too many) is not a claim sweep and may repeat the pair.
    assert_eq!(
        b.insert_decide_proposal(&proposal("claims_conflicts:a", 0, 10, 20))
            .unwrap(),
        Some(8)
    );
    assert_eq!(
        b.insert_decide_proposal(&proposal("other", 0, 10, 20))
            .unwrap(),
        Some(9)
    );
    // Another source may take the same claim pair.
    let mut other_source = proposal("claim_conflicts:c", 0, 10, 20);
    other_source.source_id = Some("work".into());
    assert_eq!(b.insert_decide_proposal(&other_source).unwrap(), Some(10));
}

#[test]
fn a_missing_field_is_the_not_null_error_and_a_bad_value_is_refused() {
    let b = brain("dp-null");
    for column in [
        "source_id",
        "sweep_id",
        "pair_index",
        "new_fact_id",
        "old_fact_id",
        "direction",
        "p_supersede",
        "proposal_floor",
    ] {
        let mut input = serde_json::to_value(json!({
            "source_id": "default", "sweep_id": "s", "pair_index": 0, "new_fact_id": 1, "old_fact_id": 2,
            "direction": "d", "p_supersede": 0.5, "proposal_floor": 0.1,
        }))
        .unwrap();
        input.as_object_mut().unwrap().remove(column);
        let input: DecideProposalInput = serde_json::from_value(input).unwrap();
        let err = b.insert_decide_proposal(&input).unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION, "{column}");
        assert!(err.message.contains(column), "{column}: {}", err.message);
    }
    let mut nul = proposal("s", 0, 1, 2);
    nul.direction = Some("a\0b".into());
    assert_eq!(
        b.insert_decide_proposal(&nul).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let mut fraction = proposal("s", 0, 1, 2);
    fraction.pair_index = Some(json!(1.5));
    assert_eq!(
        b.insert_decide_proposal(&fraction).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let mut huge = proposal("s", 0, 1, 2);
    huge.pair_index = Some(json!(2_147_483_648_i64));
    assert_eq!(
        b.insert_decide_proposal(&huge).unwrap_err().code,
        INVALID_ARGUMENT
    );
    let mut wide = proposal("s", 0, 1, 2);
    wide.p_supersede = Some(1.0e39);
    assert_eq!(
        b.insert_decide_proposal(&wide).unwrap_err().code,
        INVALID_ARGUMENT
    );
    // A refused insert wrote nothing and did not move the counter.
    assert_eq!(
        b.insert_decide_proposal(&proposal("s", 0, 1, 2)).unwrap(),
        Some(1)
    );
}

#[test]
fn a_proposal_reads_back_with_reals_as_their_shortest_decimal_and_microsecond_stamps() {
    let b = brain("dp-read");
    let mut input = proposal("s1", 0, 1, 2);
    input.p_supersede = Some(0.1);
    input.threshold = None;
    b.insert_decide_proposal(&input).unwrap();
    b.clock.advance(1_500_000);
    assert!(
        b.transition_decide_proposal(&moved(1, "pending", "accepted"))
            .unwrap()
    );
    let row = b.get_decide_proposal(1).unwrap().unwrap();
    // 0.1 stored as a REAL reads back as 0.1, not 0.10000000149011612.
    assert_eq!(row["p_supersede"], json!(0.1));
    assert_eq!(row["threshold"], Value::Null);
    assert_eq!(row["created_at"], json!(iso(T0)));
    assert_eq!(row["decided_at"], json!(iso(T0 + 1_500_000)));
    assert_eq!(row["status"], json!("accepted"));
    assert_eq!(b.get_decide_proposal(2).unwrap(), None);
    assert_eq!(b.get_decide_proposal(-1).unwrap(), None);
}

#[test]
fn a_transition_moves_a_proposal_once_and_a_null_state_keeps_the_stored_one() {
    let b = brain("dp-transition");
    b.insert_decide_proposal(&proposal("s1", 0, 1, 2)).unwrap();
    let mut first = moved(1, "pending", "accepted");
    first.before = Some("before".into());
    first.after = Some("after".into());
    assert!(b.transition_decide_proposal(&first).unwrap());
    // Not in `pending` any more, and a row that does not exist.
    assert!(
        !b.transition_decide_proposal(&moved(1, "pending", "rejected"))
            .unwrap()
    );
    assert!(
        !b.transition_decide_proposal(&moved(9, "pending", "rejected"))
            .unwrap()
    );
    assert!(
        !b.transition_decide_proposal(&moved(-1, "pending", "rejected"))
            .unwrap()
    );
    let mut second = moved(1, "accepted", "rolled_back");
    second.after = Some("later".into());
    assert!(b.transition_decide_proposal(&second).unwrap());
    let row = b.get_decide_proposal(1).unwrap().unwrap();
    assert_eq!(row["before_state"], json!("before"));
    assert_eq!(row["after_state"], json!("later"));
    let mut nul = moved(1, "rolled_back", "x");
    nul.before = Some("a\0".into());
    assert_eq!(
        b.transition_decide_proposal(&nul).unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn the_lists_filter_by_status_order_by_pair_index_or_age_and_limit() {
    let b = brain("dp-lists");
    for (index, (a, c)) in [(1, 2), (3, 4), (5, 6)].into_iter().enumerate().rev() {
        b.clock.advance(1);
        b.insert_decide_proposal(&proposal("s1", index as i64, a, c))
            .unwrap();
    }
    // Ids 1..=3 were inserted for pair indexes 2, 1, 0.
    assert!(
        b.transition_decide_proposal(&moved(2, "pending", "rejected"))
            .unwrap()
    );
    assert_eq!(
        b.list_decide_proposal_ids("s1", "pending").unwrap(),
        vec![3, 1]
    );
    assert_eq!(
        b.list_decide_proposal_ids("s1", "rejected").unwrap(),
        vec![2]
    );
    assert!(
        b.list_decide_proposal_ids("other", "pending")
            .unwrap()
            .is_empty()
    );
    let listed = |status: Option<&str>, limit: Option<i64>| {
        b.list_decide_proposals(&ListDecideProposalsOptions {
            status: status.map(Into::into),
            limit,
        })
        .unwrap()
    };
    assert_eq!(ids(&listed(None, None), "id"), vec![1, 3]);
    assert_eq!(ids(&listed(Some("all"), None), "id"), vec![1, 2, 3]);
    assert_eq!(ids(&listed(Some("all"), Some(2)), "id"), vec![1, 2]);
    assert!(listed(Some("all"), Some(0)).is_empty());
    // No fact rows exist: the text and entity are null.
    assert_eq!(listed(None, Some(1))[0]["new_fact"], Value::Null);
    let negative = b.list_decide_proposals(&ListDecideProposalsOptions {
        status: None,
        limit: Some(-1),
    });
    assert_eq!(negative.unwrap_err().code, INVALID_ARGUMENT);
}

#[test]
fn proposed_pairs_name_the_smaller_fact_first_in_any_status() {
    let b = brain("dp-pairs");
    b.insert_decide_proposal(&proposal("s1", 0, 9, 4)).unwrap();
    b.insert_decide_proposal(&proposal("s1", 1, 4, 7)).unwrap();
    b.insert_decide_proposal(&proposal("s1", 2, 1, 2)).unwrap();
    b.transition_decide_proposal(&moved(2, "pending", "rejected"))
        .unwrap();
    let mut pairs = b.list_decide_proposed_pairs("default", 4).unwrap();
    pairs.sort_by_key(|p| p["b"].as_i64());
    assert_eq!(
        pairs,
        vec![json!({"a": 4, "b": 7}), json!({"a": 4, "b": 9})]
    );
    assert!(b.list_decide_proposed_pairs("work", 4).unwrap().is_empty());
}

#[test]
fn a_review_proposal_is_taken_once_per_key_and_the_refused_insert_uses_up_an_id() {
    let b = brain("dp-review");
    assert_eq!(
        b.insert_decide_review_proposal(&review("dup", "a", "b", "x"))
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        b.insert_decide_review_proposal(&review("dup", "a", "b", "x"))
            .unwrap(),
        None
    );
    // The key is the whole of (kind, source, a, b, subject): changing any one makes a new row.
    assert_eq!(
        b.insert_decide_review_proposal(&review("dup", "a", "b", "y"))
            .unwrap(),
        Some(3)
    );
    assert_eq!(
        b.insert_decide_review_proposal(&review("withdraw", "a", "b", "x"))
            .unwrap(),
        Some(4)
    );
    // Parts that only differ where a joiner would sit are different keys.
    assert_eq!(
        b.insert_decide_review_proposal(&review("dup", "a\u{1}", "b", "x"))
            .unwrap(),
        Some(5)
    );
    let mut missing = review("dup", "a", "b", "z");
    missing.subject = None;
    assert_eq!(
        b.insert_decide_review_proposal(&missing).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    let mut nul = review("dup", "a", "b", "z");
    nul.receipt = Some("\0".into());
    assert_eq!(
        b.insert_decide_review_proposal(&nul).unwrap_err().code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        b.insert_decide_review_proposal(&review("dup", "a", "b", "z"))
            .unwrap(),
        Some(6)
    );
}

#[test]
fn review_proposals_list_by_status_read_with_postgres_text_stamps_and_move_once() {
    let b = brain("dp-review-read");
    b.insert_decide_review_proposal(&review("dup", "a", "b", "x"))
        .unwrap();
    b.clock.advance(500_000);
    b.insert_decide_review_proposal(&review("withdraw", "a", "b", "x"))
        .unwrap();
    assert!(
        b.transition_decide_review_proposal(&review_moved(1, "pending", "accepted"))
            .unwrap()
    );
    assert!(
        !b.transition_decide_review_proposal(&review_moved(1, "pending", "rejected"))
            .unwrap()
    );
    assert!(
        !b.transition_decide_review_proposal(&review_moved(7, "pending", "rejected"))
            .unwrap()
    );
    let all = b.list_decide_review_proposals("all").unwrap();
    assert_eq!(ids(&all, "id"), vec![1, 2]);
    assert_eq!(
        ids(&b.list_decide_review_proposals("pending").unwrap(), "id"),
        vec![2]
    );
    assert!(
        b.list_decide_review_proposals("rejected")
            .unwrap()
            .is_empty()
    );
    let row = b.get_decide_review_proposal(2).unwrap().unwrap();
    assert_eq!(row["created_at"], json!("2027-01-15 08:00:00.5+00"));
    assert_eq!(row["decided_at"], Value::Null);
    assert_eq!(row["p_action"], json!(0.7));
    assert_eq!(
        b.get_decide_review_proposal(1).unwrap().unwrap()["decided_at"],
        json!("2027-01-15 08:00:00.5+00")
    );
    assert_eq!(b.get_decide_review_proposal(3).unwrap(), None);
}

#[test]
fn the_pending_ids_of_a_sweep_leave_out_withdrawals_unless_asked() {
    let b = brain("dp-review-ids");
    b.insert_decide_review_proposal(&review("dup", "a", "b", "x"))
        .unwrap();
    b.insert_decide_review_proposal(&review("withdraw", "a", "b", "x"))
        .unwrap();
    b.insert_decide_review_proposal(&review("dup", "c", "d", "x"))
        .unwrap();
    b.transition_decide_review_proposal(&review_moved(3, "pending", "rejected"))
        .unwrap();
    assert_eq!(
        b.list_decide_review_proposal_ids("s1", false).unwrap(),
        vec![1]
    );
    assert_eq!(
        b.list_decide_review_proposal_ids("s1", true).unwrap(),
        vec![1, 2]
    );
    assert!(
        b.list_decide_review_proposal_ids("s2", true)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_rates_count_a_thirty_day_window_per_kind_and_report_the_oldest_pending_in_days() {
    let b = brain("dp-rates");
    assert!(b.read_proposal_review_rates().unwrap().is_empty());
    b.insert_decide_proposal(&proposal("s1", 0, 1, 2)).unwrap();
    b.insert_decide_proposal(&proposal("s1", 1, 3, 4)).unwrap();
    b.insert_decide_review_proposal(&review("zeta", "a", "b", "x"))
        .unwrap();
    b.insert_decide_review_proposal(&review("alpha", "a", "b", "x"))
        .unwrap();
    b.transition_decide_proposal(&moved(1, "pending", "accepted_no_action"))
        .unwrap();
    b.transition_decide_review_proposal(&review_moved(2, "pending", "rejected"))
        .unwrap();
    b.clock.advance(36 * 60 * MINUTE);
    let rates = b.read_proposal_review_rates().unwrap();
    // Supersede first, then the review kinds by name.
    let kinds: Vec<&str> = rates.iter().map(|r| r["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["supersede", "alpha", "zeta"]);
    assert_eq!(rates[0]["pending"], json!(1));
    assert_eq!(rates[0]["accepted"], json!(1));
    assert_eq!(rates[0]["rejected"], json!(0));
    assert_eq!(rates[0]["oldest"], json!(1.5));
    assert_eq!(rates[1]["pending"], json!(0));
    assert_eq!(rates[1]["oldest"], Value::Null);
    assert_eq!(rates[1]["rejected"], json!(1));
    assert_eq!(rates[2]["pending"], json!(1));
    // A decision is counted while it is less than 30 days old, not when it is exactly 30 days old.
    b.clock.set(T0 + 30 * DAY - 1);
    assert_eq!(
        b.read_proposal_review_rates().unwrap()[0]["accepted"],
        json!(1)
    );
    b.clock.set(T0 + 30 * DAY);
    assert_eq!(
        b.read_proposal_review_rates().unwrap()[0]["accepted"],
        json!(0)
    );
    b.clock.set(T0 + 30 * DAY);
    assert_eq!(
        b.read_proposal_review_rates().unwrap()[1]["rejected"],
        json!(0)
    );
    // An accepted proposal that is not pending has no age; pending ones keep counting up.
    assert_eq!(
        b.read_proposal_review_rates().unwrap()[0]["oldest"],
        json!(30.0)
    );
}

#[test]
fn a_queued_pair_is_due_at_once_and_a_defer_backs_it_off_ten_minutes_per_attempt() {
    let b = brain("dp-queue");
    assert_eq!(
        b.apply_decide_review_queue(&enqueue("dup", "a", "b"))
            .unwrap(),
        1
    );
    assert_eq!(
        b.apply_decide_review_queue(&enqueue("dup", "a", "b"))
            .unwrap(),
        0
    );
    let due = |limit: i64| {
        b.list_due_decide_review_queue("dup", "default", limit)
            .unwrap()
    };
    assert_eq!(
        due(10),
        vec![
            json!({"kind": "dup", "source_id": "default", "a_ref": "a", "b_ref": "b", "attempts": 0})
        ]
    );
    assert_eq!(
        b.apply_decide_review_queue(&defer_queue("dup", "a", "b"))
            .unwrap(),
        1
    );
    assert!(due(10).is_empty());
    b.clock.advance(10 * MINUTE - 1);
    assert!(due(10).is_empty());
    b.clock.advance(1);
    assert_eq!(due(10)[0]["attempts"], json!(1));
    // The second defer waits 20 minutes from now.
    b.apply_decide_review_queue(&defer_queue("dup", "a", "b"))
        .unwrap();
    b.clock.advance(20 * MINUTE - 1);
    assert!(due(10).is_empty());
    b.clock.advance(1);
    assert_eq!(due(10)[0]["attempts"], json!(2));
    // Another kind or source does not see the row; a negative limit is refused.
    assert!(
        b.list_due_decide_review_queue("withdraw", "default", 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        b.list_due_decide_review_queue("dup", "work", 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        b.list_due_decide_review_queue("dup", "default", -1)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    // Clearing and deferring a row that is gone touch nothing.
    let clear = ReviewQueueOp::Clear {
        kind: "dup".into(),
        source_id: "default".into(),
        a_ref: "a".into(),
        b_ref: "b".into(),
    };
    assert_eq!(b.apply_decide_review_queue(&clear).unwrap(), 1);
    assert_eq!(b.apply_decide_review_queue(&clear).unwrap(), 0);
    assert_eq!(
        b.apply_decide_review_queue(&defer_queue("dup", "a", "b"))
            .unwrap(),
        0
    );
}

#[test]
fn a_queue_row_with_five_attempts_is_no_longer_due_and_the_due_rows_come_back_in_order() {
    let b = brain("dp-queue-order");
    for pair in [("b", "z"), ("b", "a"), ("B", "z")] {
        b.apply_decide_review_queue(&enqueue("dup", pair.0, pair.1))
            .unwrap();
    }
    b.clock.advance(1);
    b.apply_decide_review_queue(&enqueue("dup", "a", "a"))
        .unwrap();
    let refs = |rows: Vec<Value>| -> Vec<String> {
        rows.iter()
            .map(|r| {
                format!(
                    "{}{}",
                    r["a_ref"].as_str().unwrap(),
                    r["b_ref"].as_str().unwrap()
                )
            })
            .collect()
    };
    // The three queued together tie on time and are ordered by bytes ("B" before "b"), then the later row.
    let all = b
        .list_due_decide_review_queue("dup", "default", 10)
        .unwrap();
    assert_eq!(refs(all), vec!["Bz", "ba", "bz", "aa"]);
    assert_eq!(
        refs(b.list_due_decide_review_queue("dup", "default", 2).unwrap()),
        vec!["Bz", "ba"]
    );
    assert!(
        b.list_due_decide_review_queue("dup", "default", 0)
            .unwrap()
            .is_empty()
    );
    for _ in 0..4 {
        b.apply_decide_review_queue(&defer_queue("dup", "a", "a"))
            .unwrap();
        b.clock.advance(60 * MINUTE);
    }
    assert_eq!(
        b.list_due_decide_review_queue("dup", "default", 10)
            .unwrap()
            .iter()
            .filter(|r| r["a_ref"] == "a")
            .count(),
        1
    );
    b.apply_decide_review_queue(&defer_queue("dup", "a", "a"))
        .unwrap();
    b.clock.advance(600 * MINUTE);
    // Five attempts: the row stays in the table but is never handed back.
    assert!(
        b.list_due_decide_review_queue("dup", "default", 10)
            .unwrap()
            .iter()
            .all(|r| r["a_ref"] != "a")
    );
}

#[test]
fn a_deferred_fact_backs_off_thirty_minutes_per_attempt_and_stops_at_five() {
    let b = brain("dp-deferred");
    assert_eq!(
        b.apply_decide_sweep_deferred("default", &defer_fact(7))
            .unwrap(),
        1
    );
    let due = || b.list_due_decide_sweep_deferred("default", 10).unwrap();
    assert!(due().is_empty());
    b.clock.advance(30 * MINUTE - 1);
    assert!(due().is_empty());
    b.clock.advance(1);
    assert_eq!(due(), vec![json!({"fact_id": 7, "attempts": 1})]);
    for attempt in 2..=4_i64 {
        b.apply_decide_sweep_deferred("default", &defer_fact(7))
            .unwrap();
        b.clock.advance(30 * MINUTE * attempt - 1);
        assert!(due().is_empty(), "attempt {attempt} is not yet due");
        b.clock.advance(1);
        assert_eq!(due()[0]["attempts"], json!(attempt));
    }
    // The fifth attempt drops the row from the due list for good.
    b.apply_decide_sweep_deferred("default", &defer_fact(7))
        .unwrap();
    b.clock.advance(1000 * DAY);
    assert!(due().is_empty());
    assert_eq!(
        b.apply_decide_sweep_deferred("default", &SweepDeferredOp::Clear { fact_id: json!(7) })
            .unwrap(),
        1
    );
    assert_eq!(
        b.apply_decide_sweep_deferred("default", &SweepDeferredOp::Clear { fact_id: json!(7) })
            .unwrap(),
        0
    );
}

#[test]
fn relinked_facts_are_queued_once_and_the_due_ones_come_back_by_due_time_then_fact_id() {
    let b = brain("dp-relinked");
    let relinked = |ids: &[i64]| SweepDeferredOp::Relinked {
        fact_ids: ids.iter().map(|i| json!(i)).collect(),
    };
    assert_eq!(
        b.apply_decide_sweep_deferred("default", &relinked(&[]))
            .unwrap(),
        0
    );
    b.apply_decide_sweep_deferred("default", &defer_fact(2))
        .unwrap();
    // Fact 2 already has a row and keeps it; 9 and 3 are queued, due now.
    assert_eq!(
        b.apply_decide_sweep_deferred("default", &relinked(&[9, 2, 3, 9]))
            .unwrap(),
        2
    );
    let due = b.list_due_decide_sweep_deferred("default", 10).unwrap();
    assert_eq!(ids(&due, "fact_id"), vec![3, 9]);
    assert_eq!(ids(&due, "attempts"), vec![0, 0]);
    assert_eq!(
        ids(
            &b.list_due_decide_sweep_deferred("default", 1).unwrap(),
            "fact_id"
        ),
        vec![3]
    );
    assert!(
        b.list_due_decide_sweep_deferred("work", 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        b.list_due_decide_sweep_deferred("default", -1)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    // Rows due at the same time go by fact id, a negative one first; a later one goes last.
    b.clock.advance(1);
    b.apply_decide_sweep_deferred("default", &relinked(&[-5]))
        .unwrap();
    assert_eq!(
        ids(
            &b.list_due_decide_sweep_deferred("default", 10).unwrap(),
            "fact_id"
        ),
        vec![3, 9, -5]
    );
    b.apply_decide_sweep_deferred("default", &relinked(&[-6]))
        .unwrap();
    b.clock.advance(1);
    assert_eq!(
        ids(
            &b.list_due_decide_sweep_deferred("default", 10).unwrap(),
            "fact_id"
        ),
        vec![3, 9, -6, -5]
    );
    let fractional = SweepDeferredOp::Clear {
        fact_id: json!(1.5),
    };
    assert_eq!(
        b.apply_decide_sweep_deferred("default", &fractional)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn a_non_finite_native_number_is_refused_before_a_proposal_takes_an_id() {
    let b = brain("dp-nonfinite");
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut p = proposal("s1", 0, 1, 2);
        p.p_supersede = Some(bad);
        assert_eq!(
            b.insert_decide_proposal(&p).unwrap_err().code,
            INVALID_ARGUMENT
        );
        let mut p = proposal("s1", 0, 1, 2);
        p.proposal_floor = Some(bad);
        assert_eq!(
            b.insert_decide_proposal(&p).unwrap_err().code,
            INVALID_ARGUMENT
        );
        let mut p = proposal("s1", 0, 1, 2);
        p.threshold = Some(bad);
        assert_eq!(
            b.insert_decide_proposal(&p).unwrap_err().code,
            INVALID_ARGUMENT
        );
        let mut r = review("pair", "a", "b", "s");
        r.p_action = Some(bad);
        assert_eq!(
            b.insert_decide_review_proposal(&r).unwrap_err().code,
            INVALID_ARGUMENT
        );
    }
    // nothing was stored and no id was spent: the first good insert is id 1
    assert_eq!(
        b.insert_decide_proposal(&proposal("s1", 0, 1, 2)).unwrap(),
        Some(1)
    );
}
