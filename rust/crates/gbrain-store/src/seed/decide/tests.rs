//! Read-back tests of the decide relations: each reads the rows back through the family's own
//! public reads, and checks a retry, the conflicts, and the next row the family's own writer takes.

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, SOURCE_NOT_FOUND};
use crate::eval_capture::calibration_profiles::LatestProfileSpec;
use crate::eval_capture::decide_proposals::{
    DecideProposalInput, DecideReviewProposalInput, ReviewQueueOp, SweepDeferredOp,
};
use crate::eval_capture::decide_store::{
    DecideCalibrationInput, DecideReceiptInput, DecideSpendInput,
};
use crate::seed::{ImportResult, SeedRow};
use crate::test_support::store;
use crate::timeline_queries::timestamptz_text;
use crate::{Store, keys};
use serde_json::{Value, json};

const SEED: &str = "seed-1";

fn row(pairs: &[(&str, &str)]) -> SeedRow {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), Some((*v).to_owned())))
        .collect()
}

fn import(s: &Store, relation: &str, rows: Vec<SeedRow>) -> ImportResult {
    s.import_relation(SEED, relation, rows).unwrap()
}

fn counter(s: &Store, name: &str) -> u64 {
    let read = s.read().unwrap();
    keys::be8(&read.get(&keys::meta(name)).unwrap().unwrap()).unwrap()
}

fn us(text: &str) -> i64 {
    crate::seed::decode::timestamp_us(text).unwrap()
}

#[test]
fn decide_state_keeps_the_value_and_its_time() {
    let s = store();
    let rows = vec![
        row(&[
            ("key", "reranker_owner"),
            ("value", "alpha"),
            ("updated_at", "2026-03-01 10:00:00.5+00"),
        ]),
        row(&[
            ("key", "receipt_salt"),
            ("value", "s3cret"),
            ("updated_at", "2026-03-02 00:00:00+00"),
        ]),
    ];
    let r = import(&s, "decide_state", rows.clone());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    assert_eq!(
        s.read_decide_state("reranker_owner").unwrap().as_deref(),
        Some("alpha")
    );
    assert_eq!(
        s.read_decide_state("receipt_salt").unwrap().as_deref(),
        Some("s3cret")
    );
    // No public read gives the time: read the record.
    let read = s.read().unwrap();
    let mut key = vec![keys::EVAL_CAPTURE, 0x10];
    key.extend_from_slice(b"reranker_owner");
    let record: Value = serde_json::from_slice(&read.get(&key).unwrap().unwrap()).unwrap();
    assert_eq!(record["updated_at_us"], json!(us("2026-03-01T10:00:00.5Z")));
    drop(read);
    assert_eq!(import(&s, "decide_state", rows).skipped, 2);
    // The family's own writer replaces the value.
    s.upsert_decide_state("reranker_owner", Some("beta"))
        .unwrap();
    assert_eq!(
        s.read_decide_state("reranker_owner").unwrap().as_deref(),
        Some("beta")
    );
}

fn spend_row(id: &str, at: &str, slot: &str, tokens: &str, cost: &str) -> SeedRow {
    row(&[
        ("request_id", id),
        ("created_at", at),
        ("source_id", "default"),
        ("slot", slot),
        ("provider", "typesafe:anthropic"),
        ("model_resolved", "claude-x"),
        ("lane", "main"),
        ("remote", "t"),
        ("input_tokens", tokens),
        ("cost_usd", cost),
        ("outcome", "kept"),
    ])
}

#[test]
fn decide_spend_keeps_the_time_and_orders_by_it() {
    let s = store();
    let rows = vec![
        spend_row("req-a", "2026-03-01 00:00:00+00", "conflict", "100", "0.25"),
        spend_row("req-b", "2026-03-02 00:00:00+00", "conflict", "50", "0.5"),
        spend_row("req-c", "2026-03-02 00:00:00+00", "review", "7", "1.5"),
    ];
    let r = import(&s, "decide_spend", rows.clone());
    assert_eq!((r.imported, r.skipped), (3, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    let all = s.daily_decide_spend("2026-03-01T00:00:00Z").unwrap();
    assert_eq!(all, json!({ "total": 2.25, "remote": 2.25 }));
    // `created_at` is the primary's: a window that starts after the first row leaves it out.
    let later = s.daily_decide_spend("2026-03-01T00:00:01Z").unwrap();
    assert_eq!(later, json!({ "total": 2.0, "remote": 2.0 }));
    let by_slot = s.list_decide_spend_by_slot().unwrap();
    assert_eq!(by_slot[0]["slot"], "conflict");
    assert_eq!(by_slot[0]["input_tokens"], 150);
    assert_eq!(by_slot[0]["requests"], 2);
    assert_eq!(by_slot[1]["slot"], "review");
    assert_eq!(import(&s, "decide_spend", rows).skipped, 3);
    // Sequence 1..=3 are taken; the family's writer takes the next one.
    assert_eq!(counter(&s, "decide_spend_seq"), 4);
    s.insert_decide_spend(&[DecideSpendInput {
        request_id: Some("req-d".into()),
        slot: Some("conflict".into()),
        provider: Some("typesafe:anthropic".into()),
        lane: Some("main".into()),
        remote: Some(false),
        input_tokens: Some(json!(1)),
        cost_usd: Some(json!(0.125)),
        outcome: Some("kept".into()),
        ..Default::default()
    }])
    .unwrap();
    assert_eq!(counter(&s, "decide_spend_seq"), 5);
    assert_eq!(s.list_decide_spend_by_slot().unwrap()[0]["requests"], 3);
}

fn calibration_row(id: &str, slot: &str, created: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("slot", slot),
        ("call_site", "sweep"),
        ("provider", "anthropic"),
        ("model_resolved", "claude-x"),
        ("threshold", "0.3"),
        ("min_keep", "2"),
        ("metric", "f1"),
        ("metric_value", "0.875"),
        ("n", "120"),
        ("calibrate_only", "f"),
        ("pack_shape", "default"),
        ("created_at", created),
        ("qualification", "pass"),
        ("qualified_at", "2026-03-05 00:00:00+00"),
        ("action_precision_lb", "0.9"),
        ("policy_fingerprint", "fp1"),
        ("notes", "first run"),
    ])
}

#[test]
fn decide_calibrations_keep_ids_times_and_the_retired_mark() {
    let s = store();
    let mut retired = calibration_row("42", "review", "2026-03-03 00:00:00+00");
    retired.insert("retired_at".into(), Some("2026-03-04 00:00:00+00".into()));
    let rows = vec![
        calibration_row("41", "conflict", "2026-03-01 12:00:00.25+00"),
        retired,
    ];
    let r = import(&s, "decide_calibrations", rows.clone());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    let got = s.get_decide_calibration(41.0).unwrap();
    assert_eq!(got["id"], 41);
    assert_eq!(got["slot"], "conflict");
    assert_eq!(got["threshold"], 0.3);
    assert_eq!(got["metric_value"], 0.875);
    assert_eq!(got["min_keep"], 2);
    assert_eq!(got["n"], 120);
    assert_eq!(got["calibrate_only"], false);
    assert_eq!(got["qualification"], "pass");
    assert_eq!(got["qualified_at"], iso(us("2026-03-05T00:00:00Z")));
    assert_eq!(got["created_at"], iso(us("2026-03-01T12:00:00.25Z")));
    assert_eq!(got["retired_at"], Value::Null);
    let listed = s.list_decide_calibrations(None, false).unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    let all = s.list_decide_calibrations(None, true).unwrap();
    assert_eq!(all[1]["id"], 42);
    assert_eq!(all[1]["retired_at"], iso(us("2026-03-04T00:00:00Z")));
    assert_eq!(import(&s, "decide_calibrations", rows).skipped, 2);
    let next = s
        .insert_decide_calibration(&DecideCalibrationInput {
            slot: Some("conflict".into()),
            call_site: Some("sweep".into()),
            provider: Some("anthropic".into()),
            model_resolved: Some("claude-x".into()),
            threshold: Some(json!(0.5)),
            metric: Some("f1".into()),
            n: Some(json!(1)),
            calibrate_only: Some(true),
            pack_shape: Some("default".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(next, 43);
}

fn receipt_row(id: &str, at: &str, slot: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("decision_id", "d-1"),
        ("created_at", at),
        ("source_id", "default"),
        ("slot", slot),
        ("mode", "live"),
        ("provider", "anthropic"),
        ("answer_value", "0.75"),
        ("outcome", "kept"),
        ("call_site", "sweep"),
        ("lane", "main"),
        ("latency_ms", "120"),
        ("input_tokens", "30"),
        ("protected", "f"),
        ("remote", "t"),
    ])
}

#[test]
fn decision_receipts_keep_ids_and_the_time_index() {
    let s = store();
    let now = s.env.now_micros();
    let hours_ago = |h: i64| timestamptz_text(now - h * 3_600_000_000);
    let rows = vec![
        receipt_row("7", &hours_ago(2), "conflict"),
        receipt_row("8", &hours_ago(24 * 90), "conflict"),
    ];
    let r = import(&s, "decision_receipts", rows.clone());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    // The window reads the time index: the first receipt is inside three hours, not inside one.
    let stats = s.list_decide_receipt_stats(None, 3.0).unwrap();
    assert_eq!(stats.as_array().unwrap().len(), 1);
    assert_eq!(stats[0]["n"], 1);
    assert_eq!(stats[0]["avg_value"], 0.75);
    assert_eq!(stats[0]["input_tokens"], 30);
    assert_eq!(stats[0]["p50_latency"], 120.0);
    assert!(
        s.list_decide_receipt_stats(None, 1.0)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(import(&s, "decision_receipts", rows).skipped, 2);
    // The prune walks the same index: only the old receipt goes.
    assert_eq!(s.prune_decide_receipts(30.0).unwrap(), 1);
    assert_eq!(s.list_decide_receipt_stats(None, 3.0).unwrap()[0]["n"], 1);
    // The family's writer takes the next id.
    s.insert_decide_receipts(&[DecideReceiptInput {
        decision_id: Some("d-2".into()),
        slot: Some("review".into()),
        mode: Some("live".into()),
        provider: Some("anthropic".into()),
        outcome: Some("kept".into()),
        call_site: Some("sweep".into()),
        lane: Some("main".into()),
        protected: Some(false),
        remote: Some(false),
        ..Default::default()
    }])
    .unwrap();
    assert_eq!(counter(&s, "decide_receipt_id"), 10);
}

fn proposal_row(id: &str, sweep: &str, pair: &str, new: &str, old: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("created_at", "2026-03-01 08:00:00.5+00"),
        ("source_id", "default"),
        ("sweep_id", sweep),
        ("pair_index", pair),
        ("new_fact_id", new),
        ("old_fact_id", old),
        ("direction", "new_supersedes_old"),
        ("p_supersede", "0.25"),
        ("threshold", "0.5"),
        ("proposal_floor", "0.1"),
        ("model_resolved", "claude-x"),
        ("status", "accepted"),
        ("decided_at", "2026-03-02 09:00:00+00"),
        ("before_state", "before"),
        ("after_state", "after"),
    ])
}

#[test]
fn decide_proposals_keep_ids_state_and_both_unique_keys() {
    let s = store();
    let rows = vec![
        proposal_row("31", "claim_conflicts:a", "0", "5", "9"),
        proposal_row("32", "sweep-b", "0", "5", "9"),
    ];
    let r = import(&s, "decide_proposals", rows.clone());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    let got = s.get_decide_proposal(31).unwrap().unwrap();
    assert_eq!(got["id"], 31);
    assert_eq!(got["created_at"], iso(us("2026-03-01T08:00:00.5Z")));
    assert_eq!(got["decided_at"], iso(us("2026-03-02T09:00:00Z")));
    assert_eq!(got["status"], "accepted");
    assert_eq!(got["p_supersede"], 0.25);
    assert_eq!(got["threshold"], 0.5);
    assert_eq!(got["before_state"], "before");
    assert_eq!(
        s.list_decide_proposal_ids("sweep-b", "accepted").unwrap(),
        [32]
    );
    assert_eq!(import(&s, "decide_proposals", rows).skipped, 2);
    // The sweep slot is unique.
    let err = s
        .import_relation(
            SEED,
            "decide_proposals",
            vec![proposal_row("33", "sweep-b", "0", "1", "2")],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    // So is the unordered pair of a claim sweep, in the same source.
    let err = s
        .import_relation(
            SEED,
            "decide_proposals",
            vec![proposal_row("34", "claim_conflicts:b", "0", "9", "5")],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    // The family's writer meets the same keys, and takes the next id.
    let input = |sweep: &str, new: i64, old: i64| DecideProposalInput {
        source_id: Some("default".into()),
        sweep_id: Some(sweep.into()),
        pair_index: Some(json!(1)),
        new_fact_id: Some(json!(new)),
        old_fact_id: Some(json!(old)),
        direction: Some("new_supersedes_old".into()),
        p_supersede: Some(0.5),
        proposal_floor: Some(0.1),
        ..Default::default()
    };
    assert_eq!(
        s.insert_decide_proposal(&input("claim_conflicts:c", 9, 5))
            .unwrap(),
        None
    );
    assert_eq!(
        s.insert_decide_proposal(&input("sweep-c", 9, 5)).unwrap(),
        Some(34)
    );
}

fn review_proposal_row(id: &str, subject: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("created_at", "2026-03-01 08:00:00+00"),
        ("kind", "withdraw"),
        ("source_id", "default"),
        ("sweep_id", "sweep-1"),
        ("a_ref", "fact:1"),
        ("b_ref", "*"),
        ("subject", subject),
        ("visibility", "world"),
        ("p_action", "0.8"),
        ("status", "pending"),
        ("receipt", "r-1"),
    ])
}

#[test]
fn decide_review_proposals_keep_ids_and_the_unique_key() {
    let s = store();
    let rows = vec![review_proposal_row("11", "*")];
    let r = import(&s, "decide_review_proposals", rows.clone());
    assert_eq!((r.imported, r.skipped), (1, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    let got = s.get_decide_review_proposal(11).unwrap().unwrap();
    assert_eq!(got["id"], 11);
    assert_eq!(got["kind"], "withdraw");
    assert_eq!(got["created_at"], "2026-03-01 08:00:00+00");
    assert_eq!(got["p_action"], 0.8);
    assert_eq!(got["visibility"], "world");
    assert_eq!(got["receipt"], "r-1");
    assert_eq!(s.list_decide_review_proposals("pending").unwrap().len(), 1);
    assert_eq!(import(&s, "decide_review_proposals", rows).skipped, 1);
    let err = s
        .import_relation(
            SEED,
            "decide_review_proposals",
            vec![review_proposal_row("12", "*")],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    // The family's writer meets the unique key, and takes the next id.
    let input = |subject: &str| DecideReviewProposalInput {
        kind: Some("withdraw".into()),
        source_id: Some("default".into()),
        sweep_id: Some("sweep-1".into()),
        a_ref: Some("fact:1".into()),
        b_ref: Some("*".into()),
        subject: Some(subject.into()),
        p_action: Some(0.5),
        ..Default::default()
    };
    assert_eq!(s.insert_decide_review_proposal(&input("*")).unwrap(), None);
    assert_eq!(
        s.insert_decide_review_proposal(&input("other")).unwrap(),
        Some(13)
    );
}

fn queue_row(a: &str, attempts: &str, next: &str) -> SeedRow {
    row(&[
        ("kind", "withdraw"),
        ("source_id", "default"),
        ("a_ref", a),
        ("b_ref", "*"),
        ("evidence", "e"),
        ("reason", "queued"),
        ("attempts", attempts),
        ("next_attempt_at", next),
        ("created_at", "2026-03-01 00:00:00+00"),
    ])
}

#[test]
fn decide_review_queue_keeps_attempts_and_due_times() {
    let s = store();
    let rows = vec![
        queue_row("fact:1", "2", "2026-03-01 00:00:00+00"),
        queue_row("fact:2", "5", "2026-03-01 00:00:00+00"),
        queue_row("fact:3", "0", "2999-01-01 00:00:00+00"),
    ];
    let r = import(&s, "decide_review_queue", rows.clone());
    assert_eq!((r.imported, r.skipped), (3, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    // Due, and under five attempts: only the first row.
    let due = s
        .list_due_decide_review_queue("withdraw", "default", 10)
        .unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0]["a_ref"], "fact:1");
    assert_eq!(due[0]["attempts"], 2);
    assert_eq!(import(&s, "decide_review_queue", rows).skipped, 3);
    // The family's writer sees the pair as queued.
    let enqueue = |a: &str| ReviewQueueOp::Enqueue {
        kind: "withdraw".into(),
        source_id: "default".into(),
        a_ref: a.into(),
        b_ref: "*".into(),
        evidence: None,
    };
    assert_eq!(s.apply_decide_review_queue(&enqueue("fact:1")).unwrap(), 0);
    assert_eq!(s.apply_decide_review_queue(&enqueue("fact:4")).unwrap(), 1);
}

fn deferred_row(fact: &str, attempts: &str, next: &str) -> SeedRow {
    row(&[
        ("source_id", "default"),
        ("fact_id", fact),
        ("slot", "conflict"),
        ("reason", "rate_limited"),
        ("attempts", attempts),
        ("next_attempt_at", next),
        ("created_at", "2026-03-01 00:00:00+00"),
    ])
}

#[test]
fn decide_sweep_deferred_keeps_attempts_and_due_times() {
    let s = store();
    let rows = vec![
        deferred_row("30", "2", "2026-03-01 00:00:00+00"),
        deferred_row("10", "1", "2026-02-01 00:00:00+00"),
        deferred_row("20", "5", "2026-03-01 00:00:00+00"),
        deferred_row("40", "0", "2999-01-01 00:00:00+00"),
    ];
    let r = import(&s, "decide_sweep_deferred", rows.clone());
    assert_eq!((r.imported, r.skipped), (4, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    // Due, and under five attempts: facts 10 and 30, by due time.
    let due = s.list_due_decide_sweep_deferred("default", 10).unwrap();
    assert_eq!(
        due,
        [
            json!({ "fact_id": 10, "attempts": 1 }),
            json!({ "fact_id": 30, "attempts": 2 }),
        ]
    );
    assert!(
        s.list_due_decide_sweep_deferred("other", 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(import(&s, "decide_sweep_deferred", rows).skipped, 4);
    // The family's writer sees the rows: a relink leaves a held fact alone and queues a new one,
    // and a defer backs the seeded attempts off one more.
    let relinked = SweepDeferredOp::Relinked {
        fact_ids: vec![json!(30), json!(50)],
    };
    assert_eq!(
        s.apply_decide_sweep_deferred("default", &relinked).unwrap(),
        1
    );
    let defer = SweepDeferredOp::Defer {
        fact_id: json!(10),
        reason: "again".into(),
    };
    s.apply_decide_sweep_deferred("default", &defer).unwrap();
    let due = s.list_due_decide_sweep_deferred("default", 10).unwrap();
    assert_eq!(
        due,
        [
            json!({ "fact_id": 30, "attempts": 2 }),
            json!({ "fact_id": 50, "attempts": 0 }),
        ]
    );
}

fn profile_row(id: &str, generated: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("source_id", "default"),
        ("holder", "people/alice-example"),
        ("wave_version", "v0.36.1.0"),
        ("generated_at", generated),
        ("published", "t"),
        ("total_resolved", "40"),
        ("brier", "0.3"),
        ("accuracy", "0.75"),
        ("grade_completion", "1"),
        ("domain_scorecards", r#"{"work": {"n": 4}}"#),
        ("pattern_statements", r#"{"tends to be early","a, b"}"#),
        ("voice_gate_passed", "t"),
        ("voice_gate_attempts", "2"),
        ("active_bias_tags", "{overconfident}"),
        ("model_id", "claude-x"),
    ])
}

#[test]
fn calibration_profiles_keep_ids_times_and_the_source() {
    let s = store();
    let rows = vec![
        profile_row("21", "2026-03-01 00:00:00+00"),
        profile_row("22", "2026-03-02 00:00:00.5+00"),
    ];
    let r = import(&s, "calibration_profiles", rows.clone());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    // The newest by `generated_at` comes first.
    let got = s
        .get_latest_calibration_profile(&LatestProfileSpec::default())
        .unwrap()
        .unwrap();
    assert_eq!(got["id"], "22");
    assert_eq!(got["generated_at"], iso(us("2026-03-02T00:00:00.5Z")));
    assert_eq!(got["brier"], 0.3);
    assert_eq!(got["published"], true);
    assert_eq!(got["voice_gate_attempts"], 2);
    assert_eq!(
        got["pattern_statements"],
        json!(["tends to be early", "a, b"])
    );
    assert_eq!(got["active_bias_tags"], json!(["overconfident"]));
    assert_eq!(import(&s, "calibration_profiles", rows).skipped, 2);
    // The family's writer takes the next id.
    s.insert_calibration_profile(
        &serde_json::from_value(json!({
            "sourceId": "default", "holder": "h", "totalResolved": 1, "gradeCompletion": 1,
            "domainScorecards": {}, "patternStatements": [], "voiceGatePassed": true,
            "voiceGateAttempts": 1, "activeBiasTags": [], "modelId": "m",
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(counter(&s, "calibration_profile_next_id"), 24);
    // The source must be seeded.
    let mut orphan = profile_row("30", "2026-03-03 00:00:00+00");
    orphan.insert("source_id".into(), Some("nowhere".into()));
    let err = s
        .import_relation(SEED, "calibration_profiles", vec![orphan])
        .unwrap_err();
    assert_eq!(err.code, SOURCE_NOT_FOUND);
}

#[test]
fn calibration_profile_cost_and_agreement_are_unmapped_when_set() {
    let s = store();
    let r = import(
        &s,
        "calibration_profiles",
        vec![profile_row("21", "2026-03-01 00:00:00+00")],
    );
    assert!(r.unmapped_columns.is_empty());
    let mut with_cost = profile_row("22", "2026-03-02 00:00:00+00");
    with_cost.insert("cost_usd".into(), Some("0.0123".into()));
    with_cost.insert("judge_model_agreement".into(), Some("0.9".into()));
    let r = import(&s, "calibration_profiles", vec![with_cost]);
    assert_eq!(r.unmapped_columns, ["cost_usd", "judge_model_agreement"]);
}

#[test]
fn dream_synthesis_completions_keep_the_time() {
    let s = store();
    let rows = vec![
        row(&[
            ("source_id", "default"),
            ("idempotency_key", "dream:synth-v2:abc"),
            ("completed_at", "2026-03-01 00:00:00+00"),
        ]),
        row(&[
            ("source_id", "default"),
            ("idempotency_key", "dream:synth-v1:old"),
            ("completed_at", "2026-02-01 00:00:00+00"),
        ]),
    ];
    let r = import(&s, "dream_synthesis_completions", rows.clone());
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.losses.is_empty() && r.unmapped_columns.is_empty());
    assert_eq!(
        s.list_synthesis_completion_keys("default", "dream:synth")
            .unwrap(),
        ["dream:synth-v1:old", "dream:synth-v2:abc"]
    );
    assert!(
        s.list_synthesis_completion_keys("other", "dream:synth")
            .unwrap()
            .is_empty()
    );
    // `at` is the primary's `completed_at`: the window reaches it from far enough back only.
    let hours = (s.env.now_micros() - us("2026-03-01T00:00:00Z")) as f64 / 3_600_000_000.0;
    let recent = s
        .list_recent_synthesis_completions("default", hours + 1.0)
        .unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0]["idempotency_key"], "dream:synth-v2:abc");
    assert_eq!(recent[0]["at"], iso(us("2026-03-01T00:00:00Z")));
    assert!(
        s.list_recent_synthesis_completions("default", hours - 1.0)
            .unwrap()
            .is_empty()
    );
    assert_eq!(import(&s, "dream_synthesis_completions", rows).skipped, 2);
}

#[test]
fn the_decide_relations_import_in_dependency_order() {
    let names: Vec<_> = crate::seed::plan()
        .relations
        .iter()
        .map(|p| p.relation)
        .collect();
    let at = |name: &str| names.iter().position(|n| *n == name).unwrap();
    let decide = [
        "decide_state",
        "decide_spend",
        "decide_calibrations",
        "decision_receipts",
        "decide_proposals",
        "decide_sweep_deferred",
        "decide_review_proposals",
        "decide_review_queue",
        "calibration_profiles",
        "dream_synthesis_completions",
    ];
    for pair in decide.windows(2) {
        assert!(at(pair[0]) < at(pair[1]), "{pair:?}");
    }
    assert!(at("sources") < at("calibration_profiles"));
}
