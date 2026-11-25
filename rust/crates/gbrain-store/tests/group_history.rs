//! Many writers on the single-writer record file with group commit (`group_kv.rs`), checked
//! against their history.
//!
//! The checker is the one `occ_history.rs` runs for the optimistic store (copied here so that file
//! stays its own): 4, 16 or 64 writer threads on one `GroupKv` over a `RedbKv` on the simulated
//! disk, each transaction allocating an id, adding 1 to a counter and either appending to two hot
//! registers or inserting a row whose value is the number of rows it saw. Writes of one group
//! share a commit sequence, so within a group the checker looks for an order in which no write
//! reads a key an earlier one writes; group commit runs the writes of a group one after another,
//! so there is one, and every read must return the replayed state.
//!
//! The crash runs stop the simulated machine at a random write, set_len or fsync (some runs also
//! fail fsyncs), reboot it and reopen the store. Every acknowledged write must be there; the group
//! whose commit was in flight must be there entirely or not at all, and nothing refused after it
//! may be there. A write acknowledged before its group's fsync would be lost by such a crash.

use gbrain_sim::seed::seeds;
use gbrain_sim::{CrashMode, FaultPlan, SimDisk, SimFile, SimRng};
use gbrain_store::error::{STORE_IO, WRITE_CONFLICT};
use gbrain_store::group_kv::GroupKv;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{FileBackend, Kv, StoreError};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;

const FILE: &str = "brain.redb";
const HOT: usize = 12;
const COUNTER: &[u8] = b"n";
const SEQUENCE: &[u8] = b"seq/id";
const ROWS: &[u8] = b"p/";
const ROWS_END: &[u8] = b"p0";
/// Transactions per run, split across the writers.
const TXNS: usize = 384;
const WRITERS: &[usize] = &[4, 16, 64];

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

fn open(disk: &SimDisk) -> Result<GroupKv, StoreError> {
    Ok(GroupKv::new(std::sync::Arc::new(RedbKv::open_backend(
        Box::new(SimBackend(disk.open(FILE))),
    )?)))
}

fn register(i: usize) -> Vec<u8> {
    format!("r/{i:02}").into_bytes()
}

type Model = BTreeMap<Vec<u8>, Vec<u8>>;

#[derive(Clone, Debug)]
enum Read {
    Point(Vec<u8>, Option<Vec<u8>>),
    Rows(Vec<(Vec<u8>, Vec<u8>)>),
}

#[derive(Clone, Debug)]
enum Write {
    Put(Vec<u8>, Vec<u8>),
    Add(Vec<u8>, i64),
}

#[derive(Clone, Debug)]
struct Txn {
    id: u64,
    id_allocated: u64,
    reads: Vec<Read>,
    writes: Vec<Write>,
}

#[derive(Clone, Debug)]
enum Plan {
    Append(Vec<usize>),
    Insert,
}

#[derive(Default)]
struct History {
    /// Acknowledged transactions with their commit sequence.
    acked: Vec<(u64, Txn)>,
    /// The transactions of the batch whose record-file commit failed: in doubt.
    in_doubt: Vec<Txn>,
    /// Transactions refused without reaching the record file (after the failed batch, or an
    /// I/O error before commit).
    refused: Vec<Txn>,
    /// Every id handed out, by every attempt.
    ids: Vec<u64>,
    gave_up: usize,
    conflicts: usize,
    /// Errors other than a conflict or an I/O failure: always a failure of the run.
    unexpected: Vec<String>,
}

fn conflict_key(e: &StoreError) -> Option<Vec<u8>> {
    let hex = e.message.strip_prefix("write conflict on key ")?;
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

/// One attempt of `plan`. Returns the transaction as it ran, and the commit's outcome.
fn attempt(
    kv: &GroupKv,
    locked: &BTreeSet<Vec<u8>>,
    id: u64,
    plan: &Plan,
    ids: &mut Vec<u64>,
) -> (Option<Txn>, Result<u64, StoreError>) {
    let begun = if locked.is_empty() {
        kv.begin_write()
    } else {
        kv.begin_write_locked(locked)
    };
    let mut tx = match begun {
        Ok(tx) => tx,
        Err(e) => return (None, Err(e)),
    };
    let ran = (|| -> Result<Txn, StoreError> {
        let id_allocated = tx.allocate(SEQUENCE, 1)?;
        ids.push(id_allocated);
        let mut t = Txn {
            id,
            id_allocated,
            reads: Vec::new(),
            writes: Vec::new(),
        };
        match plan {
            Plan::Append(registers) => {
                for &i in registers {
                    let key = register(i);
                    let before = tx.get(&key)?;
                    t.reads.push(Read::Point(key.clone(), before.clone()));
                    let mut list = before.unwrap_or_default();
                    list.extend_from_slice(&id.to_le_bytes());
                    tx.put(&key, &list)?;
                    t.writes.push(Write::Put(key, list));
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
                t.reads.push(Read::Rows(rows));
                tx.put(&key, &value)?;
                t.writes.push(Write::Put(key, value));
            }
        }
        tx.add_i64(COUNTER, 1)?;
        t.writes.push(Write::Add(COUNTER.to_vec(), 1));
        Ok(t)
    })();
    match ran {
        Ok(t) => (Some(t), tx.commit()),
        Err(e) => (None, Err(e)),
    }
}

fn writer(kv: &GroupKv, seed: u64, thread: usize, txns: usize, history: &Mutex<History>) {
    let mut rng = SimRng::new(seed).fork(thread as u64 + 1);
    let mut local = History::default();
    for n in 0..txns {
        let id = ((thread as u64) << 32) | n as u64;
        let plan = if rng.chance(200) {
            Plan::Insert
        } else {
            let a = rng.below(HOT);
            let b = (a + 1 + rng.below(HOT - 1)) % HOT;
            Plan::Append(vec![a, b])
        };
        let mut locked = BTreeSet::new();
        let mut tries = 0;
        loop {
            tries += 1;
            let (txn, outcome) = attempt(kv, &locked, id, &plan, &mut local.ids);
            match outcome {
                Ok(version) => {
                    local
                        .acked
                        .push((version, txn.expect("a commit ran a transaction")));
                    break;
                }
                Err(e) if e.code == WRITE_CONFLICT => {
                    local.conflicts += 1;
                    if tries >= 1_000 {
                        local.gave_up += 1;
                        break;
                    }
                    if let Some(key) = conflict_key(&e) {
                        locked.insert(key);
                    }
                }
                Err(e) => {
                    if e.code != STORE_IO {
                        local.unexpected.push(e.to_string());
                    }
                    if let Some(t) = txn {
                        if e.message.starts_with("record store commit failed") {
                            local.in_doubt.push(t);
                        } else {
                            local.refused.push(t);
                        }
                    }
                    // The store stopped; this writer stops too.
                    let mut h = history.lock().unwrap();
                    merge(&mut h, local);
                    return;
                }
            }
        }
    }
    merge(&mut history.lock().unwrap(), local);
}

fn merge(into: &mut History, from: History) {
    into.acked.extend(from.acked);
    into.in_doubt.extend(from.in_doubt);
    into.refused.extend(from.refused);
    into.ids.extend(from.ids);
    into.gave_up += from.gave_up;
    into.conflicts += from.conflicts;
    into.unexpected.extend(from.unexpected);
}

fn run_writers(kv: &GroupKv, seed: u64, writers: usize) -> History {
    let history = Mutex::new(History::default());
    let per = TXNS.div_ceil(writers);
    std::thread::scope(|s| {
        for thread in 0..writers {
            let history = &history;
            s.spawn(move || writer(kv, seed, thread, per, history));
        }
    });
    history.into_inner().unwrap()
}

/// Whether every read of `t` returns what `model` holds.
fn reads_match(model: &Model, t: &Txn) -> bool {
    t.reads.iter().all(|r| match r {
        Read::Point(key, value) => model.get(key) == value.as_ref(),
        Read::Rows(rows) => {
            let now: Vec<(Vec<u8>, Vec<u8>)> = model
                .range(ROWS.to_vec()..ROWS_END.to_vec())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            &now == rows
        }
    })
}

fn apply(model: &mut Model, t: &Txn) {
    for w in &t.writes {
        match w {
            Write::Put(k, v) => {
                model.insert(k.clone(), v.clone());
            }
            Write::Add(k, d) => {
                let old = model
                    .get(k)
                    .map(|b| i64::from_le_bytes(b.as_slice().try_into().unwrap()))
                    .unwrap_or(0);
                model.insert(k.clone(), (old + d).to_le_bytes().to_vec());
            }
        }
    }
}

/// A serial order of `left` (indexes into `batch`) from `model` in which every read returns the
/// replayed state; the state after it.
fn serial_order(
    model: &Model,
    batch: &[&Txn],
    left: &mut Vec<usize>,
    budget: &mut usize,
) -> Option<Model> {
    if left.is_empty() {
        return Some(model.clone());
    }
    for pos in 0..left.len() {
        let i = left[pos];
        if !reads_match(model, batch[i]) {
            continue;
        }
        if *budget == 0 {
            return None;
        }
        *budget -= 1;
        let mut next = model.clone();
        apply(&mut next, batch[i]);
        left.swap_remove(pos);
        if let Some(done) = serial_order(&next, batch, left, budget) {
            return Some(done);
        }
        left.push(i);
        let last = left.len() - 1;
        left.swap(pos, last);
    }
    None
}

/// Replays one group onto `model`: the writes of a group ran one after another, so there must be
/// an order in which each write's reads return the state the earlier ones left; applies it.
fn replay_batch(model: &mut Model, batch: &[&Txn]) -> Result<(), String> {
    let mut left: Vec<usize> = (0..batch.len()).collect();
    let mut budget = 100_000;
    match serial_order(model, batch, &mut left, &mut budget) {
        Some(done) => {
            *model = done;
            Ok(())
        }
        None => Err(format!(
            "a group of {} (writes {:x?}) has no serial order in which every read returns the \
             replayed state (a stale read, a lost update or a phantom)",
            batch.len(),
            batch.iter().map(|t| t.id).collect::<Vec<_>>()
        )),
    }
}

/// Replays the acknowledged transactions batch by batch. Returns the state and the last
/// commit sequence.
fn replay_acked(acked: &[(u64, Txn)]) -> Result<(Model, u64), String> {
    let mut by_version: BTreeMap<u64, Vec<&Txn>> = BTreeMap::new();
    for (v, t) in acked {
        by_version.entry(*v).or_default().push(t);
    }
    let mut model = Model::new();
    let mut last = None;
    for (v, batch) in &by_version {
        if let Some(prev) = last
            && *v != prev + 1
        {
            return Err(format!(
                "commit sequence jumps from {prev} to {v}: a batch was acknowledged to nobody"
            ));
        }
        replay_batch(&mut model, batch).map_err(|e| format!("at sequence {v}: {e}"))?;
        last = Some(*v);
    }
    Ok((model, last.unwrap_or(0)))
}

/// The registers, rows and counter the store holds.
fn stored(kv: &dyn Kv) -> Result<Model, StoreError> {
    let read = kv.snapshot()?;
    let mut model = Model::new();
    for (start, end) in [
        (b"r/".as_slice(), b"r0".as_slice()),
        (ROWS, ROWS_END),
        (COUNTER, b"n\0".as_slice()),
    ] {
        read.scan(start, end, false, &mut |k, v| {
            model.insert(k.to_vec(), v.to_vec());
            true
        })?;
    }
    Ok(model)
}

fn check_ids(h: &History) -> Result<(), String> {
    if let Some(e) = h.unexpected.first() {
        return Err(format!("a writer got an unexpected error: {e}"));
    }
    let mut seen = HashSet::new();
    for id in &h.ids {
        if !seen.insert(*id) {
            return Err(format!("id {id} was handed out twice"));
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Honest,
    Crash,
    FsyncFault,
}

#[derive(Default, Debug)]
struct Tally {
    runs: usize,
    acked: usize,
    conflicts: usize,
    gave_up: usize,
    crash_hit: usize,
    in_doubt_applied: usize,
    in_doubt_dropped: usize,
    /// Acknowledged writes that shared their group's commit with an earlier write.
    shared: usize,
}

fn honest_run(seed: u64, writers: usize, tally: &mut Tally) -> Result<(), String> {
    let disk = SimDisk::new(seed, FaultPlan::none());
    let kv = open(&disk).map_err(|e| e.to_string())?;
    let h = run_writers(&kv, seed, writers);
    if !h.in_doubt.is_empty() || !h.refused.is_empty() {
        return Err("a write failed on an honest disk".into());
    }
    check_ids(&h)?;
    let (model, last) = replay_acked(&h.acked)?;
    if kv.version().map_err(|e| e.to_string())? != last {
        return Err("the store's commit sequence is not the last acknowledged one".into());
    }
    if stored(&kv).map_err(|e| e.to_string())? != model {
        return Err("the store's final state is not the replay of its history".into());
    }
    let groups: BTreeSet<u64> = h.acked.iter().map(|(seq, _)| *seq).collect();
    tally.shared += h.acked.len() - groups.len();
    let expected = h.acked.len() as i64;
    let counted = model
        .get(COUNTER)
        .map(|b| i64::from_le_bytes(b.as_slice().try_into().unwrap()))
        .unwrap_or(0);
    if counted != expected {
        return Err(format!("counter is {counted}, {expected} commits"));
    }
    tally.runs += 1;
    tally.acked += h.acked.len();
    tally.conflicts += h.conflicts;
    tally.gave_up += h.gave_up;
    Ok(())
}

fn crash_run(seed: u64, writers: usize, kind: Kind, tally: &mut Tally) -> Result<(), String> {
    // Calibration: the I/O an honest run of this seed does after the store opens.
    let budget = {
        let disk = SimDisk::new(seed, FaultPlan::none());
        let kv = open(&disk).map_err(|e| e.to_string())?;
        let setup = disk.stats().io_ops;
        run_writers(&kv, seed, writers);
        drop(kv);
        disk.stats().io_ops - setup
    };
    let mut rng = SimRng::new(seed ^ 0xC7A5_0000 ^ writers as u64);
    let modes = [
        CrashMode::DropUnsynced,
        CrashMode::TearLast,
        CrashMode::Subset,
    ];
    let mode = modes[rng.below(modes.len())];
    let disk = SimDisk::new(seed, FaultPlan::none());
    let kv = open(&disk).map_err(|e| e.to_string())?;
    let setup = disk.stats().io_ops;
    disk.set_plan(FaultPlan {
        fsync_error_pm: if kind == Kind::FsyncFault {
            5 + rng.below(40) as u32
        } else {
            0
        },
        fsync_lie_pm: 0,
        crash_at_op: Some(setup + 1 + rng.below(budget.max(1) as usize) as u64),
        crash_mode: mode,
    });
    let h = run_writers(&kv, seed, writers);
    let crash_hit = disk.is_crashed();
    disk.crash_now();
    drop(kv);
    check_ids(&h)?;
    let (acked_model, acked_last) = replay_acked(&h.acked)?;
    let mut with_doubt = acked_model.clone();
    let doubt: Vec<&Txn> = h.in_doubt.iter().collect();
    replay_batch(&mut with_doubt, &doubt).map_err(|e| format!("the in-doubt batch: {e}"))?;

    disk.reboot();
    disk.set_plan(FaultPlan::none());
    let reopened = catch_unwind(AssertUnwindSafe(|| -> Result<_, StoreError> {
        let kv = open(&disk)?;
        let version = kv.version()?;
        let state = stored(&kv)?;
        let mut tx = kv.begin_write()?;
        let next_id = tx.allocate(SEQUENCE, 1)?;
        tx.put(b"r/after", b"x")?;
        let after = tx.commit()?;
        Ok((version, state, next_id, after))
    }));
    let (version, state, next_id, after) = match reopened {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return Err(format!("refused to reopen after an honest crash: {e}")),
        Err(_) => return Err("reopening panicked".into()),
    };
    let applied = if state == acked_model && version == acked_last {
        false
    } else if !doubt.is_empty() && state == with_doubt && version == acked_last + 1 {
        true
    } else if state == acked_model {
        return Err(format!(
            "the state is the acknowledged one but the sequence is {version}, not {acked_last}"
        ));
    } else {
        return Err(format!(
            "recovered state (sequence {version}) is neither the {} acknowledged commits nor \
             those plus the whole in-doubt batch of {} (lost, torn, or a refused write applied)",
            h.acked.len(),
            doubt.len()
        ));
    };
    if after != version + 1 {
        return Err(format!(
            "the first write after recovery got sequence {after}"
        ));
    }
    let recovered_ids = h
        .acked
        .iter()
        .map(|(_, t)| t)
        .chain(if applied { doubt.clone() } else { Vec::new() })
        .map(|t| t.id_allocated);
    if let Some(max) = recovered_ids.max()
        && next_id <= max
    {
        return Err(format!(
            "after recovery the id {next_id} was handed out again (a recovered commit holds {max})"
        ));
    }
    tally.runs += 1;
    tally.acked += h.acked.len();
    tally.conflicts += h.conflicts;
    tally.gave_up += h.gave_up;
    tally.crash_hit += crash_hit as usize;
    if !doubt.is_empty() {
        if applied {
            tally.in_doubt_applied += 1;
        } else {
            tally.in_doubt_dropped += 1;
        }
    }
    Ok(())
}

fn sweep(kind: Kind, default_seeds: u64) {
    for &writers in WRITERS {
        let mut tally = Tally::default();
        for seed in seeds(default_seeds) {
            let outcome = match kind {
                Kind::Honest => honest_run(seed, writers, &mut tally),
                _ => crash_run(seed, writers, kind, &mut tally),
            };
            if let Err(e) = outcome {
                panic!(
                    "{kind:?} run with {writers} writers failed (GBRAIN_SIM_SEED={seed}; the \
                     thread interleaving is not replayed): {e}"
                );
            }
        }
        eprintln!("{kind:?} {writers} writers: {tally:?}");
        assert_eq!(tally.gave_up, 0, "a writer gave up after 1,000 conflicts");
        if kind == Kind::Honest {
            assert!(tally.acked >= tally.runs * TXNS, "{tally:?}");
            if writers >= 16 {
                assert!(
                    tally.shared > 0,
                    "no two writes ever shared a commit: {tally:?}"
                );
            }
        }
    }
}

#[test]
fn grouped_writers_leave_a_serial_history() {
    sweep(Kind::Honest, 6);
}

#[test]
fn a_crash_keeps_every_acknowledged_write_and_the_in_flight_group_whole() {
    sweep(Kind::Crash, 10);
}

#[test]
fn a_failed_fsync_leaves_the_in_flight_group_whole() {
    sweep(Kind::FsyncFault, 10);
}
