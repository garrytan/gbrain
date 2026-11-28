//! Optimistic explicit transactions (multi-user mode): the store half of lane L1. Conformance case
//! names (C12, C13, C15, C20) are the multi-writer suite's (`docs/designs/rust-engine/multi-user-server.md`).

use super::*;
use crate::error::{TIMEOUT, WRITE_CONFLICT};
use crate::test_support::{FlakyFile, mu_store, mu_store_on_file};
use std::time::Duration;

fn optimistic() -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        ..TxnOptions::default()
    }
}

fn with_deadline(ms: u64) -> TxnOptions {
    TxnOptions {
        deadline: Some(Instant::now() + Duration::from_millis(ms)),
        ..optimistic()
    }
}

fn get(s: &Store, key: &[u8]) -> Option<Vec<u8>> {
    s.read().unwrap().get(key).unwrap()
}

fn counter(s: &Store, key: &[u8]) -> i64 {
    crate::kv::read_i64(&*s.read().unwrap(), key).unwrap()
}

fn page(slug: &str) -> PageKeyHint {
    PageKeyHint {
        source_id: "default".into(),
        slug: slug.into(),
        incarnation: None,
    }
}

fn held(slug: &str) -> HeldKey {
    ("default".into(), slug.into())
}

#[test]
fn c13_other_writers_commit_while_an_optimistic_transaction_is_open() {
    let s = mu_store();
    let t = s.begin_bound(optimistic()).unwrap();
    assert!(t.transaction_optimistic());
    t.write(|w| w.put(b"ya", b"from the transaction")).unwrap();
    s.write(|w| w.put(b"yb", b"from a plain writer")).unwrap();
    let other = s.begin_bound(optimistic()).unwrap();
    other
        .write(|w| w.put(b"yc", b"from another transaction"))
        .unwrap();
    other.commit_transaction().unwrap();
    assert_eq!(get(&s, b"yb").as_deref(), Some(&b"from a plain writer"[..]));
    t.commit_transaction().unwrap();
    assert_eq!(
        get(&s, b"ya").as_deref(),
        Some(&b"from the transaction"[..])
    );
    assert_eq!(
        get(&s, b"yc").as_deref(),
        Some(&b"from another transaction"[..])
    );
}

/// C12: each transaction reads its own uncommitted writes and never the other's.
#[test]
fn c12_two_transactions_read_only_their_own_writes() {
    let s = mu_store();
    let a = s.begin_bound(optimistic()).unwrap();
    let b = s.begin_bound(optimistic()).unwrap();
    a.write(|w| w.put(b"ya", b"a")).unwrap();
    b.write(|w| w.put(b"yb", b"b")).unwrap();
    assert_eq!(get(&a, b"ya").as_deref(), Some(&b"a"[..]));
    assert_eq!(get(&a, b"yb"), None);
    assert_eq!(get(&b, b"yb").as_deref(), Some(&b"b"[..]));
    assert_eq!(get(&b, b"ya"), None);
    assert_eq!(get(&s, b"ya"), None);
    a.commit_transaction().unwrap();
    // A snapshot read: b still does not see a's commit.
    assert_eq!(get(&b, b"ya"), None);
    // Each read the key the other wrote, so no serial order explains both: the second commit is
    // refused and keeps nothing.
    assert_eq!(b.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    assert_eq!(get(&s, b"ya").as_deref(), Some(&b"a"[..]));
    assert_eq!(get(&s, b"yb"), None);
}

#[test]
fn a_stale_read_refuses_the_commit_and_keeps_none_of_its_writes() {
    let s = mu_store();
    let t = s.begin_bound(optimistic()).unwrap();
    assert_eq!(get(&t, b"yk"), None);
    t.write(|w| w.put(b"yj", b"mine")).unwrap();
    s.write(|w| w.put(b"yk", b"theirs")).unwrap();
    let err = t.commit_transaction().unwrap_err();
    assert_eq!(err.code, WRITE_CONFLICT);
    assert_eq!(get(&s, b"yj"), None);
    assert_eq!(get(&s, b"yk").as_deref(), Some(&b"theirs"[..]));
    // Ended: a rollback after the refusal is a no-op.
    t.rollback_transaction().unwrap();
}

/// Write skew: two transactions each read both rows and write one; serializable validation refuses
/// the second commit, so the "at most one of x and y" rule holds.
#[test]
fn write_skew_is_refused() {
    let s = mu_store();
    let a = s.begin_bound(optimistic()).unwrap();
    let b = s.begin_bound(optimistic()).unwrap();
    for t in [&a, &b] {
        assert_eq!(get(t, b"yx"), None);
        assert_eq!(get(t, b"yy"), None);
    }
    a.write(|w| w.put(b"yx", b"on")).unwrap();
    b.write(|w| w.put(b"yy", b"on")).unwrap();
    a.commit_transaction().unwrap();
    assert_eq!(b.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    assert_eq!(get(&s, b"yy"), None);
}

#[test]
fn a_phantom_in_a_scanned_range_is_refused() {
    let s = mu_store();
    let t = s.begin_bound(optimistic()).unwrap();
    let mut seen = 0;
    t.read()
        .unwrap()
        .scan(b"yp", b"yq", false, &mut |_, _| {
            seen += 1;
            true
        })
        .unwrap();
    assert_eq!(seen, 0);
    t.write(|w| w.put(b"yz", b"count=0")).unwrap();
    s.write(|w| w.put(b"yp/new", b"inserted")).unwrap();
    assert_eq!(t.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    assert_eq!(get(&s, b"yz"), None);
}

#[test]
fn a_rollback_never_overwrites_another_writers_commit() {
    let s = mu_store();
    s.write(|w| w.put(b"yk", b"first")).unwrap();
    let t = s.begin_bound(optimistic()).unwrap();
    t.write(|w| w.put(b"yk", b"rolled back")).unwrap();
    s.write(|w| w.put(b"yk", b"committed by another")).unwrap();
    t.rollback_transaction().unwrap();
    assert_eq!(
        get(&s, b"yk").as_deref(),
        Some(&b"committed by another"[..])
    );
}

/// F1: an id taken by a transaction that did not commit is not handed out again, also after a
/// reopen: a rollback, a drop, a deadline, a transaction an earlier conflict doomed, a store failure,
/// and a commit refused for a conflict after another write took a later id from the sequence.
/// A commit the pipeline refused for a conflict, with no later id taken, gives its id back
/// (`occ_kv.rs`, "Id sequences"): the next write takes the same id, also after a reopen.
#[test]
fn ids_of_a_transaction_that_did_not_commit_are_never_handed_out_again_after_a_reopen() {
    let ends = [
        "conflict",
        "conflict_after_a_later_id",
        "rollback",
        "drop",
        "deadline",
        "doomed",
        "store_io",
    ];
    for end in ends {
        let file = FlakyFile::default();
        let (handed, later) = {
            let s = mu_store_on_file(&file);
            let options = if end == "deadline" {
                with_deadline(200)
            } else {
                optimistic()
            };
            let t = s.begin_bound(options).unwrap();
            let handed = t
                .write(|w| crate::pages::next_id(w, "next_probe_id"))
                .unwrap();
            let mut later = None;
            match end {
                "conflict" | "conflict_after_a_later_id" => {
                    assert_eq!(get(&t, b"yk"), None);
                    s.write(|w| w.put(b"yk", b"conflict")).unwrap();
                    if end == "conflict_after_a_later_id" {
                        later = Some(
                            s.write(|w| crate::pages::next_id(w, "next_probe_id"))
                                .unwrap(),
                        );
                    }
                    assert_eq!(t.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
                }
                "rollback" => t.rollback_transaction().unwrap(),
                "deadline" => {
                    std::thread::sleep(Duration::from_millis(250));
                    assert_eq!(t.commit_transaction().unwrap_err().code, TIMEOUT);
                }
                "doomed" => {
                    let _ =
                        t.write(|_| -> Result<()> { Err(StoreError::new(WRITE_CONFLICT, "lost")) });
                    assert!(t.transaction_conflicted());
                    assert_eq!(t.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
                }
                "store_io" => {
                    t.write(|w| w.put(b"yz", b"x")).unwrap();
                    file.fail_sync
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    assert_eq!(
                        t.commit_transaction().unwrap_err().code,
                        crate::error::STORE_IO
                    );
                }
                _ => drop(t),
            }
            (handed, later)
        };
        let s = mu_store_on_file(&file);
        let next = s
            .write(|w| crate::pages::next_id(w, "next_probe_id"))
            .unwrap();
        if end == "conflict" {
            assert_eq!(
                next, handed,
                "{end}: the refused commit's id {handed} did not go back (next is {next})"
            );
        } else {
            assert!(
                next > handed && later.is_none_or(|l| next > l),
                "{end}: id {next} was handed out again (had {handed}, later {later:?})"
            );
        }
    }
}

/// F2: counter bumps inside optimistic transactions stay commutative: many transactions that bump
/// one shared counter all commit, and the total is exact.
#[test]
fn concurrent_counter_bumps_in_transactions_never_conflict_and_sum_exactly() {
    let s = mu_store();
    let txns: Vec<Store> = (0..8)
        .map(|_| s.begin_bound(optimistic()).unwrap())
        .collect();
    for (i, t) in txns.iter().enumerate() {
        t.write(|w| w.add_i64(b"ycount", 1)).unwrap();
        t.write(|w| w.put(format!("ypage/{i}").as_bytes(), b"x"))
            .unwrap();
        t.write(|w| w.add_i64(b"ycount", 2)).unwrap();
    }
    for t in &txns {
        t.commit_transaction().unwrap();
    }
    assert_eq!(counter(&s, b"ycount"), 24);
}

#[test]
fn a_dropped_savepoint_or_statement_leaves_no_counter_delta_and_no_check() {
    let s = mu_store();
    let t = s.begin_bound(optimistic()).unwrap();
    t.write(|w| w.add_i64(b"ycount", 1)).unwrap();
    let depth = t.savepoint().unwrap();
    t.write(|w| w.add_i64(b"ycount", 5)).unwrap();
    // A check that passes inside the savepoint (0 + 1 + 5 < 100) and is dropped with it.
    assert_eq!(t.write(|w| w.counter_below(b"ycap", 1)).unwrap(), None);
    t.rollback_savepoint(depth).unwrap();
    let _ = t.write(|w| -> Result<()> {
        w.add_i64(b"ycount", 100)?;
        Err(StoreError::invalid("boom"))
    });
    // Reads its own pending bump over the committed value.
    assert_eq!(counter(&t, b"ycount"), 1);
    // Another writer pushes the dropped check's counter over its cap: our commit is not refused.
    s.write(|w| w.add_i64(b"ycap", 7)).unwrap();
    t.commit_transaction().unwrap();
    assert_eq!(counter(&s, b"ycount"), 1);
}

#[test]
fn a_kept_admission_check_refuses_the_commit_when_the_cap_was_reached_meanwhile() {
    let s = mu_store();
    let a = s.begin_bound(optimistic()).unwrap();
    let b = s.begin_bound(optimistic()).unwrap();
    for t in [&a, &b] {
        t.write(|w| {
            assert_eq!(w.counter_below(b"yslots", 1)?, None);
            w.add_i64(b"yslots", 1)
        })
        .unwrap();
    }
    a.commit_transaction().unwrap();
    assert_eq!(b.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    assert_eq!(counter(&s, b"yslots"), 1);
    // Under the cap, both admissions commit.
    let c = s.begin_bound(optimistic()).unwrap();
    let d = s.begin_bound(optimistic()).unwrap();
    for t in [&c, &d] {
        t.write(|w| {
            assert_eq!(w.counter_below(b"yroom", 2)?, None);
            w.add_i64(b"yroom", 1)
        })
        .unwrap();
    }
    c.commit_transaction().unwrap();
    d.commit_transaction().unwrap();
    assert_eq!(counter(&s, b"yroom"), 2);
}

#[test]
fn a_swallowed_conflict_dooms_the_transaction() {
    let s = mu_store();
    let t = s.begin_bound(optimistic()).unwrap();
    t.write(|w| w.put(b"ya", b"kept?")).unwrap();
    let _ = t.write(|_| -> Result<()> { Err(StoreError::new(WRITE_CONFLICT, "lost")) });
    assert!(t.transaction_conflicted());
    assert_eq!(
        t.write(|w| w.put(b"yb", b"x")).unwrap_err().code,
        WRITE_CONFLICT
    );
    assert_eq!(t.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    assert_eq!(get(&s, b"ya"), None);
}

/// J: the deadline ends a statement and the commit with `timeout`, nothing committed.
#[test]
fn the_deadline_ends_statements_and_the_commit_with_timeout() {
    let s = mu_store();
    let past = TxnOptions {
        deadline: Some(Instant::now()),
        ..optimistic()
    };
    let Err(err) = s.begin_bound(past) else {
        panic!("a transaction began past its deadline");
    };
    assert_eq!(err.code, TIMEOUT);
    assert!(
        err.message.starts_with("transaction_deadline: "),
        "{}",
        err.message
    );

    let t = s.begin_bound(with_deadline(30)).unwrap();
    t.write(|w| w.put(b"ya", b"early")).unwrap();
    std::thread::sleep(Duration::from_millis(40));
    let err = t.write(|w| w.put(b"yb", b"late")).unwrap_err();
    assert_eq!(err.code, TIMEOUT);
    let err = t.commit_transaction().unwrap_err();
    assert_eq!(err.code, TIMEOUT);
    assert!(err.message.starts_with("transaction_deadline: "));
    assert!(!t.transaction_conflicted());
    assert_eq!(get(&s, b"ya"), None);
}

/// C15: single flight holds only its keys, sorted, never two holders, released at commit and abort.
#[test]
fn c15_single_flight_holds_its_keys_until_commit_or_abort() {
    let s = mu_store();
    let flights = s.single_flight_table();
    let a = s.begin_bound(optimistic()).unwrap();
    let keys = a.hold_page_keys(&[page("b"), page("a")], false).unwrap();
    assert_eq!(keys, vec![held("a"), held("b")]);
    let owner = flights.holder(&held("a")).expect("held");
    assert_eq!(flights.holder(&held("b")), Some(owner));
    assert_eq!(flights.holder(&held("c")), None);
    // A second transaction can take another key at once, and cannot take a held one.
    let b = s.begin_bound(with_deadline(30)).unwrap();
    b.hold_page_keys(&[page("c")], false).unwrap();
    let busy = s.begin_bound(with_deadline(30)).unwrap();
    let err = busy.hold_page_keys(&[page("a")], false).unwrap_err();
    assert_eq!(err.code, TIMEOUT);
    assert!(err.message.starts_with("key_wait: "), "{}", err.message);
    busy.rollback_transaction().unwrap();
    a.commit_transaction().unwrap();
    assert_eq!(flights.holder(&held("a")), None);
    assert_eq!(flights.holder(&held("b")), None);
    assert!(flights.holder(&held("c")).is_some());
    b.rollback_transaction().unwrap();
    assert_eq!(flights.holder(&held("c")), None);
    // A dropped transaction gives its keys back too.
    let d = s.begin_bound(optimistic()).unwrap();
    d.hold_page_keys(&[page("d")], false).unwrap();
    drop(d);
    assert_eq!(flights.holder(&held("d")), None);
}

#[test]
fn a_savepoint_rollback_gives_back_only_the_keys_it_took() {
    let s = mu_store();
    let flights = s.single_flight_table();
    let t = s.begin_bound(optimistic()).unwrap();
    t.hold_page_keys(&[page("a")], false).unwrap();
    let depth = t.savepoint().unwrap();
    t.hold_page_keys(&[page("a"), page("b")], false).unwrap();
    t.rollback_savepoint(depth).unwrap();
    assert!(
        flights.holder(&held("a")).is_some(),
        "the outer key stays held"
    );
    assert_eq!(flights.holder(&held("b")), None);
    assert_eq!(t.held_page_keys().unwrap(), vec![held("a")]);
    t.commit_transaction().unwrap();
}

/// F5: a wait that times out part way, or a refusal part way, gives back the keys the call already took.
#[test]
fn a_timed_out_or_refused_acquisition_frees_the_keys_it_took_first() {
    let s = mu_store();
    let flights = s.single_flight_table();
    // Older than the holder: it waits for `b` and times out.
    let older = s.begin_bound(with_deadline(30)).unwrap();
    let holder = s.begin_bound(optimistic()).unwrap();
    holder.hold_page_keys(&[page("b")], false).unwrap();
    let err = older
        .hold_page_keys(&[page("a"), page("b")], false)
        .unwrap_err();
    assert_eq!(err.code, TIMEOUT);
    assert!(err.message.starts_with("key_wait: "), "{}", err.message);
    assert_eq!(
        flights.holder(&held("a")),
        None,
        "the prefix was given back"
    );
    // Younger than the holder: holding `a` from this call, it is refused at `b` and gives `a` back.
    let younger = s.begin_bound(with_deadline(5_000)).unwrap();
    let err = younger
        .hold_page_keys(&[page("a"), page("b")], false)
        .unwrap_err();
    assert_eq!(err.code, WRITE_CONFLICT);
    assert_eq!(
        flights.holder(&held("a")),
        None,
        "the prefix was given back"
    );
    // A source check that fails after the keys were taken gives them back too.
    let u = s.begin_bound(optimistic()).unwrap();
    let missing = PageKeyHint {
        source_id: "nope".into(),
        ..page("x")
    };
    assert_eq!(
        u.hold_page_keys(&[missing], false).unwrap_err().code,
        SOURCE_NOT_FOUND
    );
    assert_eq!(flights.holder(&("nope".into(), "x".into())), None);
    holder.commit_transaction().unwrap();
}

/// C20: two transactions that lock two pages in opposite orders never deadlock (wait-die): the
/// younger one, which already holds a key, is refused instead of waiting; the older one waits for the
/// younger's key and gets it once the younger ends. A rerun that keeps its age gets through.
#[test]
fn c20_two_pages_locked_in_both_orders_never_deadlock() {
    let s = Arc::new(mu_store());
    let a = s.begin_bound(with_deadline(5_000)).unwrap();
    let b = s.begin_bound(optimistic()).unwrap();
    let b_age = b.transaction_age().unwrap();
    assert!(a.transaction_age().unwrap() < b_age);
    a.hold_page_keys(&[page("one")], false).unwrap();
    b.hold_page_keys(&[page("two")], false).unwrap();
    let a = Arc::new(a);
    let older = a.clone();
    let waiter =
        std::thread::spawn(move || older.hold_page_keys(&[page("two")], false).map(|_| ()));
    std::thread::sleep(Duration::from_millis(50));
    assert!(!waiter.is_finished(), "the older transaction did not wait");
    let err = b.hold_page_keys(&[page("one")], false).unwrap_err();
    assert_eq!(err.code, WRITE_CONFLICT);
    assert!(b.transaction_conflicted());
    assert_eq!(b.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    waiter.join().unwrap().unwrap();
    a.commit_transaction().unwrap();
    // The rerun keeps its age, now the oldest open one.
    let rerun = s
        .begin_bound(TxnOptions {
            age: Some(b_age),
            ..optimistic()
        })
        .unwrap();
    assert_eq!(rerun.transaction_age().unwrap(), b_age);
    rerun.hold_page_keys(&[page("two")], false).unwrap();
    rerun.hold_page_keys(&[page("one")], false).unwrap();
    rerun.commit_transaction().unwrap();
}

/// A transaction that waited for a key and had read nothing reads on from after the holder's
/// commit, so it does not conflict for certain.
#[test]
fn a_pristine_waiter_reads_the_holders_commit_and_commits() {
    let s = Arc::new(mu_store());
    let holder = s.begin_bound(optimistic()).unwrap();
    holder.hold_page_keys(&[page("p")], false).unwrap();
    holder.write(|w| w.put(b"yrow", b"1")).unwrap();
    let store = s.clone();
    let waiter = std::thread::spawn(move || {
        let t = store.begin_bound(with_deadline(5_000)).unwrap();
        t.hold_page_keys(&[page("p")], false).unwrap();
        let seen = get(&t, b"yrow");
        t.write(|w| w.put(b"yrow", b"2")).unwrap();
        t.commit_transaction().map(|_| seen)
    });
    std::thread::sleep(Duration::from_millis(50));
    assert!(!waiter.is_finished(), "the waiter did not wait for the key");
    holder.commit_transaction().unwrap();
    let seen = waiter.join().unwrap().unwrap();
    assert_eq!(seen.as_deref(), Some(&b"1"[..]));
    assert_eq!(get(&s, b"yrow").as_deref(), Some(&b"2"[..]));
}

/// Off is identical: a serialized transaction on the concurrent store still holds every other
/// commit, and takes no single-flight key.
#[test]
fn a_serialized_transaction_is_unchanged() {
    let s = Arc::new(mu_store());
    let t = s.begin_transaction(false).unwrap();
    assert!(!t.transaction_optimistic());
    t.hold_page_keys(&[page("a")], false).unwrap();
    assert_eq!(s.single_flight_table().holder(&held("a")), None);
    let store = s.clone();
    let other = std::thread::spawn(move || store.write(|w| w.put(b"yb", b"x")));
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        !other.is_finished(),
        "a commit landed during a serialized transaction"
    );
    t.commit_transaction().unwrap();
    other.join().unwrap().unwrap();
}

/// F4: a plain write queued behind a busy retry key ends at its call deadline, holding nothing.
#[test]
fn a_key_wait_ends_at_the_call_deadline_and_frees_its_prefix() {
    let kv = crate::test_support::occ_kv();
    let mut b = std::collections::BTreeSet::new();
    b.insert(b"yb".to_vec());
    let holder = kv.begin_write_locked(&b).unwrap();
    let mut both = b.clone();
    both.insert(b"ya".to_vec());
    let deadline = Some(Instant::now() + Duration::from_millis(30));
    let err = match kv.begin_write_locked_until(&both, deadline) {
        Err(e) => e,
        Ok(_) => panic!("took a held key"),
    };
    assert_eq!(err.code, TIMEOUT);
    assert!(err.message.starts_with("key_wait: "), "{}", err.message);
    let mut a = std::collections::BTreeSet::new();
    a.insert(b"ya".to_vec());
    // The prefix key is free at once: this would wait forever if the timed-out call kept it.
    let now = Some(Instant::now() + Duration::from_millis(1_000));
    let started = Instant::now();
    drop(kv.begin_write_locked_until(&a, now).unwrap());
    assert!(started.elapsed() < Duration::from_millis(500));
    drop(holder);
}

/// F4 through `Store::write`: a plain write whose retry queues behind a busy key ends `timeout`
/// (reason `key_wait`) at the deadline the binding installed for the call, writing nothing.
#[test]
fn the_call_deadline_reaches_a_retried_store_write() {
    let s = mu_store();
    let mut busy = std::collections::BTreeSet::new();
    busy.insert(b"yk".to_vec());
    // Another retried writer queues on `yk` and holds it.
    let holder = s.kv.begin_write_locked(&busy).unwrap();
    let deadline = Instant::now() + Duration::from_millis(30);
    let err = crate::call_context::with_deadline(Some(deadline), || {
        s.write(|w| {
            let _ = w.get(b"yk")?;
            w.put(b"yk", b"never")
        })
    })
    .unwrap_err();
    assert_eq!(err.code, TIMEOUT);
    assert!(err.message.starts_with("key_wait: "), "{}", err.message);
    assert_eq!(crate::call_context::deadline(), None);
    drop(holder);
    assert_eq!(get(&s, b"yk"), None);
    // Without a deadline the same write waits for the key and then lands (today's behavior).
    s.write(|w| w.put(b"yk", b"later")).unwrap();
}

#[test]
fn the_facade_matches_the_frozen_interface() {
    let s = mu_store();
    let t = s.begin_with(optimistic()).unwrap();
    s.single_flight(
        &t,
        &[
            SingleFlightKey {
                source_id: "default".into(),
                slug: "z".into(),
            },
            SingleFlightKey {
                source_id: "default".into(),
                slug: "y".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(
        t.store().held_page_keys().unwrap(),
        vec![held("y"), held("z")]
    );
    t.store().write(|w| w.put(b"yf", b"facade")).unwrap();
    t.commit().unwrap();
    assert_eq!(s.single_flight_table().holder(&held("y")), None);
    assert_eq!(get(&s, b"yf").as_deref(), Some(&b"facade"[..]));
    let r = s.begin_with(optimistic()).unwrap();
    r.store().write(|w| w.put(b"yg", b"no")).unwrap();
    r.rollback().unwrap();
    assert_eq!(get(&s, b"yg"), None);
}

/// A rerun queues for the keys its earlier run lost on (the concurrent store's row-lock queue), so
/// writers of one hot page wait in line; a first run that reads a queued key stops at once; the queue
/// wait ends at the deadline.
#[test]
fn a_rerun_queues_for_the_keys_it_lost_on() {
    let s = Arc::new(mu_store());
    let hot = || TxnOptions {
        retry_keys: vec![b"yhot".to_vec()],
        ..with_deadline(5_000)
    };
    let first = s.begin_bound(hot()).unwrap();
    let store = s.clone();
    let second = std::thread::spawn(move || {
        let t = store.begin_bound(hot()).unwrap();
        let seen = get(&t, b"yhot");
        t.write(|w| w.put(b"yhot", b"2")).unwrap();
        t.commit_transaction().map(|_| seen)
    });
    std::thread::sleep(Duration::from_millis(50));
    assert!(!second.is_finished(), "the second rerun did not queue");
    let fresh = s.begin_bound(optimistic()).unwrap();
    let Err(early) = fresh.read().unwrap().get(b"yhot") else {
        panic!("a first run read a queued key");
    };
    assert_eq!(early.code, WRITE_CONFLICT);
    assert!(fresh.transaction_conflicted());
    fresh.rollback_transaction().unwrap();
    let late = TxnOptions {
        retry_keys: vec![b"yhot".to_vec()],
        ..with_deadline(30)
    };
    let Err(timed_out) = s.begin_bound(late) else {
        panic!("took a queued key");
    };
    assert_eq!(timed_out.code, TIMEOUT);
    first.write(|w| w.put(b"yhot", b"1")).unwrap();
    first.commit_transaction().unwrap();
    let seen = second.join().unwrap().unwrap();
    assert_eq!(seen.as_deref(), Some(&b"1"[..]));
    assert_eq!(get(&s, b"yhot").as_deref(), Some(&b"2"[..]));
}

/// Interface fact 6 (leases): work started under an old epoch is refused after a takeover. A lease
/// check reads the lease record inside the transaction (L5's `assert_lease` on a bound store is a
/// statement), so the record is in the read set: an optimistic commit after another writer moved the
/// record is refused; a serialized transaction sees its own view and the takeover waits for it. Here
/// the record is a plain row standing in for the lease row; L5's own test covers `assert_lease`.
#[test]
fn a_lease_record_that_moved_after_the_check_refuses_the_optimistic_commit() {
    let s = Arc::new(mu_store());
    s.write(|w| w.put(b"ylease", b"epoch=1")).unwrap();
    let t = s.begin_bound(optimistic()).unwrap();
    assert_eq!(get(&t, b"ylease").as_deref(), Some(&b"epoch=1"[..]));
    t.write(|w| w.put(b"yprotected", b"written under epoch 1"))
        .unwrap();
    // The takeover: another holder takes the lease under a new epoch.
    s.write(|w| w.put(b"ylease", b"epoch=2")).unwrap();
    assert_eq!(t.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    assert_eq!(get(&s, b"yprotected"), None);

    // Serialized: the transaction keeps its own view and the takeover lands only after it ends.
    let x = s.begin_transaction(false).unwrap();
    assert_eq!(get(&x, b"ylease").as_deref(), Some(&b"epoch=2"[..]));
    let store = s.clone();
    let takeover = std::thread::spawn(move || store.write(|w| w.put(b"ylease", b"epoch=3")));
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        !takeover.is_finished(),
        "a takeover landed inside a serialized transaction"
    );
    x.write(|w| w.put(b"yprotected", b"written under epoch 2"))
        .unwrap();
    assert_eq!(get(&x, b"ylease").as_deref(), Some(&b"epoch=2"[..]));
    x.commit_transaction().unwrap();
    takeover.join().unwrap().unwrap();
    assert_eq!(
        get(&s, b"yprotected").as_deref(),
        Some(&b"written under epoch 2"[..])
    );
    assert_eq!(get(&s, b"ylease").as_deref(), Some(&b"epoch=3"[..]));
}
