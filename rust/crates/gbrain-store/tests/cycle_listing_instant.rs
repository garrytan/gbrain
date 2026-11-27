//! The per-source cycle's listing instant in multi-user mode (`cycle_window.rs`,
//! `readCycleListingInstant`).
//!
//! A cycle lists a source's pages after its cursor and, when it lists them all, stamps its listing
//! instant as the next cursor. A page is stamped with its transaction's start time (as Postgres
//! `now()`). In multi-user mode explicit transactions run optimistically, so a transaction that
//! started before the instant can commit after it: its page's stamp is older than the cursor the
//! cycle just wrote, and every later window starts after that cursor, so no cycle ever lists the
//! page. The SQL engines hold the instant back to just before the oldest transaction still open
//! (`src/core/engine-sql/cycle-reads.ts`); the store must give the same guarantee.

mod common;

use common::TempDir;
use common::mode::{StoreMode, open_options_mu};
use gbrain_store::env::{Env, SystemEnv};
use gbrain_store::error::WRITE_CONFLICT;
use gbrain_store::occ_kv::OccKv;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::transactions::{TxnMode, TxnOptions};
use gbrain_store::{OpenOptions, Store};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

fn page(body: &str) -> PageInput {
    serde_json::from_value(json!({"type": "note", "title": "t", "compiled_truth": body})).unwrap()
}

fn open_multiuser(dir: &TempDir) -> Store {
    let store = Store::open_dir(
        &dir.path().join("brain"),
        open_options_mu(StoreMode::Optimistic),
    )
    .unwrap();
    assert!(store.multiuser(), "the brain must run in multi-user mode");
    store
}

/// The slugs a cycle that stamped `cursor` lists next: the source's pages after it.
fn listed_after(store: &Store, cursor: &str) -> Vec<String> {
    store
        .list_source_changed_pages_after("default", Some(cursor), "", 1000)
        .unwrap()
        .into_iter()
        .map(|row| row.slug)
        .collect()
}

/// The slugs a cycle lists from the start (no cursor), up to and including `instant`.
fn listed_through(store: &Store, instant: &str) -> Vec<String> {
    store
        .list_source_changed_pages_after("default", None, "", 1000)
        .unwrap()
        .into_iter()
        .filter(|row| row.updated_at.as_str() <= instant)
        .map(|row| row.slug)
        .collect()
}

#[test]
fn a_page_committed_after_the_listing_instant_by_a_transaction_open_before_it_is_listed_by_a_later_cycle()
 {
    let dir = TempDir::new("cycle-listing-late-commit");
    let store = open_multiuser(&dir);
    store
        .put_page("notes/early", &page("early"), &PutPageOptions::default())
        .unwrap();

    // A transaction opens (its clock starts now) and writes a page stamped with that start.
    let tx = store
        .begin_with(TxnOptions {
            mode: TxnMode::Optimistic,
            ..TxnOptions::default()
        })
        .unwrap();
    tx.put_page("notes/late", &page("late"), &PutPageOptions::default())
        .unwrap();
    std::thread::sleep(Duration::from_millis(5));

    // A cycle reads its listing instant while that transaction is still open ...
    let instant = store.read_cycle_listing_instant().unwrap();
    // ... and, having listed everything, stamps the instant as its cursor.
    let first_cycle = listed_through(&store, &instant);
    assert!(first_cycle.contains(&"notes/early".to_string()));
    assert!(
        !first_cycle.contains(&"notes/late".to_string()),
        "the page was not committed yet"
    );

    // The transaction commits after the instant was read.
    tx.commit().unwrap();

    // The next cycle lists the pages after the cursor: the late page must be there.
    let next_cycle = listed_after(&store, &instant);
    assert!(
        next_cycle.contains(&"notes/late".to_string()),
        "a page a transaction open before the listing instant committed after it was never listed (instant {instant}, next window {next_cycle:?})"
    );
}

#[test]
fn with_no_transaction_open_the_instant_is_now() {
    let dir = TempDir::new("cycle-listing-idle");
    let store = open_multiuser(&dir);
    store
        .put_page("notes/a", &page("a"), &PutPageOptions::default())
        .unwrap();
    let instant = store.read_cycle_listing_instant().unwrap();
    // Every committed page is at or before the instant, so the cycle that stamps it lists them all.
    assert_eq!(
        listed_through(&store, &instant),
        vec!["notes/a".to_string()]
    );
    assert!(listed_after(&store, &instant).is_empty());
}

fn optimistic(store: &Store) -> gbrain_store::transactions::Transaction {
    store
        .begin_with(TxnOptions {
            mode: TxnMode::Optimistic,
            ..TxnOptions::default()
        })
        .unwrap()
}

/// A clock a test moves by hand (random ids still come from the system).
struct HandClock(AtomicI64);

impl Env for HandClock {
    fn now_micros(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        SystemEnv.new_uuid()
    }
}

/// A commit refused with `write_conflict` releases its open-write registration in the same call,
/// before its handle drops: the instant moves forward right after the `Err`.
#[test]
fn a_refused_commit_releases_its_registration_at_once() {
    let dir = TempDir::new("cycle-listing-refused");
    let store = open_multiuser(&dir);
    store
        .put_page("notes/a", &page("a"), &PutPageOptions::default())
        .unwrap();
    let loser = optimistic(&store);
    loser
        .read_page_snapshot("notes/a", &ReadScope::default())
        .unwrap();
    loser
        .put_page(
            "notes/a",
            &page("from the loser"),
            &PutPageOptions::default(),
        )
        .unwrap();
    std::thread::sleep(Duration::from_millis(5));
    let held = store.read_cycle_listing_instant().unwrap();
    // Another writer commits the page the loser read: the loser's commit is refused.
    store
        .put_page(
            "notes/a",
            &page("from the winner"),
            &PutPageOptions::default(),
        )
        .unwrap();
    let refused = loser.store().commit_transaction().unwrap_err();
    assert_eq!(refused.code, WRITE_CONFLICT);
    // The handle is still alive here; its registration is already gone.
    assert_eq!(store.open_write_count(), 0);
    std::thread::sleep(Duration::from_millis(2));
    let after = store.read_cycle_listing_instant().unwrap();
    assert!(
        after > held,
        "the instant stayed pinned after the refused commit ({held} then {after})"
    );
    drop(loser);
}

/// After a callback's attempts lose to `write_conflict` and a later attempt commits, no
/// registration of an earlier attempt is left open (each attempt is its own transaction).
#[test]
fn no_registration_of_an_earlier_attempt_is_left_after_retries() {
    let dir = TempDir::new("cycle-listing-retries");
    let store = open_multiuser(&dir);
    store
        .put_page("notes/a", &page("0"), &PutPageOptions::default())
        .unwrap();
    let mut refused = 0;
    for attempt in 0..4 {
        let tx = optimistic(&store);
        tx.read_page_snapshot("notes/a", &ReadScope::default())
            .unwrap();
        tx.put_page(
            "notes/a",
            &page(&format!("attempt {attempt}")),
            &PutPageOptions::default(),
        )
        .unwrap();
        if attempt < 3 {
            // A concurrent writer beats the first three attempts.
            store
                .put_page(
                    "notes/a",
                    &page(&format!("winner {attempt}")),
                    &PutPageOptions::default(),
                )
                .unwrap();
            assert_eq!(
                tx.store().commit_transaction().unwrap_err().code,
                WRITE_CONFLICT
            );
            refused += 1;
        } else {
            tx.commit().unwrap();
        }
    }
    assert_eq!(refused, 3);
    assert_eq!(store.open_write_count(), 0);
    // A plain write that loses and runs again inside one call registers once and leaves nothing.
    store
        .put_page("notes/b", &page("b"), &PutPageOptions::default())
        .unwrap();
    assert_eq!(store.open_write_count(), 0);
}

/// A stale or leaked registration (a transaction never ended) holds the instant back at most ten
/// minutes: the floor of the SQL rule.
#[test]
fn a_leaked_registration_cannot_hold_the_instant_back_more_than_ten_minutes() {
    let dir = TempDir::new("cycle-listing-leak");
    let clock = Arc::new(HandClock(AtomicI64::new(1_800_000_000_000_000)));
    let kv = OccKv::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap()).unwrap();
    let store = Store::open_kv(
        Arc::new(kv),
        clock.clone(),
        OpenOptions {
            multiuser: true,
            ..OpenOptions::default()
        },
    )
    .unwrap();
    let start = clock.now_micros();
    let leaked = optimistic(&store);
    leaked
        .put_page("notes/leak", &page("leak"), &PutPageOptions::default())
        .unwrap();
    std::mem::forget(leaked);
    let minute = 60 * 1_000_000;
    clock.0.store(start + minute, Ordering::SeqCst);
    let one_minute = store.read_cycle_listing_instant().unwrap();
    assert_eq!(
        one_minute,
        gbrain_store::env::iso(start - 1_000),
        "held one millisecond before the leaked start"
    );
    clock.0.store(start + 25 * minute, Ordering::SeqCst);
    let later = store.read_cycle_listing_instant().unwrap();
    assert_eq!(
        later,
        gbrain_store::env::iso(start + 15 * minute),
        "never more than ten minutes back"
    );
}
