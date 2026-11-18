//! The simulated workload and its history, shared by every simulation in this crate.
//!
//! A handful of simulated clients run small transactions over five keys, and one simulated
//! flusher groups finished transactions into batches and hands each batch to the commit layer
//! (`Committer::commit_batch`), exactly as the pipeline thread would. All of it runs on one
//! thread under the `gbrain-sim` scheduler, so the interleaving is a function of the seed.
//!
//! Which transactions conflict, and so which commits exist and what versions they get, depends
//! only on the seed, never on the base store. That is what lets a child process that writes a real
//! store be checked against a reference run of the same seed on the in-memory store.

use crate::kv::*;
use crate::occ::*;
use gbrain_sim::check::{self, Class, Committed, Model, Own, ReadObs, Violation};
use gbrain_sim::{Cx, Scheduler, SimRng, Step, Task};
use std::collections::BTreeMap;
use std::sync::Arc;

pub const KEYS: [&[u8]; 5] = [b"k/0", b"k/1", b"k/2", b"k/3", b"k/4"];
const CLIENTS: usize = 8;

fn range_of(rng: &mut SimRng) -> (Vec<u8>, Vec<u8>) {
    let a = rng.below(KEYS.len());
    let b = a + 1 + rng.below(KEYS.len() - a);
    let end = if b >= KEYS.len() {
        b"k/9".to_vec()
    } else {
        KEYS[b].to_vec()
    };
    (KEYS[a].to_vec(), end)
}

struct Active {
    id: usize,
    txn: Txn,
    steps_left: usize,
    own: Own,
    reads: Vec<ReadObs>,
}

/// What a run produced.
#[derive(Default)]
pub struct Outcome {
    /// Every acknowledged commit, in commit order.
    pub committed: Vec<Committed>,
    /// The one batch whose base-store commit failed (so it may or may not be durable). Empty if
    /// every batch was acknowledged.
    pub in_doubt: Vec<Committed>,
    /// Why the run stopped early, if it did.
    pub store_failure: Option<String>,
    pub conflicts: usize,
    /// Batches that committed more than one transaction together.
    pub multi_batches: usize,
    /// (first version, last version) of every acknowledged batch, in order.
    pub batches: Vec<(u64, u64)>,
    /// Problems found while running: torn snapshot reads, unexpected errors.
    pub violations: Vec<Violation>,
    /// Hash of the scheduler's choices and every commit outcome. Same seed, same hash.
    pub trace_hash: u64,
    pub steps: u64,
    pub started: usize,
}

type AckHook = Box<dyn FnMut(u64)>;

struct World {
    store: Arc<dyn BaseStore>,
    committer: Committer,
    n_txns: usize,
    started: usize,
    ready: Vec<Active>,
    out: Outcome,
    on_ack: Option<AckHook>,
}

impl World {
    fn live(&self) -> bool {
        self.out.store_failure.is_none()
    }
}

struct Client {
    cur: Option<Active>,
}

impl Task<World> for Client {
    fn name(&self) -> &str {
        "client"
    }

    fn ready(&self, w: &World) -> bool {
        w.live() && (self.cur.is_some() || w.started < w.n_txns)
    }

    fn step(&mut self, w: &mut World, cx: &mut Cx<'_>) -> Step {
        let Some(a) = &mut self.cur else {
            let mut t = Txn::begin(w.store.as_ref()).expect("begin a transaction");
            t.enable_trace();
            self.cur = Some(Active {
                id: w.started,
                txn: t,
                steps_left: 1 + cx.rng.below(5),
                own: BTreeMap::new(),
                reads: vec![],
            });
            w.started += 1;
            return Step::Continue;
        };
        match cx.rng.below(4) {
            0 | 1 => {
                let k = KEYS[cx.rng.below(KEYS.len())];
                let got = a.txn.get(k).expect("get");
                if let Some(own) = a.own.get(k) {
                    assert_eq!(&got, own, "read-your-own-write");
                } else {
                    a.reads.push(ReadObs::Point {
                        key: k.to_vec(),
                        value: got,
                    });
                }
            }
            2 => {
                let (s, e) = range_of(cx.rng);
                let limit = 1 + cx.rng.below(4);
                let rows = a.txn.range(&s, &e, limit).expect("range");
                a.reads.push(ReadObs::Range {
                    start: s,
                    end: e,
                    limit,
                    own: a.own.clone(),
                    rows,
                });
            }
            _ => {
                let k = KEYS[cx.rng.below(KEYS.len())].to_vec();
                if cx.rng.below(5) == 0 {
                    a.txn.delete(k.clone());
                    a.own.insert(k, None);
                } else {
                    let v = format!("t{}-{}", a.id, cx.rng.below(1000)).into_bytes();
                    a.txn.put(k.clone(), v.clone());
                    a.own.insert(k, Some(v));
                }
            }
        }
        a.steps_left -= 1;
        if a.steps_left == 0 {
            w.ready.push(self.cur.take().unwrap());
        }
        Step::Continue
    }
}

struct Flusher;

impl Task<World> for Flusher {
    fn name(&self) -> &str {
        "flusher"
    }

    fn ready(&self, w: &World) -> bool {
        w.live() && !w.ready.is_empty()
    }

    fn step(&mut self, w: &mut World, cx: &mut Cx<'_>) -> Step {
        // A random-sized group of finished transactions, in random order, as ONE batch.
        let take = 1 + cx.rng.below(w.ready.len());
        let mut metas = Vec::new();
        let mut reqs = Vec::new();
        for _ in 0..take {
            let j = cx.rng.below(w.ready.len());
            let mut a = w.ready.swap_remove(j);
            let observed = a.txn.take_trace();
            assert_eq!(observed.len(), a.reads.len(), "trace and sim reads agree");
            let req = a.txn.into_request();
            let writes: Vec<_> = req
                .writes
                .iter()
                .map(|(k, op)| match op {
                    WriteOp::Put(v) => (k.clone(), Some(v.clone())),
                    WriteOp::Delete => (k.clone(), None),
                    WriteOp::AddI64(_) => unreachable!("the simulation does not use atomic adds"),
                })
                .collect();
            metas.push((req.snapshot_version, a.reads, writes));
            reqs.push(req);
        }
        let base = w.committer.version();
        cx.trace
            .event(&format!("batch of {} at version {base}", metas.len()));
        let results = w.committer.commit_batch(reqs, None);

        // A store failure fails every accepted transaction with Error::Store; those are the
        // in-doubt batch, and they were numbered base+1, base+2, ... in order.
        let failed = results.iter().any(|r| matches!(r, Err(Error::Store(_))));
        let mut next = base;
        let mut accepted = 0usize;
        let mut batch_committed = Vec::new();
        for ((snapshot, reads, writes), r) in metas.into_iter().zip(results) {
            match r {
                Ok(version) => {
                    cx.trace
                        .event(&format!("commit {version} snapshot {snapshot}"));
                    accepted += 1;
                    batch_committed.push(Committed {
                        snapshot,
                        version,
                        reads,
                        writes,
                    });
                }
                Err(Error::Conflict) => {
                    cx.trace.event("conflict");
                    w.out.conflicts += 1;
                }
                Err(Error::Store(m)) => {
                    next += 1;
                    cx.trace.event(&format!("store failure {m}"));
                    w.out.store_failure.get_or_insert(m);
                    w.out.in_doubt.push(Committed {
                        snapshot,
                        version: next,
                        reads,
                        writes,
                    });
                }
                Err(e) => {
                    w.out.violations.push(Violation {
                        class: Class::Corrupt,
                        message: format!("unexpected commit error: {e}"),
                    });
                    w.out.store_failure.get_or_insert(e.to_string());
                }
            }
        }
        if failed {
            return Step::Continue;
        }
        if accepted > 1 {
            w.out.multi_batches += 1;
        }
        if let (Some(first), Some(last)) = (batch_committed.first(), batch_committed.last()) {
            let bounds = (first.version, last.version);
            w.out.batches.push(bounds);
            w.out.committed.append(&mut batch_committed);
            if let Some(hook) = &mut w.on_ack {
                hook(bounds.1);
            }
            // No torn read: a snapshot taken now shows exactly the replay to its version.
            match read_state(w.store.as_ref()) {
                Ok((version, state)) => {
                    if let Err(v) = check::check_snapshot(&state, &w.out.committed, version) {
                        w.out.violations.push(v);
                    }
                    if version != bounds.1 {
                        w.out.violations.push(Violation {
                            class: Class::Torn,
                            message: format!(
                                "snapshot after the batch shows version {version}, expected {}",
                                bounds.1
                            ),
                        });
                    }
                }
                Err(e) => {
                    w.out.store_failure.get_or_insert(e.to_string());
                }
            }
        }
        Step::Continue
    }
}

/// The version and the full simulation key set, read from one snapshot.
pub fn read_state(store: &dyn BaseStore) -> Result<(u64, Model)> {
    let snap = store.snapshot()?;
    let version = read_version(snap.as_ref())?;
    let mut state = Model::new();
    for k in KEYS {
        if let Some(v) = snap.get(Table::Data, k)? {
            state.insert(k.to_vec(), v);
        }
    }
    Ok((version, state))
}

/// Check the commit log of a reopened store: versions 1..=version, each exactly once, and the
/// state must replay from the log. Returns problems (empty when the log is whole).
pub fn log_problems(store: &dyn BaseStore, version: u64) -> Result<Vec<String>> {
    let snap = store.snapshot()?;
    let mut problems = Vec::new();
    let mut seen = 0u64;
    snap.scan(Table::Log, &[0], &[0xFF; 9], false, &mut |k, _| {
        seen += 1;
        let v = u64::from_be_bytes(k.try_into().unwrap_or([0; 8]));
        if v != seen {
            problems.push(format!("commit log entry {v} where {seen} was expected"));
            return false;
        }
        true
    })?;
    if problems.is_empty() && seen != version {
        problems.push(format!(
            "commit log has {seen} entries but the store is at version {version}"
        ));
    }
    Ok(problems)
}

/// Run the seeded workload over `store`. Stops early if the base store fails a commit.
pub fn run_workload(
    store: Arc<dyn BaseStore>,
    opts: Options,
    seed: u64,
    n_txns: usize,
    on_ack: Option<AckHook>,
) -> Result<Outcome> {
    let committer = Committer::new(store.clone(), opts)?;
    let mut world = World {
        store,
        committer,
        n_txns,
        started: 0,
        ready: Vec::new(),
        out: Outcome::default(),
        on_ack,
    };
    let mut sched = Scheduler::new(seed);
    for _ in 0..CLIENTS {
        sched.spawn(Box::new(Client { cur: None }));
    }
    sched.spawn(Box::new(Flusher));
    sched.run(&mut world, u64::MAX, |_| false);
    let mut out = world.out;
    out.trace_hash = sched.trace.hash();
    out.steps = sched.steps;
    out.started = world.started;
    if out.store_failure.is_none() {
        if let Err(v) = check::check_serializable(&out.committed) {
            out.violations.push(v);
        }
    }
    Ok(out)
}

/// The workload over the in-memory store: the reference history for a seed.
pub fn run_mem(seed: u64, n_txns: usize) -> Outcome {
    let store: Arc<dyn BaseStore> = Arc::new(crate::mem_store::MemStore::new());
    run_workload(store, Options::default(), seed, n_txns, None)
        .expect("in-memory store cannot fail")
}
