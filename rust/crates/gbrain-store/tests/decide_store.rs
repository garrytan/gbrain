//! The decide store: decide state, the spend ledger, receipts and calibrations, matched to the
//! PGLite engine (src/core/engine-sql/decide-store.ts).

mod common;

use common::TempDir;
use gbrain_store::env::{iso, Env};
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::eval_capture::decide_store::DecideSpendInput;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{OpenOptions, Store};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

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
