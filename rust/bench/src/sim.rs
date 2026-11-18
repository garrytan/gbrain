//! Tests for the optimistic layer: targeted conflict-detection cases, then seeded simulations on
//! the `gbrain-sim` scheduler (see `simload.rs`): many simulated transactions over a few keys,
//! the committed history checked for serializability and torn reads. A failing seed prints a
//! one-line repro. Crash and fsync-fault simulations are in `simrun.rs`. Thread-interleaving
//! tests under shuttle or loom are a follow-up.

use crate::kv::*;
use crate::mem_store::MemStore;
use crate::occ::*;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn mem() -> Arc<dyn BaseStore> {
    Arc::new(MemStore::new())
}

fn committer(store: &Arc<dyn BaseStore>) -> Committer {
    Committer::new(store.clone(), Options::default()).unwrap()
}

fn txn(store: &Arc<dyn BaseStore>) -> Txn {
    Txn::begin(store.as_ref()).unwrap()
}

fn val(store: &Arc<dyn BaseStore>, key: &[u8]) -> Option<Vec<u8>> {
    store.snapshot().unwrap().get(Table::Data, key).unwrap()
}

fn is_conflict(r: &Result<u64>) -> bool {
    matches!(r, Err(Error::Conflict))
}

// ---- conflict detection ----------------------------------------------------------------------

#[test]
fn read_then_overwritten_is_a_conflict() {
    let store = mem();
    let mut c = committer(&store);
    let mut a = txn(&store);
    let mut b = txn(&store);
    assert_eq!(a.get(b"k").unwrap(), None);
    a.put(b"out".to_vec(), b"a".to_vec());
    b.put(b"k".to_vec(), b"b".to_vec());
    // b commits first, a read k at the old snapshot, so a must conflict.
    assert!(c.commit_batch(vec![b.into_request()], None)[0].is_ok());
    assert!(is_conflict(
        &c.commit_batch(vec![a.into_request()], None)[0]
    ));
    assert_eq!(val(&store, b"out"), None);
}

#[test]
fn blind_writes_never_conflict_and_last_commit_wins() {
    let store = mem();
    let mut c = committer(&store);
    let (mut a, mut b) = (txn(&store), txn(&store));
    a.put(b"k".to_vec(), b"a".to_vec());
    b.put(b"k".to_vec(), b"b".to_vec());
    let r = c.commit_batch(vec![a.into_request(), b.into_request()], None);
    assert!(r.iter().all(|x| x.is_ok()));
    assert_eq!(val(&store, b"k"), Some(b"b".to_vec()));
}

#[test]
fn two_read_modify_writes_in_one_batch_cannot_both_commit() {
    // Without checking against writes accepted earlier in the same batch, both would pass.
    let store = mem();
    let mut c = committer(&store);
    let (mut a, mut b) = (txn(&store), txn(&store));
    for t in [&mut a, &mut b] {
        t.get(b"n").unwrap();
        t.put(b"n".to_vec(), b"1".to_vec());
    }
    let r = c.commit_batch(vec![a.into_request(), b.into_request()], None);
    assert!(r[0].is_ok());
    assert!(is_conflict(&r[1]));
}

#[test]
fn a_range_read_conflicts_with_a_phantom_insert_and_a_delete() {
    let store = mem();
    let mut c = committer(&store);
    let mut seed = txn(&store);
    seed.put(b"r/1".to_vec(), b"x".to_vec());
    seed.put(b"r/3".to_vec(), b"x".to_vec());
    assert!(c.commit_batch(vec![seed.into_request()], None)[0].is_ok());

    for writer in [
        (b"r/2".to_vec(), Some(b"y".to_vec())),
        (b"r/3".to_vec(), None),
    ] {
        let mut scan = txn(&store);
        assert_eq!(scan.range(b"r/", b"r0", 10).unwrap().len(), 2);
        scan.put(b"copy".to_vec(), b"z".to_vec());
        let mut w = txn(&store);
        match writer.1 {
            Some(v) => w.put(writer.0, v),
            None => w.delete(writer.0),
        }
        assert!(c.commit_batch(vec![w.into_request()], None)[0].is_ok());
        assert!(is_conflict(
            &c.commit_batch(vec![scan.into_request()], None)[0]
        ));
        // restore for the next case
        let mut fix = txn(&store);
        fix.put(b"r/3".to_vec(), b"x".to_vec());
        fix.delete(b"r/2".to_vec());
        assert!(c.commit_batch(vec![fix.into_request()], None)[0].is_ok());
    }
}

#[test]
fn a_limited_range_read_only_depends_on_what_it_returned() {
    let store = mem();
    let mut c = committer(&store);
    let mut seed = txn(&store);
    for k in [b"r/1", b"r/2", b"r/9"] {
        seed.put(k.to_vec(), b"x".to_vec());
    }
    c.commit_batch(vec![seed.into_request()], None);
    let mut scan = txn(&store);
    assert_eq!(scan.range(b"r/", b"r0", 2).unwrap().len(), 2); // saw r/1, r/2 only
    scan.put(b"copy".to_vec(), b"z".to_vec());
    let mut w = txn(&store);
    w.put(b"r/5".to_vec(), b"y".to_vec()); // beyond what the scan returned
    c.commit_batch(vec![w.into_request()], None);
    assert!(c.commit_batch(vec![scan.into_request()], None)[0].is_ok());
}

#[test]
fn read_your_own_writes_and_untouched_keys_do_not_conflict() {
    let store = mem();
    let mut c = committer(&store);
    let mut a = txn(&store);
    a.put(b"mine".to_vec(), b"1".to_vec());
    assert_eq!(a.get(b"mine").unwrap(), Some(b"1".to_vec())); // not part of the read set
    a.delete(b"mine".to_vec());
    assert_eq!(a.get(b"mine").unwrap(), None);
    let mut b = txn(&store);
    b.put(b"other".to_vec(), b"2".to_vec());
    let r = c.commit_batch(vec![b.into_request(), a.into_request()], None);
    assert!(r.iter().all(|x| x.is_ok()));
}

#[test]
fn history_older_than_the_forgotten_window_conflicts_instead_of_risking_a_miss() {
    let store = mem();
    let opts = Options {
        history_keys: 4,
        ..Options::default()
    };
    let mut c = Committer::new(store.clone(), opts).unwrap();
    let mut old = txn(&store);
    old.get(b"watched").unwrap();
    old.put(b"x".to_vec(), b"1".to_vec());
    for i in 0..20u8 {
        let mut w = txn(&store);
        w.put(vec![b'k', i], b"v".to_vec());
        assert!(c.commit_batch(vec![w.into_request()], None)[0].is_ok());
    }
    assert!(is_conflict(
        &c.commit_batch(vec![old.into_request()], None)[0]
    ));
}

#[test]
fn atomic_adds_in_one_batch_sum_and_never_conflict() {
    let store = mem();
    let mut c = committer(&store);
    let reqs: Vec<_> = (1..=10)
        .map(|d| {
            let mut t = txn(&store);
            t.add_i64(b"hot".to_vec(), d).unwrap();
            t.into_request()
        })
        .collect();
    let r = c.commit_batch(reqs, None);
    assert!(r.iter().all(|x| x.is_ok()));
    assert_eq!(
        i64::from_le_bytes(val(&store, b"hot").unwrap().try_into().unwrap()),
        55
    );
}

#[test]
fn versions_are_contiguous_and_the_commit_log_replays_to_the_same_state() {
    let store = mem();
    let mut c = committer(&store);
    let mut want: BTreeMap<Vec<u8>, Option<Vec<u8>>> = BTreeMap::new();
    for i in 0..10u8 {
        let mut t = txn(&store);
        t.put(vec![b'a', i % 3], vec![i]);
        if i % 4 == 3 {
            t.delete(vec![b'a', 0]);
        }
        let r = c.commit_batch(vec![t.into_request()], None);
        assert_eq!(r[0].as_ref().unwrap(), &(i as u64 + 1));
    }
    let snap = store.snapshot().unwrap();
    assert_eq!(read_version(snap.as_ref()).unwrap(), 10);
    let mut v = 0u64;
    snap.scan(Table::Log, &[0], &[0xFF; 9], false, &mut |k, val| {
        v += 1;
        assert_eq!(u64::from_be_bytes(k.try_into().unwrap()), v);
        for (key, value) in decode_write_set(val).unwrap() {
            want.insert(key, value);
        }
        true
    })
    .unwrap();
    assert_eq!(v, 10);
    for (k, expected) in want {
        assert_eq!(val(&store, &k), expected);
    }
}

struct FailingStore {
    inner: MemStore,
    fail: AtomicBool,
}

impl BaseStore for FailingStore {
    fn name(&self) -> &'static str {
        "failing"
    }
    fn snapshot(&self) -> Result<Box<dyn Snapshot>> {
        self.inner.snapshot()
    }
    fn commit(&self, batch: &WriteBatch) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            Err(Error::Store("disk full".into()))
        } else {
            self.inner.commit(batch)
        }
    }
}

#[test]
fn a_failed_base_commit_fails_every_transaction_and_leaves_nothing_behind() {
    let fs = Arc::new(FailingStore {
        inner: MemStore::new(),
        fail: AtomicBool::new(true),
    });
    let store: Arc<dyn BaseStore> = fs.clone();
    let mut c = committer(&store);
    let (mut a, mut b) = (txn(&store), txn(&store));
    a.put(b"a".to_vec(), b"1".to_vec());
    b.put(b"b".to_vec(), b"2".to_vec());
    let r = c.commit_batch(vec![a.into_request(), b.into_request()], None);
    assert!(r.iter().all(|x| matches!(x, Err(Error::Store(_)))));
    assert_eq!(val(&store, b"a"), None);
    assert_eq!(c.version(), 0);
    // The store recovers: the next batch commits as version 1, with no gap.
    fs.fail.store(false, Ordering::SeqCst);
    let mut t = txn(&store);
    t.put(b"a".to_vec(), b"1".to_vec());
    assert_eq!(
        c.commit_batch(vec![t.into_request()], None)[0]
            .as_ref()
            .unwrap(),
        &1
    );
}

#[test]
fn typed_run_retries_to_success_and_never_returns_busy() {
    let store = mem();
    let db = Arc::new(Db::open(store, Options::default()).unwrap());
    let hs: Vec<_> = (0..8)
        .map(|_| {
            let db = db.clone();
            std::thread::spawn(move || {
                for _ in 0..40 {
                    db.run(|t| {
                        let n = t
                            .get(b"n")?
                            .map(|v| v[0] as u32 + ((v[1] as u32) << 8))
                            .unwrap_or(0)
                            + 1;
                        t.put(b"n".to_vec(), vec![(n & 0xFF) as u8, (n >> 8) as u8]);
                        Ok(())
                    })
                    .unwrap();
                }
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    let v = db.read(|s| s.get(Table::Data, b"n")).unwrap().unwrap();
    assert_eq!(v[0] as u32 + ((v[1] as u32) << 8), 320);
    assert!(
        db.stats.snapshot().conflicts > 0,
        "the test should have seen conflicts"
    );
}

// ---- seeded simulations ----------------------------------------------------------------------

use crate::simload::run_mem;
use crate::simrun::{layer_seed, redb_seed, Kind, TXNS};
use gbrain_sim::check::{self, Committed, ReadObs};
use gbrain_sim::seed::run_seeds;

#[test]
fn simulation_histories_are_serializable_across_many_seeds() {
    let totals = std::cell::RefCell::new((0usize, 0usize, 0usize));
    run_seeds(
        "cargo test --release -p gbrain-bakeoff simulation_histories_are_serializable_across_many_seeds",
        300,
        |seed| {
            let o = run_mem(seed, 60);
            if let Some(v) = o.violations.first() {
                return Err(format!("{}: {}", v.class.name(), v.message));
            }
            let mut t = totals.borrow_mut();
            t.0 += o.committed.len();
            t.1 += o.conflicts;
            t.2 += o.multi_batches;
            Ok(())
        },
    );
    let (commits, conflicts, multi) = *totals.borrow();
    // Make sure the simulation exercised what it claims to: commits, conflicts and group commits.
    assert!(commits > 3000, "commits {commits}");
    assert!(conflicts > 300, "conflicts {conflicts}");
    assert!(multi > 100, "multi-transaction batches {multi}");
}

#[test]
fn the_same_seed_twice_gives_the_same_history_and_trace_hash() {
    for seed in [42, 7, 1234] {
        let (a, same) = layer_seed(seed, 80);
        assert!(same, "seed {seed}: trace hash differs between two runs");
        let b = run_mem(seed, 80);
        assert_eq!(a.trace_hash, b.trace_hash);
        assert_eq!(a.committed.len(), b.committed.len());
        assert_eq!(a.batches, b.batches);
    }
    assert_ne!(run_mem(1, 80).trace_hash, run_mem(2, 80).trace_hash);
}

/// The checker must be able to fail: a history with a stale read is rejected.
#[test]
fn the_serializability_checker_rejects_a_stale_read() {
    let history = vec![
        Committed {
            snapshot: 0,
            version: 1,
            reads: vec![],
            writes: vec![(b"k/0".to_vec(), Some(b"a".to_vec()))],
        },
        Committed {
            snapshot: 0,
            version: 2,
            reads: vec![ReadObs::Point {
                key: b"k/0".to_vec(),
                value: None, // saw the pre-commit value
            }],
            writes: vec![],
        },
    ];
    let e = check::check_serializable(&history).unwrap_err();
    assert!(e.message.contains("stale"), "{}", e.message);
}

// ---- crash simulation on a simulated disk (redb) ---------------------------------------------

#[test]
fn redb_survives_seeded_crash_points_and_fsync_faults() {
    for (kind, name) in [(Kind::Crash, "crash"), (Kind::FsyncFault, "fault")] {
        let cell = std::cell::RefCell::new((0u64, 0u64));
        run_seeds(
            &format!("cargo test --release -p gbrain-bakeoff redb_survives_seeded_crash_points_and_fsync_faults  # kind {name}"),
            150,
            |seed| {
                let r = redb_seed(seed, kind, TXNS);
                let mut c = cell.borrow_mut();
                c.0 += r.crash_hit as u64;
                c.1 += r.faults;
                match r.violations.first() {
                    Some(v) => Err(format!("{name}: {}: {}", v.class.name(), v.message)),
                    None => Ok(()),
                }
            },
        );
        let (crash_points, faults) = *cell.borrow();
        assert!(crash_points > 50, "{name}: crash points hit {crash_points}");
        if kind == Kind::FsyncFault {
            assert!(faults > 50, "faults injected {faults}");
        }
    }
}

#[test]
fn a_redb_seed_is_deterministic_including_the_disk() {
    for seed in [3, 99] {
        let a = redb_seed(seed, Kind::FsyncFault, TXNS);
        let b = redb_seed(seed, Kind::FsyncFault, TXNS);
        assert_eq!(a.trace_hash, b.trace_hash, "seed {seed}");
        assert_eq!(a.io_ops, b.io_ops, "seed {seed}");
        assert_eq!(a.faults, b.faults, "seed {seed}");
    }
}

/// The checker must be able to fail on real redb output: with every fsync lying and a reordering
/// crash, told the disk was honest, it must flag violations.
#[test]
fn the_redb_control_run_is_flagged() {
    let flagged = (0..60u64)
        .filter(|s| !redb_seed(*s, Kind::Control, TXNS).violations.is_empty())
        .count();
    assert!(
        flagged > 10,
        "negative control flagged only {flagged} of 60 seeds"
    );
}
