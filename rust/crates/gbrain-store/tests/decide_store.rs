//! The decide store: decide state, the spend ledger, receipts and calibrations, matched to the
//! PGLite engine (src/core/engine-sql/decide-store.ts).

mod common;

use common::TempDir;
use gbrain_store::env::Env;
use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{OpenOptions, Store};
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
