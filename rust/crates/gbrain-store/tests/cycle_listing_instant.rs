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
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::transactions::{TxnMode, TxnOptions};
use serde_json::json;
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
