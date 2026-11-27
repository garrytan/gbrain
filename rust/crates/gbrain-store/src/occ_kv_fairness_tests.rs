//! First come, first served for retried transactions that wait for one key lock (`KeyLocks`).

use super::*;
use crate::error::TIMEOUT;
use std::sync::mpsc;
use std::time::Duration;

fn one(key: &[u8]) -> BTreeSet<Vec<u8>> {
    BTreeSet::from([key.to_vec()])
}

fn after(ms: u64) -> Option<Instant> {
    Some(Instant::now() + Duration::from_millis(ms))
}

/// A key freed while a retry waits for it goes to that retry, never to one that asks a moment later.
#[test]
fn a_newcomer_never_takes_a_key_lock_ahead_of_a_waiter() {
    for round in 0..10 {
        let locks = Arc::new(KeyLocks::default());
        let first = locks.acquire(&one(b"hot"), None).unwrap();
        let (took, took_rx) = mpsc::channel();
        let (go, go_rx) = mpsc::channel::<()>();
        let l = locks.clone();
        let waiter = std::thread::spawn(move || {
            let g = l.acquire(&one(b"hot"), after(10_000)).unwrap();
            took.send(()).unwrap();
            go_rx.recv().unwrap();
            drop(g);
        });
        std::thread::sleep(Duration::from_millis(40));
        assert!(
            !waiter.is_finished(),
            "round {round}: the waiter did not wait"
        );
        drop(first);
        let taken = locks.acquire(&one(b"hot"), after(150));
        let barged = taken.is_ok();
        let code = taken.err().map(|e| e.code);
        took_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the waiter took the key");
        go.send(()).unwrap();
        waiter.join().unwrap();
        assert!(
            !barged,
            "round {round}: a newcomer took the key lock ahead of the retry waiting for it"
        );
        assert_eq!(code, Some(TIMEOUT));
        assert!(!locks.held_by_other(b"hot"), "every key was given back");
    }
}

/// Several retries that wait for one key take it in the order they came.
#[test]
fn waiters_for_one_key_lock_take_it_in_the_order_they_came() {
    const WAITERS: usize = 6;
    for round in 0..3 {
        let locks = Arc::new(KeyLocks::default());
        let first = locks.acquire(&one(b"hot"), None).unwrap();
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut waiters = Vec::new();
        for i in 0..WAITERS {
            let l = locks.clone();
            let order = order.clone();
            waiters.push(std::thread::spawn(move || {
                let g = l.acquire(&one(b"hot"), after(20_000)).unwrap();
                order.lock().unwrap().push(i);
                std::thread::sleep(Duration::from_millis(2));
                drop(g);
            }));
            // Each waiter reaches the key before the next one starts.
            std::thread::sleep(Duration::from_millis(30));
        }
        drop(first);
        for w in waiters {
            w.join().unwrap();
        }
        let order = order.lock().unwrap().clone();
        assert_eq!(
            order,
            (0..WAITERS).collect::<Vec<_>>(),
            "round {round}: the retries took the key out of their arrival order"
        );
    }
}

/// A waiter that gives up at its deadline leaves the line, so the one behind it gets the key.
#[test]
fn a_waiter_that_times_out_lets_the_next_one_through() {
    let locks = Arc::new(KeyLocks::default());
    let first = locks.acquire(&one(b"hot"), None).unwrap();
    let l = locks.clone();
    let quitter = std::thread::spawn(move || l.acquire(&one(b"hot"), after(60)).map(|_| ()));
    std::thread::sleep(Duration::from_millis(20));
    let l = locks.clone();
    let patient = std::thread::spawn(move || l.acquire(&one(b"hot"), after(10_000)).map(|_| ()));
    assert_eq!(quitter.join().unwrap().unwrap_err().code, TIMEOUT);
    drop(first);
    patient.join().unwrap().unwrap();
    assert!(!locks.held_by_other(b"hot"));
}
