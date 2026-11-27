//! Findings of L6's review of the I-1 facade (rust-engine/mu-tests 3807928732), each a test that failed
//! before its fix.

use super::*;
use crate::error::WRITE_CONFLICT;
use crate::test_support::{mu_store, occ_store, store};

fn optimistic() -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        ..TxnOptions::default()
    }
}

fn refused(result: Result<Transaction>) -> StoreError {
    match result {
        Err(e) => e,
        Ok(_) => panic!("an optimistic transaction began on a brain without multi-user mode"),
    }
}

/// Finding 1: optimistic mode never quietly runs serialized. A brain without the multi-user switch,
/// and one with the switch but on the single-writer store, refuse it with `invalid_state`, through
/// both entry points; a serialized transaction still begins on each.
#[test]
fn optimistic_mode_is_refused_without_multi_user_mode() {
    for (what, s) in [
        ("single-writer, switch off", store()),
        ("concurrent, switch off", occ_store()),
    ] {
        let err = refused(s.begin_with(optimistic()));
        assert_eq!(err.code, INVALID_STATE, "{what}");
        assert!(
            err.message.contains("multi-user mode"),
            "{what}: {}",
            err.message
        );
        let Err(err) = s.begin_bound(optimistic()) else {
            panic!("{what}: begin_bound ran optimistic without multi-user mode");
        };
        assert_eq!(err.code, INVALID_STATE, "{what}");
        s.begin_with(TxnOptions::default())
            .unwrap()
            .rollback()
            .unwrap();
    }
    let on = mu_store();
    let t = on.begin_with(optimistic()).unwrap();
    assert!(t.store().transaction_optimistic());
    t.rollback().unwrap();
}

/// Finding 2: `Transaction::commit` answers the frozen `CommitPosition` (I-1, I-2), rising commit
/// by commit.
#[test]
fn transaction_commit_answers_its_commit_position() {
    let s = mu_store();
    let mut last: Option<CommitPosition> = None;
    for i in 0..3 {
        let t = s.begin_with(optimistic()).unwrap();
        t.store()
            .write(|w| w.put(format!("ypos/{i}").as_bytes(), b"x"))
            .unwrap();
        let at = t.commit().unwrap();
        assert!(at.sequence > 0);
        if let Some(prev) = last {
            assert!(at > prev, "{at:?} after {prev:?}");
        }
        last = Some(at);
    }
}

/// Finding 3: only the `Transaction` ends it. Its bound store refuses `commit_transaction` and
/// `rollback_transaction` with `invalid_state` and leaves the transaction open; `commit` and
/// `rollback` (which consume it) still work. `begin_bound` (the binding's shape) is unchanged.
#[test]
fn a_transaction_is_ended_only_by_consuming_it() {
    let s = mu_store();
    let t = s.begin_with(optimistic()).unwrap();
    t.store().write(|w| w.put(b"yowned", b"kept")).unwrap();
    assert_eq!(
        t.store().commit_transaction().unwrap_err().code,
        INVALID_STATE
    );
    assert_eq!(
        t.store().commit_transaction_at().unwrap_err().code,
        INVALID_STATE
    );
    assert_eq!(
        t.store().rollback_transaction().unwrap_err().code,
        INVALID_STATE
    );
    assert!(
        t.store().transaction_open(),
        "a refused end ended the transaction"
    );
    t.commit().unwrap();
    assert_eq!(
        s.read().unwrap().get(b"yowned").unwrap().as_deref(),
        Some(&b"kept"[..])
    );
    let r = s.begin_with(optimistic()).unwrap();
    r.store().write(|w| w.put(b"yrolled", b"no")).unwrap();
    r.rollback().unwrap();
    assert_eq!(s.read().unwrap().get(b"yrolled").unwrap(), None);
    // The binding's bound store ends itself, as before.
    let b = s.begin_bound(optimistic()).unwrap();
    b.write(|w| w.put(b"ybound", b"x")).unwrap();
    b.commit_transaction().unwrap();
    // A refused end does not lose the conflict rule: a stale owned transaction still refuses.
    let stale = s.begin_with(optimistic()).unwrap();
    assert_eq!(stale.store().read().unwrap().get(b"ystale").unwrap(), None);
    stale
        .store()
        .write(|w| w.put(b"ystale-derived", b"x"))
        .unwrap();
    s.write(|w| w.put(b"ystale", b"moved")).unwrap();
    assert_eq!(stale.commit().unwrap_err().code, WRITE_CONFLICT);
}
