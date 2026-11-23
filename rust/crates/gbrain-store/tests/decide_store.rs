//! The decide store: decide state, the spend ledger, receipts and calibrations, matched to the
//! PGLite engine (src/core/engine-sql/decide-store.ts).

mod common;

use common::TempDir;
use gbrain_store::env::{Env, iso};
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::eval_capture::decide_store::{
    DecideCalibrationInput, DecideQualificationInput, DecideReceiptInput, DecideSpendInput,
};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{OpenOptions, Store};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

/// A clock the test moves by hand; every reading advances it one microsecond so stamps differ.
struct Clock(AtomicI64);

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.0.fetch_add(1, Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        "00000000-0000-4000-8000-000000000000".into()
    }
}

const T0: i64 = 1_800_000_000_000_000;

fn open(dir: &TempDir) -> (Store, Arc<Clock>) {
    let clock = Arc::new(Clock(AtomicI64::new(T0)));
    let kv = RedbKv::open_path(&dir.path().join("records.redb")).unwrap();
    let store = Store::open_kv(Arc::new(kv), clock.clone(), OpenOptions::default()).unwrap();
    (store, clock)
}

#[test]
fn state_keeps_the_last_value_and_forgets_one_key() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    assert_eq!(store.read_decide_state("kill_switch").unwrap(), None);
    store
        .upsert_decide_state("kill_switch", Some("on"))
        .unwrap();
    store.upsert_decide_state("salt", Some("s1")).unwrap();
    store
        .upsert_decide_state("kill_switch", Some("off"))
        .unwrap();
    assert_eq!(
        store.read_decide_state("kill_switch").unwrap().as_deref(),
        Some("off")
    );
    store.delete_decide_state("kill_switch").unwrap();
    store.delete_decide_state("kill_switch").unwrap();
    assert_eq!(store.read_decide_state("kill_switch").unwrap(), None);
    assert_eq!(
        store.read_decide_state("salt").unwrap().as_deref(),
        Some("s1")
    );
}

#[test]
fn state_keys_differ_by_exact_text_and_keep_empty_values() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    for (k, v) in [
        ("", "empty key"),
        ("a", ""),
        ("A", "upper"),
        ("a ", "spaced"),
    ] {
        store.upsert_decide_state(k, Some(v)).unwrap();
    }
    assert_eq!(
        store.read_decide_state("").unwrap().as_deref(),
        Some("empty key")
    );
    assert_eq!(store.read_decide_state("a").unwrap().as_deref(), Some(""));
    assert_eq!(
        store.read_decide_state("A").unwrap().as_deref(),
        Some("upper")
    );
    assert_eq!(
        store.read_decide_state("a ").unwrap().as_deref(),
        Some("spaced")
    );
    assert_eq!(store.read_decide_state("b").unwrap(), None);
}

#[test]
fn ensure_keeps_the_first_value_and_answers_the_stored_one() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    assert_eq!(
        store
            .ensure_decide_state("salt", Some("a"))
            .unwrap()
            .as_deref(),
        Some("a")
    );
    assert_eq!(
        store
            .ensure_decide_state("salt", Some("b"))
            .unwrap()
            .as_deref(),
        Some("a")
    );
    store.upsert_decide_state("salt", Some("c")).unwrap();
    assert_eq!(
        store
            .ensure_decide_state("salt", Some("d"))
            .unwrap()
            .as_deref(),
        Some("c")
    );
    store.delete_decide_state("salt").unwrap();
    assert_eq!(
        store
            .ensure_decide_state("salt", Some("e"))
            .unwrap()
            .as_deref(),
        Some("e")
    );
}

#[test]
fn state_refuses_a_null_value_or_a_nul_byte_and_keeps_what_was_stored() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    store.upsert_decide_state("kept", Some("original")).unwrap();
    assert_eq!(
        store.upsert_decide_state("kept", None).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        store.ensure_decide_state("fresh", None).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        store
            .upsert_decide_state("bad\0key", Some("v"))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store
            .upsert_decide_state("kept", Some("bad\0value"))
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store.read_decide_state("bad\0key").unwrap_err().code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store.read_decide_state("kept").unwrap().as_deref(),
        Some("original")
    );
    assert_eq!(store.read_decide_state("fresh").unwrap(), None);
}

// ---------------------------------------------------------------- spend

const HOUR: i64 = 3_600_000_000;

fn spend(
    id: &str,
    slot: &str,
    provider: &str,
    remote: bool,
    tokens: i64,
    cost: f64,
) -> DecideSpendInput {
    DecideSpendInput {
        request_id: Some(id.into()),
        source_id: Some("default".into()),
        slot: Some(slot.into()),
        provider: Some(provider.into()),
        model_resolved: Some("m".into()),
        lane: Some("sweep".into()),
        remote: Some(remote),
        input_tokens: Some(json!(tokens)),
        cost_usd: Some(json!(cost)),
        outcome: Some("ok".into()),
    }
}

fn totals(v: &Value) -> (f64, f64) {
    (v["total"].as_f64().unwrap(), v["remote"].as_f64().unwrap())
}

#[test]
fn spend_windows_follow_the_clock_and_count_only_typesafe_providers() {
    let dir = TempDir::new("decide-store");
    let (store, clock) = open(&dir);
    // The first batch is stamped with the next reading of the clock.
    let first_stamp = clock.0.load(Ordering::SeqCst);
    store
        .insert_decide_spend(&[
            spend("a", "conflict", "typesafe:x", false, 1, 0.5),
            spend("b", "conflict", "typesafe:x", true, 1, 0.25),
            spend("c", "conflict", "local:y", true, 1, 8.0),
        ])
        .unwrap();
    clock.0.fetch_add(3 * HOUR, Ordering::SeqCst);
    store
        .insert_decide_spend(&[spend("d", "triage", "typesafe:x", true, 1, 1.0)])
        .unwrap();
    let all = store.daily_decide_spend(&iso(0)).unwrap();
    assert_eq!(totals(&all), (1.75, 1.25));
    // Two hours after the first batch: only the second batch is at or after it.
    let late = store
        .daily_decide_spend(&iso(first_stamp + 2 * HOUR))
        .unwrap();
    assert_eq!(totals(&late), (1.0, 1.0));
    let none = store
        .daily_decide_spend(&iso(first_stamp + 4 * HOUR))
        .unwrap();
    assert_eq!(totals(&none), (0.0, 0.0));
    // A row stamped exactly at `since` counts (`>=`): the first batch carries one stamp, so `since` one microsecond later leaves it out.
    let at = store.daily_decide_spend(&iso(first_stamp)).unwrap();
    assert_eq!(totals(&at), (1.75, 1.25));
    let after = store.daily_decide_spend(&iso(first_stamp + 1)).unwrap();
    assert_eq!(totals(&after), (1.0, 1.0));
    assert_eq!(
        store.daily_decide_spend("not a date").unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn spend_costs_add_in_insertion_order_and_slots_list_in_byte_order() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    store
        .insert_decide_spend(&[
            spend("1", "b", "typesafe:x", false, 1, 0.1),
            spend("2", "A", "typesafe:x", false, 2, 0.2),
        ])
        .unwrap();
    store
        .insert_decide_spend(&[spend("3", "b", "typesafe:x", false, 4, 0.3)])
        .unwrap();
    // (0.1 + 0.2) + 0.3: the order Postgres adds them in.
    let (total, _) = totals(&store.daily_decide_spend(&iso(0)).unwrap());
    assert_eq!(total, (0.1 + 0.2) + 0.3);
    let by_slot = store.list_decide_spend_by_slot().unwrap();
    assert_eq!(
        by_slot,
        json!([
            { "slot": "A", "input_tokens": 2, "cost_usd": 0.2, "requests": 1 },
            { "slot": "b", "input_tokens": 5, "cost_usd": 0.1 + 0.3, "requests": 2 },
        ])
    );
}

#[test]
fn spend_keeps_the_first_row_of_a_request_id_and_survives_a_reopen() {
    let dir = TempDir::new("decide-store");
    {
        let (store, _) = open(&dir);
        store
            .insert_decide_spend(&[
                spend("dup", "one", "typesafe:x", false, 1, 1.0),
                spend("dup", "two", "typesafe:x", false, 2, 2.0),
            ])
            .unwrap();
        store
            .insert_decide_spend(&[spend("dup", "three", "typesafe:x", false, 4, 4.0)])
            .unwrap();
    }
    let (store, _) = open(&dir);
    assert_eq!(
        store.list_decide_spend_by_slot().unwrap(),
        json!([{ "slot": "one", "input_tokens": 1, "cost_usd": 1.0, "requests": 1 }])
    );
    store.insert_decide_spend(&[]).unwrap();
}

#[test]
fn spend_refuses_a_bad_row_and_records_none_of_its_batch() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    let good = || spend("good", "s", "typesafe:x", false, 1, 1.0);
    let refused =
        |row: DecideSpendInput| store.insert_decide_spend(&[good(), row]).unwrap_err().code;
    let base = || spend("bad", "s", "typesafe:x", false, 1, 1.0);
    let cases: Vec<(&str, DecideSpendInput, &str)> = vec![
        (
            "request_id",
            DecideSpendInput {
                request_id: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "slot",
            DecideSpendInput {
                slot: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "provider",
            DecideSpendInput {
                provider: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "lane",
            DecideSpendInput {
                lane: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "remote",
            DecideSpendInput {
                remote: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "input_tokens",
            DecideSpendInput {
                input_tokens: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "input_tokens null",
            DecideSpendInput {
                input_tokens: Some(Value::Null),
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "cost_usd",
            DecideSpendInput {
                cost_usd: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "outcome",
            DecideSpendInput {
                outcome: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "nul",
            DecideSpendInput {
                slot: Some("a\0b".into()),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "fraction",
            DecideSpendInput {
                input_tokens: Some(json!(1.5)),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "too big",
            DecideSpendInput {
                input_tokens: Some(json!(2_147_483_648_i64)),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "text tokens",
            DecideSpendInput {
                input_tokens: Some(json!("7")),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "text cost",
            DecideSpendInput {
                cost_usd: Some(json!("1")),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
    ];
    for (name, row, code) in cases {
        assert_eq!(refused(row), code, "{name}");
    }
    assert_eq!(store.list_decide_spend_by_slot().unwrap(), json!([]));
    assert_eq!(
        totals(&store.daily_decide_spend(&iso(0)).unwrap()),
        (0.0, 0.0)
    );
    // The refused batches burned no request id: it records now.
    store.insert_decide_spend(&[good()]).unwrap();
    assert_eq!(
        store.list_decide_spend_by_slot().unwrap(),
        json!([{ "slot": "s", "input_tokens": 1, "cost_usd": 1.0, "requests": 1 }])
    );
}

// ---------------------------------------------------------------- receipts

const DAY: i64 = 24 * HOUR;

fn receipt(decision: &str, slot: &str, outcome: &str) -> DecideReceiptInput {
    DecideReceiptInput {
        decision_id: Some(decision.into()),
        slot: Some(slot.into()),
        mode: Some("live".into()),
        provider: Some("typesafe:x".into()),
        outcome: Some(outcome.into()),
        call_site: Some("sweep".into()),
        lane: Some("sweep".into()),
        protected: Some(false),
        remote: Some(false),
        ..DecideReceiptInput::default()
    }
}

fn with_latency(mut r: DecideReceiptInput, ms: i64) -> DecideReceiptInput {
    r.latency_ms = Some(json!(ms));
    r
}

fn with_model(mut r: DecideReceiptInput, model: &str) -> DecideReceiptInput {
    r.model_resolved = Some(model.into());
    r
}

fn with_reason(mut r: DecideReceiptInput, reason: &str) -> DecideReceiptInput {
    r.error_reason = Some(reason.into());
    r
}

fn slots(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| r["slot"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn receipt_windows_follow_the_clock_in_every_read() {
    let dir = TempDir::new("decide-store");
    let (store, clock) = open(&dir);
    store
        .insert_decide_receipts(&[
            with_model(receipt("old", "conflict", "kept"), "m-old"),
            with_reason(receipt("old-mixed", "conflict", "skipped"), "mixed_model"),
        ])
        .unwrap();
    clock.0.fetch_add(3 * HOUR, Ordering::SeqCst);
    // The second batch is stamped with the next reading of the clock.
    let second_stamp = clock.0.load(Ordering::SeqCst);
    store
        .insert_decide_receipts(&[
            with_model(receipt("new", "conflict", "kept"), "m-new"),
            with_reason(receipt("new-skip", "conflict", "skipped"), "no_entity"),
            with_reason(receipt("new-mixed", "triage", "skipped"), "mixed_model"),
        ])
        .unwrap();
    // Two hours back reaches the second batch only; four reaches both; zero reaches neither.
    let rows = |hours: f64| store.decide_slot_usage(hours).unwrap();
    let count = |v: &Value, slot: &str| {
        v.as_array()
            .unwrap()
            .iter()
            .find(|r| r["slot"] == slot)
            .map(|r| r["rows"].as_i64().unwrap())
            .unwrap_or(0)
    };
    assert_eq!(
        (count(&rows(2.0), "conflict"), count(&rows(2.0), "triage")),
        (2, 1)
    );
    assert_eq!(
        (count(&rows(4.0), "conflict"), count(&rows(4.0), "triage")),
        (4, 1)
    );
    assert_eq!(rows(0.0), json!([]));
    let conflict = |hours: f64| store.decide_conflict_no_entity_counts(hours).unwrap();
    assert_eq!(conflict(2.0), json!({ "receipts": 2, "skipped": 1 }));
    assert_eq!(conflict(4.0), json!({ "receipts": 4, "skipped": 1 }));
    let models = |hours: f64| store.list_decide_resolved_models(hours).unwrap();
    assert_eq!(models(2.0).as_array().unwrap().len(), 1);
    // The newest group comes first, and `last_at` is the time of its newest receipt.
    let both = models(4.0);
    assert_eq!(both[0]["model_resolved"], "m-new");
    assert_eq!(both[1]["model_resolved"], "m-old");
    assert_eq!(both[0]["last_at"], iso(second_stamp));
    let mixed = |hours: f64| store.list_decide_mixed_model_decisions(hours).unwrap();
    assert_eq!(mixed(2.0), json!([{ "slot": "triage", "n": 1 }]));
    assert_eq!(
        mixed(4.0),
        json!([{ "slot": "conflict", "n": 1 }, { "slot": "triage", "n": 1 }])
    );
    assert_eq!(
        store
            .list_decide_receipt_stats(Some("conflict"), 2.0)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["n"].as_i64().unwrap())
            .sum::<i64>(),
        2
    );
    // A negative window starts in the future: nothing is in it.
    assert_eq!(rows(-1.0), json!([]));
}

#[test]
fn a_resolved_model_reports_the_newest_time_of_its_group_and_mixed_counts_only_mixed_model() {
    let dir = TempDir::new("decide-store");
    let (store, clock) = open(&dir);
    store
        .insert_decide_receipts(&[with_model(receipt("first", "conflict", "kept"), "m-x")])
        .unwrap();
    clock.0.fetch_add(HOUR, Ordering::SeqCst);
    let later_stamp = clock.0.load(Ordering::SeqCst);
    store
        .insert_decide_receipts(&[
            with_model(receipt("second", "conflict", "kept"), "m-x"),
            with_reason(receipt("slow", "conflict", "error"), "timeout"),
        ])
        .unwrap();
    let models = store.list_decide_resolved_models(4.0).unwrap();
    assert_eq!(models.as_array().unwrap().len(), 1);
    assert_eq!(models[0]["n"], 2);
    assert_eq!(models[0]["last_at"], iso(later_stamp));
    // A receipt with some other reason is not a mixed-model decision.
    assert_eq!(
        store.list_decide_mixed_model_decisions(4.0).unwrap(),
        json!([])
    );
}

#[test]
fn prune_drops_old_receipts_and_keeps_spend_for_at_least_31_days() {
    let dir = TempDir::new("decide-store");
    let (store, clock) = open(&dir);
    store
        .insert_decide_receipts(&[
            receipt("a", "conflict", "kept"),
            receipt("b", "triage", "kept"),
        ])
        .unwrap();
    store
        .insert_decide_spend(&[spend("s1", "conflict", "typesafe:x", false, 1, 0.5)])
        .unwrap();
    clock.0.fetch_add(10 * DAY, Ordering::SeqCst);
    store
        .insert_decide_receipts(&[receipt("c", "conflict", "kept")])
        .unwrap();
    // Seven days: the two old receipts go; ten-day-old spend stays (31-day floor).
    assert_eq!(store.prune_decide_receipts(7.0).unwrap(), 2);
    assert_eq!(store.prune_decide_receipts(7.0).unwrap(), 0);
    assert_eq!(
        store
            .decide_slot_usage(24.0 * 365.0)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        totals(&store.daily_decide_spend(&iso(0)).unwrap()),
        (0.5, 0.0)
    );
    // Thirty-one days is the floor for a shorter retention; a longer one is used as given.
    clock.0.fetch_add(25 * DAY, Ordering::SeqCst);
    assert_eq!(store.prune_decide_receipts(1.0).unwrap(), 1);
    assert_eq!(
        totals(&store.daily_decide_spend(&iso(0)).unwrap()),
        (0.0, 0.0)
    );
    store
        .insert_decide_spend(&[spend("s2", "conflict", "typesafe:x", false, 1, 0.25)])
        .unwrap();
    clock.0.fetch_add(40 * DAY, Ordering::SeqCst);
    assert_eq!(store.prune_decide_receipts(60.0).unwrap(), 0);
    assert_eq!(
        totals(&store.daily_decide_spend(&iso(0)).unwrap()),
        (0.25, 0.0)
    );
    assert_eq!(store.prune_decide_receipts(30.0).unwrap(), 0);
    assert_eq!(
        totals(&store.daily_decide_spend(&iso(0)).unwrap()),
        (0.0, 0.0)
    );
}

#[test]
fn stats_average_interpolate_and_group_the_way_postgres_does() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    let mut rows = Vec::new();
    for (i, ms) in [1, 2, 3, 4, 5, 6, 7, 8, 9, 100].into_iter().enumerate() {
        let mut r = with_latency(receipt(&format!("d{i}"), "conflict", "kept"), ms);
        r.answer_value = Some(json!(if i % 2 == 0 { 0.5 } else { 0.25 }));
        r.input_tokens = Some(json!(10));
        rows.push(r);
    }
    rows.push(receipt("null-value", "conflict", "kept"));
    rows.push(with_reason(receipt("e1", "conflict", "error"), "timeout"));
    rows.push(receipt("e2", "conflict", "error"));
    rows.push(receipt("t1", "Triage", "kept"));
    store.insert_decide_receipts(&rows).unwrap();
    let stats = store.list_decide_receipt_stats(None, 1.0).unwrap();
    let stats = stats.as_array().unwrap();
    // Byte order: 'Triage' < 'conflict'; within the slot 'error' < 'kept'; a null reason sorts last.
    let keys: Vec<(String, String, Value)> = stats
        .iter()
        .map(|r| {
            (
                r["slot"].as_str().unwrap().into(),
                r["outcome"].as_str().unwrap().into(),
                r["error_reason"].clone(),
            )
        })
        .collect();
    assert_eq!(
        keys,
        vec![
            ("Triage".into(), "kept".into(), Value::Null),
            ("conflict".into(), "error".into(), json!("timeout")),
            ("conflict".into(), "error".into(), Value::Null),
            ("conflict".into(), "kept".into(), Value::Null),
        ]
    );
    let kept = &stats[3];
    assert_eq!(kept["n"], 11);
    // Five 0.5s and five 0.25s; the null value is not counted: 3.75 / 10.
    assert_eq!(kept["avg_value"], 0.375);
    // Ten latencies 1..9 and 100: p50 sits between the 5th and 6th (5.5), p95 at row 8.55.
    assert_eq!(kept["p50_latency"], 5.5);
    let p95 = kept["p95_latency"].as_f64().unwrap();
    assert!((p95 - (9.0 + 0.55 * 91.0)).abs() < 1e-9, "{p95}");
    assert_eq!(kept["input_tokens"], 100);
    // No latency, value or token anywhere in a group: nulls and a zero total.
    assert_eq!(stats[0]["avg_value"], Value::Null);
    assert_eq!(stats[0]["p50_latency"], Value::Null);
    assert_eq!(stats[0]["input_tokens"], 0);
    // A slot filter keeps that slot's groups only.
    let only = store
        .list_decide_receipt_stats(Some("Triage"), 1.0)
        .unwrap();
    assert_eq!(slots(&only), vec!["Triage"]);
}

#[test]
fn real_columns_read_back_as_the_single_precision_number_postgres_prints() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    let mut rows = Vec::new();
    for (i, v) in [0.1, 1.0 / 3.0, 16_777_217.0, 3.4e38, -0.5]
        .into_iter()
        .enumerate()
    {
        let mut r = receipt(&format!("r{i}"), "conflict", "pass");
        r.answer_value = Some(json!(v));
        r.rank = Some(json!(i as i64));
        rows.push(r);
    }
    store.insert_decide_receipts(&rows).unwrap();
    let replay = store.list_decide_replay_receipts("conflict", 1.0).unwrap();
    let values: Vec<f64> = replay
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["answer_value"].as_f64().unwrap())
        .collect();
    assert_eq!(values, vec![0.1, 0.33333334, 16_777_216.0, 3.4e38, -0.5]);
}

#[test]
fn replay_orders_by_decision_then_rank_with_nulls_last_then_insertion() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    let ranked = |decision: &str, outcome: &str, rank: Option<i64>| {
        let mut r = receipt(decision, "conflict", outcome);
        r.rank = rank.map(|n| json!(n));
        r.answer_value = Some(json!(rank.unwrap_or(-1) as f64 + 0.5));
        r
    };
    store
        .insert_decide_receipts(&[
            ranked("b", "kept", Some(2)),
            ranked("b", "pruned", None),
            ranked("b", "kept", Some(1)),
            ranked("B", "pass", Some(1)),
            ranked("a", "reject", Some(5)),
            ranked("a", "quarantine", Some(5)),
            ranked("a", "skipped", Some(0)),
            ranked("a", "Kept", Some(0)),
            receipt("other-slot", "triage", "kept"),
        ])
        .unwrap();
    let replay = store.list_decide_replay_receipts("conflict", 1.0).unwrap();
    let order: Vec<(String, String)> = replay
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["decision_id"].as_str().unwrap().into(),
                r["outcome"].as_str().unwrap().into(),
            )
        })
        .collect();
    let want = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    };
    assert_eq!(
        order,
        want(&[
            ("B", "pass"),
            ("a", "reject"),
            ("a", "quarantine"),
            ("b", "kept"),
            ("b", "kept"),
            ("b", "pruned"),
        ])
    );
    // The two rank-5 rows of `a` keep insertion order; `b` runs rank 1, rank 2, then no rank.
    let ranks: Vec<Value> = replay
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["decision_id"] == "b")
        .map(|r| r["rank"].clone())
        .collect();
    assert_eq!(ranks, vec![json!(1), json!(2), Value::Null]);
}

#[test]
fn slot_usage_counts_egress_reasons_and_distinct_decisions() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    let mut tokens = receipt("u1", "conflict", "kept");
    tokens.input_tokens = Some(json!(7));
    store
        .insert_decide_receipts(&[
            tokens.clone(),
            tokens,
            with_reason(receipt("u2", "conflict", "skipped"), "egress_denied"),
            with_reason(receipt("u3", "conflict", "error"), "egress"),
            with_reason(receipt("u4", "conflict", "skipped"), "denied_source"),
            with_reason(receipt("u5", "conflict", "skipped"), "missing_provenance"),
            with_reason(receipt("u6", "conflict", "skipped"), "EGRESS"),
            with_reason(receipt("u7", "conflict", "skipped"), "not_egress"),
            with_reason(receipt("u8", "conflict", "skipped"), "denied_source_2"),
        ])
        .unwrap();
    assert_eq!(
        store.decide_slot_usage(1.0).unwrap(),
        json!([{
            "slot": "conflict", "decisions": 8, "rows": 9, "input_tokens": 14,
            "errors": 1, "skipped": 6, "egress": 4
        }])
    );
}

#[test]
fn receipt_sums_past_int4_are_refused_like_the_cast() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    let mut big = receipt("big", "conflict", "kept");
    big.input_tokens = Some(json!(2_147_483_647));
    store.insert_decide_receipts(&[big.clone(), big]).unwrap();
    assert_eq!(
        store.decide_slot_usage(1.0).unwrap_err().code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store.list_decide_receipt_stats(None, 1.0).unwrap_err().code,
        INVALID_ARGUMENT
    );
}

#[test]
fn receipts_refuse_a_bad_row_and_record_none_of_the_batch() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    let good = || receipt("good", "conflict", "kept");
    let base = || receipt("bad", "conflict", "kept");
    let cases: Vec<(&str, DecideReceiptInput, &str)> = vec![
        (
            "decision_id",
            DecideReceiptInput {
                decision_id: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "slot",
            DecideReceiptInput {
                slot: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "mode",
            DecideReceiptInput {
                mode: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "provider",
            DecideReceiptInput {
                provider: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "outcome",
            DecideReceiptInput {
                outcome: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "call_site",
            DecideReceiptInput {
                call_site: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "lane",
            DecideReceiptInput {
                lane: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "protected",
            DecideReceiptInput {
                protected: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "remote",
            DecideReceiptInput {
                remote: None,
                ..base()
            },
            CONSTRAINT_VIOLATION,
        ),
        (
            "nul",
            DecideReceiptInput {
                error_reason: Some("a\0b".into()),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "nul meta",
            DecideReceiptInput {
                run_meta: Some("\0".into()),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "fraction",
            DecideReceiptInput {
                latency_ms: Some(json!(1.5)),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "too big",
            DecideReceiptInput {
                input_tokens: Some(json!(2_147_483_648_i64)),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "too small rank",
            DecideReceiptInput {
                rank: Some(json!(-2_147_483_649_i64)),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "text int",
            DecideReceiptInput {
                min_keep: Some(json!("3")),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "k fraction",
            DecideReceiptInput {
                k_used: Some(json!(2.5)),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "real too big",
            DecideReceiptInput {
                answer_value: Some(json!(1e39)),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "real too small",
            DecideReceiptInput {
                confidence: Some(json!(-1e39)),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "real underflow",
            DecideReceiptInput {
                threshold: Some(json!(1e-50)),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
        (
            "text real",
            DecideReceiptInput {
                answer_value: Some(json!("0.5")),
                ..base()
            },
            INVALID_ARGUMENT,
        ),
    ];
    for (name, row, code) in cases {
        let got = store
            .insert_decide_receipts(&[good(), row])
            .unwrap_err()
            .code;
        assert_eq!(got, code, "{name}");
    }
    assert_eq!(store.decide_slot_usage(1.0).unwrap(), json!([]));
    // A zero real is fine, as is a real that rounds to a finite single.
    let mut zero = good();
    zero.answer_value = Some(json!(0.0));
    zero.confidence = Some(json!(1e-45));
    store.insert_decide_receipts(&[zero]).unwrap();
    assert_eq!(
        store
            .decide_slot_usage(1.0)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn receipt_windows_must_be_whole_and_inside_the_timestamp_range() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    store
        .insert_decide_receipts(&[receipt("a", "conflict", "kept")])
        .unwrap();
    let huge = f64::from(i32::MAX);
    let refused: Vec<(&str, Value)> = vec![
        (
            "stats fraction",
            json!(store.list_decide_receipt_stats(None, 1.5).is_err()),
        ),
        (
            "stats nan",
            json!(store.list_decide_receipt_stats(None, f64::NAN).is_err()),
        ),
        (
            "stats inf",
            json!(
                store
                    .list_decide_receipt_stats(None, f64::INFINITY)
                    .is_err()
            ),
        ),
        (
            "stats huge",
            json!(store.list_decide_receipt_stats(None, huge).is_err()),
        ),
        (
            "stats > int4",
            json!(store.list_decide_receipt_stats(None, huge + 1.0).is_err()),
        ),
        ("usage", json!(store.decide_slot_usage(0.5).is_err())),
        (
            "conflict",
            json!(store.decide_conflict_no_entity_counts(huge).is_err()),
        ),
        (
            "replay",
            json!(store.list_decide_replay_receipts("conflict", 0.1).is_err()),
        ),
        (
            "models",
            json!(store.list_decide_resolved_models(huge).is_err()),
        ),
        (
            "mixed",
            json!(store.list_decide_mixed_model_decisions(2.2).is_err()),
        ),
        (
            "prune fraction",
            json!(store.prune_decide_receipts(7.5).is_err()),
        ),
        (
            "prune nan",
            json!(store.prune_decide_receipts(f64::NAN).is_err()),
        ),
        (
            "prune huge",
            json!(store.prune_decide_receipts(huge).is_err()),
        ),
        (
            "slot nul",
            json!(store.list_decide_receipt_stats(Some("a\0b"), 1.0).is_err()),
        ),
        (
            "replay nul",
            json!(store.list_decide_replay_receipts("a\0b", 1.0).is_err()),
        ),
    ];
    for (name, was_refused) in refused {
        assert_eq!(was_refused, json!(true), "{name}");
    }
    assert_eq!(
        store
            .list_decide_receipt_stats(None, huge)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    // A far but valid window works, and nothing was pruned by the refused calls.
    assert_eq!(
        store
            .decide_slot_usage(1_000_000.0)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn receipts_survive_a_reopen_and_ids_keep_counting() {
    let dir = TempDir::new("decide-store");
    {
        let (store, _) = open(&dir);
        store
            .insert_decide_receipts(&[receipt("a", "conflict", "kept")])
            .unwrap();
    }
    let (store, _) = open(&dir);
    store
        .insert_decide_receipts(&[receipt("a", "conflict", "kept")])
        .unwrap();
    let usage = store.decide_slot_usage(1.0).unwrap();
    assert_eq!(usage[0]["rows"], 2);
    assert_eq!(usage[0]["decisions"], 1);
}

#[test]
fn a_receipt_stamped_exactly_at_the_window_start_is_inside_it() {
    let dir = TempDir::new("decide-store");
    let (store, clock) = open(&dir);
    // The batch is stamped with the next reading of the clock.
    let stamp = clock.0.load(Ordering::SeqCst);
    store
        .insert_decide_receipts(&[receipt("a", "conflict", "kept")])
        .unwrap();
    // The next reading is exactly two hours on, so a two-hour window starts at the stamp (`>=`).
    clock.0.store(stamp + 2 * HOUR, Ordering::SeqCst);
    assert_eq!(
        store
            .decide_slot_usage(2.0)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // One microsecond later the stamp is outside it.
    clock.0.store(stamp + 2 * HOUR + 1, Ordering::SeqCst);
    assert_eq!(store.decide_slot_usage(2.0).unwrap(), json!([]));
    // The prune is `<`: a receipt exactly at the cutoff stays; one microsecond older goes.
    clock.0.store(stamp + 7 * DAY, Ordering::SeqCst);
    assert_eq!(store.prune_decide_receipts(7.0).unwrap(), 0);
    clock.0.store(stamp + 7 * DAY + 1, Ordering::SeqCst);
    assert_eq!(store.prune_decide_receipts(7.0).unwrap(), 1);
}

fn calibration(slot: &str) -> DecideCalibrationInput {
    DecideCalibrationInput {
        slot: Some(slot.into()),
        call_site: Some("sweep".into()),
        provider: Some("typesafe:openai".into()),
        model_resolved: Some("gpt-x".into()),
        threshold: Some(json!(0.8)),
        metric: Some("f1".into()),
        metric_value: Some(json!(0.9)),
        ece: Some(json!(0.05)),
        n: Some(json!(100)),
        calibrate_only: Some(true),
        pack_shape: Some("full".into()),
        ..DecideCalibrationInput::default()
    }
}

fn with_note(mut c: DecideCalibrationInput, note: &str) -> DecideCalibrationInput {
    c.notes = Some(note.into());
    c
}

fn qualification(
    lb: Value,
    text: Option<&str>,
    fingerprint: Option<&str>,
) -> DecideQualificationInput {
    DecideQualificationInput {
        action_precision_lb: Some(lb),
        qualification: text.map(Into::into),
        policy_fingerprint: fingerprint.map(Into::into),
    }
}

fn notes(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|r| r["notes"].as_str().unwrap_or("").to_string())
        .collect()
}

#[test]
fn calibrations_count_ids_from_one_and_read_back_with_their_defaults() {
    let dir = TempDir::new("decide-store");
    let (store, clock) = open(&dir);
    let stamp = clock.0.load(Ordering::SeqCst);
    let mut first = calibration("conflict");
    first.threshold = Some(json!(0.1));
    first.metric_value = Some(json!(1.0 / 3.0));
    first.ece = Some(json!(16777217));
    first.min_keep = Some(json!(3));
    first.calibrate_only = Some(false);
    assert_eq!(store.insert_decide_calibration(&first).unwrap(), 1);
    assert_eq!(
        store
            .insert_decide_calibration(&calibration("triage"))
            .unwrap(),
        2
    );
    let row = store.get_decide_calibration(1.0).unwrap();
    // `0.1` as `real` prints as `0.1`; a third is cut to single precision.
    assert_eq!(row["threshold"], json!(0.1));
    assert_eq!(row["metric_value"], json!(0.33333334));
    assert_eq!(row["ece"], json!(16777216.0));
    assert_eq!(row["min_keep"], json!(3));
    assert_eq!(row["calibrate_only"], json!(false));
    assert_eq!(row["n"], json!(100));
    // Defaults: stamped by the clock, nothing qualified or retired.
    assert_eq!(row["created_at"], json!(iso(stamp)));
    for column in [
        "qualification",
        "qualified_at",
        "retired_at",
        "action_precision_lb",
        "policy_fingerprint",
        "notes",
        "dataset_hash",
    ] {
        assert_eq!(row[column], Value::Null, "{column}");
    }
    assert_eq!(row["id"], json!(1));
    assert_eq!(store.get_decide_calibration(2.0).unwrap()["slot"], "triage");
}

#[test]
fn calibrations_list_by_slot_in_byte_order_then_newest_first_and_hide_retired() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    for (slot, note) in [
        ("alpha", "a1"),
        ("Alpha", "A1"),
        ("zeta", "z1"),
        ("\u{e9}", "e1"),
        ("", "x1"),
        ("alpha", "a2"),
        ("alpha", "a3"),
    ] {
        store
            .insert_decide_calibration(&with_note(calibration(slot), note))
            .unwrap();
    }
    let all = |slot: Option<&str>, retired: bool| {
        notes(&store.list_decide_calibrations(slot, retired).unwrap())
    };
    assert_eq!(all(None, false), ["x1", "A1", "a3", "a2", "a1", "z1", "e1"]);
    assert!(store.set_decide_calibration_retired(6.0, true).unwrap());
    assert_eq!(all(None, false), ["x1", "A1", "a3", "a1", "z1", "e1"]);
    assert_eq!(all(None, true), ["x1", "A1", "a3", "a2", "a1", "z1", "e1"]);
    assert_eq!(all(Some("alpha"), false), ["a3", "a1"]);
    assert_eq!(all(Some("alpha"), true), ["a3", "a2", "a1"]);
    assert_eq!(all(Some(""), false), ["x1"]);
    assert!(all(Some("nothing"), true).is_empty());
}

#[test]
fn a_qualification_replaces_three_columns_and_stamps_the_time() {
    let dir = TempDir::new("decide-store");
    let (store, clock) = open(&dir);
    store
        .insert_decide_calibration(&calibration("conflict"))
        .unwrap();
    store
        .insert_decide_calibration(&calibration("triage"))
        .unwrap();
    let stamp = clock.0.load(Ordering::SeqCst);
    store
        .store_decide_qualification(
            1.0,
            &qualification(json!(0.123456789), Some("{\"pass\":true}"), Some("fp-1")),
        )
        .unwrap();
    let one = store.get_decide_calibration(1.0).unwrap();
    assert_eq!(one["action_precision_lb"], json!(0.12345679));
    assert_eq!(one["qualification"], "{\"pass\":true}");
    assert_eq!(one["policy_fingerprint"], "fp-1");
    assert_eq!(one["qualified_at"], json!(iso(stamp)));
    // A second call replaces all three, null included, and restamps.
    store
        .store_decide_qualification(1.0, &qualification(Value::Null, None, Some("fp-2")))
        .unwrap();
    let two = store.get_decide_calibration(1.0).unwrap();
    assert_eq!(two["action_precision_lb"], Value::Null);
    assert_eq!(two["qualification"], Value::Null);
    assert_eq!(two["policy_fingerprint"], "fp-2");
    assert_eq!(two["qualified_at"], json!(iso(stamp + 1)));
    // The other row, and an id with no row, are untouched and not an error.
    store
        .store_decide_qualification(99.0, &qualification(json!(1), Some("q"), Some("p")))
        .unwrap();
    assert_eq!(
        store.get_decide_calibration(2.0).unwrap()["qualified_at"],
        Value::Null
    );
    assert_eq!(store.get_decide_calibration(99.0).unwrap(), Value::Null);
}

#[test]
fn retiring_stamps_and_clears_retired_at_and_says_whether_the_row_exists() {
    let dir = TempDir::new("decide-store");
    let (store, clock) = open(&dir);
    store
        .insert_decide_calibration(&calibration("conflict"))
        .unwrap();
    store
        .store_decide_qualification(1.0, &qualification(json!(0.5), Some("q"), Some("p")))
        .unwrap();
    let stamp = clock.0.load(Ordering::SeqCst);
    assert!(store.set_decide_calibration_retired(1.0, true).unwrap());
    let retired = store.get_decide_calibration(1.0).unwrap();
    assert_eq!(retired["retired_at"], json!(iso(stamp)));
    // Every other column is kept.
    assert_eq!(retired["qualification"], "q");
    assert_eq!(retired["threshold"], json!(0.8));
    // Retiring again restamps; bringing it back clears the stamp.
    assert!(store.set_decide_calibration_retired(1.0, true).unwrap());
    assert_eq!(
        store.get_decide_calibration(1.0).unwrap()["retired_at"],
        json!(iso(stamp + 1))
    );
    assert!(store.set_decide_calibration_retired(1.0, false).unwrap());
    assert_eq!(
        store.get_decide_calibration(1.0).unwrap()["retired_at"],
        Value::Null
    );
    // An id with no row (or a negative one) answers false and creates nothing.
    for id in [0.0, 2.0, -1.0, 9007199254740991.0] {
        assert!(
            !store.set_decide_calibration_retired(id, true).unwrap(),
            "{id}"
        );
        assert_eq!(store.get_decide_calibration(id).unwrap(), Value::Null);
    }
    assert_eq!(
        store
            .list_decide_calibrations(None, true)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn calibrations_keep_nulls_unicode_and_extreme_numbers_exactly() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    let mut text = calibration("slot \u{e9} \u{1F600}");
    text.call_site = Some(String::new());
    text.model_resolved = Some("it's \"quoted\" \\ back".into());
    text.pack_shape = Some("\u{4e2d}\u{6587}".into());
    let mut extreme = calibration("conflict");
    extreme.n = Some(json!(2147483647));
    extreme.min_keep = Some(json!(-2147483648));
    extreme.threshold = Some(json!(-0.5));
    extreme.ece = Some(json!(3.4e38));
    extreme.retest_sd = Some(json!(-3.4e38));
    extreme.repack_sd = Some(json!(1e-37));
    let mut zero = calibration("conflict");
    zero.n = Some(json!(0));
    zero.threshold = Some(json!(0));
    for row in [&text, &extreme, &zero] {
        store.insert_decide_calibration(row).unwrap();
    }
    let a = store.get_decide_calibration(1.0).unwrap();
    assert_eq!(a["slot"], "slot \u{e9} \u{1F600}");
    assert_eq!(a["call_site"], "");
    assert_eq!(a["model_resolved"], "it's \"quoted\" \\ back");
    assert_eq!(a["pack_shape"], "\u{4e2d}\u{6587}");
    let b = store.get_decide_calibration(2.0).unwrap();
    assert_eq!(b["n"], json!(2147483647));
    assert_eq!(b["min_keep"], json!(-2147483648));
    assert_eq!(b["threshold"], json!(-0.5));
    assert_eq!(b["ece"], json!(3.4e38));
    assert_eq!(b["retest_sd"], json!(-3.4e38));
    assert_eq!(b["repack_sd"], json!(1e-37));
    let c = store.get_decide_calibration(3.0).unwrap();
    assert_eq!(
        (c["n"].clone(), c["threshold"].clone()),
        (json!(0), json!(0.0))
    );
}

#[test]
fn calibrations_refuse_a_bad_row_and_record_nothing() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    let missing: Vec<(&str, DecideCalibrationInput)> = vec![
        (
            "slot",
            DecideCalibrationInput {
                slot: None,
                ..calibration("x")
            },
        ),
        (
            "call_site",
            DecideCalibrationInput {
                call_site: None,
                ..calibration("x")
            },
        ),
        (
            "provider",
            DecideCalibrationInput {
                provider: None,
                ..calibration("x")
            },
        ),
        (
            "model_resolved",
            DecideCalibrationInput {
                model_resolved: None,
                ..calibration("x")
            },
        ),
        (
            "threshold",
            DecideCalibrationInput {
                threshold: None,
                ..calibration("x")
            },
        ),
        (
            "threshold",
            DecideCalibrationInput {
                threshold: Some(Value::Null),
                ..calibration("x")
            },
        ),
        (
            "metric",
            DecideCalibrationInput {
                metric: None,
                ..calibration("x")
            },
        ),
        (
            "n",
            DecideCalibrationInput {
                n: None,
                ..calibration("x")
            },
        ),
        (
            "calibrate_only",
            DecideCalibrationInput {
                calibrate_only: None,
                ..calibration("x")
            },
        ),
        (
            "pack_shape",
            DecideCalibrationInput {
                pack_shape: None,
                ..calibration("x")
            },
        ),
    ];
    for (column, row) in &missing {
        let err = store.insert_decide_calibration(row).unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION, "{column}");
        assert!(err.message.contains(column), "{column}: {}", err.message);
    }
    let invalid: Vec<(&str, DecideCalibrationInput)> = vec![
        ("nul slot", calibration("a\0b")),
        ("nul notes", with_note(calibration("x"), "a\0b")),
        (
            "nul hash",
            DecideCalibrationInput {
                dataset_hash: Some("a\0b".into()),
                ..calibration("x")
            },
        ),
        (
            "fractional n",
            DecideCalibrationInput {
                n: Some(json!(1.5)),
                ..calibration("x")
            },
        ),
        (
            "huge n",
            DecideCalibrationInput {
                n: Some(json!(2147483648_i64)),
                ..calibration("x")
            },
        ),
        (
            "string n",
            DecideCalibrationInput {
                n: Some(json!("5")),
                ..calibration("x")
            },
        ),
        (
            "huge min_keep",
            DecideCalibrationInput {
                min_keep: Some(json!(-2147483649_i64)),
                ..calibration("x")
            },
        ),
        (
            "huge threshold",
            DecideCalibrationInput {
                threshold: Some(json!(1e39)),
                ..calibration("x")
            },
        ),
        (
            "huge ece",
            DecideCalibrationInput {
                ece: Some(json!(-1e39)),
                ..calibration("x")
            },
        ),
        (
            "underflow sd",
            DecideCalibrationInput {
                retest_sd: Some(json!(1e-50)),
                ..calibration("x")
            },
        ),
    ];
    for (what, row) in &invalid {
        let err = store.insert_decide_calibration(row).unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT, "{what}");
    }
    assert_eq!(
        store.list_decide_calibrations(None, true).unwrap(),
        json!([])
    );
    // Unlike a Postgres sequence, a refused row does not use up an id.
    assert_eq!(
        store.insert_decide_calibration(&calibration("x")).unwrap(),
        1
    );
}

#[test]
fn calibration_ids_must_be_whole_numbers_in_the_bigint_range() {
    let dir = TempDir::new("decide-store");
    let (store, _) = open(&dir);
    store.insert_decide_calibration(&calibration("x")).unwrap();
    let q = qualification(json!(0.5), Some("q"), Some("p"));
    let too_far = 9223372036854775808.0_f64;
    for bad in [1.5, f64::NAN, f64::INFINITY, 1e21, -1e21, too_far] {
        assert!(store.get_decide_calibration(bad).is_err(), "get {bad}");
        assert!(
            store.set_decide_calibration_retired(bad, true).is_err(),
            "retire {bad}"
        );
        assert!(
            store.store_decide_qualification(bad, &q).is_err(),
            "qualify {bad}"
        );
    }
    let nul = qualification(json!(0.5), Some("a\0b"), Some("p"));
    assert!(store.store_decide_qualification(1.0, &nul).is_err());
    let nul = qualification(json!(0.5), Some("q"), Some("a\0b"));
    assert!(store.store_decide_qualification(1.0, &nul).is_err());
    assert!(
        store
            .store_decide_qualification(1.0, &qualification(json!(1e39), Some("q"), Some("p")))
            .is_err()
    );
    assert!(store.list_decide_calibrations(Some("a\0b"), false).is_err());
    let row = store.get_decide_calibration(1.0).unwrap();
    assert_eq!(row["qualified_at"], Value::Null);
    assert_eq!(row["retired_at"], Value::Null);
}

#[test]
fn calibrations_survive_a_reopen_and_ids_keep_counting() {
    let dir = TempDir::new("decide-store");
    {
        let (store, _) = open(&dir);
        store
            .insert_decide_calibration(&with_note(calibration("x"), "one"))
            .unwrap();
        store
            .store_decide_qualification(1.0, &qualification(json!(0.5), Some("q"), Some("p")))
            .unwrap();
        assert!(store.set_decide_calibration_retired(1.0, true).unwrap());
    }
    let (store, clock) = open(&dir);
    // The reopened clock starts over; move it past the first row's stamp.
    clock.0.store(T0 + 1000, Ordering::SeqCst);
    assert_eq!(
        store
            .insert_decide_calibration(&with_note(calibration("x"), "two"))
            .unwrap(),
        2
    );
    let row = store.get_decide_calibration(1.0).unwrap();
    assert_eq!(row["qualification"], "q");
    assert_ne!(row["retired_at"], Value::Null);
    assert_eq!(
        notes(&store.list_decide_calibrations(None, true).unwrap()),
        ["two", "one"]
    );
}
