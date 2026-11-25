//! Unit tests of `leases.rs` on both store modes: the lease lifecycle, expiry on the store clock, and fencing of a
//! protected data write by a paused holder (conformance C06, property P-D).

use super::*;
use crate::env::Env;
use crate::test_support::{mem_kv, occ_kv};
use crate::{OpenOptions, Store};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Barrier};

/// A clock the test moves by hand, and ids from a counter.
struct Clock {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Clock {
    fn new() -> Arc<Clock> {
        Arc::new(Clock {
            now: AtomicI64::new(1_800_000_000_000_000),
            ids: AtomicU64::new(1),
        })
    }
    fn advance_ms(&self, ms: i64) {
        self.now.fetch_add(ms * 1000, Ordering::SeqCst);
    }
}

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::SeqCst);
        format!("00000000-0000-4000-8000-{n:012x}")
    }
}

fn origin(host: &str) -> WriteOrigin {
    WriteOrigin {
        host_id: format!("{host}-host"),
        incarnation: format!("{host}-incarnation"),
        writer_id: "local_cli:test".into(),
    }
}

fn single(clock: &Arc<Clock>, multiuser: bool) -> Store {
    Store::open_kv(
        mem_kv(),
        clock.clone(),
        OpenOptions {
            multiuser,
            ..OpenOptions::default()
        },
    )
    .unwrap()
}

fn concurrent(clock: &Arc<Clock>, multiuser: bool) -> Store {
    Store::open_kv(
        Arc::new(occ_kv()),
        clock.clone(),
        OpenOptions {
            multiuser,
            ..OpenOptions::default()
        },
    )
    .unwrap()
}

fn both(clock: &Arc<Clock>) -> [(&'static str, Store); 2] {
    [
        ("single", single(clock, false)),
        ("concurrent", concurrent(clock, false)),
    ]
}

fn reason(e: &StoreError) -> String {
    assert_eq!(e.code, LEASE_LOST, "{e}");
    lost_reason(e).unwrap()
}

#[test]
fn a_takeover_raises_the_epoch_and_the_old_token_loses_renew_assert_and_release() {
    let clock = Clock::new();
    for (mode, store) in both(&clock) {
        let a = store
            .acquire_lease("consumer:h1", &origin("a"), 1_000)
            .unwrap()
            .unwrap();
        assert_eq!(a.epoch, 1, "{mode}");
        // A live lease is never handed to a second taker, and that is not an error.
        assert_eq!(
            store
                .acquire_lease("consumer:h1", &origin("b"), 1_000)
                .unwrap(),
            None,
            "{mode}"
        );
        store.renew_lease(&a, 1_000).unwrap();
        store.assert_lease(&a).unwrap();
        store.release_lease(&a).unwrap();
        assert_eq!(
            reason(&store.assert_lease(&a).unwrap_err()),
            "released",
            "{mode}"
        );
        assert_eq!(
            reason(&store.renew_lease(&a, 1_000).unwrap_err()),
            "released",
            "{mode}"
        );
        let b = store
            .acquire_lease("consumer:h1", &origin("b"), 1_000)
            .unwrap()
            .unwrap();
        assert_eq!(b.epoch, 2, "{mode}");
        assert_ne!(a.token, b.token, "{mode}");
        assert_eq!(
            reason(&store.renew_lease(&a, 1_000).unwrap_err()),
            "epoch_moved",
            "{mode}"
        );
        assert_eq!(
            reason(&store.assert_lease(&a).unwrap_err()),
            "epoch_moved",
            "{mode}"
        );
        // Releasing with a stale token, or twice, changes nothing.
        store.release_lease(&a).unwrap();
        store.assert_lease(&b).unwrap();
        let state = store.read_lease("consumer:h1").unwrap().unwrap();
        assert_eq!(
            (state.epoch, state.live, state.holder.host_id.as_str()),
            (2, true, "b-host"),
            "{mode}"
        );
        assert_eq!(store.read_lease("never").unwrap(), None);
        let unknown = LeaseToken {
            name: "never".into(),
            epoch: 1,
            token: "x".into(),
        };
        assert_eq!(
            reason(&store.assert_lease(&unknown).unwrap_err()),
            "not_found",
            "{mode}"
        );
    }
}

#[test]
fn expiry_is_judged_on_the_store_clock_and_an_expired_holder_takes_a_new_epoch() {
    let clock = Clock::new();
    for (mode, store) in both(&clock) {
        let a = store
            .acquire_lease("drain:s", &origin("a"), 1_000)
            .unwrap()
            .unwrap();
        clock.advance_ms(500);
        store.renew_lease(&a, 1_000).unwrap();
        clock.advance_ms(1_500);
        assert_eq!(
            reason(&store.assert_lease(&a).unwrap_err()),
            "expired",
            "{mode}"
        );
        // A holder back after its lease expired cannot renew the old epoch: it takes the lease again.
        assert_eq!(
            reason(&store.renew_lease(&a, 1_000).unwrap_err()),
            "expired",
            "{mode}"
        );
        let again = store
            .acquire_lease("drain:s", &origin("a"), 1_000)
            .unwrap()
            .unwrap();
        assert_eq!(again.epoch, a.epoch + 1, "{mode}");
        assert_eq!(
            reason(&store.assert_lease(&a).unwrap_err()),
            "epoch_moved",
            "{mode}"
        );
        store.assert_lease(&again).unwrap();
    }
}

#[test]
fn malformed_names_ttls_and_origins_are_refused_before_anything_is_written() {
    let clock = Clock::new();
    let store = single(&clock, false);
    let before = store.commit_version().unwrap();
    for name in ["", "a\0b", &"x".repeat(MAX_NAME_BYTES + 1)] {
        assert_eq!(
            store
                .acquire_lease(name, &origin("a"), 10)
                .unwrap_err()
                .code,
            crate::error::INVALID_ARGUMENT
        );
    }
    for ttl in [0, MAX_TTL_MS + 1] {
        assert_eq!(
            store
                .acquire_lease("n", &origin("a"), ttl)
                .unwrap_err()
                .code,
            crate::error::INVALID_ARGUMENT
        );
    }
    let mut bad = origin("a");
    bad.host_id.clear();
    assert_eq!(
        store.acquire_lease("n", &bad, 10).unwrap_err().code,
        crate::error::INVALID_ARGUMENT
    );
    assert_eq!(store.commit_version().unwrap(), before);
}

#[test]
fn lease_tokens_are_uuid_v7_and_the_store_ids_stay_v4() {
    let store = single(&Clock::new(), false);
    let a = store.acquire_lease("n", &origin("a"), 10).unwrap().unwrap();
    assert_eq!(&a.token[14..15], "7");
    let legacy = store.env.new_uuid();
    assert_eq!(&legacy[14..15], "4");
}

/// C06 / P-D on the concurrent store: holder A checks its lease inside a data write and pauses; the lease expires and
/// B takes it over (committed); A resumes and tries to commit. A's read of the lease record is in its read set, so its
/// commit loses, the rerun sees the new epoch, and A's protected data never lands.
#[test]
fn a_paused_holder_cannot_commit_protected_data_after_a_takeover() {
    let clock = Clock::new();
    let store = Arc::new(concurrent(&clock, true));
    let a = store
        .acquire_lease("job-runner", &origin("a"), 1_000)
        .unwrap()
        .unwrap();
    let checked = Arc::new(Barrier::new(2));
    let taken = Arc::new(Barrier::new(2));
    let first = Arc::new(AtomicBool::new(true));
    let attempts = Arc::new(AtomicU64::new(0));
    let holder = {
        let (store, a, checked, taken, first, attempts) = (
            store.clone(),
            a.clone(),
            checked.clone(),
            taken.clone(),
            first.clone(),
            attempts.clone(),
        );
        std::thread::spawn(move || {
            store.write(|tx| {
                attempts.fetch_add(1, Ordering::SeqCst);
                check_fence(&store, tx, Some(&a), "test")?;
                if first.swap(false, Ordering::SeqCst) {
                    checked.wait();
                    taken.wait();
                }
                crate::put_json(
                    tx,
                    &crate::config::config_key("protected")?,
                    &"written by A",
                )
            })
        })
    };
    checked.wait();
    clock.advance_ms(2_000);
    let b = store
        .acquire_lease("job-runner", &origin("b"), 1_000)
        .unwrap()
        .unwrap();
    assert_eq!(b.epoch, 2);
    taken.wait();
    let outcome = holder.join().unwrap();
    assert_eq!(reason(&outcome.unwrap_err()), "epoch_moved");
    assert!(
        attempts.load(Ordering::SeqCst) >= 2,
        "the losing commit ran again"
    );
    assert_eq!(store.get_config("protected").unwrap(), None);
    // The new holder writes.
    store
        .write(|tx| {
            check_fence(&store, tx, Some(&b), "test")?;
            crate::put_json(
                tx,
                &crate::config::config_key("protected")?,
                &"written by B",
            )
        })
        .unwrap();
}

/// The single-writer store: the holder's write holds the writer from its lease read to its commit, so a takeover
/// waits for it; the holder's write lands before the takeover, never after.
#[test]
fn on_the_single_writer_store_a_takeover_waits_for_the_holder_s_write() {
    let clock = Clock::new();
    let store = Arc::new(single(&clock, true));
    let a = store
        .acquire_lease("job-runner", &origin("a"), 1_000)
        .unwrap()
        .unwrap();
    let checked = Arc::new(Barrier::new(2));
    let holder = {
        let (store, a, checked) = (store.clone(), a.clone(), checked.clone());
        std::thread::spawn(move || {
            store.write(|tx| {
                check_fence(&store, tx, Some(&a), "test")?;
                checked.wait();
                std::thread::sleep(std::time::Duration::from_millis(50));
                crate::put_json(
                    tx,
                    &crate::config::config_key("protected")?,
                    &"written by A",
                )
            })
        })
    };
    checked.wait();
    clock.advance_ms(2_000);
    let b = store
        .acquire_lease("job-runner", &origin("b"), 1_000)
        .unwrap()
        .unwrap();
    holder.join().unwrap().unwrap();
    assert_eq!(b.epoch, 2);
    assert_eq!(
        store.get_config("protected").unwrap().as_deref(),
        Some("\"written by A\"")
    );
    assert_eq!(reason(&store.assert_lease(&a).unwrap_err()), "epoch_moved");
}

/// Inside an explicit transaction the check is a statement of the transaction; a token that lost its lease before
/// the transaction refuses, and a statement that fails leaves the transaction usable.
#[test]
fn an_explicit_transaction_asserts_the_lease_as_one_of_its_statements() {
    let clock = Clock::new();
    for (mode, store) in both(&clock) {
        let a = store
            .acquire_lease("cycle", &origin("a"), 1_000)
            .unwrap()
            .unwrap();
        let tx = store.begin_transaction(false).unwrap();
        tx.assert_lease(&a).unwrap();
        tx.set_config("in-tx", "1").unwrap();
        store_commit(&tx);
        clock.advance_ms(2_000);
        let b = store
            .acquire_lease("cycle", &origin("b"), 1_000)
            .unwrap()
            .unwrap();
        let tx = store.begin_transaction(false).unwrap();
        assert_eq!(
            reason(&tx.assert_lease(&a).unwrap_err()),
            "epoch_moved",
            "{mode}"
        );
        tx.assert_lease(&b).unwrap();
        store_commit(&tx);
    }
}

fn store_commit(tx: &Store) {
    tx.commit_transaction().unwrap();
}

#[test]
fn a_multiuser_store_refuses_a_protected_write_with_no_fence_and_a_plain_store_keeps_today_s_path()
{
    let clock = Clock::new();
    let plain = single(&clock, false);
    plain
        .write(|tx| check_fence(&plain, tx, None, "complete_job"))
        .unwrap();
    let multi = concurrent(&clock, true);
    let e = multi
        .write(|tx| check_fence(&multi, tx, None, "complete_job"))
        .unwrap_err();
    assert_eq!(reason(&e), "fence_missing");
    assert!(multi.multiuser() && !plain.multiuser());
}

#[test]
fn a_claim_finishes_only_under_the_lease_and_epoch_it_was_taken_with() {
    let clock = Clock::new();
    for (mode, store) in both(&clock) {
        let a = store
            .acquire_lease("consumer:h1", &origin("a"), 1_000)
            .unwrap()
            .unwrap();
        store
            .write(|tx| record_claim_epoch(tx, CLAIM_JOB, "42", &a))
            .unwrap();
        store
            .write(|tx| check_claim_epoch(tx, CLAIM_JOB, "42", &a))
            .unwrap();
        let other = LeaseToken {
            epoch: a.epoch + 1,
            ..a.clone()
        };
        let e = store
            .write(|tx| check_claim_epoch(tx, CLAIM_JOB, "42", &other))
            .unwrap_err();
        assert_eq!(reason(&e), "claim_epoch_mismatch", "{mode}");
        // Another family's claim with the same id is a different claim.
        let e = store
            .write(|tx| check_claim_epoch(tx, CLAIM_EFFECT, "42", &a))
            .unwrap_err();
        assert_eq!(reason(&e), "claim_epoch_mismatch", "{mode}");
        store
            .write(|tx| clear_claim_epoch(tx, CLAIM_JOB, "42"))
            .unwrap();
        let e = store
            .write(|tx| check_claim_epoch(tx, CLAIM_JOB, "42", &a))
            .unwrap_err();
        assert_eq!(reason(&e), "claim_epoch_mismatch", "{mode}");
    }
}

/// Many takers race for one expired lease on the concurrent store: exactly one wins each epoch.
#[test]
fn concurrent_takers_of_one_lease_get_one_winner() {
    let clock = Clock::new();
    let store = Arc::new(concurrent(&clock, true));
    for round in 1..=5u64 {
        let start = Arc::new(Barrier::new(8));
        let winners: Vec<_> = (0..8)
            .map(|i| {
                let (store, start) = (store.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    store
                        .acquire_lease("hot", &origin(&format!("t{i}")), 1_000)
                        .unwrap()
                })
            })
            .collect();
        let won: Vec<LeaseToken> = winners
            .into_iter()
            .filter_map(|h| h.join().unwrap())
            .collect();
        assert_eq!(won.len(), 1, "round {round}");
        assert_eq!(won[0].epoch, round);
        clock.advance_ms(2_000);
    }
}

/// E1: the lease check reads the lease record inside the writing transaction, so the record is in its read set and
/// the commit checks it again. On the concurrent store a write transaction that checked the lease, then saw a takeover
/// commit before its own commit, loses with `write_conflict` at commit (the record was in its read set); an untouched
/// lease lets it commit.
#[test]
fn the_lease_read_is_in_the_transaction_s_read_set_and_the_commit_checks_it_again() {
    use crate::kv::Kv;
    let clock = Clock::new();
    let kv = Arc::new(occ_kv());
    let store = Store::open_kv(
        kv.clone(),
        clock.clone(),
        OpenOptions {
            multiuser: true,
            ..OpenOptions::default()
        },
    )
    .unwrap();
    let a = store
        .acquire_lease("held", &origin("a"), 1_000)
        .unwrap()
        .unwrap();

    // Untouched lease: the checked write commits.
    let mut tx = kv.begin_write().unwrap();
    assert_held(&*tx, &a, clock.clock_micros()).unwrap();
    tx.put(b"Cprobe-1", b"1").unwrap();
    tx.commit().unwrap();

    // Takeover between the check and the commit: the commit itself refuses.
    let mut tx = kv.begin_write().unwrap();
    assert_held(&*tx, &a, clock.clock_micros()).unwrap();
    clock.advance_ms(2_000);
    let b = store
        .acquire_lease("held", &origin("b"), 1_000)
        .unwrap()
        .unwrap();
    assert_eq!(b.epoch, 2);
    tx.put(b"Cprobe-2", b"1").unwrap();
    let e = tx.commit().unwrap_err();
    assert_eq!(e.code, crate::error::WRITE_CONFLICT, "{e}");
    assert_eq!(kv.snapshot().unwrap().get(b"Cprobe-2").unwrap(), None);

    // A write that does not read the lease is not fenced by it: the control that shows the read is what conflicts.
    let mut tx = kv.begin_write().unwrap();
    clock.advance_ms(2_000);
    let _c = store
        .acquire_lease("held", &origin("c"), 1_000)
        .unwrap()
        .unwrap();
    tx.put(b"Cprobe-3", b"1").unwrap();
    tx.commit().unwrap();
}

/// E1 on today's explicit transaction (which holds the writer exclusively): the check is a statement of the
/// transaction, read through the transaction's own view (it sees a lease the transaction itself took, which no other
/// reader sees yet), and a takeover tried while the transaction is open waits for its commit.
#[test]
fn inside_an_explicit_transaction_the_lease_is_read_through_the_transaction() {
    let clock = Clock::new();
    for (mode, store) in both(&clock) {
        let store = Arc::new(store);
        let tx = store.begin_transaction(false).unwrap();
        let a = tx
            .acquire_lease("in-tx", &origin("a"), 1_000)
            .unwrap()
            .unwrap();
        tx.assert_lease(&a).unwrap();
        assert_eq!(
            store.read_lease("in-tx").unwrap(),
            None,
            "{mode}: outside readers do not see it before commit"
        );
        let taker = {
            let store = store.clone();
            std::thread::spawn(move || store.acquire_lease("in-tx", &origin("b"), 1_000).unwrap())
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !taker.is_finished(),
            "{mode}: the takeover waits for the transaction"
        );
        tx.commit_transaction().unwrap();
        assert_eq!(
            taker.join().unwrap(),
            None,
            "{mode}: the committed lease is live, so the taker gets none"
        );
        store.assert_lease(&a).unwrap();
    }
}
