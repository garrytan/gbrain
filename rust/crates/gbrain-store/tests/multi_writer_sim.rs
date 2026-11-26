//! Seeded simulation for many writers: P-A (serializable) and P-H (a crash keeps every acknowledged commit and the
//! in-doubt batch whole) of the design's "Concurrency and ordering property tests".
//!
//! What is here, all in the default build:
//! - a batch-aware serializability checker (`check_batches`) on the replay semantics of `occ_history.rs`: the
//!   transactions of one commit batch share a sequence and are ordered by index (when the history carries indices, that
//!   order; when it does not, an order in which no transaction reads a key an earlier one of the batch writes), every read
//!   must return exactly the replayed state, and the sequences must have no gap. Its controls: same-sequence batches that
//!   must pass, and stale-read, partial-batch, swapped-index, gap and duplicate histories that must be rejected. The
//!   histories it checks are asserted to hold reads, so a checker that sees no reads cannot pass.
//! - P-A on the single-writer store, driven by the `gbrain-sim` `Scheduler`: three client tasks and a snapshot reader take
//!   seeded steps over `RedbKv`; the history passes `check_serializable` and the batch checker, and rebuilds the store.
//! - P-H on both stores over `GBRAIN_SIM_SEEDS` seeds (default 200; the gate is 10,000 with
//!   `GBRAIN_SIM_SEEDS=10000 cargo test -p gbrain-store --release --test multi_writer_sim -- --include-ignored p_h`; the
//!   pending P-H twin is named `pending_crash_keeps_…` so that filter never selects it; run it on purpose with
//!   `-- --ignored pending_crash_keeps`): a
//!   simulated disk crashes (or fails an fsync) at a seeded point, the store reopens, and `check_recovery` plus the batch
//!   checker judge it. Each test prints and asserts a non-zero count of executed histories, checked commits and checked
//!   reads. The optimistic store runs on OS threads here (as `occ_history.rs` does), so its interleaving is not replayed
//!   from the seed; its workload and crash point are.
//!
//! The seeded driver of the optimistic store is the one piece that waits: it lives in `mod optimistic_driver`, compiled
//! only with `--features sim`, written against the `step_pipeline()` seam that the optimistic-transaction lane adds.
//!
//! DECISION (the seam, to be relayed to the optimistic-transaction lane). Today the commit pipeline is one thread that loops
//! "take the first queued commit, take every other one already queued up to a batch limit, `commit_batch`"
//! (`Pipeline::run` in `src/occ_kv.rs`), and `OccTxn::commit` blocks until the pipeline replies. A single-threaded scheduler
//! needs to decide when that loop body runs and how many commits it sees, so the seam is three items on `OccKv`, all behind
//! `#[cfg(feature = "sim")]`:
//!
//! ```ignore
//! impl OccKv {
//!     /// Like `OccKv::new`, but starts no pipeline thread: commits queue until `step_pipeline` runs.
//!     pub fn new_stepped(base: RedbKv) -> Result<OccKv>;
//!     /// Commit requests queued and not yet taken by a step.
//!     pub fn queued_commits(&self) -> usize;
//!     /// One iteration of `Pipeline::run`'s loop on the calling thread: takes up to `max_batch` queued commits in
//!     /// arrival order (an exclusive-write message ends the batch), validates and writes them as one batch, answers
//!     /// each, and reports what happened. `Ok(None)` when nothing was queued.
//!     pub fn step_pipeline(&self, max_batch: usize) -> Result<Option<PipelineStep>>;
//! }
//! pub struct PipelineStep {
//!     /// The batch's commit sequence; `None` when every request in it conflicted.
//!     pub sequence: Option<u64>,
//!     pub taken: usize,
//!     pub accepted: usize,
//!     pub conflicts: usize,
//! }
//! ```
//!
//! `Box<dyn KvWrite>` is `Send`, so the driver commits each transaction on a helper thread and waits until
//! `queued_commits()` shows the request landed before it takes its next step; that fixes the arrival order, and with it the
//! batch, from the seed. Until the seam lands, `optimistic_driver::seam` is a test-only stub with exactly these
//! signatures, so `cargo clippy --all-targets --features sim -- -D warnings` and `cargo test --features sim --no-run`
//! typecheck the driver. When the real methods land they shadow the stub (inherent methods win); delete `seam`, then
//! remove the `#[ignore]` from `p_a_optimistic_store_replays_serially_by_seed` and run
//! `cargo test -p gbrain-store --features sim --test multi_writer_sim`.

mod common;

use common::clock;
use gbrain_sim::check::{
    self, Committed, Model, Own, ReadObs, Reopen, WriteSet, apply_writes, merge_range,
};
use gbrain_sim::seed::seeds;
use gbrain_sim::{CrashMode, Cx, FaultPlan, Scheduler, SimDisk, SimFile, SimRng, Step, Task};
use gbrain_store::error::WRITE_CONFLICT;
use gbrain_store::occ_kv::OccKv;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{Env, FileBackend, Kv, KvWrite, OpenOptions, Store, StoreError};
use std::collections::{BTreeMap, BTreeSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};

const FILE: &str = "brain.redb";
const HOT: usize = 8;
const ROWS: &[u8] = b"p/";
const ROWS_END: &[u8] = b"p0";

// ---- the disk under redb -----------------------------------------------------------------------------------------------

#[derive(Debug)]
struct SimBackend(SimFile);

impl FileBackend for SimBackend {
    fn size(&self) -> std::io::Result<u64> {
        self.0.len()
    }
    fn read_at(&self, offset: u64, out: &mut [u8]) -> std::io::Result<()> {
        self.0.read_at(offset, out)
    }
    fn write_at(&self, offset: u64, data: &[u8]) -> std::io::Result<()> {
        self.0.write_at(offset, data)
    }
    fn set_len(&self, len: u64) -> std::io::Result<()> {
        self.0.set_len(len)
    }
    fn sync(&self) -> std::io::Result<()> {
        self.0.sync()
    }
}

fn open_single(disk: &SimDisk) -> Result<RedbKv, StoreError> {
    RedbKv::open_backend(Box::new(SimBackend(disk.open(FILE))))
}

fn open_optimistic(disk: &SimDisk) -> Result<OccKv, StoreError> {
    OccKv::new(open_single(disk)?)
}

// ---- the workload ------------------------------------------------------------------------------------------------------

fn register(i: usize) -> Vec<u8> {
    format!("r/{i:02}").into_bytes()
}

/// What one transaction does. `Append` reads two registers and appends its id to each (a list append: a lost update or a
/// stale read shows in the lists); `Insert` range-reads the `p/` rows and adds one whose value is the number it saw (a
/// phantom shows in the values).
#[derive(Clone, Debug)]
enum Plan {
    Append(usize, usize),
    Insert,
}

fn gen_plan(rng: &mut SimRng) -> Plan {
    if rng.chance(200) {
        Plan::Insert
    } else {
        let a = rng.below(HOT);
        Plan::Append(a, (a + 1 + rng.below(HOT - 1)) % HOT)
    }
}

/// One attempt of `plan` in `tx`: the reads it made and the writes it staged.
fn attempt(
    tx: &mut dyn KvWrite,
    id: u64,
    plan: &Plan,
) -> Result<(Vec<ReadObs>, WriteSet), StoreError> {
    let (mut reads, mut writes) = (Vec::new(), WriteSet::new());
    match plan {
        Plan::Append(a, b) => {
            for &i in &[*a, *b] {
                let key = register(i);
                let before = tx.get(&key)?;
                reads.push(ReadObs::Point {
                    key: key.clone(),
                    value: before.clone(),
                });
                let mut list = before.unwrap_or_default();
                list.extend_from_slice(&id.to_le_bytes());
                tx.put(&key, &list)?;
                writes.push((key, Some(list)));
            }
        }
        Plan::Insert => {
            let mut rows = Vec::new();
            tx.scan(ROWS, ROWS_END, false, &mut |k, v| {
                rows.push((k.to_vec(), v.to_vec()));
                true
            })?;
            let key = format!("p/{id:016x}").into_bytes();
            let value = (rows.len() as u64).to_le_bytes().to_vec();
            reads.push(ReadObs::Range {
                start: ROWS.to_vec(),
                end: ROWS_END.to_vec(),
                limit: usize::MAX,
                own: Own::new(),
                rows,
            });
            tx.put(&key, &value)?;
            writes.push((key, Some(value)));
        }
    }
    Ok((reads, writes))
}

/// The registers and rows the store holds.
fn stored(kv: &dyn Kv) -> Result<Model, StoreError> {
    let read = kv.snapshot()?;
    let mut model = Model::new();
    for (start, end) in [(b"r/".as_slice(), b"r0".as_slice()), (ROWS, ROWS_END)] {
        read.scan(start, end, false, &mut |k, v| {
            model.insert(k.to_vec(), v.to_vec());
            true
        })?;
    }
    Ok(model)
}

// ---- the batch-aware checker -------------------------------------------------------------------------------------------

/// One acknowledged transaction: its commit sequence, its index inside the batch when the store reports one, and what it
/// read and wrote.
#[derive(Clone, Debug)]
struct Entry {
    sequence: u64,
    index: Option<u32>,
    txn: Committed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Checked {
    batches: usize,
    txns: usize,
    reads: usize,
    largest_batch: usize,
}

fn entries(committed: &[Committed]) -> Vec<Entry> {
    committed
        .iter()
        .map(|c| Entry {
            sequence: c.version,
            index: None,
            txn: c.clone(),
        })
        .collect()
}

fn writes_key(t: &Committed, key: &[u8]) -> bool {
    t.writes.iter().any(|(k, _)| k == key)
}

/// Whether `a` reads something `b` writes: then `a` must replay before `b`.
fn reads_before(a: &Committed, b: &Committed) -> bool {
    a.reads.iter().any(|r| match r {
        ReadObs::Point { key, .. } => writes_key(b, key),
        ReadObs::Range { start, end, .. } => b.writes.iter().any(|(k, _)| k >= start && k < end),
    })
}

/// The order a batch replays in. With indices: index order (and the indices must be distinct). Without: a topological order
/// in which no transaction reads a key an earlier one of the batch writes; none exists when they read each other's writes.
fn batch_order<'a>(batch: &[&'a Entry]) -> Result<Vec<&'a Entry>, String> {
    if batch.iter().all(|e| e.index.is_some()) {
        let mut ordered = batch.to_vec();
        ordered.sort_by_key(|e| e.index);
        if ordered.windows(2).any(|w| w[0].index == w[1].index) {
            return Err("two transactions share a (sequence, index) position".into());
        }
        return Ok(ordered);
    }
    let n = batch.len();
    let mut after: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut waiting = vec![0usize; n];
    for a in 0..n {
        for b in 0..n {
            if a != b && reads_before(&batch[a].txn, &batch[b].txn) {
                after[a].push(b);
                waiting[b] += 1;
            }
        }
    }
    let mut ready: Vec<usize> = (0..n).filter(|&i| waiting[i] == 0).collect();
    let mut order = Vec::with_capacity(n);
    while let Some(i) = ready.pop() {
        order.push(batch[i]);
        for &j in &after[i] {
            waiting[j] -= 1;
            if waiting[j] == 0 {
                ready.push(j);
            }
        }
    }
    if order.len() != n {
        return Err(format!(
            "a batch of {n} has no serial order: its transactions read each other's writes"
        ));
    }
    Ok(order)
}

/// Replays the acknowledged transactions batch by batch. Every read must return exactly the replayed state, and the commit
/// sequences must run on without a gap. Returns the final state and what it looked at.
fn check_batches(history: &[Entry]) -> Result<(Model, Checked), String> {
    let mut by_sequence: BTreeMap<u64, Vec<&Entry>> = BTreeMap::new();
    for e in history {
        by_sequence.entry(e.sequence).or_default().push(e);
    }
    let (mut model, mut seen, mut last) = (Model::new(), Checked::default(), None);
    for (sequence, batch) in &by_sequence {
        if let Some(prev) = last
            && *sequence != prev + 1
        {
            return Err(format!(
                "commit sequence jumps from {prev} to {sequence}: a batch was acknowledged to nobody"
            ));
        }
        last = Some(*sequence);
        for t in batch_order(batch).map_err(|e| format!("at sequence {sequence}: {e}"))? {
            for r in &t.txn.reads {
                seen.reads += 1;
                match r {
                    ReadObs::Point { key, value } => {
                        if model.get(key) != value.as_ref() {
                            return Err(format!(
                                "at sequence {sequence}: a transaction read a stale {}",
                                String::from_utf8_lossy(key)
                            ));
                        }
                    }
                    ReadObs::Range {
                        start,
                        end,
                        limit,
                        own,
                        rows,
                    } => {
                        if &merge_range(&model, own, start, end, *limit) != rows {
                            return Err(format!(
                                "at sequence {sequence}: a transaction saw {} rows, the replay has a different range",
                                rows.len()
                            ));
                        }
                    }
                }
            }
            apply_writes(&mut model, &t.txn.writes);
            seen.txns += 1;
        }
        seen.batches += 1;
        seen.largest_batch = seen.largest_batch.max(batch.len());
    }
    Ok((model, seen))
}

/// A recovered state must be the replay up to a whole commit sequence: never half a batch.
fn check_state_is_a_batch_prefix(history: &[Entry], state: &Model) -> Result<u64, String> {
    let sequences: BTreeSet<u64> = history.iter().map(|e| e.sequence).collect();
    let mut candidates = vec![0];
    candidates.extend(sequences);
    for &upto in &candidates {
        let mut model = Model::new();
        let mut batch: Vec<&Entry> = history.iter().filter(|e| e.sequence <= upto).collect();
        batch.sort_by_key(|e| e.sequence);
        for e in batch {
            apply_writes(&mut model, &e.txn.writes);
        }
        if &model == state {
            return Ok(upto);
        }
    }
    Err("the state is the replay up to no whole batch: half a batch is applied".into())
}

// ---- the checker's controls ---------------------------------------------------------------------------------------------

fn put(k: &str, v: &str) -> (Vec<u8>, Option<Vec<u8>>) {
    (k.as_bytes().to_vec(), Some(v.as_bytes().to_vec()))
}

fn point(k: &str, v: Option<&str>) -> ReadObs {
    ReadObs::Point {
        key: k.as_bytes().to_vec(),
        value: v.map(|v| v.as_bytes().to_vec()),
    }
}

fn txn(sequence: u64, index: Option<u32>, reads: Vec<ReadObs>, writes: WriteSet) -> Entry {
    Entry {
        sequence,
        index,
        txn: Committed {
            snapshot: sequence.saturating_sub(1),
            version: sequence,
            reads,
            writes,
        },
    }
}

/// A same-sequence batch of three, in index order, followed by a transaction that reads all three results.
fn valid_batch_history() -> Vec<Entry> {
    vec![
        txn(1, Some(0), vec![point("a", None)], vec![put("a", "1")]),
        txn(1, Some(1), vec![point("b", None)], vec![put("b", "2")]),
        txn(1, Some(2), vec![], vec![put("c", "3")]),
        txn(
            2,
            Some(0),
            vec![
                point("a", Some("1")),
                point("b", Some("2")),
                point("c", Some("3")),
            ],
            vec![put("d", "4")],
        ),
    ]
}

#[test]
fn the_checker_accepts_a_same_sequence_batch_and_reads_something() {
    let (model, seen) = check_batches(&valid_batch_history()).unwrap();
    assert_eq!(
        (seen.batches, seen.txns, seen.largest_batch),
        (2, 4, 3),
        "{seen:?}"
    );
    assert!(seen.reads >= 5, "the history holds no reads: {seen:?}");
    assert_eq!(model.len(), 4);
    // Without indices the same batch is replayed in an order that exists.
    let unindexed: Vec<Entry> = valid_batch_history()
        .into_iter()
        .map(|e| Entry { index: None, ..e })
        .collect();
    assert!(check_batches(&unindexed).is_ok());
    // A blind write in the same batch as a reader of that key is a valid batch: the reader replays first.
    let reader_then_writer = vec![
        txn(1, None, vec![point("x", None)], vec![put("y", "1")]),
        txn(1, None, vec![], vec![put("x", "2")]),
    ];
    assert!(check_batches(&reader_then_writer).is_ok());
}

#[test]
fn the_checker_rejects_a_stale_read() {
    let mut h = valid_batch_history();
    // A later transaction that still sees `a` empty although the first batch wrote it.
    h.push(txn(3, Some(0), vec![point("a", None)], vec![put("e", "5")]));
    let err = check_batches(&h).unwrap_err();
    assert!(err.contains("stale"), "{err}");
}

#[test]
fn the_checker_rejects_a_stale_range_read() {
    let row = |n: u64| put(&format!("p/{n:016x}"), "x");
    let scan = |rows: Vec<(Vec<u8>, Vec<u8>)>| ReadObs::Range {
        start: ROWS.to_vec(),
        end: ROWS_END.to_vec(),
        limit: usize::MAX,
        own: Own::new(),
        rows,
    };
    let h = vec![
        txn(1, Some(0), vec![scan(vec![])], vec![row(1)]),
        // A phantom: this insert still saw no rows.
        txn(2, Some(0), vec![scan(vec![])], vec![row(2)]),
    ];
    assert!(check_batches(&h).unwrap_err().contains("rows"));
    // The same two inserts in one batch read each other's range: no serial order.
    let h = vec![
        txn(1, None, vec![scan(vec![])], vec![row(1)]),
        txn(1, None, vec![scan(vec![])], vec![row(2)]),
    ];
    assert!(check_batches(&h).unwrap_err().contains("no serial order"));
}

#[test]
fn the_checker_rejects_a_partial_batch() {
    // The batch at sequence 1 had two members; the later reader saw both. With one member missing from the history
    // (a partial batch), the reader's read of the missing member's write matches nothing.
    let full = valid_batch_history();
    let partial: Vec<Entry> = full
        .iter()
        .filter(|e| !writes_key(&e.txn, b"b"))
        .cloned()
        .collect();
    let err = check_batches(&partial).unwrap_err();
    assert!(err.contains("stale"), "{err}");
    // A recovered state with only part of a batch applied is no whole-batch prefix.
    let state = |pairs: &[(&str, &str)]| -> Model {
        pairs
            .iter()
            .map(|(k, v)| (k.as_bytes().to_vec(), v.as_bytes().to_vec()))
            .collect()
    };
    assert_eq!(check_state_is_a_batch_prefix(&full, &state(&[])), Ok(0));
    let whole = state(&[("a", "1"), ("b", "2"), ("c", "3")]);
    assert_eq!(check_state_is_a_batch_prefix(&full, &whole), Ok(1));
    let half = state(&[("a", "1"), ("c", "3")]);
    assert!(check_state_is_a_batch_prefix(&full, &half).is_err());
}

#[test]
fn the_checker_rejects_a_wrong_index_order_a_gap_and_a_repeated_position() {
    // Index order is the commit order: the reader at index 0 sees `x` empty, so it cannot come after the writer.
    let in_order = vec![
        txn(1, Some(0), vec![point("x", None)], vec![put("y", "1")]),
        txn(1, Some(1), vec![], vec![put("x", "2")]),
    ];
    assert!(check_batches(&in_order).is_ok());
    let swapped = vec![
        txn(1, Some(1), vec![point("x", None)], vec![put("y", "1")]),
        txn(1, Some(0), vec![], vec![put("x", "2")]),
    ];
    assert!(check_batches(&swapped).unwrap_err().contains("stale"));
    // A gap in the commit sequence.
    let gap = vec![
        txn(1, Some(0), vec![], vec![put("a", "1")]),
        txn(3, Some(0), vec![point("a", Some("1"))], vec![]),
    ];
    assert!(check_batches(&gap).unwrap_err().contains("jumps"));
    // Two transactions at one (sequence, index).
    let repeated = vec![
        txn(1, Some(0), vec![], vec![put("a", "1")]),
        txn(1, Some(0), vec![], vec![put("b", "2")]),
    ];
    assert!(check_batches(&repeated).unwrap_err().contains("share"));
    // Write skew inside one batch: each reads what the other writes.
    let skew = vec![
        txn(1, None, vec![point("x", None)], vec![put("y", "1")]),
        txn(1, None, vec![point("y", None)], vec![put("x", "1")]),
    ];
    assert!(
        check_batches(&skew)
            .unwrap_err()
            .contains("no serial order")
    );
}

// ---- P-A on the single-writer store: the seeded scheduler ---------------------------------------------------------------

#[derive(Default)]
struct Log {
    committed: Vec<Committed>,
    in_doubt: Vec<Committed>,
    /// Snapshot reads that matched no commit prefix.
    torn: Vec<String>,
    snapshots_checked: usize,
    stopped: bool,
}

struct World {
    kv: Arc<RedbKv>,
    log: Log,
}

/// A client: each step is one whole transaction (the single-writer store admits one write transaction at a time, so a task
/// that held one open across steps would block the scheduler).
struct Client {
    index: u64,
    next: u64,
}

impl Task<World> for Client {
    fn name(&self) -> &str {
        "client"
    }
    fn ready(&self, world: &World) -> bool {
        !world.log.stopped
    }
    fn step(&mut self, world: &mut World, cx: &mut Cx<'_>) -> Step {
        let plan = gen_plan(cx.rng);
        let id = (self.index << 32) | self.next;
        let snapshot = match world.kv.version() {
            Ok(v) => v,
            Err(_) => {
                world.log.stopped = true;
                return Step::Done;
            }
        };
        let ran = world
            .kv
            .begin_write()
            .and_then(|mut tx| attempt(&mut *tx, id, &plan).map(|(r, w)| (tx, r, w)));
        let (tx, reads, writes) = match ran {
            Ok(ran) => ran,
            Err(_) => {
                world.log.stopped = true;
                return Step::Done;
            }
        };
        let mut c = Committed {
            snapshot,
            version: snapshot + 1,
            reads,
            writes,
        };
        match tx.commit() {
            Ok(version) => {
                c.version = version;
                world.log.committed.push(c);
                self.next += 1;
                Step::Continue
            }
            Err(_) => {
                // The disk failed under the commit: it may or may not have landed.
                world.log.in_doubt.push(c);
                world.log.stopped = true;
                Step::Done
            }
        }
    }
}

/// A reader: takes a snapshot in one step and, in a later step (after other commits), reads all of it and compares it with
/// the replay to the version it was taken at: a read that mixed two commits is torn.
struct Reader {
    held: Option<(Box<dyn gbrain_store::KvRead + Send>, u64)>,
}

impl Task<World> for Reader {
    fn name(&self) -> &str {
        "reader"
    }
    fn ready(&self, world: &World) -> bool {
        !world.log.stopped
    }
    fn step(&mut self, world: &mut World, _cx: &mut Cx<'_>) -> Step {
        match self.held.take() {
            None => match world.kv.versioned_snapshot() {
                Ok(held) => self.held = Some(held),
                Err(_) => return Step::Done,
            },
            Some((snapshot, version)) => {
                let mut state = Model::new();
                for (start, end) in [(b"r/".as_slice(), b"r0".as_slice()), (ROWS, ROWS_END)] {
                    let scanned = snapshot.scan(start, end, false, &mut |k, v| {
                        state.insert(k.to_vec(), v.to_vec());
                        true
                    });
                    if scanned.is_err() {
                        return Step::Done;
                    }
                }
                world.log.snapshots_checked += 1;
                if let Err(v) = check::check_snapshot(&state, &world.log.committed, version) {
                    world.log.torn.push(v.message);
                }
            }
        }
        Step::Continue
    }
}

fn run_scheduled(seed: u64, disk: &SimDisk, steps: u64) -> World {
    let kv = Arc::new(open_single(disk).unwrap());
    let mut world = World {
        kv,
        log: Log::default(),
    };
    let mut scheduler = Scheduler::new(seed);
    for index in 0..3 {
        scheduler.spawn(Box::new(Client { index, next: 0 }));
    }
    scheduler.spawn(Box::new(Reader { held: None }));
    scheduler.run(&mut world, steps, |w| w.log.stopped);
    world
}

fn history_of(committed: &[Committed]) -> Vec<Entry> {
    entries(committed)
}

/// P-A: any generated interleaving of the clients, replayed in commit order, reproduces every read; no snapshot read is
/// torn; the history rebuilds the store.
#[test]
fn p_a_single_writer_interleavings_replay_serially() {
    let (mut commits, mut reads, mut snapshots) = (0, 0, 0);
    for seed in seeds(60) {
        let disk = SimDisk::new(seed, FaultPlan::none());
        let world = run_scheduled(seed, &disk, 120);
        let log = &world.log;
        assert!(!log.stopped && log.in_doubt.is_empty(), "seed {seed}");
        assert!(log.torn.is_empty(), "seed {seed}: {:?}", log.torn);
        let model = check::check_serializable(&log.committed)
            .unwrap_or_else(|v| panic!("seed {seed}: {}", v.message));
        let (replayed, seen) = check_batches(&history_of(&log.committed))
            .unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        assert_eq!(model, replayed, "seed {seed}: the two checkers disagree");
        assert_eq!(
            replayed,
            stored(&*world.kv).unwrap(),
            "seed {seed}: the history does not rebuild the store"
        );
        assert_eq!(world.kv.version().unwrap(), log.committed.len() as u64);
        commits += log.committed.len();
        reads += seen.reads;
        snapshots += log.snapshots_checked;
    }
    eprintln!(
        "P-A single writer: {commits} commits, {reads} reads, {snapshots} snapshot reads checked"
    );
    assert!(commits > 0 && reads > 0 && snapshots > 0);
}

/// A recorded history with one read changed must fail both checkers: the checker is not blind.
#[test]
fn p_a_the_checkers_fail_a_history_with_a_tampered_read() {
    let disk = SimDisk::new(11, FaultPlan::none());
    let world = run_scheduled(11, &disk, 120);
    let mut committed = world.log.committed.clone();
    assert!(check::check_serializable(&committed).is_ok());
    let victim = committed
        .iter_mut()
        .rev()
        .find(|c| {
            c.reads
                .iter()
                .any(|r| matches!(r, ReadObs::Point { value: Some(_), .. }))
        })
        .expect("a transaction that read a register with a value");
    for r in victim.reads.iter_mut() {
        if let ReadObs::Point { value, .. } = r {
            *value = None;
        }
    }
    assert!(check::check_serializable(&committed).is_err());
    assert!(check_batches(&history_of(&committed)).is_err());
}

// ---- P-H: a crash keeps every acknowledged commit and the in-doubt batch whole -------------------------------------------

#[derive(Default, Debug)]
struct Tally {
    histories: usize,
    commits: usize,
    reads: usize,
    crashes: usize,
    in_doubt_applied: usize,
    in_doubt_dropped: usize,
    violations: Vec<String>,
}

/// The crash plan of a seed: where the disk stops, how it loses its cache, and whether fsyncs also fail.
fn crash_plan(seed: u64, setup_ops: u64) -> FaultPlan {
    let mut rng = SimRng::new(seed ^ 0xC7A5_0000);
    let modes = [
        CrashMode::DropUnsynced,
        CrashMode::TearLast,
        CrashMode::Subset,
    ];
    FaultPlan {
        fsync_error_pm: if seed % 2 == 1 {
            5 + rng.below(40) as u32
        } else {
            0
        },
        fsync_lie_pm: 0,
        crash_at_op: Some(setup_ops + 1 + rng.below(260) as u64),
        crash_mode: modes[rng.below(modes.len())],
    }
}

/// How a store reopens a crashed disk: its commit version and the state it holds.
type Reopener<'a> = &'a dyn Fn(&SimDisk) -> Result<(u64, Model), StoreError>;

/// Reopens the crashed disk and judges the recovered store against the history.
fn judge_recovery(
    disk: &SimDisk,
    acked: &[Committed],
    in_doubt: &[Committed],
    reopen_as: Reopener<'_>,
    tally: &mut Tally,
    label: &str,
) {
    disk.reboot();
    disk.set_plan(FaultPlan::none());
    let reopened = match catch_unwind(AssertUnwindSafe(|| reopen_as(disk))) {
        Ok(Ok((version, state))) => Reopen::Opened { version, state },
        Ok(Err(e)) => Reopen::Refused(e.to_string()),
        Err(_) => Reopen::Panicked("reopen panicked".into()),
    };

    let (violations, applied) = recovery_violations(acked, in_doubt, &reopened);
    for v in violations {
        tally.violations.push(format!("{label}: {v}"));
    }
    match applied {
        Some(true) => tally.in_doubt_applied += 1,
        Some(false) => tally.in_doubt_dropped += 1,
        None => {}
    }
}

/// The verdict on a recovered store: the violations, and (when there was an in-doubt batch and the store opened) whether the batch
/// was applied. Pure, so a control can feed it a state.
fn recovery_violations(
    acked: &[Committed],
    in_doubt: &[Committed],
    reopened: &Reopen,
) -> (Vec<String>, Option<bool>) {
    let mut violations: Vec<String> = check::check_recovery(acked, in_doubt, false, reopened)
        .violations
        .into_iter()
        .map(|v| v.message)
        .collect();
    let mut applied = None;
    // The recovered state must also be a whole-batch prefix of the acknowledged history plus the in-doubt batch.
    if let Reopen::Opened { state, .. } = reopened {
        let mut all = entries(acked);
        all.extend(entries(in_doubt));
        match check_state_is_a_batch_prefix(&all, state) {
            Ok(upto) => {
                let acked_max = acked.iter().map(|c| c.version).max().unwrap_or(0);
                if !in_doubt.is_empty() {
                    applied = Some(upto > acked_max);
                }
                // When recovery includes the in-doubt batch, its reads and writes are validated together with the acknowledged
                // prefix (a serial replay), and that replay must be the state on disk.
                if upto > acked_max && !in_doubt.is_empty() {
                    let included: Vec<Entry> =
                        all.iter().filter(|e| e.sequence <= upto).cloned().collect();
                    match check_batches(&included) {
                        Ok((replayed, _)) if &replayed != state => violations.push(
                            "the serial replay of the acknowledged prefix and the in-doubt batch is not the state on disk".into(),
                        ),
                        Ok(_) => {}
                        Err(e) => violations.push(format!("the recovered in-doubt batch is not serializable: {e}")),
                    }
                }
            }
            Err(e) => violations.push(e),
        }
    }
    (violations, applied)
}

fn tally_history(acked: &[Committed], tally: &mut Tally, label: &str) {
    match check_batches(&entries(acked)) {
        Ok((_, seen)) => {
            tally.commits += seen.txns;
            tally.reads += seen.reads;
        }
        Err(e) => tally.violations.push(format!(
            "{label}: the acknowledged history is not serializable: {e}"
        )),
    }
}

/// One P-H run on the single-writer store: seeded clients on the scheduler, a crash at the seeded op.
fn p_h_single(seed: u64, tally: &mut Tally) {
    let label = format!("single seed {seed}");
    let disk = SimDisk::new(seed, FaultPlan::none());
    let kv = Arc::new(open_single(&disk).unwrap());
    let setup = disk.stats().io_ops;
    disk.set_plan(crash_plan(seed, setup));
    let mut world = World {
        kv,
        log: Log::default(),
    };
    let mut scheduler = Scheduler::new(seed);
    for index in 0..3 {
        scheduler.spawn(Box::new(Client { index, next: 0 }));
    }
    scheduler.run(&mut world, 120, |w| w.log.stopped);
    tally.crashes += usize::from(disk.is_crashed());
    disk.crash_now();
    let (acked, in_doubt) = (world.log.committed.clone(), world.log.in_doubt.clone());
    drop(world);
    tally.histories += 1;
    tally_history(&acked, tally, &label);
    judge_recovery(
        &disk,
        &acked,
        &in_doubt,
        &|disk| {
            let kv = open_single(disk)?;
            Ok((kv.version()?, stored(&kv)?))
        },
        tally,
        &label,
    );
}

/// One P-H run on the optimistic store: four writer threads (the workload is the seed's; the interleaving is the
/// operating system's), a crash at the seeded op.
fn p_h_optimistic(seed: u64, tally: &mut Tally) {
    const WRITER_THREADS: usize = 4;
    const PER_WRITER: u64 = 12;
    let label = format!("optimistic seed {seed}");
    let disk = SimDisk::new(seed, FaultPlan::none());
    let kv = open_optimistic(&disk).unwrap();
    let setup = disk.stats().io_ops;
    disk.set_plan(crash_plan(seed, setup));
    let history = Mutex::new((Vec::<Committed>::new(), Vec::<Committed>::new()));
    std::thread::scope(|s| {
        for thread in 0..WRITER_THREADS {
            let (kv, history) = (&kv, &history);
            s.spawn(move || {
                let mut rng = SimRng::new(seed).fork(thread as u64 + 1);
                for n in 0..PER_WRITER {
                    let id = ((thread as u64) << 32) | n;
                    let plan = gen_plan(&mut rng);
                    for _try in 0..500 {
                        let ran = kv.begin_write().and_then(|mut tx| {
                            attempt(&mut *tx, id, &plan).map(|(r, w)| (tx, r, w))
                        });
                        let (tx, reads, writes) = match ran {
                            Ok(ran) => ran,
                            Err(_) => return,
                        };
                        let mut c = Committed {
                            snapshot: 0,
                            version: 0,
                            reads,
                            writes,
                        };
                        match tx.commit() {
                            Ok(version) => {
                                c.version = version;
                                history.lock().unwrap().0.push(c);
                                break;
                            }
                            Err(e) if e.code == WRITE_CONFLICT => std::thread::yield_now(),
                            Err(e) => {
                                // A failed record-file commit leaves the batch in doubt; anything else stopped before it.
                                if e.message.starts_with("record store commit failed") {
                                    history.lock().unwrap().1.push(c);
                                }
                                return;
                            }
                        }
                    }
                }
            });
        }
    });
    tally.crashes += usize::from(disk.is_crashed());
    disk.crash_now();
    drop(kv);
    let (acked, mut in_doubt) = history.into_inner().unwrap();
    // The in-doubt batch is the one after the last acknowledged sequence.
    let next = acked.iter().map(|c| c.version).max().unwrap_or(0) + 1;
    for c in &mut in_doubt {
        c.version = next;
    }
    tally.histories += 1;
    tally_history(&acked, tally, &label);
    judge_recovery(
        &disk,
        &acked,
        &in_doubt,
        &|disk| {
            let kv = open_optimistic(disk)?;
            Ok((kv.version()?, stored(&kv)?))
        },
        tally,
        &label,
    );
}

fn run_p_h(label: &str, default_seeds: u64, one: fn(u64, &mut Tally)) {
    let mut tally = Tally::default();
    let started = std::time::Instant::now();
    for seed in seeds(default_seeds) {
        one(seed, &mut tally);
        if !tally.violations.is_empty() {
            break;
        }
    }
    eprintln!(
        "P-H {label}: {} histories executed, {} commits checked, {} reads checked, {} crashes hit, in-doubt batch applied {} / dropped {}, {:?}",
        tally.histories,
        tally.commits,
        tally.reads,
        tally.crashes,
        tally.in_doubt_applied,
        tally.in_doubt_dropped,
        started.elapsed()
    );
    assert!(
        tally.violations.is_empty(),
        "P-H {label}: {:#?}\nrepro: GBRAIN_SIM_SEED=<seed> cargo test -p gbrain-store --test multi_writer_sim p_h",
        tally.violations
    );
    assert!(tally.histories > 0, "P-H {label}: no history was executed");
    assert!(tally.commits > 0, "P-H {label}: no commit was checked");
    assert!(tally.reads > 0, "P-H {label}: no read was checked");
    assert!(tally.crashes > 0, "P-H {label}: no seed crashed mid-run");
}

#[test]
fn p_h_single_writer_crash_keeps_every_acknowledged_commit_and_the_in_doubt_batch_whole() {
    run_p_h("single writer", 200, p_h_single);
}

#[test]
fn p_h_optimistic_crash_keeps_every_acknowledged_commit_and_the_in_doubt_batch_whole() {
    run_p_h("optimistic", 200, p_h_optimistic);
}

/// P-H, the in-doubt batch: two writers both read register `r/00` as empty and append their own id; only the last append is on disk.
/// The disk image is the replay of their writes, but no serial order of the two gives both reads, so a recovery that includes the
/// batch must be rejected: the acknowledged prefix and the in-doubt batch are validated together, reads included.
#[test]
fn p_h_a_non_serializable_in_doubt_batch_that_reached_disk_is_rejected() {
    let append = |id: u64| Committed {
        snapshot: 0,
        version: 1,
        reads: vec![ReadObs::Point {
            key: b"r/00".to_vec(),
            value: None,
        }],
        writes: vec![(b"r/00".to_vec(), Some(id.to_le_bytes().to_vec()))],
    };
    let in_doubt = vec![append(1), append(2)];
    // The write replay of the batch: the second append overwrote the first.
    let on_disk: Model = [(b"r/00".to_vec(), 2u64.to_le_bytes().to_vec())].into();
    let opened = Reopen::Opened {
        version: 1,
        state: on_disk,
    };
    let (violations, applied) = recovery_violations(&[], &in_doubt, &opened);
    assert_eq!(applied, Some(true), "the batch is on disk");
    assert!(
        violations.iter().any(|v| v.contains("no serial order")),
        "a non-serializable in-doubt batch on disk was accepted: {violations:?}"
    );
    // A serial order is accepted: the acknowledged append, then an in-doubt append that read it.
    let both = [1u64.to_le_bytes(), 2u64.to_le_bytes()].concat();
    let acked = vec![append(1)];
    let after = Committed {
        snapshot: 1,
        version: 2,
        reads: vec![ReadObs::Point {
            key: b"r/00".to_vec(),
            value: Some(1u64.to_le_bytes().to_vec()),
        }],
        writes: vec![(b"r/00".to_vec(), Some(both.clone()))],
    };
    let state: Model = [(b"r/00".to_vec(), both)].into();
    let (violations, applied) =
        recovery_violations(&acked, &[after], &Reopen::Opened { version: 2, state });
    assert_eq!(applied, Some(true));
    assert!(violations.is_empty(), "{violations:?}");
    // An in-doubt batch that did NOT reach disk is not judged on its reads (it never happened).
    let (violations, applied) = recovery_violations(
        &[],
        &in_doubt,
        &Reopen::Opened {
            version: 0,
            state: Model::new(),
        },
    );
    assert_eq!(applied, Some(false));
    assert!(violations.is_empty(), "{violations:?}");
}

/// The recovery checker must fail what it claims to: an acknowledged commit missing after the reopen, and half of the
/// in-doubt batch applied.
#[test]
fn p_h_the_recovery_checkers_fail_a_lost_commit_and_a_half_applied_batch() {
    let c = |version, writes: WriteSet| Committed {
        snapshot: version - 1,
        version,
        reads: vec![],
        writes,
    };
    let acked = vec![c(1, vec![put("r/00", "1")]), c(2, vec![put("r/01", "2")])];
    let in_doubt = vec![c(3, vec![put("r/02", "3")]), c(3, vec![put("r/03", "4")])];
    let state = |pairs: &[(&str, &str)]| -> Model {
        pairs
            .iter()
            .map(|(k, v)| (k.as_bytes().to_vec(), v.as_bytes().to_vec()))
            .collect()
    };
    let opened = |version, pairs: &[(&str, &str)]| Reopen::Opened {
        version,
        state: state(pairs),
    };
    let judge = |r: Reopen| check::check_recovery(&acked, &in_doubt, false, &r).violations;
    // Whole outcomes pass: the acknowledged commits alone, or those plus the whole batch.
    assert!(judge(opened(2, &[("r/00", "1"), ("r/01", "2")])).is_empty());
    let all = [("r/00", "1"), ("r/01", "2"), ("r/02", "3"), ("r/03", "4")];
    assert!(judge(opened(3, &all)).is_empty());
    // Commit 2 lost after the reopen.
    let lost = judge(opened(1, &[("r/00", "1")]));
    assert!(
        lost.iter().any(|v| v.class == check::Class::Lost),
        "{lost:?}"
    );
    // Half the in-doubt batch: the state of version 3 with one member missing is not the replay of anything.
    let half = judge(opened(3, &[("r/00", "1"), ("r/01", "2"), ("r/02", "3")]));
    assert!(!half.is_empty(), "half a batch passed the recovery check");
    let mut full = entries(&acked);
    full.extend(entries(&in_doubt));
    assert!(
        check_state_is_a_batch_prefix(
            &full,
            &state(&[("r/00", "1"), ("r/01", "2"), ("r/02", "3")])
        )
        .is_err()
    );
}

// ---- P-H, I-4.v2 clocks: commit times after a crash -------------------------------------------------------------------

/// A clock that moves forward by a fixed step each time it is read, and ids from a counter: the store's `Env` on the
/// simulated disk.
struct TickEnv {
    now: std::sync::atomic::AtomicI64,
    ids: std::sync::atomic::AtomicU64,
}

impl Env for TickEnv {
    fn now_micros(&self) -> i64 {
        self.now
            .fetch_add(1_000, std::sync::atomic::Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        gbrain_store::env::uuid_from_bytes(bytes)
    }
}

/// A whole store (not just its record file) on the simulated disk, on the optimistic record file.
fn open_store(disk: &SimDisk) -> Result<Store, StoreError> {
    let env = TickEnv {
        now: std::sync::atomic::AtomicI64::new(1_800_000_000_000_000),
        ids: std::sync::atomic::AtomicU64::new(1),
    };
    Store::open_kv(
        Arc::new(open_optimistic(disk)?),
        Arc::new(env),
        OpenOptions {
            concurrent_writes: true,
            ..OpenOptions::default()
        },
    )
}

/// P-H with commit times: after a crash at a seeded point and a reopen, the commit times in the log strictly rise in position
/// order and the newest equals `last_commit_time()`. Pending on the commit log (I-4.v2).
#[test]
#[ignore = "multi_writer"]
fn pending_crash_keeps_commit_times_rising_and_equal_to_last_commit_time_multi_writer() {
    {
        let disk = SimDisk::new(0, FaultPlan::none());
        let fresh = open_store(&disk).unwrap();
        fresh
            .read_commit_log(None, 1)
            .unwrap_or_else(|e| panic!("{e}"));
    }
    let mut checked = 0;
    for seed in seeds(50) {
        let disk = SimDisk::new(seed, FaultPlan::none());
        let store = Arc::new(open_store(&disk).unwrap());
        let setup = disk.stats().io_ops;
        disk.set_plan(crash_plan(seed, setup));
        std::thread::scope(|s| {
            for thread in 0..4usize {
                let store = &store;
                s.spawn(move || {
                    for n in 0..12 {
                        let page = serde_json::from_value(serde_json::json!({
                            "type": "note", "title": "t", "compiled_truth": format!("{thread} {n}"),
                        }))
                        .unwrap();
                        let options = gbrain_store::pages::PutPageOptions::default();
                        if store
                            .put_page(&format!("p/{thread}-{n}"), &page, &options)
                            .is_err()
                        {
                            return;
                        }
                    }
                });
            }
        });
        disk.crash_now();
        drop(store);
        disk.reboot();
        disk.set_plan(FaultPlan::none());
        let store = open_store(&disk).unwrap();
        let log = store
            .read_commit_log(None, usize::MAX)
            .unwrap_or_else(|e| panic!("{e}"));
        let last = store.last_commit_time().unwrap_or_else(|e| panic!("{e}"));
        clock::replay_clock_checks(&log.records, last, None, &[])
            .unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        checked += log.records.len();
    }
    assert!(checked > 0, "no commit was checked");
}

// ---- the optimistic store under the seeded scheduler (waits for the `step_pipeline()` seam) -------------------------------

/// The seeded driver of the optimistic store: client tasks and a pipeline task on the `gbrain-sim` scheduler, the pipeline
/// advanced one batch at a time through `step_pipeline()`. Compiled only with `--features sim`.
#[cfg(feature = "sim")]
mod optimistic_driver {
    use super::*;
    use std::thread::JoinHandle;

    /// Test-only stand-in for the seam described in the file header, with its exact signatures. It answers `Err` (a typed
    /// "pending" store error) until the optimistic-transaction lane adds the real methods, which shadow these.
    mod seam {
        use super::*;

        pub struct PipelineStep {
            pub sequence: Option<u64>,
            pub taken: usize,
            pub accepted: usize,
            pub conflicts: usize,
        }

        pub trait StepPipeline: Sized {
            fn new_stepped(base: RedbKv) -> Result<Self, StoreError>;
            fn queued_commits(&self) -> usize;
            fn step_pipeline(&self, max_batch: usize) -> Result<Option<PipelineStep>, StoreError>;
        }

        fn pending() -> StoreError {
            StoreError::new(
                "sim_seam_pending",
                "pending on L1 sim seam: OccKv::step_pipeline",
            )
        }

        impl StepPipeline for OccKv {
            fn new_stepped(_base: RedbKv) -> Result<Self, StoreError> {
                Err(pending())
            }
            fn queued_commits(&self) -> usize {
                0
            }
            fn step_pipeline(&self, _max_batch: usize) -> Result<Option<PipelineStep>, StoreError> {
                Err(pending())
            }
        }
    }
    use seam::StepPipeline;

    struct Sim {
        kv: Arc<OccKv>,
        /// Commits handed to the pipeline so far, and how many the steps have taken.
        submitted: usize,
        taken: usize,
        acked: Vec<Entry>,
        conflicts: usize,
        accepted: usize,
        last_sequence: Option<u64>,
        /// Set at the cutoff: clients stop starting new transactions and the pipeline drains what is queued.
        draining: bool,
        stopped: bool,
    }

    /// A transaction on its way through the pipeline: the helper thread blocked in `commit`, and what it read and wrote.
    struct InFlight {
        ticket: usize,
        handle: JoinHandle<Result<u64, StoreError>>,
        reads: Vec<ReadObs>,
        writes: WriteSet,
    }

    struct Client {
        index: u64,
        next: u64,
        plan: Option<Plan>,
        flying: Option<InFlight>,
    }

    impl Task<Sim> for Client {
        fn name(&self) -> &str {
            "client"
        }
        fn ready(&self, sim: &Sim) -> bool {
            !sim.stopped
                && match &self.flying {
                    // While draining, a client with nothing in flight has nothing left to do.
                    None => !sim.draining,
                    // Only once a step has taken its commit (the step has answered it).
                    Some(f) => f.ticket < sim.taken,
                }
        }
        fn step(&mut self, sim: &mut Sim, cx: &mut Cx<'_>) -> Step {
            if let Some(f) = self.flying.take() {
                match f.handle.join().expect("the commit thread panicked") {
                    Ok(sequence) => {
                        sim.acked.push(Entry {
                            sequence,
                            index: None,
                            txn: Committed {
                                snapshot: 0,
                                version: sequence,
                                reads: f.reads,
                                writes: f.writes,
                            },
                        });
                        self.next += 1;
                        self.plan = None;
                    }
                    // The pipeline already counted this conflict; the client only runs the transaction again.
                    Err(e) if e.code == WRITE_CONFLICT => {}
                    Err(_) => {
                        sim.stopped = true;
                        return Step::Done;
                    }
                }
                return Step::Continue;
            }
            if sim.draining {
                return Step::Done;
            }
            let plan = self.plan.get_or_insert_with(|| gen_plan(cx.rng)).clone();
            let id = (self.index << 32) | self.next;
            let begun = sim
                .kv
                .begin_write()
                .and_then(|mut tx| attempt(&mut *tx, id, &plan).map(|(r, w)| (tx, r, w)));
            let Ok((tx, reads, writes)) = begin_or_stop(begun, sim) else {
                return Step::Done;
            };
            let queued = sim.kv.queued_commits();
            let handle = std::thread::spawn(move || tx.commit());
            // The request is in the queue before the next step, so arrival order (and the batch) follows the seed.
            while sim.kv.queued_commits() == queued && !handle.is_finished() {
                std::thread::yield_now();
            }
            self.flying = Some(InFlight {
                ticket: sim.submitted,
                handle,
                reads,
                writes,
            });
            sim.submitted += 1;
            Step::Continue
        }
    }

    fn begin_or_stop<T>(r: Result<T, StoreError>, sim: &mut Sim) -> Result<T, ()> {
        r.map_err(|_| sim.stopped = true)
    }

    /// The pipeline as a task: ready while commits are queued; each step is one batch of a seeded size.
    struct Pipeline;

    impl Task<Sim> for Pipeline {
        fn name(&self) -> &str {
            "pipeline"
        }
        fn ready(&self, sim: &Sim) -> bool {
            !sim.stopped && sim.kv.queued_commits() > 0
        }
        fn step(&mut self, sim: &mut Sim, cx: &mut Cx<'_>) -> Step {
            let max_batch = 1 + cx.rng.below(4);
            match sim.kv.step_pipeline(max_batch) {
                Ok(Some(step)) => {
                    sim.taken += step.taken;
                    sim.accepted += step.accepted;
                    sim.conflicts += step.conflicts;
                    sim.last_sequence = step.sequence.or(sim.last_sequence);
                    Step::Continue
                }
                Ok(None) => Step::Idle,
                Err(_) => {
                    sim.stopped = true;
                    Step::Done
                }
            }
        }
    }

    /// P-A on the optimistic store: any seeded interleaving, replayed batch by batch, reproduces every read, and the
    /// replay is the state the store holds.
    #[test]
    #[ignore = "L1 sim seam"]
    fn p_a_optimistic_store_replays_serially_by_seed() {
        let (mut commits, mut reads, mut largest) = (0, 0, 0);
        for seed in seeds(200) {
            let disk = SimDisk::new(seed, FaultPlan::none());
            let kv = Arc::new(OccKv::new_stepped(open_single(&disk).unwrap()).unwrap());
            let mut sim = Sim {
                kv,
                submitted: 0,
                taken: 0,
                acked: Vec::new(),
                conflicts: 0,
                accepted: 0,
                last_sequence: None,
                draining: false,
                stopped: false,
            };
            let mut scheduler = Scheduler::new(seed);
            for index in 0..4 {
                scheduler.spawn(Box::new(Client {
                    index,
                    next: 0,
                    plan: None,
                    flying: None,
                }));
            }
            scheduler.spawn(Box::new(Pipeline));
            scheduler.run(&mut sim, 400, |s| s.stopped);
            // The cutoff: stop admitting, then step until every queued commit is taken and every client has joined its helper and
            // appended its acknowledgement (or conflict). A batch accepted at the last step is thus counted, never missed.
            sim.draining = true;
            scheduler.run(&mut sim, 400 + 400, |s| s.stopped);
            assert_eq!(
                sim.kv.queued_commits(),
                0,
                "seed {seed}: a commit is still queued after the drain"
            );
            assert_eq!(
                sim.submitted, sim.taken,
                "seed {seed}: a helper is still blocked in the stepped pipeline"
            );
            assert!(!sim.stopped, "seed {seed}: the store stopped");
            let (model, seen) = check_batches(&sim.acked)
                .unwrap_or_else(|e| panic!("seed {seed}: {e}\nrepro: GBRAIN_SIM_SEED={seed}"));
            assert_eq!(model, stored(&*sim.kv).unwrap(), "seed {seed}");
            assert_eq!(
                sim.accepted,
                sim.acked.len(),
                "seed {seed}: the steps accepted another count"
            );
            assert_eq!(
                sim.last_sequence,
                sim.acked.iter().map(|e| e.sequence).max(),
                "seed {seed}"
            );
            commits += seen.txns;
            reads += seen.reads;
            largest = largest.max(seen.largest_batch);
        }
        eprintln!("P-A optimistic: {commits} commits, {reads} reads, largest batch {largest}");
        assert!(commits > 0 && reads > 0, "no history was checked");
        assert!(largest > 1, "no batch held more than one commit");
    }
}
