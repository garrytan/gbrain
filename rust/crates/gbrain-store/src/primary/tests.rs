//! Round-2 review of the primary's write fence: the edges of `serve_as_primary` and of a commit judged before the
//! store served, reached through seams the integration tests in `tests/takeover.rs` cannot use. Each failed on
//! a19ee62774 and passes after its fix.

use super::*;
use crate::error::WRITE_CONFLICT;
use crate::leases::lost_reason;
use crate::test_support::mu_logged_store;
use crate::transactions::{AFTER_COMMIT_FENCE, TxnMode, TxnOptions};
use std::sync::atomic::{AtomicI64, Ordering};

/// A clock set by hand, starting at the wall clock.
struct HandClock(AtomicI64);

impl Env for HandClock {
    fn now_micros(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        crate::SystemEnv.new_uuid()
    }
}

fn hand_clock() -> Arc<HandClock> {
    Arc::new(HandClock(AtomicI64::new(crate::SystemEnv.now_micros())))
}

fn origin() -> WriteOrigin {
    WriteOrigin {
        host_id: "p-host".into(),
        incarnation: "p-run".into(),
        writer_id: "local_cli:test".into(),
    }
}

/// The sweep-record backfill's done marker goes, so `serve_as_primary` has upkeep to commit.
fn leave_upkeep(store: &Store) {
    store
        .write(|w| w.delete(&crate::page_body::purge_record::repair_done_key()))
        .unwrap();
}

fn backfill_done(store: &Store) -> bool {
    store
        .kv
        .snapshot()
        .unwrap()
        .get(&crate::page_body::purge_record::repair_done_key())
        .unwrap()
        .is_some()
}

/// Round-2 finding 1: the upkeep `serve_as_primary` finishes committed without the lease's fence, so upkeep that
/// outlived the lease still wrote. Each upkeep commit now carries the fence: here the lease lapses between the
/// acquisition and the upkeep, the upkeep is refused and writes nothing, and the serve fails.
#[test]
fn upkeep_that_outlives_the_lease_is_refused_and_writes_nothing() {
    let clock = hand_clock();
    let store = mu_logged_store(clock.clone());
    leave_upkeep(&store);
    let late = clock.clone();
    AFTER_ACQUIRE.with(|h| {
        *h.borrow_mut() = Some(Box::new(move || {
            late.0.fetch_add(5_000_001, Ordering::SeqCst);
        }))
    });
    let e = store.serve_as_primary(&origin(), 5_000).unwrap_err();
    assert_eq!(lost_reason(&e).as_deref(), Some("expired"), "{e}");
    assert!(
        !backfill_done(&store),
        "the upkeep wrote after the lease's end"
    );
    assert_eq!(store.primary_token(), None);
}

/// Round-2 finding 3: when the upkeep failed, a store that never served went back to unfenced writes although its
/// records now held a primary lease. It now refuses writes (`primary_not_served`) until it serves.
#[test]
fn a_serve_whose_upkeep_failed_leaves_the_store_refusing_writes() {
    let clock = hand_clock();
    let store = mu_logged_store(clock.clone());
    leave_upkeep(&store);
    let late = clock.clone();
    AFTER_ACQUIRE.with(|h| {
        *h.borrow_mut() = Some(Box::new(move || {
            late.0.fetch_add(5_000_001, Ordering::SeqCst);
        }))
    });
    assert!(store.serve_as_primary(&origin(), 5_000).is_err());
    let before = store.kv.version().unwrap();
    let e = store.set_config("after-failed-serve", "1").unwrap_err();
    assert_eq!(lost_reason(&e).as_deref(), Some(PRIMARY_NOT_SERVED), "{e}");
    assert_eq!(store.kv.version().unwrap(), before);
    // Serving again (the lapsed lease is taken at the next epoch) finishes the upkeep and writes.
    store.serve_as_primary(&origin(), 60_000).unwrap().unwrap();
    assert!(backfill_done(&store));
    store.set_config("after-failed-serve", "1").unwrap();
}

/// Round-2 finding 2: an optimistic commit judged while the store never served, then held while the store took the
/// primary lease, went on to commit unfenced. The judgement now reads the lease record, so the lease taken first makes
/// the commit conflict, and nothing of it is written.
#[test]
fn a_commit_judged_before_the_lease_was_taken_conflicts() {
    let s = Arc::new(mu_logged_store(Arc::new(crate::SystemEnv)));
    let t = s
        .begin_bound(TxnOptions {
            mode: TxnMode::Optimistic,
            ..TxnOptions::default()
        })
        .unwrap();
    t.write(|w| w.put(b"ypre", b"1")).unwrap();
    let serving = s.clone();
    AFTER_COMMIT_FENCE.with(|h| {
        *h.borrow_mut() = Some(Box::new(move || {
            serving
                .serve_as_primary(&origin(), 60_000)
                .unwrap()
                .unwrap();
        }))
    });
    let err = t.commit_transaction().unwrap_err();
    assert_eq!(err.code, WRITE_CONFLICT, "{err}");
    assert!(s.primary_token().is_some());
    assert_eq!(s.kv.snapshot().unwrap().get(b"ypre").unwrap(), None);
}

/// A serve refused for bad input leaves a store that never served as it was: it writes as before.
#[test]
fn a_serve_refused_for_its_input_leaves_the_store_as_it_was() {
    let store = mu_logged_store(Arc::new(crate::SystemEnv));
    let e = store.serve_as_primary(&origin(), 0).unwrap_err();
    assert_eq!(lost_reason(&e), None, "{e}");
    assert_eq!(store.primary.get(), PrimaryState::NeverArmed);
    store.set_config("k", "1").unwrap();
}
