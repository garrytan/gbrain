//! Tests for the optimistic layer: targeted conflict-detection cases plus a seeded, deterministic
//! simulation stub that interleaves many simulated transactions over a few keys and checks the
//! recorded history is serializable. The scheduler is single-threaded and driven by one seed, so a
//! failing seed replays exactly. (A real simulation harness with I/O and crash injection, and
//! thread-interleaving tests under shuttle or loom, are follow-ups; this is the stub.)

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

// ---- deterministic simulation stub -----------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

#[derive(Clone, Debug)]
enum SimRead {
    Get(Vec<u8>, Option<Vec<u8>>),
    Range {
        start: Vec<u8>,
        end: Vec<u8>,
        limit: usize,
        /// Own writes made before the range read, as (key -> Some(put)/None(delete)).
        own: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
        rows: Vec<(Vec<u8>, Vec<u8>)>,
    },
}

struct Active {
    id: usize,
    txn: Txn,
    steps_left: usize,
    own: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    reads: Vec<SimRead>,
}

struct Committed {
    snapshot: u64,
    version: u64,
    reads: Vec<SimRead>,
    writes: Vec<(Vec<u8>, Option<Vec<u8>>)>,
}

const KEYS: [&[u8]; 5] = [b"k/0", b"k/1", b"k/2", b"k/3", b"k/4"];

fn range_of(rng: &mut Rng) -> (Vec<u8>, Vec<u8>) {
    let a = rng.below(KEYS.len());
    let b = a + 1 + rng.below(KEYS.len() - a);
    let end = if b >= KEYS.len() {
        b"k/9".to_vec()
    } else {
        KEYS[b].to_vec()
    };
    (KEYS[a].to_vec(), end)
}

fn run_sim(seed: u64, n_txns: usize) -> (usize, usize, usize) {
    let mut rng = Rng(seed);
    let store = mem();
    let mut committer = committer(&store);
    let mut active: Vec<Active> = Vec::new();
    let mut ready: Vec<Active> = Vec::new();
    let mut committed: Vec<Committed> = Vec::new();
    let (mut started, mut conflicts, mut multi_batches) = (0usize, 0usize, 0usize);

    while started < n_txns || !active.is_empty() || !ready.is_empty() {
        match rng.below(10) {
            // begin a new transaction (snapshot taken now, so it interleaves with others)
            0..=2 if started < n_txns && active.len() < 8 => {
                let mut t = txn(&store);
                t.enable_trace();
                active.push(Active {
                    id: started,
                    txn: t,
                    steps_left: 1 + rng.below(5),
                    own: BTreeMap::new(),
                    reads: vec![],
                });
                started += 1;
            }
            // advance one active transaction by one step
            3..=7 if !active.is_empty() => {
                let i = rng.below(active.len());
                let a = &mut active[i];
                match rng.below(4) {
                    0 | 1 => {
                        let k = KEYS[rng.below(KEYS.len())];
                        let got = a.txn.get(k).unwrap();
                        if let Some(own) = a.own.get(k) {
                            assert_eq!(&got, own, "read-your-own-write");
                        } else {
                            a.reads.push(SimRead::Get(k.to_vec(), got));
                        }
                    }
                    2 => {
                        let (s, e) = range_of(&mut rng);
                        let limit = 1 + rng.below(4);
                        let rows = a.txn.range(&s, &e, limit).unwrap();
                        a.reads.push(SimRead::Range {
                            start: s,
                            end: e,
                            limit,
                            own: a.own.clone(),
                            rows,
                        });
                    }
                    _ => {
                        let k = KEYS[rng.below(KEYS.len())].to_vec();
                        if rng.below(5) == 0 {
                            a.txn.delete(k.clone());
                            a.own.insert(k, None);
                        } else {
                            let v = format!("t{}-{}", a.id, rng.below(1000)).into_bytes();
                            a.txn.put(k.clone(), v.clone());
                            a.own.insert(k, Some(v));
                        }
                    }
                }
                a.steps_left -= 1;
                if a.steps_left == 0 {
                    ready.push(active.swap_remove(i));
                }
            }
            // flush a random-sized group of finished transactions as ONE batch, in random order
            _ if !ready.is_empty() => {
                let take = 1 + rng.below(ready.len());
                let mut group = Vec::new();
                for _ in 0..take {
                    let j = rng.below(ready.len());
                    group.push(ready.swap_remove(j));
                }
                let mut metas = Vec::new();
                let mut reqs = Vec::new();
                for mut a in group {
                    let observed = a.txn.take_trace();
                    assert_eq!(observed.len(), a.reads.len(), "trace and sim reads agree");
                    let req = a.txn.into_request();
                    let writes: Vec<_> = req
                        .writes
                        .iter()
                        .map(|(k, op)| match op {
                            WriteOp::Put(v) => (k.clone(), Some(v.clone())),
                            WriteOp::Delete => (k.clone(), None),
                            WriteOp::AddI64(_) => {
                                unreachable!("the simulation does not use atomic adds")
                            }
                        })
                        .collect();
                    metas.push((req.snapshot_version, a.reads, writes));
                    reqs.push(req);
                }
                let results = committer.commit_batch(reqs, None);
                let ok_in_batch = results.iter().filter(|r| r.is_ok()).count();
                if ok_in_batch > 1 {
                    multi_batches += 1;
                }
                for ((snapshot, reads, writes), r) in metas.into_iter().zip(results) {
                    match r {
                        Ok(version) => committed.push(Committed {
                            snapshot,
                            version,
                            reads,
                            writes,
                        }),
                        Err(Error::Conflict) => conflicts += 1,
                        Err(e) => panic!("unexpected error {e}"),
                    }
                }
            }
            _ => {}
        }
    }

    check_serializable(&committed, &store);
    (committed.len(), conflicts, multi_batches)
}

fn merge_range(
    model: &BTreeMap<Vec<u8>, Vec<u8>>,
    own: &BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    start: &[u8],
    end: &[u8],
    limit: usize,
) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut m: BTreeMap<Vec<u8>, Vec<u8>> = model
        .range(start.to_vec()..end.to_vec())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (k, v) in own.range(start.to_vec()..end.to_vec()) {
        match v {
            Some(v) => {
                m.insert(k.clone(), v.clone());
            }
            None => {
                m.remove(k);
            }
        }
    }
    m.into_iter().take(limit).collect()
}

fn check_serializable(committed: &[Committed], store: &Arc<dyn BaseStore>) {
    // Versions are unique and strictly increasing in commit order.
    let mut order: Vec<&Committed> = committed.iter().collect();
    order.sort_by_key(|c| c.version);
    for w in order.windows(2) {
        assert!(w[0].version < w[1].version);
    }

    // Property 1: replaying committed transactions in commit order reproduces every read.
    let mut model: BTreeMap<Vec<u8>, Vec<u8>> = BTreeMap::new();
    for c in &order {
        for r in &c.reads {
            match r {
                SimRead::Get(k, seen) => assert_eq!(
                    model.get(k),
                    seen.as_ref(),
                    "txn at version {} read a stale value of {:?}",
                    c.version,
                    String::from_utf8_lossy(k)
                ),
                SimRead::Range {
                    start,
                    end,
                    limit,
                    own,
                    rows,
                } => assert_eq!(
                    &merge_range(&model, own, start, end, *limit),
                    rows,
                    "txn at version {} saw a stale range",
                    c.version
                ),
            }
        }
        for (k, v) in &c.writes {
            match v {
                Some(v) => {
                    model.insert(k.clone(), v.clone());
                }
                None => {
                    model.remove(k);
                }
            }
        }
    }

    // Property 2 (stated directly): no committed transaction read a key that another committed
    // transaction overwrote between its snapshot and its own commit.
    for c in &order {
        for other in &order {
            if other.version > c.snapshot && other.version < c.version {
                for r in &c.reads {
                    match r {
                        SimRead::Get(k, _) => {
                            assert!(
                                !other.writes.iter().any(|(w, _)| w == k),
                                "overwritten read of {:?}",
                                k
                            )
                        }
                        SimRead::Range {
                            start,
                            end,
                            rows,
                            limit,
                            ..
                        } => {
                            // observed extent: up to the last returned key if the page was full
                            let hi = if rows.len() == *limit {
                                key_successor(&rows[rows.len() - 1].0)
                            } else {
                                end.clone()
                            };
                            assert!(
                                !other.writes.iter().any(|(w, _)| w >= start && *w < hi),
                                "overwritten range read"
                            );
                        }
                    }
                }
            }
        }
    }

    // The store ends in exactly the replayed state.
    let snap = store.snapshot().unwrap();
    for k in KEYS {
        assert_eq!(snap.get(Table::Data, k).unwrap().as_ref(), model.get(k));
    }
    assert_eq!(
        read_version(snap.as_ref()).unwrap(),
        order.last().map(|c| c.version).unwrap_or(0)
    );
}

#[test]
fn simulation_histories_are_serializable_across_many_seeds() {
    let (mut commits, mut conflicts, mut multi) = (0, 0, 0);
    for seed in 0..300u64 {
        let (c, x, m) = run_sim(seed, 60);
        commits += c;
        conflicts += x;
        multi += m;
    }
    // Make sure the stub exercised what it claims to: commits, conflicts and group commits.
    assert!(commits > 3000, "commits {commits}");
    assert!(conflicts > 300, "conflicts {conflicts}");
    assert!(multi > 100, "multi-transaction batches {multi}");
}

#[test]
fn simulation_is_deterministic_for_a_seed() {
    assert_eq!(run_sim(42, 80), run_sim(42, 80));
}

/// The checker must be able to fail: feeding it a history with a stale read is rejected.
#[test]
#[should_panic(expected = "stale")]
fn the_serializability_checker_rejects_a_stale_read() {
    let store = mem();
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
            reads: vec![SimRead::Get(b"k/0".to_vec(), None)], // saw the pre-commit value
            writes: vec![],
        },
    ];
    check_serializable(&history, &store);
}
