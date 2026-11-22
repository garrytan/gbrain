//! `SimDisk`: an in-memory disk that behaves like a real one when things go wrong.
//!
//! Every file has two images. The visible image is what reads see: every write so far. The
//! durable image is what survives a crash: it only changes when an fsync is honest. Writes that
//! are not yet durable wait in a pending list. Faults, all chosen by the seed:
//!
//! - fsync error: the call fails and nothing becomes durable (the writes stay pending).
//! - fsync lie: the call reports success but does nothing; the writes stay pending, and a later
//!   honest fsync still flushes them. A crash before then loses them even though they were acked.
//! - crash point: after a seed-chosen number of I/O calls the machine "loses power". Every call
//!   from then on fails until [`SimDisk::reboot`].
//! - what a crash keeps of the pending writes: none of them, an in-order prefix whose last write
//!   is cut at a 512-byte sector (a torn write), or an arbitrary subset (the device reordered).
//!
//! After a crash, handles opened before it are dead (their epoch is stale), so a database object
//! that is dropped late cannot write into the rebooted image.

use crate::rng::SimRng;
use std::collections::BTreeMap;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard};

pub const SECTOR: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrashMode {
    /// Everything not yet fsynced is lost.
    DropUnsynced,
    /// An in-order prefix of the unsynced writes survives; the last one survives only up to a
    /// sector boundary.
    TearLast,
    /// An arbitrary subset of the unsynced writes survives (the device reordered them).
    Subset,
}

#[derive(Clone, Debug)]
pub struct FaultPlan {
    /// Chance (per 1000 fsyncs) that an fsync fails.
    pub fsync_error_pm: u32,
    /// Chance (per 1000 fsyncs) that an fsync reports success and does nothing.
    pub fsync_lie_pm: u32,
    /// Crash before the I/O call with this index (1-based, counting writes, set_lens and fsyncs).
    pub crash_at_op: Option<u64>,
    pub crash_mode: CrashMode,
}

impl FaultPlan {
    pub fn none() -> Self {
        FaultPlan {
            fsync_error_pm: 0,
            fsync_lie_pm: 0,
            crash_at_op: None,
            crash_mode: CrashMode::DropUnsynced,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiskStats {
    pub writes: u64,
    pub fsyncs: u64,
    pub io_ops: u64,
    pub fsync_errors: u64,
    pub fsync_lies: u64,
    pub crashes: u64,
    pub torn_writes: u64,
    pub dropped_writes: u64,
}

#[derive(Clone, Debug)]
enum Op {
    Write { offset: usize, data: Vec<u8> },
    SetLen(usize),
}

fn apply(image: &mut Vec<u8>, op: &Op) {
    match op {
        Op::Write { offset, data } => {
            if image.len() < offset + data.len() {
                image.resize(offset + data.len(), 0);
            }
            image[*offset..offset + data.len()].copy_from_slice(data);
        }
        Op::SetLen(n) => image.resize(*n, 0),
    }
}

#[derive(Default)]
struct File {
    visible: Vec<u8>,
    durable: Vec<u8>,
    pending: Vec<Op>,
}

struct Inner {
    files: BTreeMap<String, File>,
    rng: SimRng,
    plan: FaultPlan,
    stats: DiskStats,
    epoch: u64,
    crashed: bool,
}

#[derive(Clone)]
pub struct SimDisk(Arc<Mutex<Inner>>);

fn dead() -> io::Error {
    io::Error::other("simulated machine is down (crashed)")
}

impl SimDisk {
    pub fn new(seed: u64, plan: FaultPlan) -> Self {
        SimDisk(Arc::new(Mutex::new(Inner {
            files: BTreeMap::new(),
            rng: SimRng::new(seed),
            plan,
            stats: DiskStats::default(),
            epoch: 0,
            crashed: false,
        })))
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Open (creating if absent) a file. The handle is valid until the next crash.
    pub fn open(&self, name: &str) -> SimFile {
        let mut g = self.lock();
        g.files.entry(name.to_string()).or_default();
        SimFile {
            disk: self.clone(),
            name: name.to_string(),
            epoch: g.epoch,
        }
    }

    pub fn stats(&self) -> DiskStats {
        self.lock().stats.clone()
    }

    pub fn is_crashed(&self) -> bool {
        self.lock().crashed
    }

    pub fn set_plan(&self, plan: FaultPlan) {
        self.lock().plan = plan;
    }

    /// Lose power now, with the plan's crash mode.
    pub fn crash_now(&self) {
        let mut g = self.lock();
        let mode = g.plan.crash_mode;
        Self::crash_locked(&mut g, mode);
    }

    /// Lose power now with an explicit crash mode.
    pub fn crash_now_with(&self, mode: CrashMode) {
        Self::crash_locked(&mut self.lock(), mode);
    }

    fn crash_locked(g: &mut Inner, mode: CrashMode) {
        if g.crashed {
            return;
        }
        let Inner {
            files, rng, stats, ..
        } = g;
        for f in files.values_mut() {
            let pending = std::mem::take(&mut f.pending);
            match mode {
                CrashMode::DropUnsynced => stats.dropped_writes += pending.len() as u64,
                CrashMode::TearLast => {
                    // keep ops [0, keep), then maybe a torn version of op `keep`
                    let keep = rng.below(pending.len() + 1);
                    for op in &pending[..keep] {
                        apply(&mut f.durable, op);
                    }
                    if let Some(Op::Write { offset, data }) = pending.get(keep) {
                        let sectors = data.len().div_ceil(SECTOR);
                        let cut = rng.below(sectors) * SECTOR;
                        if cut > 0 {
                            apply(
                                &mut f.durable,
                                &Op::Write {
                                    offset: *offset,
                                    data: data[..cut.min(data.len())].to_vec(),
                                },
                            );
                        }
                        stats.torn_writes += 1;
                    }
                    stats.dropped_writes += (pending.len() - keep) as u64;
                }
                CrashMode::Subset => {
                    for op in &pending {
                        if rng.chance(500) {
                            apply(&mut f.durable, op);
                        } else {
                            stats.dropped_writes += 1;
                        }
                    }
                }
            }
            f.visible = f.durable.clone();
        }
        g.crashed = true;
        g.stats.crashes += 1;
    }

    /// Power back on: the disk shows exactly the durable image. Old handles stay dead.
    pub fn reboot(&self) {
        let mut g = self.lock();
        for f in g.files.values_mut() {
            f.pending.clear();
            f.visible = f.durable.clone();
        }
        g.epoch += 1;
        g.crashed = false;
        g.plan.crash_at_op = None;
        g.plan.fsync_error_pm = 0;
        g.plan.fsync_lie_pm = 0;
    }

    /// A copy of a file's durable bytes (what a crash right now would keep).
    pub fn durable_bytes(&self, name: &str) -> Vec<u8> {
        self.lock()
            .files
            .get(name)
            .map(|f| f.durable.clone())
            .unwrap_or_default()
    }

    /// Count one I/O call; crash first if this is the crash point. Err if the machine is down.
    fn tick(g: &mut Inner, epoch: u64) -> io::Result<()> {
        if g.crashed || epoch != g.epoch {
            return Err(dead());
        }
        g.stats.io_ops += 1;
        if g.plan.crash_at_op == Some(g.stats.io_ops) {
            let mode = g.plan.crash_mode;
            Self::crash_locked(g, mode);
            return Err(dead());
        }
        Ok(())
    }
}

/// A handle to one simulated file. Cheap to clone.
#[derive(Clone)]
pub struct SimFile {
    disk: SimDisk,
    name: String,
    epoch: u64,
}

impl std::fmt::Debug for SimFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SimFile({}, epoch {})", self.name, self.epoch)
    }
}

impl SimFile {
    fn with<R>(&self, f: impl FnOnce(&mut Inner, &str) -> io::Result<R>) -> io::Result<R> {
        let mut g = self.disk.lock();
        f(&mut g, &self.name)
    }

    pub fn len(&self) -> io::Result<u64> {
        self.with(|g, n| {
            if g.crashed || self.epoch != g.epoch {
                return Err(dead());
            }
            Ok(g.files[n].visible.len() as u64)
        })
    }

    pub fn is_empty(&self) -> io::Result<bool> {
        Ok(self.len()? == 0)
    }

    pub fn read_at(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        self.with(|g, n| {
            if g.crashed || self.epoch != g.epoch {
                return Err(dead());
            }
            let v = &g.files[n].visible;
            let (o, end) = (offset as usize, offset as usize + out.len());
            if end > v.len() {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "read past end of simulated file",
                ));
            }
            out.copy_from_slice(&v[o..end]);
            Ok(())
        })
    }

    pub fn write_at(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        self.with(|g, n| {
            SimDisk::tick(g, self.epoch)?;
            g.stats.writes += 1;
            let op = Op::Write {
                offset: offset as usize,
                data: data.to_vec(),
            };
            let f = g.files.get_mut(n).expect("file exists");
            apply(&mut f.visible, &op);
            f.pending.push(op);
            Ok(())
        })
    }

    pub fn set_len(&self, len: u64) -> io::Result<()> {
        self.with(|g, n| {
            SimDisk::tick(g, self.epoch)?;
            let op = Op::SetLen(len as usize);
            let f = g.files.get_mut(n).expect("file exists");
            apply(&mut f.visible, &op);
            f.pending.push(op);
            Ok(())
        })
    }

    /// fsync this file. May fail or lie according to the fault plan.
    pub fn sync(&self) -> io::Result<()> {
        self.with(|g, n| {
            SimDisk::tick(g, self.epoch)?;
            g.stats.fsyncs += 1;
            let (err_pm, lie_pm) = (g.plan.fsync_error_pm, g.plan.fsync_lie_pm);
            if g.rng.chance(err_pm) {
                g.stats.fsync_errors += 1;
                return Err(io::Error::other("simulated fsync error (EIO)"));
            }
            if g.rng.chance(lie_pm) {
                g.stats.fsync_lies += 1;
                return Ok(());
            }
            let f = g.files.get_mut(n).expect("file exists");
            let pending = std::mem::take(&mut f.pending);
            for op in &pending {
                apply(&mut f.durable, op);
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disk(plan: FaultPlan) -> (SimDisk, SimFile) {
        let d = SimDisk::new(1, plan);
        let f = d.open("f");
        (d, f)
    }

    #[test]
    fn synced_data_survives_a_crash_unsynced_data_does_not() {
        let (d, f) = disk(FaultPlan::none());
        f.write_at(0, b"aaaa").unwrap();
        f.sync().unwrap();
        f.write_at(0, b"bbbb").unwrap();
        let mut out = [0u8; 4];
        f.read_at(0, &mut out).unwrap();
        assert_eq!(&out, b"bbbb", "reads see unsynced writes");
        d.crash_now();
        d.reboot();
        let f2 = d.open("f");
        f2.read_at(0, &mut out).unwrap();
        assert_eq!(&out, b"aaaa");
        assert!(f.write_at(0, b"zzzz").is_err(), "old handles are dead");
    }

    #[test]
    fn an_fsync_that_lies_loses_acked_data_at_the_next_crash() {
        let (d, f) = disk(FaultPlan {
            fsync_lie_pm: 1000,
            ..FaultPlan::none()
        });
        f.write_at(0, b"data").unwrap();
        f.sync().unwrap(); // reports success
        assert_eq!(d.stats().fsync_lies, 1);
        d.crash_now();
        d.reboot();
        assert!(
            d.open("f").is_empty().unwrap(),
            "the 'synced' write is gone"
        );
    }

    #[test]
    fn an_fsync_error_makes_nothing_durable_but_a_retry_can() {
        let (d, f) = disk(FaultPlan {
            fsync_error_pm: 1000,
            ..FaultPlan::none()
        });
        f.write_at(0, b"data").unwrap();
        assert!(f.sync().is_err());
        assert!(d.durable_bytes("f").is_empty());
        d.set_plan(FaultPlan::none());
        f.sync().unwrap();
        assert_eq!(d.durable_bytes("f"), b"data");
    }

    #[test]
    fn a_crash_point_fires_at_the_chosen_io_call() {
        let (d, f) = disk(FaultPlan {
            crash_at_op: Some(3),
            ..FaultPlan::none()
        });
        f.write_at(0, b"1").unwrap();
        f.write_at(1, b"2").unwrap();
        assert!(f.write_at(2, b"3").is_err());
        assert!(d.is_crashed());
        assert_eq!(d.stats().crashes, 1);
    }

    #[test]
    fn a_torn_crash_keeps_whole_sectors_of_the_last_write_only() {
        // Over many seeds the last write is sometimes torn at a sector boundary and never mid-sector.
        let mut tore = false;
        for seed in 0..50 {
            let d = SimDisk::new(seed, FaultPlan::none());
            let f = d.open("f");
            f.write_at(0, &[7u8; 2048]).unwrap();
            d.crash_now_with(CrashMode::TearLast);
            let got = d.durable_bytes("f");
            assert_eq!(got.len() % SECTOR, 0, "seed {seed}: cut mid-sector");
            assert!(got.iter().all(|b| *b == 7));
            tore |= !got.is_empty() && got.len() < 2048;
        }
        assert!(tore, "some seed should tear the write");
    }

    #[test]
    fn the_same_seed_gives_the_same_crash_image() {
        let run = |seed| {
            let d = SimDisk::new(seed, FaultPlan::none());
            let f = d.open("f");
            for i in 0..20u8 {
                f.write_at(i as u64 * 100, &[i; 100]).unwrap();
            }
            d.crash_now_with(CrashMode::Subset);
            d.durable_bytes("f")
        };
        assert_eq!(run(9), run(9));
        assert_ne!(run(9), run(10));
    }
}
