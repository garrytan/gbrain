//! Findings of the second-model review of lane L1 (gpt-6.2-astra, one round), each a fail-first test:
//! it failed before its fix and passes after it.

use super::*;
use crate::error::{STORE_CORRUPT, STORE_IO, TIMEOUT, WRITE_CONFLICT};
use crate::test_support::{FlakyFile, mu_store, mu_store_on_file};
use std::time::Duration;

fn optimistic() -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        ..TxnOptions::default()
    }
}

fn get(s: &Store, key: &[u8]) -> Option<Vec<u8>> {
    s.read().unwrap().get(key).unwrap()
}

fn page(slug: &str) -> PageKeyHint {
    PageKeyHint {
        source_id: "default".into(),
        slug: slug.into(),
        incarnation: None,
    }
}

/// Review 4.1: optimistic mode needs the brain's resolved multi-user switch, not only a concurrent store.
#[test]
fn optimistic_mode_needs_the_multiuser_switch() {
    let concurrent_only = crate::test_support::occ_store();
    let t = concurrent_only.begin_bound(optimistic()).unwrap();
    assert!(!t.transaction_optimistic());
    t.rollback_transaction().unwrap();
    let on = mu_store();
    let t = on.begin_bound(optimistic()).unwrap();
    assert!(t.transaction_optimistic());
    t.rollback_transaction().unwrap();
}

/// Review 1.1: a read-only optimistic transaction answers the sequence it read at, not a later one.
#[test]
fn a_read_only_optimistic_commit_answers_its_own_snapshot_sequence() {
    let s = mu_store();
    s.write(|w| w.put(b"yk", b"1")).unwrap();
    let t = s
        .begin_bound(TxnOptions {
            read_only: true,
            ..optimistic()
        })
        .unwrap();
    let seen = s.commit_version().unwrap();
    assert_eq!(get(&t, b"yk").as_deref(), Some(&b"1"[..]));
    s.write(|w| w.put(b"yk", b"2")).unwrap();
    assert_eq!(t.commit_transaction().unwrap(), seen);
}

/// Review 1.2: the commit sequence read inside an optimistic transaction is its snapshot's, stays put,
/// and a commit after it refuses the transaction (a write derived from it would be stale).
#[test]
fn the_commit_sequence_read_in_a_transaction_is_its_snapshot_and_is_validated() {
    let s = mu_store();
    let t = s.begin_bound(optimistic()).unwrap();
    let g = t.read_trust_generation().unwrap();
    s.write(|w| w.put(b"yother", b"x")).unwrap();
    assert_eq!(
        t.read_trust_generation().unwrap(),
        g,
        "the generation moved inside the transaction"
    );
    t.write(|w| w.put(b"yderived", g.as_bytes())).unwrap();
    assert_eq!(t.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    assert_eq!(get(&s, b"yderived"), None);
}

/// Review 1.3: a statement whose merge fails part way keeps nothing, even when the caller goes on.
#[test]
fn a_statement_whose_merge_fails_part_way_keeps_nothing() {
    let s = mu_store();
    let t = s.begin_bound(optimistic()).unwrap();
    t.write(|w| w.add_i64(b"yz", 1)).unwrap();
    let merge = t.write(|w| {
        w.put(b"ya", b"prefix")?;
        w.raise_counter(b"yz", 5)
    });
    assert!(
        merge.is_err(),
        "a counter that is also an id sequence must refuse"
    );
    assert_ne!(t.commit_transaction().map(|_| ()), Ok(()));
    assert_eq!(
        get(&s, b"ya"),
        None,
        "a prefix of the failed statement was committed"
    );
}

/// Review 1.4: a conflict a statement catches still dooms the transaction.
#[test]
fn a_conflict_caught_inside_a_statement_still_dooms_the_transaction() {
    let s = mu_store();
    let mut busy = std::collections::BTreeSet::new();
    busy.insert(b"yk".to_vec());
    let holder = s.kv.begin_write_locked(&busy).unwrap();
    let t = s.begin_bound(optimistic()).unwrap();
    t.write(|w| {
        let _ = w.get(b"yk"); // swallowed write_conflict on a queued key
        w.put(b"ya", b"after a swallowed conflict")
    })
    .unwrap();
    drop(holder);
    assert_eq!(t.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
    assert_eq!(get(&s, b"ya"), None);
}

/// Review 1.5: a cap no value can be below admits nothing, whatever the pending delta.
#[test]
fn counter_below_with_the_smallest_cap_never_admits() {
    let s = mu_store();
    let t = s.begin_bound(optimistic()).unwrap();
    // The delta pending in a savepoint layer is what the check subtracts from the cap.
    t.savepoint().unwrap();
    t.write(|w| w.add_i64(b"yc", 1)).unwrap();
    assert!(
        t.write(|w| w.counter_below(b"yc", i64::MIN))
            .unwrap()
            .is_some()
    );
    t.rollback_transaction().unwrap();
}

/// Review 1.5: a counter that failed to decode is a read the commit checks.
#[test]
fn a_malformed_counter_read_is_validated_at_commit() {
    let s = mu_store();
    s.write(|w| w.put(b"yc", b"1234567")).unwrap();
    let t = s.begin_bound(optimistic()).unwrap();
    let _ = t.write(|w| w.counter_below(b"yc", 10));
    t.write(|w| w.put(b"ydecided", b"on a broken counter"))
        .unwrap();
    s.write(|w| w.put(b"yc", &3i64.to_le_bytes())).unwrap();
    assert_eq!(t.commit_transaction().unwrap_err().code, WRITE_CONFLICT);
}

/// Review 2.1: when writing the id sequences forward fails, the store failure is the answer (the
/// engine must not run the callback again), not the conflict.
#[test]
fn a_failed_id_write_forward_is_reported_as_a_store_failure() {
    let file = FlakyFile::default();
    let s = mu_store_on_file(&file);
    let t = s.begin_bound(optimistic()).unwrap();
    t.write(|w| crate::pages::next_id(w, "next_probe_id"))
        .unwrap();
    assert_eq!(get(&t, b"yk"), None);
    s.write(|w| w.put(b"yk", b"conflict")).unwrap();
    file.fail_sync
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(t.commit_transaction().unwrap_err().code, STORE_IO);
}

/// Review 2.2: a commit the pipeline refuses for another definite reason keeps its ids too.
#[test]
fn ids_survive_a_definite_refusal_that_is_not_a_conflict() {
    let file = FlakyFile::default();
    let handed = {
        let s = mu_store_on_file(&file);
        s.write(|w| w.put(b"ybroken", b"1234567")).unwrap();
        let t = s.begin_bound(optimistic()).unwrap();
        let handed = t
            .write(|w| crate::pages::next_id(w, "next_probe_id"))
            .unwrap();
        t.write(|w| w.add_i64(b"ybroken", 1)).unwrap();
        assert_eq!(t.commit_transaction().unwrap_err().code, STORE_CORRUPT);
        handed
    };
    let s = mu_store_on_file(&file);
    let next = s
        .write(|w| crate::pages::next_id(w, "next_probe_id"))
        .unwrap();
    assert!(
        next > handed,
        "id {next} was handed out again (had {handed})"
    );
}

/// Review 2.4: the deadline is checked again right before the commit is handed to the pipeline.
#[test]
fn the_deadline_is_checked_again_after_the_savepoints_merge() {
    let s = mu_store();
    let t = s
        .begin_bound(TxnOptions {
            deadline: Some(Instant::now() + Duration::from_millis(300)),
            ..optimistic()
        })
        .unwrap();
    t.savepoint().unwrap();
    t.write(|w| w.put(b"ylate", b"x")).unwrap();
    AFTER_SAVEPOINT_MERGE.with(|h| {
        *h.borrow_mut() = Some(Box::new(|| std::thread::sleep(Duration::from_millis(60))))
    });
    let err = t.commit_transaction().unwrap_err();
    assert_eq!(err.code, TIMEOUT);
    assert_eq!(get(&s, b"ylate"), None);
}

/// Review 2.5: a deadline holds even when the transaction runs serialized (a brain whose mode the
/// store resolved on but whose records opened on the single-writer store).
#[test]
fn a_deadline_holds_on_a_transaction_that_runs_serialized() {
    let s = crate::test_support::store();
    let t = s
        .begin_bound(TxnOptions {
            deadline: Some(Instant::now() + Duration::from_millis(500)),
            ..optimistic()
        })
        .unwrap();
    t.write(|w| w.put(b"yk", b"x")).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(t.commit_transaction().unwrap_err().code, TIMEOUT);
    assert_eq!(get(&s, b"yk"), None);
}

/// Review 3.2: a pristine waiter that reads on from after the holder's commit keeps the retry keys it
/// queued for.
#[test]
fn a_resnapshot_keeps_the_retry_keys() {
    let s = Arc::new(mu_store());
    let holder = s.begin_bound(optimistic()).unwrap();
    holder.hold_page_keys(&[page("p")], false).unwrap();
    let store = s.clone();
    let waiter = std::thread::spawn(move || {
        let t = store
            .begin_bound(TxnOptions {
                retry_keys: vec![b"yk".to_vec()],
                deadline: Some(Instant::now() + Duration::from_secs(5)),
                ..optimistic()
            })
            .unwrap();
        t.hold_page_keys(&[page("p")], false).unwrap();
        // Still queued on `yk`: a fresh first run that reads it stops at once.
        let probe = store.begin_bound(optimistic()).unwrap();
        let refused = probe.read().unwrap().get(b"yk").is_err();
        probe.rollback_transaction().unwrap();
        t.rollback_transaction().unwrap();
        refused
    });
    std::thread::sleep(Duration::from_millis(50));
    holder.commit_transaction().unwrap();
    assert!(
        waiter.join().unwrap(),
        "the re-snapshot dropped the retry key"
    );
}

/// Review 4.2: a serialized transaction reports a malformed counter with the trait's own message.
#[test]
fn a_serialized_counter_error_keeps_its_message() {
    let s = crate::test_support::store();
    s.write(|w| w.put(b"yc", b"1234567")).unwrap();
    let t = s.begin_transaction(false).unwrap();
    let err = t.write(|w| w.add_i64(b"yc", 1)).unwrap_err();
    assert_eq!(err.message, "bad counter record");
    let err = t.write(|w| w.counter_below(b"yc", 1)).unwrap_err();
    assert_eq!(err.message, "bad counter record");
    t.rollback_transaction().unwrap();
}

fn origin(host: &str) -> crate::write_origin::WriteOrigin {
    crate::write_origin::WriteOrigin {
        host_id: format!("host-{host}"),
        incarnation: "0190a000-0000-7000-8000-000000000001".into(),
        writer_id: format!("local_cli:{host}"),
    }
}

/// I-1 / I-5: `Transaction::assert_lease` checks the lease inside the transaction, so an optimistic
/// commit after a takeover is refused; a serialized transaction keeps its own view and the takeover
/// waits for it.
#[test]
fn transaction_assert_lease_is_checked_again_at_commit() {
    let s = Arc::new(mu_store());
    let a = s
        .acquire_lease("job-runner", &origin("a"), 60_000)
        .unwrap()
        .unwrap();
    let t = s.begin_with(optimistic()).unwrap();
    t.assert_lease(&a).unwrap();
    t.store()
        .write(|w| w.put(b"yprotected", b"under epoch 1"))
        .unwrap();
    s.release_lease(&a).unwrap();
    let b = s
        .acquire_lease("job-runner", &origin("b"), 60_000)
        .unwrap()
        .unwrap();
    assert!(b.epoch > a.epoch);
    assert_eq!(t.commit().unwrap_err().code, WRITE_CONFLICT);
    assert_eq!(get(&s, b"yprotected"), None);

    let x = s.begin_with(TxnOptions::default()).unwrap();
    x.assert_lease(&b).unwrap();
    let store = s.clone();
    let old = b.clone();
    let takeover = std::thread::spawn(move || store.release_lease(&old));
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        !takeover.is_finished(),
        "a takeover landed inside a serialized transaction"
    );
    x.store()
        .write(|w| w.put(b"yprotected", b"under epoch 2"))
        .unwrap();
    x.assert_lease(&b).unwrap();
    x.commit().unwrap();
    takeover.join().unwrap().unwrap();
    assert_eq!(
        get(&s, b"yprotected").as_deref(),
        Some(&b"under epoch 2"[..])
    );
}
