//! Process-wide timings of the write path, for the benches (`rust/bench/keyed-lookups`): how long
//! `Store::write` runs its closure and the write chain, how long the record file's commit takes and,
//! inside that commit, how long redb's own commit call takes (page writes and the one durable sync).
//! The counters only add; nothing reads them on the write path. `snapshot` reads them and `reset`
//! zeroes them, so a bench can measure one stage at a time.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static WRITES: AtomicU64 = AtomicU64::new(0);
static WRITE_BODY_NS: AtomicU64 = AtomicU64::new(0);
static COMMITS: AtomicU64 = AtomicU64::new(0);
static COMMIT_NS: AtomicU64 = AtomicU64::new(0);
static REDB_COMMIT_NS: AtomicU64 = AtomicU64::new(0);

/// What the counters hold since the last `reset` (or since the process started).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct CommitProfile {
    /// Unbound `Store::write` runs that reached their commit (each OCC attempt counts).
    pub writes: u64,
    /// Time in those runs before the commit: the closure and the write chain's flushes.
    pub write_body_ns: u64,
    /// Record file commits (`KvWrite::commit` on the redb file, bound transactions included).
    pub commits: u64,
    /// Whole commit time: the commit sequence bump plus redb's commit.
    pub commit_ns: u64,
    /// redb's own commit call: dirty pages written and the one `fdatasync` of `Durability::Immediate`.
    pub redb_commit_ns: u64,
}

pub fn snapshot() -> CommitProfile {
    CommitProfile {
        writes: WRITES.load(Ordering::Relaxed),
        write_body_ns: WRITE_BODY_NS.load(Ordering::Relaxed),
        commits: COMMITS.load(Ordering::Relaxed),
        commit_ns: COMMIT_NS.load(Ordering::Relaxed),
        redb_commit_ns: REDB_COMMIT_NS.load(Ordering::Relaxed),
    }
}

pub fn reset() {
    for counter in [
        &WRITES,
        &WRITE_BODY_NS,
        &COMMITS,
        &COMMIT_NS,
        &REDB_COMMIT_NS,
    ] {
        counter.store(0, Ordering::Relaxed);
    }
}

fn since(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

pub(crate) fn note_write_body(start: Instant) {
    WRITES.fetch_add(1, Ordering::Relaxed);
    WRITE_BODY_NS.fetch_add(since(start), Ordering::Relaxed);
}

pub(crate) fn note_commit(start: Instant, redb_start: Instant) {
    COMMITS.fetch_add(1, Ordering::Relaxed);
    COMMIT_NS.fetch_add(since(start), Ordering::Relaxed);
    REDB_COMMIT_NS.fetch_add(since(redb_start), Ordering::Relaxed);
}
