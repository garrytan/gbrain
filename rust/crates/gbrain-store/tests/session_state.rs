//! Session state: the upsert, the manifest and the GC of `session_context_state`, matched to the
//! PGLite engine. The clock is moved by hand so the seven-day age and the cap order are exact.

mod common;

use common::TempDir;
use gbrain_store::env::Env;
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::session_state::SessionWrite;
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
const DAY: i64 = 86_400_000_000;

fn open(dir: &TempDir) -> (Store, Arc<Clock>) {
    let clock = Arc::new(Clock(AtomicI64::new(T0)));
    let kv = RedbKv::open_path(&dir.path().join("records.redb")).unwrap();
    let store = Store::open_kv(Arc::new(kv), clock.clone(), OpenOptions::default()).unwrap();
    (store, clock)
}

fn write(v: Value) -> SessionWrite {
    let mut base = json!({"degraded_wakes": "keep"});
    base.as_object_mut()
        .unwrap()
        .extend(v.as_object().unwrap().clone());
    serde_json::from_value(base).unwrap()
}

fn delta(store: &Store, session: &str) -> Value {
    store
        .read_delta_session_row("default", "local", session)
        .unwrap()
        .unwrap_or(Value::Null)
}

#[test]
fn upsert_inserts_with_defaults_then_replaces_only_given_fields() {
    let dir = TempDir::new("session-upsert");
    let (store, _) = open(&dir);
    assert_eq!(delta(&store, "s"), Value::Null);
    let wakes = store
        .upsert_session_context_row(
            "default",
            "local",
            "s",
            &write(json!({
                "standing_entities": ["people/alice-example"],
                "last_wake_at": "2026-06-01T10:00:00.123456Z",
                "degraded_wakes": "increment",
            })),
        )
        .unwrap();
    assert_eq!(wakes, 1);
    assert_eq!(
        store
            .read_session_context_state("default", "local", "s")
            .unwrap()
            .unwrap(),
        json!({"standing_entities": ["people/alice-example"], "surfaced_slugs": [], "last_wake_at": "2026-06-01T10:00:00.123456Z"})
    );
    let wakes = store
        .upsert_session_context_row(
            "default",
            "local",
            "s",
            &write(json!({
                "cursor_slug": "notes/a",
                "facts_cursor_at": "2026-06-02 00:00:00+00",
                "facts_cursor_id": 42,
                "degraded_wakes": "increment",
            })),
        )
        .unwrap();
    assert_eq!(wakes, 2);
    assert_eq!(
        delta(&store, "s"),
        json!({"surfaced_slugs": ["notes/a"], "last_wake_at": "2026-06-01T10:00:00.123456Z",
               "facts_cursor_at": "2026-06-02T00:00:00.000000Z", "facts_cursor_id": 42, "degraded_wakes": 2})
    );
    // No facts time: the stored id stays.
    store
        .upsert_session_context_row(
            "default",
            "local",
            "s",
            &write(json!({"facts_cursor_id": 7})),
        )
        .unwrap();
    assert_eq!(delta(&store, "s")["facts_cursor_id"], json!(42));
    let wakes = store
        .upsert_session_context_row(
            "default",
            "local",
            "s",
            &write(json!({"standing_entities": [], "degraded_wakes": "reset"})),
        )
        .unwrap();
    assert_eq!(wakes, 0);
    assert_eq!(
        store
            .read_session_context_state("default", "local", "s")
            .unwrap()
            .unwrap()["standing_entities"],
        json!([])
    );
    // Other clients and sources are other rows.
    assert!(
        store
            .read_delta_session_row("default", "remote", "s")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read_delta_session_row("other", "local", "s")
            .unwrap()
            .is_none()
    );
}

#[test]
fn upsert_refuses_nul_and_a_bad_timestamp() {
    let dir = TempDir::new("session-refuse");
    let (store, _) = open(&dir);
    let err = store
        .upsert_session_context_row("default", "local", "a\0b", &write(json!({})))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    let err = store
        .upsert_session_context_row(
            "default",
            "local",
            "s",
            &write(json!({"last_wake_at": "not a time"})),
        )
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert!(
        store
            .write_checkpoint_manifest("default", "local", "s", json!([{"slug": "a\u{0}"}]))
            .is_err()
    );
    assert_eq!(delta(&store, "s"), Value::Null);
}

#[test]
fn manifest_write_creates_the_row_and_replaces_only_the_manifest() {
    let dir = TempDir::new("session-manifest");
    let (store, _) = open(&dir);
    assert!(
        store
            .read_checkpoint_manifest("default", "local", "h")
            .unwrap()
            .is_none()
    );
    store
        .write_checkpoint_manifest(
            "default",
            "local",
            "h",
            json!([{"slug": "notes/x", "n": 1}]),
        )
        .unwrap();
    assert_eq!(
        store
            .read_checkpoint_manifest("default", "local", "h")
            .unwrap()
            .unwrap(),
        json!({"checkpoint_manifest": [{"slug": "notes/x", "n": 1}]})
    );
    assert_eq!(
        delta(&store, "h"),
        json!({"surfaced_slugs": [], "last_wake_at": null, "facts_cursor_at": null, "facts_cursor_id": null, "degraded_wakes": 0})
    );
    store
        .upsert_session_context_row(
            "default",
            "local",
            "h",
            &write(json!({"cursor_slug": "notes/y"})),
        )
        .unwrap();
    store
        .write_checkpoint_manifest("default", "local", "h", json!([]))
        .unwrap();
    assert_eq!(delta(&store, "h")["surfaced_slugs"], json!(["notes/y"]));
    assert_eq!(
        store
            .read_checkpoint_manifest("default", "local", "h")
            .unwrap()
            .unwrap(),
        json!({"checkpoint_manifest": []})
    );
}

#[test]
fn gc_deletes_rows_past_seven_days_then_the_oldest_past_the_cap() {
    let dir = TempDir::new("session-gc");
    let (store, clock) = open(&dir);
    let seed = |client: &str, session: &str| {
        store
            .upsert_session_context_row(
                "default",
                client,
                session,
                &write(json!({"cursor_slug": session})),
            )
            .unwrap();
    };
    seed("local", "old");
    clock.0.fetch_add(8 * DAY, Ordering::SeqCst);
    for s in ["c1", "c2", "c3", "c4"] {
        seed("capped", s);
        clock.0.fetch_add(60_000_000, Ordering::SeqCst);
    }
    seed("other", "o1");
    store
        .upsert_session_context_row(
            "other-source",
            "capped",
            "c1",
            &write(json!({"cursor_slug": "x"})),
        )
        .unwrap();
    store.gc_session_context_rows(7.0, 2).unwrap();
    let present = |source: &str, client: &str, session: &str| {
        store
            .read_session_context_state(source, client, session)
            .unwrap()
            .is_some()
    };
    assert!(!present("default", "local", "old"));
    assert!(!present("default", "capped", "c1"));
    assert!(!present("default", "capped", "c2"));
    assert!(present("default", "capped", "c3"));
    assert!(present("default", "capped", "c4"));
    assert!(present("default", "other", "o1"));
    assert!(present("other-source", "capped", "c1"));
    // A fraction of a day is a window, and a cap of 1000 keeps everything left.
    clock.0.fetch_add(DAY / 2, Ordering::SeqCst);
    seed("local", "new");
    store.gc_session_context_rows(0.25, 1000).unwrap();
    assert!(present("default", "local", "new"));
    assert!(!present("default", "capped", "c4"));
    assert!(
        store
            .gc_session_context_rows(f64::INFINITY, 1)
            .unwrap_err()
            .code
            == INVALID_ARGUMENT
    );
}

#[test]
fn gc_breaks_an_updated_at_tie_by_session_id() {
    let dir = TempDir::new("session-tie");
    let (store, clock) = open(&dir);
    for s in ["b", "a", "c"] {
        clock.0.store(T0, Ordering::SeqCst);
        store
            .upsert_session_context_row("default", "local", s, &write(json!({})))
            .unwrap();
    }
    store.gc_session_context_rows(7.0, 1).unwrap();
    assert!(delta(&store, "a").is_object());
    assert_eq!(delta(&store, "b"), Value::Null);
    assert_eq!(delta(&store, "c"), Value::Null);
}
