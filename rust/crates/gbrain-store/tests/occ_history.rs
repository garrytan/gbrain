//! Many writers on one record file (`occ_kv.rs`), checked against their history.
//!
//! Each run starts 4, 16 or 64 writer threads on one `OccKv` over a `RedbKv` on the simulated
//! disk. Every transaction allocates an id, adds 1 to a counter and then does one of:
//! - a read-modify-write of two of a few hot registers, appending its id to each (a list
//!   append, so the final list of a register is the order its writers committed in);
//! - a range read of the `p/` rows and an insert of one more row whose value is the number of
//!   rows it saw (a phantom: under a serial order the values are exactly 0, 1, 2, ...).
//!
//! A transaction that loses a conflict runs again, queued behind the key it lost on, as
//! `Store::write` does. The checker then replays the acknowledged transactions in commit order.
//! Transactions of one commit batch share a commit sequence, so within a batch it looks for an
//! order in which no transaction reads a key an earlier one writes; there must be one, and in it
//! every read must return exactly the replayed state. The replay must end in the state the store
//! holds. Ids must never repeat, even across transactions that did not commit.
//!
//! The crash runs stop the simulated machine at a random write, set_len or fsync (some runs also
//! fail fsyncs), reboot it and reopen the store. Every acknowledged transaction must be there;
//! the batch whose commit was in flight must be there entirely or not at all, and nothing that
//! was refused after it may be there. An id allocated after the reopen must be higher than every
//! id the recovered transactions hold.
//!
//! The logged runs (`logged_*`) do the same with the commit log on (`commit_log.rs`), activated
//! before the first write: besides the checks above, replaying the recovered log from an empty
//! state must give exactly the recovered records (no record without its data, no data without its
//! record), and the log must be gap-free and end at the recovered commit sequence.
//!
//! The workload of each thread comes from the seed, but the thread interleaving does not: the
//! operating system schedules the threads, so a failing seed is not always reproducible. A run
//! that fails prints its seed, writer count and kind.

use gbrain_sim::seed::seeds;
use gbrain_sim::{CrashMode, FaultPlan, SimDisk, SimFile, SimRng};
use gbrain_store::commit_log::{self, CommitPosition, LogOp, LogSettings};
use gbrain_store::error::{STORE_IO, WRITE_CONFLICT};
use gbrain_store::occ_kv::OccKv;
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

fn open(disk: &SimDisk) -> Result<OccKv, StoreError> {
    OccKv::new(RedbKv::open_backend(Box::new(SimBackend(disk.open(FILE))))?)
}

/// `open`, then, for a logged run, the log: activated on a fresh file (one commit that holds only
/// the log's meta record), enabled on a reopen.
fn open_as(disk: &SimDisk, logged: bool) -> Result<OccKv, StoreError> {
    let kv = open(disk)?;
    if logged {
        kv.set_commit_clock(std::sync::Arc::new(gbrain_store::SystemEnv), None)?;
        if commit_log::read_meta(&*kv.snapshot()?)?.is_none() {
            let mut tx = kv.begin_write()?;
            let since = CommitPosition::new(kv.version()? + 1, 0);
            commit_log::write_activation(&mut *tx, since)?;
            tx.commit()?;
        }
        kv.enable_commit_log(LogSettings::default())?;
    }
    Ok(kv)
}

/// The logged run's extra check: the log, replayed from an empty state, is exactly the store's
/// records (all but the log's own), gap-free, and it ends at the store's commit sequence.
fn check_log(kv: &dyn Kv) -> Result<(), String> {
    let read = kv.snapshot().map_err(|e| e.to_string())?;
    let version = kv.version().map_err(|e| e.to_string())?;
    let page = commit_log::read_commit_log(&*read, None, usize::MAX).map_err(|e| e.to_string())?;
    if page.snapshot_required {
        return Err("the log does not reach back to its start".into());
    }
    let mut model: BTreeMap<Vec<u8>, Vec<u8>> = BTreeMap::new();
    let mut last = None;
    let mut last_time = None;
    for record in &page.records {
        if last_time.is_some_and(|t| record.commit_time <= t) {
            return Err(format!(
                "commit time goes back at {}",
                record.position.token()
            ));
        }
        last_time = Some(record.commit_time);
        for (key, op) in &record.ops {
            match op {
                LogOp::Put(v) => {
                    model.insert(key.clone(), v.clone());
                }
                LogOp::Delete => {
                    model.remove(key);
                }
                LogOp::AddI64(d) => {
                    let base = model
                        .get(key)
                        .map(|b| i64::from_le_bytes(b.as_slice().try_into().unwrap()))
                        .unwrap_or(0);
                    model.insert(key.clone(), base.wrapping_add(*d).to_le_bytes().to_vec());
                }
                LogOp::RaiseCounter(m) => {
                    let base = model
                        .get(key)
                        .map(|b| u64::from_be_bytes(b.as_slice().try_into().unwrap()))
                        .unwrap_or(0);
                    model.insert(key.clone(), base.max(*m).to_be_bytes().to_vec());
                }
            }
        }
        last = Some(record.position);
    }
    let mut stored = BTreeMap::new();
    read.scan(&[1], &[0xFF; 64], false, &mut |k, v| {
        if !commit_log::is_log_key(k) {
            stored.insert(k.to_vec(), v.to_vec());
        }
        true
    })
    .map_err(|e| e.to_string())?;
    if stored != model {
        return Err(format!(
            "the log replays to {} keys, the store holds {} (a record without its data or data without its record)",
            model.len(),
            stored.len()
        ));
    }
    if let Some(t) = last_time {
        let durable = kv.last_commit_time().map_err(|e| e.to_string())?;
        if durable != Some(t) {
            return Err(format!(
                "the newest record's time is {t}, the durable time {durable:?}"
            ));
        }
    }
    if let Some(last) = last
        && last.sequence != version
    {
        return Err(format!(
            "the log ends at sequence {}, the store at {version}",
            last.sequence
        ));
    }
    Ok(())
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
    kv: &OccKv,
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

fn writer(kv: &OccKv, seed: u64, thread: usize, txns: usize, history: &Mutex<History>) {
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

fn run_writers(kv: &OccKv, seed: u64, writers: usize) -> History {
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

fn reads_before(a: &Txn, b: &Txn) -> bool {
    a.reads.iter().any(|r| match r {
        Read::Point(key, _) => b
            .writes
            .iter()
            .any(|w| matches!(w, Write::Put(k, _) if k == key)),
        Read::Rows(_) => b
            .writes
            .iter()
            .any(|w| matches!(w, Write::Put(k, _) if k.starts_with(ROWS))),
    })
}

/// Replays one commit batch onto `model`: finds an order in which no transaction reads what an
/// earlier one of the batch writes, checks every read against the replayed state and applies the
/// writes.
fn replay_batch(model: &mut Model, batch: &[&Txn]) -> Result<(), String> {
    let n = batch.len();
    let mut before: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut waiting = vec![0usize; n];
    for a in 0..n {
        for b in 0..n {
            if a != b && reads_before(batch[a], batch[b]) {
                before[a].push(b);
                waiting[b] += 1;
            }
        }
    }
    let mut ready: Vec<usize> = (0..n).filter(|&i| waiting[i] == 0).collect();
    let mut order = Vec::with_capacity(n);
    while let Some(i) = ready.pop() {
        order.push(i);
        for &j in &before[i] {
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
    for i in order {
        let t = batch[i];
        for r in &t.reads {
            match r {
                Read::Point(key, value) => {
                    if model.get(key) != value.as_ref() {
                        return Err(format!(
                            "txn {:x} read a stale {}",
                            t.id,
                            String::from_utf8_lossy(key)
                        ));
                    }
                }
                Read::Rows(rows) => {
                    let now: Vec<(Vec<u8>, Vec<u8>)> = model
                        .range(ROWS.to_vec()..ROWS_END.to_vec())
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    if &now != rows {
                        return Err(format!(
                            "txn {:x} saw {} rows, the replay has {}",
                            t.id,
                            rows.len(),
                            now.len()
                        ));
                    }
                }
            }
        }
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
    Ok(())
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
}

fn honest_run(seed: u64, writers: usize, logged: bool, tally: &mut Tally) -> Result<(), String> {
    let disk = SimDisk::new(seed, FaultPlan::none());
    let kv = open_as(&disk, logged).map_err(|e| e.to_string())?;
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
    let expected = h.acked.len() as i64;
    let counted = model
        .get(COUNTER)
        .map(|b| i64::from_le_bytes(b.as_slice().try_into().unwrap()))
        .unwrap_or(0);
    if counted != expected {
        return Err(format!("counter is {counted}, {expected} commits"));
    }
    if logged {
        check_log(&kv)?;
    }
    tally.runs += 1;
    tally.acked += h.acked.len();
    tally.conflicts += h.conflicts;
    tally.gave_up += h.gave_up;
    Ok(())
}

fn crash_run(
    seed: u64,
    writers: usize,
    kind: Kind,
    logged: bool,
    tally: &mut Tally,
) -> Result<(), String> {
    // Calibration: the I/O an honest run of this seed does after the store opens.
    let budget = {
        let disk = SimDisk::new(seed, FaultPlan::none());
        let kv = open_as(&disk, logged).map_err(|e| e.to_string())?;
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
    let kv = open_as(&disk, logged).map_err(|e| e.to_string())?;
    // The version the run starts from: 0, or the log activation commit on a logged run.
    let base_version = kv.version().map_err(|e| e.to_string())?;
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
    let acked_last = acked_last.max(base_version);
    let mut with_doubt = acked_model.clone();
    let doubt: Vec<&Txn> = h.in_doubt.iter().collect();
    replay_batch(&mut with_doubt, &doubt).map_err(|e| format!("the in-doubt batch: {e}"))?;

    disk.reboot();
    disk.set_plan(FaultPlan::none());
    let reopened = catch_unwind(AssertUnwindSafe(|| -> Result<_, StoreError> {
        let kv = open_as(&disk, logged)?;
        if logged {
            // Checked as recovered, before the write below adds to it.
            check_log(&kv).map_err(|e| StoreError::new("log_check", e))?;
        }
        let version = kv.version()?;
        let state = stored(&kv)?;
        let mut tx = kv.begin_write()?;
        let next_id = tx.allocate(SEQUENCE, 1)?;
        tx.put(b"r/after", b"x")?;
        let after = tx.commit()?;
        if logged {
            check_log(&kv).map_err(|e| StoreError::new("log_check", e))?;
        }
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
    sweep_as(kind, default_seeds, false);
}

fn sweep_as(kind: Kind, default_seeds: u64, logged: bool) {
    for &writers in WRITERS {
        let mut tally = Tally::default();
        for seed in seeds(default_seeds) {
            let outcome = match kind {
                Kind::Honest => honest_run(seed, writers, logged, &mut tally),
                _ => crash_run(seed, writers, kind, logged, &mut tally),
            };
            if let Err(e) = outcome {
                panic!(
                    "{kind:?} run (logged {logged}) with {writers} writers failed (GBRAIN_SIM_SEED={seed}; the \
                     thread interleaving is not replayed): {e}"
                );
            }
        }
        eprintln!("{kind:?} logged={logged} {writers} writers: {tally:?}");
        assert_eq!(tally.gave_up, 0, "a writer gave up after 1,000 conflicts");
        if kind == Kind::Honest {
            assert!(tally.acked >= tally.runs * TXNS, "{tally:?}");
        }
    }
}

#[test]
fn concurrent_writers_leave_a_serializable_history() {
    sweep(Kind::Honest, 6);
}

#[test]
fn a_crash_keeps_every_acknowledged_commit_and_the_in_flight_batch_whole() {
    sweep(Kind::Crash, 10);
}

#[test]
fn a_failed_fsync_leaves_the_in_flight_batch_whole() {
    sweep(Kind::FsyncFault, 10);
}

#[test]
fn logged_concurrent_writers_leave_a_serializable_history_and_a_matching_log() {
    sweep_as(Kind::Honest, 6, true);
}

#[test]
fn logged_a_crash_keeps_the_log_and_the_records_in_step() {
    sweep_as(Kind::Crash, 10, true);
}

#[test]
fn logged_a_failed_fsync_keeps_the_log_and_the_records_in_step() {
    sweep_as(Kind::FsyncFault, 10, true);
}

/// Every record of `kv` but the log's own.
fn all_data(kv: &dyn Kv) -> BTreeMap<Vec<u8>, Vec<u8>> {
    let mut out = BTreeMap::new();
    kv.snapshot()
        .unwrap()
        .scan(&[1], &[0xFF; 64], false, &mut |k, v| {
            if !commit_log::is_log_key(k) {
                out.insert(k.to_vec(), v.to_vec());
            }
            true
        })
        .unwrap();
    out
}

/// Waits (bounded) until `n` commits sit on the pipeline's queue: the schedule the batch tests force.
fn wait_queued(kv: &OccKv, n: usize) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while kv.queued_commits() < n {
        assert!(
            std::time::Instant::now() < deadline,
            "the commits never queued ({} of {n})",
            kv.queued_commits()
        );
        std::thread::yield_now();
    }
}

/// One forced group commit: the pipeline is held while three transactions queue, in this order and
/// whatever the machine's load (each is on the queue before the next is sent): two in write skew,
/// so the second is refused, and one with a counter, an id sequence and a 200 KB value. Then they go
/// as one batch. Returns how many were acknowledged.
fn forced_batch(kv: &std::sync::Arc<OccKv>) -> usize {
    let exclusive = kv.begin_write_exclusive().unwrap();
    let queue = |reads: &'static [u8], write: &'static [u8]| {
        let mut tx = kv.begin_write().unwrap();
        tx.get(reads).unwrap();
        tx.put(write, write).unwrap();
        std::thread::spawn(move || tx.commit_position())
    };
    let t1 = queue(b"r/01", b"r/00");
    wait_queued(kv, 1);
    let t2 = queue(b"r/00", b"r/01");
    wait_queued(kv, 2);
    let t3 = {
        let mut tx = kv.begin_write().unwrap();
        tx.add_i64(COUNTER, 3).unwrap();
        tx.raise_counter(SEQUENCE, 77).unwrap();
        tx.put(b"r/big", &vec![9u8; 200_000]).unwrap();
        std::thread::spawn(move || tx.commit_position())
    };
    wait_queued(kv, 3);
    drop(exclusive);
    [t1, t2, t3]
        .into_iter()
        .map(|t| t.join().expect("a writer thread panicked"))
        .filter(Result::is_ok)
        .count()
}

/// What the crash sweep accepts after a reboot.
#[derive(Clone, Copy, PartialEq)]
enum Oracle {
    /// The batch is there whole or not at all (the one batch `forced_batch` forms).
    WholeOrNone,
    /// Any committed prefix of the schedule's commits (a schedule that commits more than once).
    CommittedPrefix,
}

/// A schedule the sweep runs: it commits the three transactions of `forced_batch`.
type Schedule = fn(&std::sync::Arc<OccKv>) -> usize;

/// The schedule the earlier, sleep-based `forced_batch` fell into on a loaded machine: the third
/// transaction reaches the pipeline only after the first two were taken into a batch, so the three
/// commit as two record-file commits instead of one.
fn forced_split(kv: &std::sync::Arc<OccKv>) -> usize {
    let exclusive = kv.begin_write_exclusive().unwrap();
    let queue = |reads: &'static [u8], write: &'static [u8]| {
        let mut tx = kv.begin_write().unwrap();
        tx.get(reads).unwrap();
        tx.put(write, write).unwrap();
        std::thread::spawn(move || tx.commit_position())
    };
    let t1 = queue(b"r/01", b"r/00");
    wait_queued(kv, 1);
    let t2 = queue(b"r/00", b"r/01");
    wait_queued(kv, 2);
    drop(exclusive);
    let first: Vec<_> = [t1, t2]
        .into_iter()
        .map(|t| t.join().expect("a writer thread panicked"))
        .collect();
    let mut tx = kv.begin_write().unwrap();
    tx.add_i64(COUNTER, 3).unwrap();
    tx.raise_counter(SEQUENCE, 77).unwrap();
    tx.put(b"r/big", &vec![9u8; 200_000]).unwrap();
    first.iter().filter(|r| r.is_ok()).count() + usize::from(tx.commit_position().is_ok())
}

/// The record states a committed prefix of `schedule` can leave, from an honest run: after each of
/// its record-file commits.
fn prefix_states(seed: u64, schedule: Schedule) -> Vec<BTreeMap<Vec<u8>, Vec<u8>>> {
    let disk = SimDisk::new(seed, FaultPlan::none());
    let kv = sweep_start(&disk);
    let base = kv.version().unwrap();
    schedule(&kv);
    let page = commit_log::read_commit_log(
        &*kv.snapshot().unwrap(),
        Some(CommitPosition::new(base, 0)),
        100,
    )
    .unwrap();
    // Replay the honest log one record-file commit at a time onto the starting records.
    let mut states = Vec::new();
    let mut model = all_data(&*sweep_start(&SimDisk::new(seed, FaultPlan::none())));
    let mut at = base;
    for record in &page.records {
        if record.position.sequence != at {
            states.push(model.clone());
            at = record.position.sequence;
        }
        for (key, op) in &record.ops {
            match op {
                LogOp::Put(v) => {
                    model.insert(key.clone(), v.clone());
                }
                LogOp::Delete => {
                    model.remove(key);
                }
                LogOp::AddI64(d) => {
                    let b = model
                        .get(key)
                        .map(|b| i64::from_le_bytes(b.as_slice().try_into().unwrap()))
                        .unwrap_or(0);
                    model.insert(key.clone(), b.wrapping_add(*d).to_le_bytes().to_vec());
                }
                LogOp::RaiseCounter(m) => {
                    let b = model
                        .get(key)
                        .map(|b| u64::from_be_bytes(b.as_slice().try_into().unwrap()))
                        .unwrap_or(0);
                    model.insert(key.clone(), b.max(*m).to_be_bytes().to_vec());
                }
            }
        }
    }
    states.push(model);
    states
}

fn sweep_start(disk: &SimDisk) -> std::sync::Arc<OccKv> {
    let kv = std::sync::Arc::new(open_as(disk, true).unwrap());
    let mut tx = kv.begin_write().unwrap();
    tx.put(b"r/00", b"0").unwrap();
    tx.put(b"r/01", b"0").unwrap();
    tx.commit().unwrap();
    kv
}

/// A crash at every I/O call of the crashed runs' schedule, calibrated on `forced_batch`'s one
/// group commit. Returns (runs that kept everything, runs that kept nothing).
fn group_commit_sweep(
    crashed: Schedule,
    oracle: Oracle,
    commits_more_than_once: bool,
) -> (u32, u32) {
    let seed = 0xB47C;
    let disk = SimDisk::new(seed, FaultPlan::none());
    let kv = sweep_start(&disk);
    let before_data = all_data(&*kv);
    let before_version = kv.version().unwrap();
    let before_ops = disk.stats().io_ops;
    forced_batch(&kv);
    let after_ops = disk.stats().io_ops;
    let after_data = all_data(&*kv);
    let page = commit_log::read_commit_log(
        &*kv.snapshot().unwrap(),
        Some(CommitPosition::new(before_version, 0)),
        10,
    )
    .unwrap();
    assert_eq!(
        page.records.iter().map(|r| r.position).collect::<Vec<_>>(),
        vec![
            CommitPosition::new(before_version + 1, 0),
            CommitPosition::new(before_version + 1, 1)
        ],
        "the honest batch has two accepted transactions"
    );
    check_log(&*kv).unwrap();
    drop(kv);
    let prefixes = prefix_states(seed, crashed);
    let modes = [
        CrashMode::DropUnsynced,
        CrashMode::TearLast,
        CrashMode::Subset,
    ];
    let (mut whole, mut none) = (0, 0);
    // A few more points than the calibrated batch has I/O calls, so a schedule that commits more
    // than once is crashed after its first commit too, and the last point is past the last fsync.
    let extra = if commits_more_than_once {
        after_ops - before_ops
    } else {
        0
    };
    for k in 0..=(after_ops - before_ops + extra) {
        let disk = SimDisk::new(seed, FaultPlan::none());
        let kv = sweep_start(&disk);
        assert_eq!(
            disk.stats().io_ops,
            before_ops,
            "the setup is not deterministic"
        );
        disk.set_plan(FaultPlan {
            fsync_error_pm: 0,
            fsync_lie_pm: 0,
            crash_at_op: Some(before_ops + 1 + k),
            crash_mode: modes[k as usize % modes.len()],
        });
        crashed(&kv);
        disk.crash_now();
        drop(kv);
        disk.reboot();
        disk.set_plan(FaultPlan::none());
        let kv = open_as(&disk, true).unwrap();
        check_log(&kv).unwrap_or_else(|e| panic!("crash at I/O {k}: {e}"));
        let data = all_data(&kv);
        match oracle {
            Oracle::WholeOrNone => {
                if data == after_data {
                    assert_eq!(
                        kv.version().unwrap(),
                        before_version + 1,
                        "crash at I/O {k}"
                    );
                    whole += 1;
                } else {
                    assert_eq!(data, before_data, "crash at I/O {k}: the batch is torn");
                    assert_eq!(kv.version().unwrap(), before_version, "crash at I/O {k}");
                    none += 1;
                }
            }
            Oracle::CommittedPrefix => {
                let at = prefixes
                    .iter()
                    .position(|state| *state == data)
                    .unwrap_or_else(|| {
                        panic!("crash at I/O {k}: the records match no committed prefix")
                    });
                if at == 0 {
                    none += 1;
                } else if at == prefixes.len() - 1 {
                    whole += 1;
                }
            }
        }
    }
    eprintln!("group commit crash sweep: {whole} whole, {none} absent");
    (whole, none)
}

/// A crash at every I/O call of one forced group commit (two accepted transactions and one
/// refused): after the reboot the batch is there whole, with its two records, or not at all, and
/// the log replays to exactly the records the store holds. `forced_batch` queues the batch in a
/// fixed order before it lets the pipeline go, so every run crashes the same I/O sequence.
#[test]
fn logged_a_crash_at_every_io_of_one_group_commit_keeps_it_whole() {
    let (whole, none) = group_commit_sweep(forced_batch, Oracle::WholeOrNone, false);
    assert!(
        none > 0,
        "no crash point dropped the batch: the sweep did not reach its commit"
    );
    assert!(
        whole > 0,
        "no crash point kept the batch: the sweep never got past its fsync"
    );
}

/// The "torn batch" seen once on a loaded machine (rust-engine/multiuser dc25d27bce, seed 0xB47C,
/// crash at I/O 10: r/00 written, the counter, id sequence and r/big not): the sleep-based schedule
/// let the third transaction miss the batch, so the run committed twice, and a crash between the
/// two commits left the first commit alone, which the whole-or-nothing oracle reports as torn.
/// Forcing that schedule reproduces it on every run.
#[test]
#[should_panic(expected = "the batch is torn")]
fn logged_a_split_schedule_is_what_the_whole_or_nothing_oracle_called_torn() {
    group_commit_sweep(forced_split, Oracle::WholeOrNone, true);
}

/// The same split schedule, crashed at every I/O call: every reboot holds a committed prefix (none,
/// the first commit, or both), and the log agrees: each record-file commit is whole.
#[test]
fn logged_a_split_schedule_crashed_anywhere_keeps_each_commit_whole() {
    let (whole, none) = group_commit_sweep(forced_split, Oracle::CommittedPrefix, true);
    assert!(
        none > 0 && whole > 0,
        "the sweep did not cover both commits"
    );
}

/// The log check must catch what it claims to catch: a record without its data and data without
/// its record.
#[test]
fn the_log_check_catches_a_record_without_data_and_data_without_a_record() {
    let disk = SimDisk::new(1, FaultPlan::none());
    let kv = open_as(&disk, true).unwrap();
    let mut tx = kv.begin_write().unwrap();
    tx.put(b"r/00", b"x").unwrap();
    tx.commit().unwrap();
    assert!(check_log(&kv).is_ok());
    // Data with no record: written around the log by a store that does not log.
    let base = RedbKv::open_backend(Box::new(SimBackend(
        SimDisk::new(2, FaultPlan::none()).open(FILE),
    )))
    .unwrap();
    let unlogged = OccKv::new(base).unwrap();
    let mut tx = unlogged.begin_write().unwrap();
    let since = CommitPosition::new(unlogged.version().unwrap() + 1, 0);
    commit_log::write_activation(&mut *tx, since).unwrap();
    tx.commit().unwrap();
    let mut tx = unlogged.begin_write().unwrap();
    tx.put(b"r/00", b"x").unwrap();
    tx.commit().unwrap();
    assert!(check_log(&unlogged).is_err());
    // A record with no data: the record's key deleted behind the log's back.
    drop(kv);
    let kv = open(&disk).unwrap();
    let mut tx = kv.begin_write().unwrap();
    tx.delete(b"r/00").unwrap();
    tx.commit().unwrap();
    assert!(check_log(&kv).is_err());
}

/// The checker must catch what it claims to catch. A lost update (two writers that read the
/// same list and both append) and a phantom (two inserts that saw the same rows) must fail the
/// replay; a lost acknowledged write must not match the stored state.
#[test]
fn the_checker_catches_lost_updates_phantoms_and_lost_commits() {
    let append = |id: u64, before: &[u64]| {
        let mut list: Vec<u8> = before.iter().flat_map(|i| i.to_le_bytes()).collect();
        let read = (!list.is_empty()).then(|| list.clone());
        list.extend_from_slice(&id.to_le_bytes());
        Txn {
            id,
            id_allocated: id,
            reads: vec![Read::Point(register(0), read)],
            writes: vec![Write::Put(register(0), list)],
        }
    };
    // Serial: 1 then 2 (2 saw 1).
    let ok = vec![(1, append(1, &[])), (2, append(2, &[1]))];
    assert!(replay_acked(&ok).is_ok());
    // Lost update across batches: 2 read the empty list although 1 committed first.
    let lost = vec![(1, append(1, &[])), (2, append(2, &[]))];
    assert!(replay_acked(&lost).unwrap_err().contains("stale"));
    // Same, inside one batch: no serial order exists.
    let same_batch = vec![(1, append(1, &[])), (1, append(2, &[]))];
    assert!(replay_acked(&same_batch).is_err());
    // A phantom: two inserts that both saw no rows.
    let insert = |id: u64| Txn {
        id,
        id_allocated: id,
        reads: vec![Read::Rows(Vec::new())],
        writes: vec![Write::Put(
            format!("p/{id:016x}").into_bytes(),
            0u64.to_le_bytes().to_vec(),
        )],
    };
    assert!(replay_acked(&[(1, insert(1)), (2, insert(2))]).is_err());
    assert!(replay_acked(&[(1, insert(1)), (1, insert(2))]).is_err());
    // A gap in the commit sequence.
    assert!(replay_acked(&[(1, append(1, &[])), (3, append(2, &[1]))]).is_err());
    // A repeated id.
    let h = History {
        ids: vec![1, 2, 2],
        ..History::default()
    };
    assert!(check_ids(&h).is_err());
}

/// Research only (the storage bake-off): the same checks on fjall, built only with the
/// off-by-default `fjall` feature. fjall does its own file I/O, so the simulated disk cannot
/// stand under it: there is no torn-write, dropped-cache or failed-fsync run here. In their
/// place the kill runs stop a real child process with SIGKILL while its writers commit, then
/// reopen the database. That tests recovery from a process crash (the page cache survives), not
/// from a power loss.
#[cfg(feature = "fjall")]
mod fjall_research {
    use super::*;
    use gbrain_store::fjall_kv::FjallKv;
    use std::collections::HashMap;
    use std::io::{BufRead, Write as _};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    const CHILD_DIR: &str = "GBRAIN_FJALL_KILL_DIR";
    const CHILD_WRITERS: &str = "GBRAIN_FJALL_KILL_WRITERS";

    fn scratch(label: &str) -> PathBuf {
        let n = SimRng::new(std::process::id() as u64 ^ label.len() as u64).next_u64();
        let dir = std::env::temp_dir().join(format!(
            "gbrain-fjall-research-{label}-{}-{n:x}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn open_fjall(dir: &Path) -> Result<OccKv, StoreError> {
        OccKv::new_fjall(FjallKv::open_dir(dir)?)
    }

    /// The honest sweep of the redb test, on fjall: the full history replay must hold.
    #[test]
    fn fjall_concurrent_writers_leave_a_serializable_history() {
        for &writers in WRITERS {
            for seed in seeds(3) {
                let dir = scratch("honest");
                let kv = open_fjall(&dir).unwrap();
                let h = run_writers(&kv, seed, writers);
                assert!(
                    h.in_doubt.is_empty() && h.refused.is_empty(),
                    "a write failed"
                );
                check_ids(&h).unwrap();
                assert_eq!(h.gave_up, 0);
                let (model, last) = replay_acked(&h.acked)
                    .unwrap_or_else(|e| panic!("seed {seed}, {writers} writers: {e}"));
                assert_eq!(kv.version().unwrap(), last);
                assert_eq!(stored(&kv).unwrap(), model);
                drop(kv);
                // Reopen: the state survives a clean close and the sequence goes on.
                let kv = open_fjall(&dir).unwrap();
                assert_eq!(kv.version().unwrap(), last);
                assert_eq!(stored(&kv).unwrap(), model);
                drop(kv);
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }

    /// The child of a kill run (started by the test below; ignored in a normal run). Its writers
    /// commit until the process is killed. Before each commit a writer prints the attempt
    /// (`@@I id id_allocated plan`), and after an acknowledged commit `@@K id sequence`.
    #[test]
    #[ignore]
    fn kill_child() {
        let Some(dir) = std::env::var_os(CHILD_DIR) else {
            return;
        };
        let writers: usize = std::env::var(CHILD_WRITERS).unwrap().parse().unwrap();
        let kv = open_fjall(Path::new(&dir)).unwrap();
        let out = Mutex::new(std::io::stdout());
        let say = |line: String| {
            let mut o = out.lock().unwrap();
            o.write_all(line.as_bytes()).unwrap();
            o.flush().unwrap();
        };
        std::thread::scope(|s| {
            for thread in 0..writers {
                let (kv, say) = (&kv, &say);
                s.spawn(move || {
                    let mut rng = SimRng::new(0xF1A1).fork(thread as u64 + 1);
                    for n in 0u64.. {
                        let id = ((thread as u64) << 32) | n;
                        let plan = if rng.chance(200) {
                            None
                        } else {
                            let a = rng.below(HOT);
                            Some((a, (a + 1 + rng.below(HOT - 1)) % HOT))
                        };
                        let mut locked = BTreeSet::new();
                        loop {
                            let mut tx = if locked.is_empty() {
                                kv.begin_write().unwrap()
                            } else {
                                kv.begin_write_locked(&locked).unwrap()
                            };
                            let ran = (|| -> Result<u64, StoreError> {
                                let allocated = tx.allocate(SEQUENCE, 1)?;
                                match plan {
                                    Some((a, b)) => {
                                        for i in [a, b] {
                                            let key = register(i);
                                            let mut list = tx.get(&key)?.unwrap_or_default();
                                            list.extend_from_slice(&id.to_le_bytes());
                                            tx.put(&key, &list)?;
                                        }
                                    }
                                    None => {
                                        let mut rows = 0u64;
                                        tx.scan(ROWS, ROWS_END, false, &mut |_, _| {
                                            rows += 1;
                                            true
                                        })?;
                                        let key = format!("p/{id:016x}").into_bytes();
                                        tx.put(&key, &rows.to_le_bytes())?;
                                    }
                                }
                                tx.add_i64(COUNTER, 1)?;
                                Ok(allocated)
                            })();
                            let allocated = match ran {
                                Ok(a) => a,
                                Err(e) if e.code == WRITE_CONFLICT => {
                                    if let Some(key) = conflict_key(&e) {
                                        locked.insert(key);
                                    }
                                    continue;
                                }
                                Err(e) => panic!("{e}"),
                            };
                            let shape = match plan {
                                Some((a, b)) => format!("A {a} {b}"),
                                None => "R".into(),
                            };
                            say(format!("@@I {id} {allocated} {shape}\n"));
                            match tx.commit() {
                                Ok(version) => {
                                    say(format!("@@K {id} {version}\n"));
                                    break;
                                }
                                Err(e) if e.code == WRITE_CONFLICT => {
                                    if let Some(key) = conflict_key(&e) {
                                        locked.insert(key);
                                    }
                                }
                                Err(e) => panic!("{e}"),
                            }
                        }
                    }
                });
            }
        });
    }

    struct Intent {
        allocated: u64,
        registers: Option<(usize, usize)>,
    }

    fn ids_of(list: &[u8]) -> Vec<u64> {
        list.chunks(8)
            .map(|c| u64::from_le_bytes(c.try_into().unwrap()))
            .collect()
    }

    /// Checks the reopened state against what the killed child said. Returns the number of
    /// committed transactions found.
    fn check_recovered(
        kv: &OccKv,
        intents: &HashMap<u64, Intent>,
        acked: &HashMap<u64, u64>,
    ) -> Result<usize, String> {
        let state = stored(kv).map_err(|e| e.to_string())?;
        let version = kv.version().map_err(|e| e.to_string())?;
        let mut lists: Vec<Vec<u64>> = vec![Vec::new(); HOT];
        let mut rows: Vec<(u64, u64)> = Vec::new();
        let mut counter = 0i64;
        for (k, v) in &state {
            if let Some(rest) = k.strip_prefix(b"r/") {
                let i: usize = std::str::from_utf8(rest).unwrap().parse().unwrap();
                lists[i] = ids_of(v);
            } else if let Some(rest) = k.strip_prefix(b"p/") {
                let id = u64::from_str_radix(std::str::from_utf8(rest).unwrap(), 16).unwrap();
                rows.push((id, u64::from_le_bytes(v.as_slice().try_into().unwrap())));
            } else if k.as_slice() == COUNTER {
                counter = i64::from_le_bytes(v.as_slice().try_into().unwrap());
            }
        }
        // The committed transactions, and in which registers each one is.
        let mut present: BTreeMap<u64, BTreeSet<usize>> = BTreeMap::new();
        for (i, list) in lists.iter().enumerate() {
            for id in list {
                if !present.entry(*id).or_default().insert(i) {
                    return Err(format!("id {id} appears twice in register {i}"));
                }
            }
        }
        for (id, _) in &rows {
            present.entry(*id).or_default();
        }
        for (id, regs) in &present {
            let intent = intents
                .get(id)
                .ok_or_else(|| format!("id {id} is in the store but was never attempted"))?;
            match intent.registers {
                Some((a, b)) if *regs != BTreeSet::from([a, b]) => {
                    return Err(format!("transaction {id} is torn: in registers {regs:?}"));
                }
                None if !regs.is_empty() || !rows.iter().any(|(r, _)| r == id) => {
                    return Err(format!("insert {id} is torn"));
                }
                _ => {}
            }
        }
        if counter != present.len() as i64 {
            return Err(format!(
                "counter is {counter}, {} transactions are in the store",
                present.len()
            ));
        }
        for (id, seq) in acked {
            if !present.contains_key(id) {
                return Err(format!(
                    "acknowledged commit {id} (sequence {seq}) was lost"
                ));
            }
        }
        if let Some(max) = acked.values().max()
            && version < *max
        {
            return Err(format!(
                "sequence {version} is behind an acknowledged {max}"
            ));
        }
        // A phantom-free insert order: the row values are exactly 0, 1, 2, ...
        let mut values: Vec<u64> = rows.iter().map(|(_, v)| *v).collect();
        values.sort_unstable();
        if values.iter().enumerate().any(|(i, v)| *v != i as u64) {
            return Err(format!("row counts {values:?} are not 0, 1, 2, ..."));
        }
        // One serial order must explain every register's append order: no cycle.
        let mut after: HashMap<u64, BTreeSet<u64>> = HashMap::new();
        let mut indegree: HashMap<u64, usize> = present.keys().map(|id| (*id, 0)).collect();
        for list in &lists {
            for pair in list.windows(2) {
                if after.entry(pair[0]).or_default().insert(pair[1]) {
                    *indegree.get_mut(&pair[1]).unwrap() += 1;
                }
            }
        }
        let mut ready: Vec<u64> = indegree
            .iter()
            .filter(|(_, d)| **d == 0)
            .map(|(id, _)| *id)
            .collect();
        let mut ordered = 0;
        while let Some(id) = ready.pop() {
            ordered += 1;
            for next in after.get(&id).into_iter().flatten() {
                let d = indegree.get_mut(next).unwrap();
                *d -= 1;
                if *d == 0 {
                    ready.push(*next);
                }
            }
        }
        if ordered != present.len() {
            return Err("the register orders have a cycle: no serial order exists".into());
        }
        // Ids allocated after the reopen are above every recovered one.
        let mut tx = kv.begin_write().map_err(|e| e.to_string())?;
        let next = tx.allocate(SEQUENCE, 1).map_err(|e| e.to_string())?;
        tx.put(b"r/after", b"x").map_err(|e| e.to_string())?;
        let seq = tx.commit().map_err(|e| e.to_string())?;
        if seq != version + 1 {
            return Err(format!("the first write after reopen got sequence {seq}"));
        }
        if let Some(max) = present.keys().map(|id| intents[id].allocated).max()
            && next <= max
        {
            return Err(format!("id {next} was handed out again after the reopen"));
        }
        Ok(present.len())
    }

    /// The kill checker must fail on a lost acknowledged commit and on a torn transaction.
    #[test]
    fn fjall_the_kill_checker_catches_a_lost_commit_and_a_torn_one() {
        let dir = scratch("checker");
        let kv = open_fjall(&dir).unwrap();
        let mut tx = kv.begin_write().unwrap();
        let allocated = tx.allocate(SEQUENCE, 1).unwrap();
        tx.put(&register(0), &7u64.to_le_bytes()).unwrap();
        tx.add_i64(COUNTER, 1).unwrap();
        let seq = tx.commit().unwrap();
        let intent = |registers| Intent {
            allocated,
            registers,
        };
        // Transaction 7 meant to append to registers 0 and 1, but only register 0 has it.
        let torn = HashMap::from([(7, intent(Some((0, 1))))]);
        let err = check_recovered(&kv, &torn, &HashMap::from([(7, seq)])).unwrap_err();
        assert!(err.contains("torn"), "{err}");
        // With an intent that matches the store, an acknowledged commit 8 that is missing fails.
        let whole = HashMap::from([(7, intent(Some((0, 0)))), (8, intent(None))]);
        let err = check_recovered(&kv, &whole, &HashMap::from([(8, seq)])).unwrap_err();
        assert!(err.contains("was lost"), "{err}");
        drop(kv);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Kills a child process at a random point while 4, 16 or 64 writers commit, reopens the
    /// database and checks it. Set `GBRAIN_FJALL_KILL_RUNS` for more runs per writer count.
    #[test]
    fn fjall_a_killed_process_keeps_every_acknowledged_commit_whole() {
        let runs: u64 = std::env::var("GBRAIN_FJALL_KILL_RUNS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3);
        let exe = std::env::current_exe().unwrap();
        for &writers in WRITERS {
            let (mut acked_total, mut found_total, mut unacked_found) = (0, 0, 0);
            for run in 0..runs {
                let dir = scratch("kill");
                let mut rng = SimRng::new(run ^ ((writers as u64) << 16));
                let mut child = Command::new(&exe)
                    .args(["fjall_research::kill_child", "--exact", "--ignored"])
                    .args(["--nocapture", "--test-threads=1", "-q"])
                    .env(CHILD_DIR, &dir)
                    .env(CHILD_WRITERS, writers.to_string())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                let stdout = child.stdout.take().unwrap();
                let reader = std::thread::spawn(move || {
                    let mut lines = Vec::new();
                    let mut r = std::io::BufReader::new(stdout);
                    let mut buf = String::new();
                    while r.read_line(&mut buf).unwrap_or(0) > 0 {
                        if buf.ends_with('\n') {
                            lines.push(std::mem::take(&mut buf));
                        }
                        buf.clear();
                    }
                    lines
                });
                std::thread::sleep(Duration::from_millis(300 + rng.below(700) as u64));
                child.kill().unwrap(); // SIGKILL
                child.wait().unwrap();
                let mut intents = HashMap::new();
                let mut acked = HashMap::new();
                for line in reader.join().unwrap() {
                    let f: Vec<&str> = line.split_whitespace().collect();
                    match f.as_slice() {
                        ["@@I", id, alloc, rest @ ..] => {
                            let registers = match rest {
                                ["A", a, b] => Some((a.parse().unwrap(), b.parse().unwrap())),
                                _ => None,
                            };
                            intents.insert(
                                id.parse::<u64>().unwrap(),
                                Intent {
                                    allocated: alloc.parse().unwrap(),
                                    registers,
                                },
                            );
                        }
                        ["@@K", id, seq] => {
                            acked.insert(id.parse::<u64>().unwrap(), seq.parse::<u64>().unwrap());
                        }
                        _ => {}
                    }
                }
                assert!(
                    !acked.is_empty(),
                    "the child acknowledged nothing before the kill"
                );
                let kv = open_fjall(&dir).unwrap();
                let found = check_recovered(&kv, &intents, &acked).unwrap_or_else(|e| {
                    panic!(
                        "kill run {run} with {writers} writers ({}): {e}",
                        dir.display()
                    )
                });
                drop(kv);
                acked_total += acked.len();
                found_total += found;
                unacked_found += found - acked.len();
                let _ = std::fs::remove_dir_all(&dir);
            }
            eprintln!(
                "fjall kill, {writers} writers, {runs} runs: {acked_total} acknowledged, \
                 {found_total} recovered ({unacked_found} committed but not yet acknowledged)"
            );
        }
    }
}
