//! The per-candidate crash simulations and their result rows.
//!
//! - redb runs in-process on a `SimDisk` through its `StorageBackend` trait. The seed chooses a
//!   crash point (any I/O call after setup), what the crash keeps of unsynced writes (nothing, a
//!   torn tail, or an arbitrary subset), and for the fsync-fault kind also fsync errors and
//!   fsync lies. Everything is checked by `gbrain-sim`'s checkers after a reboot.
//! - fjall and LMDB write real files, so a simulated disk cannot sit under them. They get seeded
//!   SIGKILLs of a child process instead: the child runs the seeded workload and acknowledges
//!   every durable commit on a pipe, the parent kills it after a seed-chosen number of acks, then
//!   reopens the real files and checks them against a reference run of the same seed. A SIGKILL
//!   is a process crash, not a power cut: the OS keeps its page cache, so this exercises each
//!   store's recovery and atomicity but NOT fsync ordering, torn sectors or fsync faults.
//! - the commit layer itself (`Committer` over the in-memory store) runs under the scheduler for
//!   every candidate, checking serializability and determinism.

use crate::engine::{open_base, Engine};
use crate::kv::*;
use crate::mem_store::MemStore;
use crate::occ::*;
use crate::redb_store::{RedbStore, SimDiskBackend};
use crate::simload::*;
use gbrain_sim::check::{self, Class, Committed, Reopen, Violation};
use gbrain_sim::{CrashMode, FaultPlan, SimDisk, SimRng};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Transactions per seed for in-process runs.
pub const TXNS: usize = 60;
/// Transactions per seed for the SIGKILL child (long enough that a kill lands mid-run).
pub const CHILD_TXNS: usize = 400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Crash points only: the disk is honest.
    Crash,
    /// Crash points plus fsync errors and fsync lies.
    FsyncFault,
    /// Negative control: every fsync lies and the crash keeps a random subset of the writes, but
    /// the checker is told the disk was honest. No store survives that unharmed, so the checker
    /// MUST report violations; if it does not, the harness is blind.
    Control,
}

#[derive(Default)]
pub struct SeedResult {
    pub violations: Vec<Violation>,
    pub commits: usize,
    /// The crash fired mid-workload (rather than after the workload finished).
    pub crash_hit: bool,
    /// fsync errors and lies injected.
    pub faults: u64,
    pub fsync_errors: u64,
    pub fsync_lies: u64,
    pub torn_writes: u64,
    pub refused: bool,
    pub lost_after_lie: bool,
    pub crash_mode: &'static str,
    pub trace_hash: u64,
    pub io_ops: u64,
    /// After recovery the store held the whole in-doubt batch (true) or stopped at the last
    /// acknowledged commit (false); None if it did not reopen.
    pub in_doubt_applied: Option<bool>,
}

fn msg(p: Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<String>()
        .cloned()
        .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "panic".into())
}

fn corrupt(m: String) -> Violation {
    Violation {
        class: Class::Corrupt,
        message: m,
    }
}

/// Reopen a store and describe what recovery gave: version and state, or a clean refusal, or a
/// panic. Also checks the commit log and that the reopened store accepts a new commit.
fn reopen_report(
    open: impl FnOnce() -> Result<std::sync::Arc<dyn BaseStore>>,
) -> (Reopen, Vec<Violation>) {
    let mut extra = Vec::new();
    let opened = catch_unwind(AssertUnwindSafe(|| -> Result<(u64, check::Model)> {
        let store = open()?;
        let (version, state) = read_state(store.as_ref())?;
        for p in log_problems(store.as_ref(), version)? {
            extra.push(Violation {
                class: Class::Torn,
                message: p,
            });
        }
        // A recovered store must take writes again.
        let mut c = Committer::new(store.clone(), Options::default())?;
        let mut t = Txn::begin(store.as_ref())?;
        t.put(b"k/0".to_vec(), b"after-recovery".to_vec());
        match c.commit_batch(vec![t.into_request()], None).remove(0) {
            Ok(v) if v == version + 1 => {}
            other => extra.push(corrupt(format!(
                "reopened at version {version} but the next commit gave {other:?}"
            ))),
        }
        Ok((version, state))
    }));
    match opened {
        Ok(Ok((version, state))) => (Reopen::Opened { version, state }, extra),
        Ok(Err(e)) => (Reopen::Refused(e.to_string()), extra),
        Err(p) => (Reopen::Panicked(msg(p)), extra),
    }
}

fn new_redb(disk: &SimDisk) -> Result<std::sync::Arc<dyn BaseStore>> {
    Ok(std::sync::Arc::new(RedbStore::open_with_backend(
        SimDiskBackend(disk.open("records.redb")),
    )?))
}

/// One redb seed on a simulated disk.
pub fn redb_seed(seed: u64, kind: Kind, txns: usize) -> SeedResult {
    let mut res = SeedResult::default();
    // Calibration: the same seed with an honest disk and no crash gives the I/O budget.
    let (setup_ops, total_ops) = {
        let disk = SimDisk::new(seed, FaultPlan::none());
        let store = new_redb(&disk).expect("redb opens on a fresh simulated disk");
        let setup = disk.stats().io_ops;
        run_workload(store, Options::default(), seed, txns, None).expect("calibration run");
        (setup, disk.stats().io_ops)
    };

    let salt = match kind {
        Kind::Crash => 0x51,
        Kind::FsyncFault => 0xF5,
        Kind::Control => 0xC0,
    };
    let mut rng = SimRng::new(seed ^ (salt << 56));
    let crash_at = setup_ops + 1 + rng.below((total_ops - setup_ops + 1) as usize) as u64;
    let (mut error_pm, mut lie_pm) = (0, 0);
    let mut modes = vec![
        CrashMode::DropUnsynced,
        CrashMode::TearLast,
        CrashMode::Subset,
    ];
    if kind == Kind::Control {
        lie_pm = 1000;
        modes = vec![CrashMode::Subset];
    }
    if kind == Kind::FsyncFault {
        match rng.below(3) {
            0 => error_pm = 10 + rng.below(50) as u32,
            1 => lie_pm = 100 + rng.below(300) as u32,
            _ => {
                error_pm = 10 + rng.below(30) as u32;
                lie_pm = 100 + rng.below(200) as u32;
            }
        }
        // After a lie the device may have reordered nothing but did lose data: keep crashes
        // in-order (drop or torn tail). Subset is only fair when fsync is honest or merely errors.
        if lie_pm > 0 {
            modes.truncate(2);
        }
    }
    let mode = modes[rng.below(modes.len())];
    res.crash_mode = match mode {
        CrashMode::DropUnsynced => "drop",
        CrashMode::TearLast => "tear",
        CrashMode::Subset => "subset",
    };

    let disk = SimDisk::new(seed, FaultPlan::none());
    let store = match new_redb(&disk) {
        Ok(s) => s,
        Err(e) => {
            res.violations
                .push(corrupt(format!("could not create the database: {e}")));
            return res;
        }
    };
    // Faults and the crash point apply to the workload, not to creating the file.
    disk.set_plan(FaultPlan {
        fsync_error_pm: error_pm,
        fsync_lie_pm: lie_pm,
        crash_at_op: Some(crash_at),
        crash_mode: mode,
    });
    let ran = catch_unwind(AssertUnwindSafe(|| {
        run_workload(store.clone(), Options::default(), seed, txns, None)
    }));
    let out = match ran {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            res.violations
                .push(corrupt(format!("workload could not start: {e}")));
            return res;
        }
        Err(p) => {
            res.violations
                .push(corrupt(format!("panic during the workload: {}", msg(p))));
            return res;
        }
    };
    res.crash_hit = disk.is_crashed();
    disk.crash_now(); // no-op if the crash point already fired
    drop(store);
    let st = disk.stats();
    res.fsync_errors = st.fsync_errors;
    res.fsync_lies = st.fsync_lies;
    res.faults = st.fsync_errors + st.fsync_lies;
    res.torn_writes = st.torn_writes;
    res.io_ops = st.io_ops;
    res.commits = out.committed.len();
    res.trace_hash = out.trace_hash;
    res.violations.extend(out.violations.iter().cloned());

    disk.reboot();
    let (reopen, extra) = reopen_report(|| new_redb(&disk));
    // The control tells the checker the disk was honest although it lied, so a clean refusal or a
    // lost acknowledged commit must show up as a violation. If it does not, the checker is blind.
    let lied = st.fsync_lies > 0 && kind != Kind::Control;
    let verdict = check::check_recovery(&out.committed, &out.in_doubt, lied, &reopen);
    res.refused = verdict.refused;
    res.lost_after_lie = verdict.lost_after_lie;
    if let Reopen::Opened { version, .. } = &reopen {
        let acked_max = out.committed.last().map(|c| c.version).unwrap_or(0);
        res.in_doubt_applied = Some(*version > acked_max);
    }
    res.violations.extend(extra);
    res.violations.extend(verdict.violations);
    res
}

/// One commit-layer seed on the in-memory store, run twice to check determinism.
pub fn layer_seed(seed: u64, txns: usize) -> (Outcome, bool) {
    let a = run_mem(seed, txns);
    let b = run_mem(seed, txns);
    let same = a.trace_hash == b.trace_hash && a.committed.len() == b.committed.len();
    (a, same)
}

// ---- fjall and LMDB: seeded SIGKILL --------------------------------------------------------

fn write_stdout(buf: &[u8]) {
    // SAFETY: raw write(2) to fd 1; 8 bytes is below PIPE_BUF so each ack is atomic.
    unsafe {
        libc::write(1, buf.as_ptr().cast(), buf.len());
    }
}

/// The SIGKILL child: open the store, run the seeded workload, write each durable batch's last
/// version (8 bytes, little endian) to stdout as it is acknowledged. The parent kills it.
pub fn child_sim_crash(engine: Engine, store: &Path, seed: u64, txns: usize) -> i32 {
    let base = match open_base(engine, store) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("sim child could not open the store: {e}");
            return 1;
        }
    };
    let hook: Box<dyn FnMut(u64)> = Box::new(|v| write_stdout(&v.to_le_bytes()));
    match run_workload(base, Options::default(), seed, txns, Some(hook)) {
        Ok(o) if o.store_failure.is_none() => 0,
        Ok(o) => {
            eprintln!("sim child: store failure {:?}", o.store_failure);
            1
        }
        Err(e) => {
            eprintln!("sim child: {e}");
            1
        }
    }
}

/// One fjall or LMDB seed: kill a child at a seed-chosen acknowledged batch, reopen, check.
pub fn kill_seed(
    engine: Engine,
    seed: u64,
    dir: &Path,
    txns: usize,
) -> std::result::Result<SeedResult, String> {
    kill_seed_against(engine, seed, seed, dir, txns)
}

/// Like `kill_seed`, but checks the reopened store against the reference history of
/// `reference_seed`. With a different seed this is a negative control: it must report violations.
pub fn kill_seed_against(
    engine: Engine,
    seed: u64,
    reference_seed: u64,
    dir: &Path,
    txns: usize,
) -> std::result::Result<SeedResult, String> {
    let mut res = SeedResult::default();
    let reference = run_mem(reference_seed, txns);
    if reference.batches.is_empty() {
        return Err("reference run committed nothing".into());
    }
    let mut rng = SimRng::new(seed ^ 0x4B << 56);
    let target = 1 + rng.below(reference.batches.len());
    let jitter_us = rng.below(1500) as u64;

    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Integration tests run as a different executable and point this at the real binary.
    let exe = match std::env::var_os("GBRAIN_BAKEOFF_EXE") {
        Some(p) => p.into(),
        None => std::env::current_exe().map_err(|e| e.to_string())?,
    };
    let mut child = Command::new(exe)
        .args([
            "child-sim-crash",
            "--engine",
            engine.name(),
            "--store",
            &dir.display().to_string(),
            "--seed",
            &seed.to_string(),
            "--txns",
            &txns.to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let (tx, rx) = mpsc::channel::<u64>();
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 8];
        while stdout.read_exact(&mut buf).is_ok() {
            if tx.send(u64::from_le_bytes(buf)).is_err() {
                break;
            }
        }
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let mut acks: Vec<u64> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut finished_early = false;
    while acks.len() < target {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(v) => acks.push(v),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                finished_early = true;
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("child produced no acknowledgements within 60 s".into());
                }
            }
        }
    }
    if !finished_early {
        std::thread::sleep(Duration::from_micros(jitter_us));
    }
    let _ = child.kill(); // SIGKILL
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = reader.join();
    acks.extend(rx.try_iter());
    let child_err = err_reader.join().unwrap_or_default();
    let completed = status.code() == Some(0);
    if finished_early && !completed && acks.is_empty() {
        return Err(format!(
            "child failed before acknowledging anything: {}",
            child_err.trim()
        ));
    }
    res.crash_hit = !completed;
    res.crash_mode = "sigkill";
    let acked_max = acks.iter().copied().max().unwrap_or(0);
    res.commits = reference
        .committed
        .iter()
        .filter(|c| c.version <= acked_max)
        .count();
    let acked: Vec<Committed> = reference
        .committed
        .iter()
        .filter(|c| c.version <= acked_max)
        .cloned()
        .collect();
    // The batch after the last acknowledged one may or may not have reached the disk.
    let in_doubt: Vec<Committed> = reference
        .batches
        .iter()
        .find(|(first, _)| *first > acked_max)
        .map(|(first, last)| {
            reference
                .committed
                .iter()
                .filter(|c| c.version >= *first && c.version <= *last)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let (reopen, extra) = reopen_report(|| open_base(engine, dir));
    let verdict = check::check_recovery(&acked, &in_doubt, false, &reopen);
    res.refused = verdict.refused;
    if let Reopen::Opened { version, .. } = &reopen {
        res.in_doubt_applied = Some(*version > acked_max);
    }
    res.violations.extend(reference.violations.iter().cloned());
    res.violations.extend(extra);
    res.violations.extend(verdict.violations);
    Ok(res)
}

// ---- aggregation ---------------------------------------------------------------------------

#[derive(Default)]
pub struct Totals {
    pub seeds: u64,
    pub crash_points: u64,
    pub faults: u64,
    pub fsync_errors: u64,
    pub fsync_lies: u64,
    pub torn_writes: u64,
    pub commits: u64,
    pub refused: u64,
    pub lost_after_lie: u64,
    pub recovered_in_doubt: u64,
    pub recovered_at_last_ack: u64,
    pub by_class: BTreeMap<&'static str, u64>,
    pub failed_seeds: Vec<(u64, String)>,
    pub crash_modes: BTreeMap<&'static str, u64>,
    pub elapsed: Duration,
    pub harness_errors: Vec<String>,
}

impl Totals {
    pub fn add(&mut self, seed: u64, r: &SeedResult) {
        self.seeds += 1;
        self.crash_points += r.crash_hit as u64;
        self.faults += r.faults;
        self.fsync_errors += r.fsync_errors;
        self.fsync_lies += r.fsync_lies;
        self.torn_writes += r.torn_writes;
        self.commits += r.commits as u64;
        self.refused += r.refused as u64;
        self.lost_after_lie += r.lost_after_lie as u64;
        match r.in_doubt_applied {
            Some(true) => self.recovered_in_doubt += 1,
            Some(false) => self.recovered_at_last_ack += 1,
            None => {}
        }
        *self.crash_modes.entry(r.crash_mode).or_default() += 1;
        for v in &r.violations {
            *self.by_class.entry(v.class.name()).or_default() += 1;
        }
        if let Some(v) = r.violations.first() {
            if self.failed_seeds.len() < 10 {
                self.failed_seeds
                    .push((seed, format!("{}: {}", v.class.name(), v.message)));
            }
        }
    }

    pub fn violations(&self) -> u64 {
        self.by_class.values().sum::<u64>() + self.harness_errors.len() as u64
    }

    fn class(&self, c: Class) -> u64 {
        self.by_class.get(c.name()).copied().unwrap_or(0)
    }

    /// The row shape every candidate shares.
    pub fn metric(&self, engine: Engine, kind: &str, extra: Value) -> Value {
        let secs = self.elapsed.as_secs_f64().max(1e-9);
        let repro = format!(
            "GBRAIN_SIM_SEED=<n> cargo run --release -- sim --engine {} --kind {kind}",
            engine.name()
        );
        let repro_note = match self.failed_seeds.first() {
            None => format!("no violation. To replay any seed: {repro}"),
            Some((seed, why)) => format!(
                "first failing seed {seed} ({why}). Repro: GBRAIN_SIM_SEED={seed} cargo run --release -- sim --engine {} --kind {kind}",
                engine.name()
            ),
        };
        let mut m = json!({
            "n": self.seeds,
            "seeds": self.seeds,
            "crash_points": self.crash_points,
            "faults": self.faults,
            "lost": self.class(Class::Lost),
            "torn": self.class(Class::Torn),
            "nonserializable": self.class(Class::Nonserializable),
            "corrupt": self.class(Class::Corrupt) + self.harness_errors.len() as u64,
            "ops_per_s": (self.commits as f64 / secs * 10.0).round() / 10.0,
            "repro_note": repro_note,
            "acked_commits": self.commits,
            "elapsed_s": (secs * 100.0).round() / 100.0,
            "refused_cleanly": self.refused,
            "lost_after_lie_expected": self.lost_after_lie,
            "recovered_with_in_doubt_batch": self.recovered_in_doubt,
            "recovered_at_last_ack": self.recovered_at_last_ack,
            "crash_modes": self.crash_modes,
            "failed_seeds": self.failed_seeds.iter().map(|(s, w)| json!({"seed": s, "why": w})).collect::<Vec<_>>(),
            "harness_errors": self.harness_errors,
        });
        if let (Some(m), Some(e)) = (m.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                m.insert(k.clone(), v.clone());
            }
        }
        m
    }
}

pub fn pick_seeds(count: u64, base: u64) -> Vec<u64> {
    // GBRAIN_SIM_SEED always wins (it is the repro); otherwise the explicit range.
    match std::env::var(gbrain_sim::seed::ENV_SEED)
        .ok()
        .and_then(|v| v.parse().ok())
    {
        Some(s) => vec![s],
        None => (base..base + count).collect(),
    }
}

pub fn run_redb_kind(kind: Kind, seeds: &[u64], txns: usize) -> Totals {
    let mut t = Totals::default();
    let t0 = Instant::now();
    for &seed in seeds {
        let r = redb_seed(seed, kind, txns);
        t.add(seed, &r);
    }
    t.elapsed = t0.elapsed();
    t
}

pub fn run_kill_kind(engine: Engine, seeds: &[u64], dir: &Path, txns: usize) -> Totals {
    let mut t = Totals::default();
    let t0 = Instant::now();
    for &seed in seeds {
        match kill_seed(engine, seed, dir, txns) {
            Ok(r) => t.add(seed, &r),
            Err(e) => {
                t.seeds += 1;
                t.harness_errors.push(format!("seed {seed}: {e}"));
            }
        }
    }
    t.elapsed = t0.elapsed();
    let _ = std::fs::remove_dir_all(dir);
    t
}

/// The commit layer over the in-memory store under the scheduler, engine independent.
pub fn run_layer(seeds: &[u64], txns: usize) -> (Totals, Value) {
    let mut t = Totals::default();
    let (mut conflicts, mut multi, mut nondet) = (0usize, 0usize, 0usize);
    let t0 = Instant::now();
    for &seed in seeds {
        let (o, same) = layer_seed(seed, txns);
        let r = SeedResult {
            commits: o.committed.len(),
            violations: o.violations.clone(),
            trace_hash: o.trace_hash,
            crash_mode: "none",
            ..Default::default()
        };
        conflicts += o.conflicts;
        multi += o.multi_batches;
        nondet += !same as usize;
        t.add(seed, &r);
    }
    t.elapsed = t0.elapsed();
    let extra = json!({"conflicts": conflicts, "multi_txn_batches": multi, "nondeterministic_seeds": nondet,
        "scope": "Committer over the in-memory store under the gbrain-sim scheduler: serializability of the committed history, no torn snapshot read, and the same seed run twice gives the same trace hash. Independent of the candidate store."});
    (t, extra)
}

/// Make a fresh in-memory store (used by tests and the layer runs).
pub fn mem() -> std::sync::Arc<dyn BaseStore> {
    std::sync::Arc::new(MemStore::new())
}
