//! First come, first served for optimistic transactions that wait for one page key (the brain's
//! single-flight table).

use super::*;
use crate::error::{TIMEOUT, WRITE_CONFLICT};
use crate::test_support::mu_store;
use std::sync::mpsc;
use std::time::Duration;

fn with_deadline(ms: u64) -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        deadline: Some(Instant::now() + Duration::from_millis(ms)),
        ..TxnOptions::default()
    }
}

/// Waits until `n` transactions wait in line for page `slug` (see `occ_kv_fairness_tests::until_waiting`).
fn until_waiting(s: &Store, slug: &str, n: usize) {
    let key: HeldKey = ("default".into(), slug.into());
    let end = Instant::now() + Duration::from_secs(30);
    while s.flights.waiting(&key) < n {
        assert!(
            Instant::now() < end,
            "{n} waiter(s) never got in line for {slug}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn page(slug: &str) -> PageKeyHint {
    PageKeyHint {
        source_id: "default".into(),
        slug: slug.into(),
        incarnation: None,
    }
}

/// A key freed while a transaction waits for it goes to that transaction, never to one that asks
/// for it a moment later.
#[test]
fn a_newcomer_never_takes_a_page_key_ahead_of_a_waiter() {
    for round in 0..10 {
        let s = Arc::new(mu_store());
        let holder = s.begin_bound(with_deadline(10_000)).unwrap();
        holder.hold_page_keys(&[page("p")], false).unwrap();
        let (took, took_rx) = mpsc::channel();
        let (go, go_rx) = mpsc::channel::<()>();
        let store = s.clone();
        let waiter = std::thread::spawn(move || {
            let t = store.begin_bound(with_deadline(10_000)).unwrap();
            t.hold_page_keys(&[page("p")], false).unwrap();
            took.send(()).unwrap();
            go_rx.recv().unwrap();
            t.commit_transaction().map(|_| ())
        });
        until_waiting(&s, "p", 1);
        assert!(
            !waiter.is_finished(),
            "round {round}: the waiter did not wait"
        );
        let newcomer = s.begin_bound(with_deadline(150)).unwrap();
        holder.commit_transaction().unwrap();
        let taken = newcomer.hold_page_keys(&[page("p")], false);
        let barged = taken.is_ok();
        drop(newcomer);
        took_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the waiter took the key");
        go.send(()).unwrap();
        waiter.join().unwrap().unwrap();
        assert!(
            !barged,
            "round {round}: a newcomer took the page key ahead of the transaction waiting for it"
        );
        assert_eq!(taken.unwrap_err().code, TIMEOUT);
    }
}

/// Several transactions that wait for one key take it in the order they came.
#[test]
fn waiters_for_one_page_key_take_it_in_the_order_they_came() {
    const WAITERS: usize = 6;
    for round in 0..3 {
        let s = Arc::new(mu_store());
        let holder = s.begin_bound(with_deadline(20_000)).unwrap();
        holder.hold_page_keys(&[page("p")], false).unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut waiters = Vec::new();
        for i in 0..WAITERS {
            let store = s.clone();
            let order = order.clone();
            waiters.push(std::thread::spawn(move || {
                let t = store.begin_bound(with_deadline(20_000)).unwrap();
                t.hold_page_keys(&[page("p")], false).unwrap();
                order.lock().unwrap().push(i);
                std::thread::sleep(Duration::from_millis(2));
                t.commit_transaction().map(|_| ())
            }));
            // Each waiter is in line before the next one starts.
            until_waiting(&s, "p", i + 1);
        }
        holder.commit_transaction().unwrap();
        for w in waiters {
            w.join().unwrap().unwrap();
        }
        let order = order.lock().unwrap().clone();
        assert_eq!(
            order,
            (0..WAITERS).collect::<Vec<_>>(),
            "round {round}: the waiters took the key out of their arrival order"
        );
    }
}

/// Wait-die counts the waiters ahead: each of them holds the key before a newcomer does. A younger
/// transaction that holds a key is refused when an older one already waits for the key, even when
/// the key's holder is younger still; otherwise the older one, once it holds the key, could wait for
/// the younger one's key while the younger one waits behind it.
#[test]
fn a_younger_holder_is_refused_behind_an_older_waiter_and_nothing_deadlocks() {
    let s = Arc::new(mu_store());
    let older = s.begin_bound(with_deadline(10_000)).unwrap();
    let younger = s.begin_bound(with_deadline(10_000)).unwrap();
    let holder = s.begin_bound(with_deadline(10_000)).unwrap();
    assert!(older.transaction_age().unwrap() < younger.transaction_age().unwrap());
    assert!(younger.transaction_age().unwrap() < holder.transaction_age().unwrap());
    holder.hold_page_keys(&[page("p")], false).unwrap();
    older.hold_page_keys(&[page("q")], false).unwrap();
    younger.hold_page_keys(&[page("r")], false).unwrap();
    let older = Arc::new(older);
    let o = older.clone();
    let waiter = std::thread::spawn(move || {
        o.hold_page_keys(&[page("p")], false)?;
        // Now holding p and q, it asks for the younger one's key.
        o.hold_page_keys(&[page("r")], false).map(|_| ())
    });
    until_waiting(&s, "p", 1);
    assert!(!waiter.is_finished(), "the older transaction did not wait");
    let err = younger.hold_page_keys(&[page("p")], false).unwrap_err();
    assert_eq!(err.code, WRITE_CONFLICT, "{}", err.message);
    younger.rollback_transaction().unwrap();
    holder.commit_transaction().unwrap();
    waiter.join().unwrap().unwrap();
    older.commit_transaction().unwrap();
}
