//! Many writers at once over the single-writer record file (optimistic transactions with one
//! group-commit pipeline).
//!
//! `RedbKv` admits one write transaction at a time: a second `begin_write` waits until the first
//! commits. `OccKv` removes that wait. A write transaction here reads from a snapshot (it never
//! blocks) and keeps its writes in memory, together with every key and key range it read. Its
//! commit goes to one pipeline thread. For each transaction, in arrival order, the pipeline checks
//! the read set against every write committed after the transaction's snapshot and every write it
//! already accepted for the same batch. A transaction that read something that changed gets the
//! internal `write_conflict` error; `Store::write` then runs it again from a fresh snapshot. The
//! accepted transactions of one round are written to the record file as one durable redb commit
//! (one fsync for the whole batch), and only then are their callers told that they committed.
//!
//! This gives the result Postgres gives with row locks (`SELECT ... FOR UPDATE` plus `UPDATE`):
//! every committed history is equal to running the committed transactions one after another in
//! commit order, so a later writer of the same page is the last writer and nothing it read went
//! stale. Writers that touch different keys never wait for each other.
//!
//! Three kinds of write do not read the key they change, so they never conflict:
//! - `allocate`: an id sequence (Postgres `nextval`). Ids are handed out from memory and are
//!   never handed out twice; an id taken by a transaction that does not commit is lost, as in
//!   Postgres. See "Id sequences" below for a reopen.
//! - `add_i64`: an atomic add on a counter.
//! - `counter_below`: an admission check (`value < cap`). It conflicts only when a later commit
//!   makes the check come out differently.
//!
//! Row-lock queueing for hot keys: a retried transaction first takes an in-memory lock on each
//! key it lost a conflict on (in key order, so two retries cannot deadlock). A first attempt that
//! reads a key another transaction holds this way stops at once with `write_conflict` and is
//! retried behind the lock. Many writers of one page then wait in line, as on a Postgres row
//! lock, instead of all retrying together. The line is first come, first served: a freed key goes
//! to the retry that has waited longest, and a newcomer joins the back.
//!
//! An exclusive write (`Kv::begin_write_exclusive`, the base of an explicit transaction) stops the
//! pipeline after the commits queued before it and holds it until the exclusive write commits or
//! is dropped. It reads the latest state, nothing else commits while it is open, so it never
//! conflicts and never runs again; commits that arrive meanwhile wait, then are checked against
//! it. Its id allocations still come from the shared sequences, so a concurrent writer never gets
//! the same id.
//!
//! A failed record-file commit stops the pipeline: every later commit fails with `store_io` until
//! the brain is opened again (the Postgres answer to a failed WAL flush is the same: stop).
//!
//! Id sequences: the first allocation of a sequence after an open starts at its committed value. In
//! multi-user mode (`Kv::set_id_reservation`) a sequence also reserves its ids on disk before it
//! hands any out: when an allocation would pass the reservation, it first raises it to the
//! allocation's end plus `RESERVE_AHEAD` in a durable commit of its own (the record file's
//! `id_reservations` table: outside the commit sequence, never logged and never checked for
//! conflicts), and the first allocation after an open starts at or above it. So an id is not handed
//! out again after a crash, a kill or a lost forward write, even when the transaction that took it
//! never committed. A clean close gives back the unused part of each reserved range, so a reopen
//! numbers on with no gap; after a crash the next ids skip at most `RESERVE_AHEAD` per sequence.
//! The reservation is local to the record file: a follower's copy or a store snapshot does not carry
//! it, so ids an old primary handed out to transactions that never committed can be handed out
//! again by a promoted follower. With the mode off nothing is reserved or changed on disk (a
//! reservation left by an earlier multi-user open is still honoured), and a crash hands out again
//! the ids of transactions that never committed, as before.

use crate::commit_log::{
    AcceptHook, CommitClock, CommitMeta, CommitPosition, LogOpRef, LogSettings, LogState,
};
use crate::error::{Result, STORE_CLOSED, STORE_CORRUPT, StoreError, WRITE_CONFLICT};
use crate::kv::{CounterCheck, Kv, KvRead, KvWrite};
use crate::redb_kv::{RedbKv, reject_reserved};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::ops::Bound;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, SyncSender, channel, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

/// Largest number of transactions the pipeline puts in one record-file commit.
const MAX_BATCH_TXNS: usize = 512;
/// Largest number of written bytes the pipeline puts in one record-file commit.
const MAX_BATCH_BYTES: usize = 64 << 20;
/// The conflict index forgets old writes once it holds this many keys and no open transaction
/// needs them. When open transactions do need them it keeps them up to `HARD_HISTORY_KEYS`, and
/// past that a transaction older than the forgotten history conflicts (it is retried, never
/// wrongly accepted).
const SOFT_HISTORY_KEYS: usize = 100_000;
const HARD_HISTORY_KEYS: usize = 2_000_000;

/// The message prefix of a `write_conflict` error; the hex of the key follows it.
const CONFLICT_PREFIX: &str = "write conflict on key ";

fn conflict(key: &[u8]) -> StoreError {
    let mut hex = String::with_capacity(key.len() * 2);
    for b in key {
        hex.push_str(&format!("{b:02x}"));
    }
    StoreError::new(WRITE_CONFLICT, format!("{CONFLICT_PREFIX}{hex}"))
}

/// The key a `write_conflict` error names, when it names one.
pub(crate) fn conflict_key(error: &StoreError) -> Option<Vec<u8>> {
    if error.code != WRITE_CONFLICT {
        return None;
    }
    let hex = error.message.strip_prefix(CONFLICT_PREFIX)?;
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

fn key_successor(key: &[u8]) -> Vec<u8> {
    let mut k = key.to_vec();
    k.push(0);
    k
}

fn decode_i64(bytes: Option<&[u8]>) -> Result<i64> {
    match bytes {
        None => Ok(0),
        Some(b) => Ok(i64::from_le_bytes(b.try_into().map_err(|_| {
            StoreError::new(STORE_CORRUPT, "a counter record is not 8 bytes")
        })?)),
    }
}

fn decode_u64_be(bytes: Option<&[u8]>) -> Result<Option<u64>> {
    match bytes {
        None => Ok(None),
        Some(b) => Ok(Some(u64::from_be_bytes(b.try_into().map_err(|_| {
            StoreError::new(STORE_CORRUPT, "an id sequence record is not 8 bytes")
        })?))),
    }
}

/// One buffered write.
#[derive(Clone, Debug)]
enum Op {
    Put(Vec<u8>),
    Delete,
    /// Add to an 8-byte little-endian i64 (absent = 0), applied against the latest committed
    /// value at commit.
    Add(i64),
    /// Raise an 8-byte big-endian u64 (absent = 0) to at least this value (id sequences).
    Max(u64),
}

/// The value `op` leaves on a key whose value before it is `base`.
fn apply(op: &Op, base: Option<&[u8]>) -> Result<Option<Vec<u8>>> {
    Ok(match op {
        Op::Put(v) => Some(v.clone()),
        Op::Delete => None,
        Op::Add(d) => Some(decode_i64(base)?.wrapping_add(*d).to_le_bytes().to_vec()),
        Op::Max(m) => {
            let current = decode_u64_be(base)?.unwrap_or(0);
            Some(current.max(*m).to_be_bytes().to_vec())
        }
    })
}

/// The base the optimistic layer runs on: a `Kv` whose snapshots can be sent to another thread
/// and report the commit sequence they see (`Kv::versioned_snapshot`). Only the pipeline thread
/// writes to it.
pub(crate) trait OccBase: Kv + 'static {
    /// True when the base keeps durable id reservations (see "Id sequences" in the module docs).
    fn keeps_id_reservations(&self) -> bool {
        false
    }
    /// The durable id reservation of sequence `key`, `None` when there is none.
    fn id_reservation(&self, key: &[u8]) -> Result<Option<u64>> {
        let _ = key;
        Ok(None)
    }
    /// Sets (`Some`) or removes (`None`) id reservations in one durable commit outside the commit
    /// sequence. Called only on a base that keeps them, never from the pipeline thread.
    fn set_id_reservations(&self, set: &[(Vec<u8>, Option<u64>)]) -> Result<()> {
        let _ = set;
        Ok(())
    }
}

impl OccBase for RedbKv {
    fn keeps_id_reservations(&self) -> bool {
        true
    }
    fn id_reservation(&self, key: &[u8]) -> Result<Option<u64>> {
        RedbKv::id_reservation(self, key)
    }
    fn set_id_reservations(&self, set: &[(Vec<u8>, Option<u64>)]) -> Result<()> {
        RedbKv::set_id_reservations(self, set)
    }
}

/// How many ids past the ones it hands out an id sequence reserves on disk at a time (multi-user
/// mode): one durable reservation write per this many ids of one sequence. A page body takes about
/// one id per word occurrence, so a small reserve puts a durable write (under the sequence lock) in
/// every few page writes; at 1024 that cost about a tenth of the write rate with 16 writers. A crash
/// skips at most this many ids per sequence (ids are 64-bit).
const RESERVE_AHEAD: u64 = 65536;

/// One id sequence in memory.
#[derive(Clone, Copy, Debug)]
struct Sequence {
    /// The next id to hand out.
    next: u64,
    /// The durable reservation (multi-user mode): no id at or above it was handed out. `None` when
    /// none is on disk for this key.
    reserved: Option<u64>,
}

/// Counts of what the layer did since open (for benchmarks and tests).
#[derive(Debug, Default)]
pub struct OccStats {
    pub commits: AtomicU64,
    pub conflicts: AtomicU64,
    pub batches: AtomicU64,
    pub max_batch: AtomicU64,
    /// Conflicts by the first bytes of the key they were on, to find hot keys.
    by_key: Mutex<HashMap<Vec<u8>, u64>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OccStatsSnapshot {
    pub commits: u64,
    pub conflicts: u64,
    pub batches: u64,
    pub max_batch: u64,
    /// The keys (first 24 bytes, escaped) conflicts happened on, most first.
    pub hot_keys: Vec<(String, u64)>,
}

/// How much of a conflict key `OccStats` keeps.
const HOT_KEY_BYTES: usize = 24;

impl OccStats {
    pub fn snapshot(&self) -> OccStatsSnapshot {
        let l = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let by_key = self.by_key.lock().unwrap_or_else(|p| p.into_inner());
        let mut hot_keys: Vec<(String, u64)> = by_key
            .iter()
            .map(|(k, n)| (k.escape_ascii().to_string(), *n))
            .collect();
        hot_keys.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        hot_keys.truncate(16);
        OccStatsSnapshot {
            commits: l(&self.commits),
            conflicts: l(&self.conflicts),
            batches: l(&self.batches),
            max_batch: l(&self.max_batch),
            hot_keys,
        }
    }

    /// Counts a conflict seen by a transaction (at commit or early, on a held key).
    fn conflict_on(&self, key: &[u8]) {
        self.conflicts.fetch_add(1, Ordering::Relaxed);
        let short = key[..key.len().min(HOT_KEY_BYTES)].to_vec();
        let mut by_key = self.by_key.lock().unwrap_or_else(|p| p.into_inner());
        *by_key.entry(short).or_insert(0) += 1;
    }
}

// ---------------------------------------------------------------------------------------------
// Key locks for retried transactions
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct KeyLocks {
    table: Mutex<KeyTable>,
    released: Condvar,
    /// How many keys are held, so a read can skip the mutex when none are.
    count: AtomicUsize,
    next_owner: AtomicU64,
}

/// The held keys and, per busy key, its waiters in arrival order.
#[derive(Default)]
struct KeyTable {
    held: HashMap<Vec<u8>, u64>,
    /// A key is taken by the first owner in its queue once it is free; a newcomer that finds the
    /// key held or a queue already waiting joins the back (first come, first served).
    queued: HashMap<Vec<u8>, VecDeque<u64>>,
}

impl KeyTable {
    /// True when `owner` may take `key` now: nobody holds it and nobody waits ahead of `owner`.
    fn turn(&self, key: &[u8], owner: u64) -> bool {
        !self.held.contains_key(key)
            && self
                .queued
                .get(key)
                .is_none_or(|q| q.front().is_none_or(|o| *o == owner))
    }

    /// Takes `owner` out of `key`'s queue.
    fn leave(&mut self, key: &[u8], owner: u64) {
        if let Some(q) = self.queued.get_mut(key) {
            q.retain(|o| *o != owner);
            if q.is_empty() {
                self.queued.remove(key);
            }
        }
    }
}

fn key_wait_timeout() -> StoreError {
    StoreError::timeout(
        "key_wait",
        "the write waited for a busy key past its deadline; nothing was committed",
    )
}

impl KeyLocks {
    /// Test only: how many callers wait in `key`'s line right now (a test waits for a waiter to be in
    /// line before it starts the next one, instead of assuming a sleep was long enough).
    #[cfg(test)]
    fn waiting(&self, key: &[u8]) -> usize {
        let table = self.table.lock().unwrap_or_else(|p| p.into_inner());
        table.queued.get(key).map_or(0, VecDeque::len)
    }

    /// Takes every key in `keys`, in order, waiting for each one that another owner holds or that
    /// earlier callers already wait for: waiters for one key take it in the order they came. With a
    /// deadline, a wait that reaches it ends `timeout` (reason `key_wait`) and gives back every key
    /// this call already took: the guard owns each key from the moment it is taken.
    ///
    /// No wait cycle can form: every caller takes its keys in sorted order and holds nothing from
    /// before the call, so a waiter waits only for owners of keys at or after its own (a holder of
    /// the key waits for a later key, a waiter ahead of it for the same key).
    fn acquire(
        self: &Arc<Self>,
        keys: &BTreeSet<Vec<u8>>,
        deadline: Option<Instant>,
    ) -> Result<LockGuard> {
        let owner = self.next_owner.fetch_add(1, Ordering::Relaxed) + 1;
        let mut guard = LockGuard {
            locks: self.clone(),
            owner,
            keys: Vec::with_capacity(keys.len()),
        };
        let mut table = self.table.lock().unwrap_or_else(|p| p.into_inner());
        for key in keys {
            if table.held.get(key) == Some(&owner) {
                continue;
            }
            if !table.turn(key, owner) {
                table
                    .queued
                    .entry(key.clone())
                    .or_default()
                    .push_back(owner);
                while !table.turn(key, owner) {
                    table = match deadline {
                        None => self.released.wait(table).unwrap_or_else(|p| p.into_inner()),
                        Some(at) => {
                            let now = Instant::now();
                            if now >= at {
                                table.leave(key, owner);
                                // Release the table before the guard gives back the keys it took.
                                drop(table);
                                self.released.notify_all();
                                drop(guard);
                                return Err(key_wait_timeout());
                            }
                            self.released
                                .wait_timeout(table, at - now)
                                .unwrap_or_else(|p| p.into_inner())
                                .0
                        }
                    };
                }
                table.leave(key, owner);
                // A key freed just as the deadline passed is not taken after it; the next waiter is.
                if deadline.is_some_and(|at| Instant::now() >= at) {
                    drop(table);
                    self.released.notify_all();
                    drop(guard);
                    return Err(key_wait_timeout());
                }
            }
            table.held.insert(key.clone(), owner);
            self.count.fetch_add(1, Ordering::Release);
            guard.keys.push(key.clone());
        }
        drop(table);
        Ok(guard)
    }

    /// True when some retried transaction holds `key`.
    fn held_by_other(&self, key: &[u8]) -> bool {
        if self.count.load(Ordering::Acquire) == 0 {
            return false;
        }
        let table = self.table.lock().unwrap_or_else(|p| p.into_inner());
        table.held.contains_key(key)
    }
}

struct LockGuard {
    locks: Arc<KeyLocks>,
    owner: u64,
    keys: Vec<Vec<u8>>,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let mut table = self.locks.table.lock().unwrap_or_else(|p| p.into_inner());
        for key in &self.keys {
            if table.held.get(key) == Some(&self.owner) {
                table.held.remove(key);
                self.locks.count.fetch_sub(1, Ordering::Release);
            }
        }
        drop(table);
        self.locks.released.notify_all();
    }
}

// ---------------------------------------------------------------------------------------------
// Conflict index
// ---------------------------------------------------------------------------------------------

/// The commit sequence of the last write to each recently written key.
struct ConflictIndex {
    last_write: BTreeMap<Vec<u8>, u64>,
    /// Writes at sequences <= floor may have been forgotten.
    floor: u64,
}

impl ConflictIndex {
    /// The first key in `reads` written after `snapshot`, if any.
    fn first_conflict(&self, snapshot: u64, reads: &[(Vec<u8>, Vec<u8>)]) -> Option<Vec<u8>> {
        if reads.is_empty() {
            return None;
        }
        for (start, end) in reads {
            if snapshot < self.floor {
                return Some(start.clone());
            }
            let hit = self
                .last_write
                .range::<[u8], _>((
                    Bound::Included(start.as_slice()),
                    Bound::Excluded(end.as_slice()),
                ))
                .find(|(_, v)| **v > snapshot);
            if let Some((k, _)) = hit {
                return Some(k.clone());
            }
        }
        None
    }

    /// Forgets writes no open transaction can conflict with. `oldest` is the oldest snapshot
    /// sequence an open transaction reads at.
    fn prune(&mut self, oldest: u64, current: u64) {
        if self.last_write.len() <= SOFT_HISTORY_KEYS {
            return;
        }
        let keep_after = oldest.min(current);
        self.last_write.retain(|_, v| *v > keep_after);
        self.floor = self.floor.max(keep_after);
        if self.last_write.len() > HARD_HISTORY_KEYS {
            // Open transactions are very old: drop everything and let them conflict.
            self.last_write.clear();
            self.floor = current;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Shared state and the pipeline
// ---------------------------------------------------------------------------------------------

/// What the pipeline receives.
enum Msg {
    Commit(Request),
    /// Stop after everything queued before this, send the published sequence on `granted`, and
    /// wait on `end` for the exclusive write's commit (or its drop).
    Exclusive {
        granted: SyncSender<u64>,
        end: Receiver<Request>,
    },
}

struct Request {
    snapshot: u64,
    reads: Vec<(Vec<u8>, Vec<u8>)>,
    /// Commit-time checks: the latest committed value of the key must be <= the bound.
    guards: Vec<(Vec<u8>, i64)>,
    /// The transaction read the commit sequence (`KvWrite::observe_sequence`): any commit accepted
    /// after its snapshot refuses it.
    observes_sequence: bool,
    writes: BTreeMap<Vec<u8>, Op>,
    /// What the commit says about itself, for its commit record (when the log is on).
    meta: CommitMeta,
    reply: SyncSender<Result<CommitPosition>>,
}

struct Shared {
    base: Arc<dyn OccBase>,
    sender: Mutex<Option<Sender<Msg>>>,
    locks: Arc<KeyLocks>,
    /// Next id to hand out per sequence key, once loaded from the record file.
    sequences: Mutex<HashMap<Vec<u8>, Sequence>>,
    /// Durable id reservation is on (multi-user mode, `Kv::set_id_reservation`).
    reserve_ids: AtomicBool,
    /// Snapshot sequences of open write transactions (sequence -> count).
    open: Mutex<BTreeMap<u64, usize>>,
    published: AtomicU64,
    poisoned: AtomicBool,
    stats: Arc<OccStats>,
    /// Commits sent to the pipeline that it has not taken off its queue yet (`OccKv::queued_commits`).
    queued: AtomicUsize,
    /// The commit log, once enabled: only the pipeline writes it (one record per accepted
    /// transaction, in the batch's own record-file commit).
    log: Mutex<Option<LogState>>,
    log_on: AtomicBool,
    /// The commit clock, once installed: the pipeline times each transaction it accepts.
    clock: Mutex<Option<Arc<CommitClock>>>,
}

impl Shared {
    fn register(&self, version: u64) {
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        *open.entry(version).or_insert(0) += 1;
    }

    fn unregister(&self, version: u64) {
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(n) = open.get_mut(&version) {
            *n -= 1;
            if *n == 0 {
                open.remove(&version);
            }
        }
    }

    fn oldest_open(&self) -> u64 {
        let open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        open.keys().next().copied().unwrap_or(u64::MAX)
    }
}

impl Drop for Shared {
    /// A clean close (the last handle of the store and of every transaction is gone, the pipeline
    /// has stopped and never failed, multi-user mode on) gives back the unused part of each reserved id range: a key
    /// whose committed sequence reached the next id loses its reservation, any other keeps it down
    /// to the next id (a transaction that ended without committing or writing its counters forward
    /// still holds the ids below). A reopen then numbers on with no gap. After a failed commit the
    /// reservations stay as they are: the next open starts above them. Errors are ignored: a
    /// reservation that stays is only a gap.
    fn drop(&mut self) {
        if self.poisoned.load(Ordering::Acquire) || !self.reserve_ids.load(Ordering::Acquire) {
            return;
        }
        let sequences = self.sequences.get_mut().unwrap_or_else(|p| p.into_inner());
        if sequences.values().all(|s| s.reserved.is_none()) {
            return;
        }
        let Ok((latest, _)) = self.base.versioned_snapshot() else {
            return;
        };
        let mut set = Vec::new();
        for (key, sequence) in sequences.iter() {
            let Some(reserved) = sequence.reserved else {
                continue;
            };
            let Ok(stored) = latest.get(key).and_then(|v| decode_u64_be(v.as_deref())) else {
                return;
            };
            if stored.unwrap_or(1) >= sequence.next {
                set.push((key.clone(), None));
            } else if reserved != sequence.next {
                set.push((key.clone(), Some(sequence.next)));
            }
        }
        drop(latest);
        if !set.is_empty() {
            let _ = self.base.set_id_reservations(&set);
        }
    }
}

/// The ordered commit pipeline: validates, assigns the commit sequence and writes each batch to
/// the record file as one durable commit. It runs on its own thread.
struct Pipeline {
    shared: Arc<Shared>,
    index: ConflictIndex,
    version: u64,
}

impl Pipeline {
    fn run(mut self, rx: Receiver<Msg>) {
        let mut pending: Option<Msg> = None;
        loop {
            let first = match pending.take() {
                Some(m) => m,
                None => match rx.recv() {
                    Ok(m) => m,
                    Err(_) => return,
                },
            };
            let first = match first {
                Msg::Commit(req) => {
                    self.shared.queued.fetch_sub(1, Ordering::AcqRel);
                    req
                }
                Msg::Exclusive { granted, end } => {
                    self.exclusive(granted, end);
                    continue;
                }
            };
            let mut bytes = approx_bytes(&first);
            let mut batch = vec![first];
            while batch.len() < MAX_BATCH_TXNS && bytes < MAX_BATCH_BYTES {
                match rx.try_recv() {
                    Ok(Msg::Commit(next)) => {
                        self.shared.queued.fetch_sub(1, Ordering::AcqRel);
                        bytes += approx_bytes(&next);
                        batch.push(next);
                    }
                    Ok(exclusive) => {
                        // Everything queued before the exclusive write commits first.
                        pending = Some(exclusive);
                        break;
                    }
                    Err(_) => break,
                }
            }
            self.commit_batch(batch);
        }
    }

    /// Holds the pipeline for one exclusive write: nothing else commits until it ends.
    fn exclusive(&mut self, granted: SyncSender<u64>, end: Receiver<Request>) {
        if granted.send(self.version).is_err() {
            return;
        }
        if let Ok(req) = end.recv() {
            self.commit_batch(vec![req]);
        }
    }

    fn commit_batch(&mut self, batch: Vec<Request>) {
        if self.shared.poisoned.load(Ordering::Acquire) {
            for req in batch {
                let _ = req.reply.send(Err(StoreError::io(
                    "an earlier commit failed; open the brain again",
                )));
            }
            return;
        }
        let next = self.version + 1;
        // Resolved writes of the accepted transactions, last write per key.
        let mut resolved: BTreeMap<Vec<u8>, Option<Vec<u8>>> = BTreeMap::new();
        let mut latest: Option<Box<dyn KvRead + Send>> = None;
        let mut accepted: Vec<Request> = Vec::new();
        let mut touched: Vec<Vec<u8>> = Vec::new();
        let clock = self
            .shared
            .clock
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        // Each accepted transaction's commit time, in accept order: each is above the one before.
        let mut times: Vec<i64> = Vec::new();
        for req in batch {
            match self.accept(&req, next, &mut resolved, &mut latest) {
                Ok(keys) => {
                    touched.extend(keys);
                    if let Some(clock) = &clock {
                        let position = CommitPosition::new(next, accepted.len() as u32);
                        times.push(clock.accept(position, times.last().copied()));
                    }
                    accepted.push(req);
                }
                Err(e) => {
                    if let Some(key) = conflict_key(&e) {
                        self.shared.stats.conflict_on(&key);
                    }
                    let _ = req.reply.send(Err(e));
                }
            }
        }
        drop(latest);
        if accepted.is_empty() {
            return;
        }
        let batch_time = times.last().copied();
        let mut log = self.shared.log.lock().unwrap_or_else(|p| p.into_inner());
        let mut append = None;
        let outcome = (|| -> Result<u64> {
            let mut tx = self.shared.base.begin_write()?;
            for (key, value) in &resolved {
                match value {
                    Some(v) => tx.put(key, v)?,
                    None => tx.delete(key)?,
                }
            }
            // With the log on: one record per accepted transaction, from its own buffered writes,
            // at (sequence, place in the batch), in this same record-file commit.
            if let Some(state) = log.as_ref() {
                if times.len() != accepted.len() {
                    // The log never records a made-up time: a logged commit needs the clock.
                    return Err(StoreError::new(
                        STORE_CORRUPT,
                        "the commit log is on but the commit has no commit time",
                    ));
                }
                let records: Vec<(CommitPosition, Vec<u8>)> = accepted
                    .iter()
                    .enumerate()
                    .map(|(i, req)| {
                        let origin = state.origin_for(&req.meta);
                        let value = crate::commit_log::encode_record(
                            &origin,
                            times[i],
                            &req.meta.write_ids,
                            req.writes.iter().map(|(k, op)| (k.as_slice(), log_op(op))),
                        );
                        (CommitPosition::new(next, i as u32), value)
                    })
                    .collect();
                append = Some(state.write(&mut *tx, &records)?);
            }
            if let Some(time) = batch_time {
                tx.set_commit_time(time);
            }
            tx.commit()
        })();
        match outcome {
            Ok(seq) if seq == next => {
                if let (Some(clock), Some(time)) = (&clock, batch_time) {
                    clock.committed(time);
                }
                if let (Some(state), Some(append)) = (log.as_mut(), append) {
                    state.applied(append);
                }
                drop(log);
                // A sequence raised by a direct write (a transaction rolling its counters
                // forward) is never handed out again from memory.
                {
                    let mut sequences = self
                        .shared
                        .sequences
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    for (key, value) in &resolved {
                        if let (Some(n), Some(v)) = (sequences.get_mut(key), value.as_deref())
                            && let Ok(Some(v)) = decode_u64_be(Some(v))
                        {
                            n.next = n.next.max(v);
                        }
                    }
                }
                self.version = next;
                self.shared.published.store(next, Ordering::Release);
                let n = accepted.len() as u64;
                let stats = &self.shared.stats;
                stats.commits.fetch_add(n, Ordering::Relaxed);
                stats.batches.fetch_add(1, Ordering::Relaxed);
                stats.max_batch.fetch_max(n, Ordering::Relaxed);
                for (i, req) in accepted.into_iter().enumerate() {
                    let _ = req.reply.send(Ok(CommitPosition::new(next, i as u32)));
                }
                let oldest = self.shared.oldest_open();
                self.index.prune(oldest, self.version);
            }
            other => {
                drop(log);
                // The batch may or may not be on disk. Stop: nothing later may build on it.
                self.shared.poisoned.store(true, Ordering::Release);
                let message = match other {
                    Ok(seq) => format!("the record file reported sequence {seq}, expected {next}"),
                    Err(e) => e.message,
                };
                for req in accepted {
                    let _ = req.reply.send(Err(StoreError::io(format!(
                        "record store commit failed: {message}"
                    ))));
                }
                // Forget what we accepted: those keys were never published.
                for key in touched {
                    self.index.last_write.remove(&key);
                }
            }
        }
    }

    /// Validates one request against the index and the batch so far. On success its writes are
    /// resolved into `resolved` and recorded in the index at `next`; returns the keys it wrote.
    fn accept(
        &mut self,
        req: &Request,
        next: u64,
        resolved: &mut BTreeMap<Vec<u8>, Option<Vec<u8>>>,
        latest: &mut Option<Box<dyn KvRead + Send>>,
    ) -> Result<Vec<Vec<u8>>> {
        if let Some(key) = self.index.first_conflict(req.snapshot, &req.reads) {
            return Err(conflict(&key));
        }
        if req.observes_sequence && (req.snapshot < self.version || !resolved.is_empty()) {
            return Err(conflict(&[]));
        }
        for (key, bound) in &req.guards {
            let current = self.current(key, resolved, latest)?;
            if decode_i64(current.as_deref())? > *bound {
                return Err(conflict(key));
            }
        }
        let mut out = Vec::with_capacity(req.writes.len());
        let mut staged = Vec::with_capacity(req.writes.len());
        for (key, op) in &req.writes {
            let value = match op {
                Op::Put(_) | Op::Delete => apply(op, None)?,
                Op::Add(_) | Op::Max(_) => {
                    let current = self.current(key, resolved, latest)?;
                    apply(op, current.as_deref())?
                }
            };
            staged.push((key.clone(), value));
        }
        for (key, value) in staged {
            self.index.last_write.insert(key.clone(), next);
            resolved.insert(key.clone(), value);
            out.push(key);
        }
        Ok(out)
    }

    /// The value of `key` after everything committed and accepted so far.
    fn current(
        &self,
        key: &[u8],
        resolved: &BTreeMap<Vec<u8>, Option<Vec<u8>>>,
        latest: &mut Option<Box<dyn KvRead + Send>>,
    ) -> Result<Option<Vec<u8>>> {
        if let Some(v) = resolved.get(key) {
            return Ok(v.clone());
        }
        if latest.is_none() {
            *latest = Some(self.shared.base.versioned_snapshot()?.0);
        }
        latest.as_ref().map_or(Ok(None), |s| s.get(key))
    }
}

/// The commit-log form of one buffered write.
fn log_op(op: &Op) -> LogOpRef<'_> {
    match op {
        Op::Put(v) => LogOpRef::Put(v),
        Op::Delete => LogOpRef::Delete,
        Op::Add(d) => LogOpRef::AddI64(*d),
        Op::Max(m) => LogOpRef::RaiseCounter(*m),
    }
}

fn approx_bytes(r: &Request) -> usize {
    r.writes
        .iter()
        .map(|(k, op)| {
            k.len()
                + match op {
                    Op::Put(v) => v.len(),
                    _ => 8,
                }
        })
        .sum()
}

// ---------------------------------------------------------------------------------------------
// The Kv
// ---------------------------------------------------------------------------------------------

/// A `Kv` that lets many write transactions run at once (see the module docs).
pub struct OccKv {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
    /// A pipeline with no thread, run by `step_pipeline` (`new_stepped`, the simulation seam).
    #[cfg(feature = "sim")]
    stepped: Mutex<Option<Stepped>>,
}

/// What `OccKv::step_pipeline` took and did (the simulation seam).
#[cfg(feature = "sim")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineStep {
    /// The batch's commit sequence; `None` when every request in it was refused.
    pub sequence: Option<u64>,
    pub taken: usize,
    pub accepted: usize,
    pub conflicts: usize,
}

/// The pipeline of a stepped `OccKv`, its queue, and a message a step took but left for the next one.
#[cfg(feature = "sim")]
struct Stepped {
    pipeline: Pipeline,
    rx: Receiver<Msg>,
    pending: Option<Msg>,
}

impl OccKv {
    /// Commits waiting on the pipeline's queue right now (sent, not yet taken into a batch). While an
    /// exclusive write holds the pipeline, this counts the commits that will form the next group
    /// commit, so a test can queue an exact batch, in an exact order, before it lets the pipeline go.
    pub fn queued_commits(&self) -> usize {
        self.shared.queued.load(Ordering::Acquire)
    }

    pub fn new(base: RedbKv) -> Result<OccKv> {
        Self::over(Arc::new(base))
    }

    pub(crate) fn over(base: Arc<dyn OccBase>) -> Result<OccKv> {
        let (shared, pipeline, rx) = Self::parts(base)?;
        let thread = std::thread::Builder::new()
            .name("gbrain-commit-pipeline".into())
            .spawn(move || pipeline.run(rx))
            .map_err(|e| StoreError::io(format!("starting the commit pipeline: {e}")))?;
        Ok(OccKv {
            shared,
            thread: Mutex::new(Some(thread)),
            #[cfg(feature = "sim")]
            stepped: Mutex::new(None),
        })
    }

    fn parts(base: Arc<dyn OccBase>) -> Result<(Arc<Shared>, Pipeline, Receiver<Msg>)> {
        let version = base.version()?;
        let (tx, rx) = channel::<Msg>();
        let shared = Arc::new(Shared {
            base,
            sender: Mutex::new(Some(tx)),
            locks: Arc::new(KeyLocks::default()),
            sequences: Mutex::new(HashMap::new()),
            reserve_ids: AtomicBool::new(false),
            open: Mutex::new(BTreeMap::new()),
            published: AtomicU64::new(version),
            poisoned: AtomicBool::new(false),
            stats: Arc::new(OccStats::default()),
            queued: AtomicUsize::new(0),
            log: Mutex::new(None),
            log_on: AtomicBool::new(false),
            clock: Mutex::new(None),
        });
        let pipeline = Pipeline {
            shared: shared.clone(),
            index: ConflictIndex {
                last_write: BTreeMap::new(),
                floor: version,
            },
            version,
        };
        Ok((shared, pipeline, rx))
    }

    /// Like [`OccKv::new`], but starts no pipeline thread: commits queue until
    /// [`OccKv::step_pipeline`] runs (the seeded simulation, `tests/multi_writer_sim.rs`).
    #[cfg(feature = "sim")]
    pub fn new_stepped(base: RedbKv) -> Result<OccKv> {
        let (shared, pipeline, rx) = Self::parts(Arc::new(base))?;
        Ok(OccKv {
            shared,
            thread: Mutex::new(None),
            stepped: Mutex::new(Some(Stepped {
                pipeline,
                rx,
                pending: None,
            })),
        })
    }

    /// One iteration of the pipeline loop on the calling thread: takes up to `max_batch` queued
    /// commits in arrival order (an exclusive-write message ends the batch, and a step that starts
    /// with one runs that exclusive write alone), validates and writes them as one batch and answers
    /// each. `Ok(None)` when nothing was queued; `invalid_state` on an `OccKv` that was not made
    /// with [`OccKv::new_stepped`].
    #[cfg(feature = "sim")]
    pub fn step_pipeline(&self, max_batch: usize) -> Result<Option<PipelineStep>> {
        let mut slot = self.stepped.lock().unwrap_or_else(|p| p.into_inner());
        let Some(stepped) = slot.as_mut() else {
            return Err(StoreError::new(
                crate::error::INVALID_STATE,
                "step_pipeline needs an OccKv made with new_stepped",
            ));
        };
        let take = |stepped: &mut Stepped| -> Option<Msg> {
            let msg = stepped
                .pending
                .take()
                .or_else(|| stepped.rx.try_recv().ok())?;
            Some(msg)
        };
        let Some(first) = take(stepped) else {
            return Ok(None);
        };
        let stats = &self.shared.stats;
        let commits_before = stats.commits.load(Ordering::Relaxed);
        let version_before = stepped.pipeline.version;
        let taken = match first {
            Msg::Exclusive { granted, end } => {
                stepped.pipeline.exclusive(granted, end);
                1
            }
            Msg::Commit(req) => {
                // `queued_commits` counts commits only, as the pipeline thread does.
                self.shared.queued.fetch_sub(1, Ordering::AcqRel);
                let mut batch = vec![req];
                while batch.len() < max_batch.max(1) {
                    match take(stepped) {
                        Some(Msg::Commit(next)) => {
                            self.shared.queued.fetch_sub(1, Ordering::AcqRel);
                            batch.push(next);
                        }
                        Some(exclusive) => {
                            stepped.pending = Some(exclusive);
                            break;
                        }
                        None => break,
                    }
                }
                let taken = batch.len();
                stepped.pipeline.commit_batch(batch);
                taken
            }
        };
        let accepted = (stats.commits.load(Ordering::Relaxed) - commits_before) as usize;
        let version = stepped.pipeline.version;
        Ok(Some(PipelineStep {
            sequence: (version != version_before).then_some(version),
            taken,
            accepted,
            conflicts: taken - accepted.min(taken),
        }))
    }

    pub fn stats(&self) -> Arc<OccStats> {
        self.shared.stats.clone()
    }

    /// Begins an exclusive write (see the module docs). Waits for the commits queued before it.
    fn begin_exclusive(&self) -> Result<Box<dyn KvWrite>> {
        let (granted_tx, granted) = sync_channel(1);
        let (end_tx, end) = sync_channel(1);
        {
            let sender = self.shared.sender.lock().unwrap_or_else(|p| p.into_inner());
            let Some(sender) = sender.as_ref() else {
                return Err(StoreError::new(STORE_CLOSED, "the brain is closing"));
            };
            sender
                .send(Msg::Exclusive {
                    granted: granted_tx,
                    end,
                })
                .map_err(|_| StoreError::new(STORE_CLOSED, "the brain is closing"))?;
        }
        let version = granted
            .recv()
            .map_err(|_| StoreError::new(STORE_CLOSED, "the brain is closing"))?;
        let mut txn = self.begin_inner(None, Some(end_tx))?;
        if txn.version != version {
            return Err(StoreError::new(
                STORE_CORRUPT,
                format!(
                    "the exclusive write sees sequence {}, the pipeline published {version}",
                    txn.version
                ),
            ));
        }
        txn.reads.get_mut().clear();
        Ok(txn)
    }

    fn begin(&self, locks: Option<LockGuard>) -> Result<Box<dyn KvWrite>> {
        Ok(self.begin_inner(locks, None)?)
    }

    fn begin_inner(
        &self,
        locks: Option<LockGuard>,
        exclusive: Option<SyncSender<Request>>,
    ) -> Result<Box<OccTxn>> {
        // Register before the snapshot, with a sequence no newer than the snapshot's, so the
        // index never forgets a write this transaction could conflict with.
        let floor = self.shared.published.load(Ordering::Acquire);
        self.shared.register(floor);
        let snapshot = match self.shared.base.versioned_snapshot() {
            Ok(s) => s,
            Err(e) => {
                self.shared.unregister(floor);
                return Err(e);
            }
        };
        Ok(Box::new(OccTxn {
            shared: self.shared.clone(),
            snap: snapshot.0,
            version: snapshot.1,
            registered: floor,
            reads: RefCell::new(Vec::new()),
            writes: BTreeMap::new(),
            guards: Vec::new(),
            observes_sequence: std::cell::Cell::new(false),
            meta: CommitMeta::default(),
            locks,
            exclusive,
        }))
    }
}

impl Drop for OccKv {
    fn drop(&mut self) {
        self.shared
            .sender
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(t) = self.thread.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = t.join();
        }
    }
}

impl Kv for OccKv {
    fn snapshot(&self) -> Result<Box<dyn KvRead>> {
        Ok(self.shared.base.versioned_snapshot()?.0)
    }

    fn versioned_snapshot(&self) -> Result<(Box<dyn KvRead + Send>, u64)> {
        self.shared.base.versioned_snapshot()
    }

    fn begin_write(&self) -> Result<Box<dyn KvWrite>> {
        self.begin(None)
    }

    fn begin_write_locked(&self, keys: &BTreeSet<Vec<u8>>) -> Result<Box<dyn KvWrite>> {
        self.begin_write_locked_until(keys, None)
    }

    fn begin_write_locked_until(
        &self,
        keys: &BTreeSet<Vec<u8>>,
        deadline: Option<Instant>,
    ) -> Result<Box<dyn KvWrite>> {
        let guard = self.shared.locks.acquire(keys, deadline)?;
        self.begin(Some(guard))
    }

    fn begin_write_exclusive(&self) -> Result<Box<dyn KvWrite>> {
        self.begin_exclusive()
    }

    fn version(&self) -> Result<u64> {
        Ok(self.shared.published.load(Ordering::Acquire))
    }

    fn occ_stats(&self) -> Option<OccStatsSnapshot> {
        Some(self.shared.stats.snapshot())
    }

    fn enable_commit_log(&self, settings: LogSettings) -> Result<()> {
        if self
            .shared
            .clock
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_none()
        {
            return Err(StoreError::new(
                crate::error::INVALID_STATE,
                "the commit log needs the commit clock (`Kv::set_commit_clock`) first",
            ));
        }
        let state = LogState::load(&*self.shared.base.snapshot()?, settings)?;
        *self.shared.log.lock().unwrap_or_else(|p| p.into_inner()) = Some(state);
        self.shared.log_on.store(true, Ordering::Release);
        Ok(())
    }

    fn commit_log_enabled(&self) -> bool {
        self.shared.log_on.load(Ordering::Acquire)
    }

    fn clear_commit_clock(&self) {
        *self.shared.clock.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    fn set_id_reservation(&self, on: bool) {
        let on = on && self.shared.base.keeps_id_reservations();
        self.shared.reserve_ids.store(on, Ordering::Release);
    }

    fn set_commit_clock(
        &self,
        clock: Arc<dyn crate::env::Env>,
        hook: Option<AcceptHook>,
    ) -> Result<()> {
        let mut slot = self.shared.clock.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_none() {
            let last = crate::commit_log::floor_time(&*self.shared.base.snapshot()?)?;
            *slot = Some(Arc::new(CommitClock::new(clock, last)));
        }
        if let Some(c) = slot.as_ref() {
            c.set_hook(hook);
        }
        Ok(())
    }
}

/// One optimistic write transaction.
struct OccTxn {
    shared: Arc<Shared>,
    snap: Box<dyn KvRead + Send>,
    version: u64,
    registered: u64,
    reads: RefCell<Vec<(Vec<u8>, Vec<u8>)>>,
    writes: BTreeMap<Vec<u8>, Op>,
    guards: Vec<(Vec<u8>, i64)>,
    /// Set by `observe_sequence` (see `Request::observes_sequence`).
    observes_sequence: std::cell::Cell<bool>,
    meta: CommitMeta,
    locks: Option<LockGuard>,
    /// Set on an exclusive write: its commit goes here, and dropping it lets the pipeline go on.
    exclusive: Option<SyncSender<Request>>,
}

impl Drop for OccTxn {
    fn drop(&mut self) {
        self.shared.unregister(self.registered);
    }
}

impl OccTxn {
    fn record(&self, start: Vec<u8>, end: Vec<u8>) {
        // Nothing commits while an exclusive write is open: its reads cannot go stale.
        if self.exclusive.is_some() {
            return;
        }
        self.reads.borrow_mut().push((start, end));
    }

    fn check_lock(&self, key: &[u8]) -> Result<()> {
        // A transaction that holds key locks never stops here: it took its locks in key order
        // before it started, so stopping could only cost it a retry.
        if self.locks.is_none() && self.exclusive.is_none() && self.shared.locks.held_by_other(key)
        {
            self.shared.stats.conflict_on(key);
            return Err(conflict(key));
        }
        Ok(())
    }
}

impl KvRead for OccTxn {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        match self.writes.get(key) {
            Some(op @ (Op::Put(_) | Op::Delete)) => return apply(op, None),
            Some(op) => {
                self.check_lock(key)?;
                self.record(key.to_vec(), key_successor(key));
                let base = self.snap.get(key)?;
                return apply(op, base.as_deref());
            }
            None => {}
        }
        self.check_lock(key)?;
        self.record(key.to_vec(), key_successor(key));
        self.snap.get(key)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        // The record file never yields keys that start with 0x00; neither do our own writes.
        let start = if start.first().is_none_or(|b| *b == 0) {
            &[1u8][..]
        } else {
            start
        };
        if start >= end {
            return Ok(());
        }
        let bounds = (Bound::Included(start), Bound::Excluded(end));
        let mut overlay: Vec<(&Vec<u8>, &Op)> = self.writes.range::<[u8], _>(bounds).collect();
        if reverse {
            overlay.reverse();
        }
        let mut pos = 0usize;
        let mut stopped_at: Option<Vec<u8>> = None;
        let mut failure: Option<StoreError> = None;
        // `before(a, b)`: a comes before b in scan order.
        let before = |a: &[u8], b: &[u8]| if reverse { a > b } else { a < b };
        {
            let mut emit =
                |k: &[u8], v: Option<Vec<u8>>, stopped_at: &mut Option<Vec<u8>>| -> bool {
                    match v {
                        Some(v) => {
                            if f(k, &v) {
                                true
                            } else {
                                *stopped_at = Some(k.to_vec());
                                false
                            }
                        }
                        None => true,
                    }
                };
            let mut keep_going = true;
            self.snap.scan(start, end, reverse, &mut |k, v| {
                // Our own writes that come before this stored key.
                while pos < overlay.len() && before(overlay[pos].0, k) {
                    let (ok, op) = overlay[pos];
                    pos += 1;
                    let value = match apply(op, None) {
                        Ok(v) => v,
                        Err(e) => {
                            failure = Some(e);
                            keep_going = false;
                            return false;
                        }
                    };
                    // An add or raise on a key the record file does not hold starts from 0.
                    if !emit(ok, value, &mut stopped_at) {
                        keep_going = false;
                        return false;
                    }
                }
                let value = if pos < overlay.len() && overlay[pos].0.as_slice() == k {
                    let op = overlay[pos].1;
                    pos += 1;
                    match apply(op, Some(v)) {
                        Ok(v) => v,
                        Err(e) => {
                            failure = Some(e);
                            keep_going = false;
                            return false;
                        }
                    }
                } else {
                    Some(v.to_vec())
                };
                if !emit(k, value, &mut stopped_at) {
                    keep_going = false;
                    return false;
                }
                true
            })?;
            if failure.is_none() && keep_going {
                while pos < overlay.len() {
                    let (ok, op) = overlay[pos];
                    pos += 1;
                    let value = apply(op, None)?;
                    if !emit(ok, value, &mut stopped_at) {
                        break;
                    }
                }
            }
        }
        if let Some(e) = failure {
            return Err(e);
        }
        // What the scan observed: everything up to the key it stopped at, else the whole range.
        match stopped_at {
            Some(k) if reverse => self.record(k, end.to_vec()),
            Some(k) => self.record(start.to_vec(), key_successor(&k)),
            None => self.record(start.to_vec(), end.to_vec()),
        }
        Ok(())
    }
}

impl KvWrite for OccTxn {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        reject_reserved(key)?;
        self.writes.insert(key.to_vec(), Op::Put(value.to_vec()));
        Ok(())
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        reject_reserved(key)?;
        self.writes.insert(key.to_vec(), Op::Delete);
        Ok(())
    }

    fn allocate(&mut self, key: &[u8], count: u64) -> Result<u64> {
        reject_reserved(key)?;
        let first = {
            let mut sequences = self
                .shared
                .sequences
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let mut sequence = match sequences.get(key) {
                Some(n) => *n,
                None => {
                    // Every allocation goes through this map once the brain is open, so the
                    // latest committed value is a safe start, raised to a durable reservation an
                    // earlier open left (it handed out ids below it that may not have committed).
                    let latest = self.shared.base.versioned_snapshot()?.0;
                    let stored = decode_u64_be(latest.get(key)?.as_deref())?.unwrap_or(1);
                    let reserved = if self.shared.base.keeps_id_reservations() {
                        self.shared.base.id_reservation(key)?
                    } else {
                        None
                    };
                    Sequence {
                        next: stored.max(reserved.unwrap_or(0)),
                        reserved,
                    }
                }
            };
            let next = sequence.next;
            let end = next.checked_add(count).ok_or_else(|| {
                StoreError::new(STORE_CORRUPT, "an id sequence ran past the largest id")
            })?;
            // Multi-user mode: reserve the range on disk before any id in it is handed out, so a
            // reopen after a crash starts above it. The pipeline never waits on this lock while it
            // holds the record file's writer, so the reservation's own commit cannot deadlock.
            if self.shared.reserve_ids.load(Ordering::Acquire)
                && sequence.reserved.is_none_or(|r| end > r)
            {
                let target = end.saturating_add(RESERVE_AHEAD);
                self.shared
                    .base
                    .set_id_reservations(&[(key.to_vec(), Some(target))])?;
                sequence.reserved = Some(target);
            }
            sequence.next = end;
            sequences.insert(key.to_vec(), sequence);
            next
        };
        let end = first + count;
        let op = match self.writes.get(key) {
            Some(Op::Max(m)) => Op::Max((*m).max(end)),
            Some(Op::Put(_) | Op::Delete | Op::Add(_)) => {
                return Err(StoreError::invalid(
                    "an id sequence key was also written directly",
                ));
            }
            None => Op::Max(end),
        };
        self.writes.insert(key.to_vec(), op);
        Ok(first)
    }

    fn raise_counter(&mut self, key: &[u8], value: u64) -> Result<()> {
        reject_reserved(key)?;
        let op = match self.writes.get(key) {
            None => Op::Max(value),
            Some(Op::Max(m)) => Op::Max((*m).max(value)),
            Some(op @ (Op::Put(_) | Op::Delete)) => {
                let current = decode_u64_be(apply(op, None)?.as_deref())?.unwrap_or(0);
                Op::Put(current.max(value).to_be_bytes().to_vec())
            }
            Some(Op::Add(_)) => {
                return Err(StoreError::invalid("an id sequence key is also a counter"));
            }
        };
        self.writes.insert(key.to_vec(), op);
        Ok(())
    }

    fn add_i64(&mut self, key: &[u8], delta: i64) -> Result<()> {
        reject_reserved(key)?;
        let op = match self.writes.get(key) {
            None => Op::Add(delta),
            Some(Op::Add(d)) => Op::Add(d.wrapping_add(delta)),
            Some(op @ (Op::Put(_) | Op::Delete)) => {
                let base = apply(op, None)?;
                let value = decode_i64(base.as_deref())?.wrapping_add(delta);
                Op::Put(value.to_le_bytes().to_vec())
            }
            Some(Op::Max(_)) => {
                return Err(StoreError::invalid("a counter key is also an id sequence"));
            }
        };
        self.writes.insert(key.to_vec(), op);
        Ok(())
    }

    fn counter_below(&mut self, key: &[u8], cap: i64) -> Result<Option<i64>> {
        match self.counter_check(key, cap)? {
            CounterCheck::Refused(value) => Ok(Some(value)),
            CounterCheck::Admitted { bound } => {
                // Accepted: commit only checks that the latest value still passes.
                self.add_guard(key, bound)?;
                Ok(None)
            }
        }
    }

    fn counter_check(&mut self, key: &[u8], cap: i64) -> Result<CounterCheck> {
        let pending = match self.writes.get(key) {
            None => 0,
            Some(Op::Add(d)) => *d,
            Some(_) => {
                // A key this transaction set outright: a plain read decides.
                let value = decode_i64(self.get(key)?.as_deref())?;
                return Ok(if value >= cap {
                    CounterCheck::Refused(value)
                } else {
                    CounterCheck::Admitted { bound: i64::MAX }
                });
            }
        };
        self.check_lock(key)?;
        let raw = self.snap.get(key)?;
        let seen = match decode_i64(raw.as_deref()) {
            Ok(v) => v,
            Err(e) => {
                // The failure depends on the stored value: a read like any other.
                self.record(key.to_vec(), key_successor(key));
                return Err(e);
            }
        };
        if seen + pending >= cap {
            // The refusal depends on the value: read it like any other read.
            self.record(key.to_vec(), key_successor(key));
            return Ok(CounterCheck::Refused(seen + pending));
        }
        Ok(CounterCheck::Admitted {
            bound: cap - 1 - pending,
        })
    }

    fn snapshot_sequence(&self) -> Option<u64> {
        Some(self.version)
    }

    fn observe_sequence(&self) -> Option<u64> {
        if self.exclusive.is_none() {
            self.observes_sequence.set(true);
        }
        Some(self.version)
    }

    fn refresh_snapshot(&mut self) -> Result<bool> {
        if self.exclusive.is_some()
            || !self.writes.is_empty()
            || !self.guards.is_empty()
            || self.observes_sequence.get()
        {
            return Ok(false);
        }
        // Register the new floor before the snapshot, as `begin_inner` does, then drop the old one.
        let floor = self.shared.published.load(Ordering::Acquire);
        self.shared.register(floor);
        let snapshot = match self.shared.base.versioned_snapshot() {
            Ok(s) => s,
            Err(e) => {
                self.shared.unregister(floor);
                return Err(e);
            }
        };
        self.shared.unregister(self.registered);
        self.registered = floor;
        self.snap = snapshot.0;
        self.version = snapshot.1;
        self.reads.get_mut().clear();
        Ok(true)
    }

    fn add_guard(&mut self, key: &[u8], bound: i64) -> Result<()> {
        if bound != i64::MAX {
            self.guards.push((key.to_vec(), bound));
        }
        Ok(())
    }

    fn set_commit_meta(&mut self, meta: CommitMeta) {
        self.meta = meta;
    }

    fn commit(self: Box<Self>) -> Result<u64> {
        self.commit_position().map(|p| p.sequence)
    }

    fn commit_position(self: Box<Self>) -> Result<CommitPosition> {
        let mut this = self;
        if this.writes.is_empty() {
            // Nothing to commit: the position this transaction saw, after its whole batch.
            return Ok(CommitPosition::end_of(this.version));
        }
        let (reply, answer) = sync_channel(1);
        let request = Request {
            snapshot: this.version,
            reads: std::mem::take(this.reads.get_mut()),
            guards: std::mem::take(&mut this.guards),
            writes: std::mem::take(&mut this.writes),
            observes_sequence: this.observes_sequence.get(),
            meta: std::mem::take(&mut this.meta),
            reply,
        };
        if let Some(end) = this.exclusive.take() {
            end.send(request)
                .map_err(|_| StoreError::new(STORE_CLOSED, "the brain is closing"))?;
        } else {
            let sender = this.shared.sender.lock().unwrap_or_else(|p| p.into_inner());
            let Some(sender) = sender.as_ref() else {
                return Err(StoreError::new(STORE_CLOSED, "the brain is closing"));
            };
            this.shared.queued.fetch_add(1, Ordering::AcqRel);
            if sender.send(Msg::Commit(request)).is_err() {
                this.shared.queued.fetch_sub(1, Ordering::AcqRel);
                return Err(StoreError::new(STORE_CLOSED, "the brain is closing"));
            }
        }
        let result = answer
            .recv()
            .unwrap_or_else(|_| Err(StoreError::new(STORE_CLOSED, "the brain is closing")));
        // Locks are released only after the commit is durable (or refused).
        drop(this.locks.take());
        result
    }
}

#[cfg(test)]
#[path = "occ_kv_fairness_tests.rs"]
mod key_lock_fairness_tests;

#[cfg(all(test, feature = "sim"))]
mod sim_seam_tests {
    use super::*;
    use crate::kv::Kv;

    fn stepped() -> Arc<OccKv> {
        let kv = crate::redb_kv::RedbKv::open_backend(Box::new(
            crate::test_support::FlakyFile::default(),
        ))
        .unwrap();
        Arc::new(OccKv::new_stepped(kv).unwrap())
    }

    /// Commits queue until a step takes them; a step batches in arrival order, refuses a stale
    /// read, and reports what it did.
    #[test]
    fn a_stepped_pipeline_commits_only_when_stepped() {
        let kv = stepped();
        assert_eq!(kv.step_pipeline(4).unwrap(), None);
        let mut stale = kv.begin_write().unwrap();
        assert_eq!(stale.get(b"yk").unwrap(), None);
        stale.put(b"ystale", b"x").unwrap();
        let commit = |kv: Arc<OccKv>, key: &'static [u8]| {
            std::thread::spawn(move || {
                let mut w = kv.begin_write().unwrap();
                w.put(key, b"v").unwrap();
                w.commit()
            })
        };
        let first = commit(kv.clone(), b"yk");
        while kv.queued_commits() < 1 {
            std::thread::yield_now();
        }
        let stale = std::thread::spawn(move || stale.commit());
        while kv.queued_commits() < 2 {
            std::thread::yield_now();
        }
        assert_eq!(kv.snapshot().unwrap().get(b"yk").unwrap(), None);
        let step = kv.step_pipeline(4).unwrap().unwrap();
        assert_eq!(
            step,
            PipelineStep {
                sequence: Some(1),
                taken: 2,
                accepted: 1,
                conflicts: 1
            }
        );
        assert_eq!(kv.queued_commits(), 0);
        assert_eq!(first.join().unwrap().unwrap(), 1);
        assert_eq!(
            stale.join().unwrap().unwrap_err().code,
            crate::error::WRITE_CONFLICT
        );
        assert!(
            OccKv::new(
                crate::redb_kv::RedbKv::open_backend(Box::new(
                    crate::test_support::FlakyFile::default()
                ))
                .unwrap()
            )
            .unwrap()
            .step_pipeline(1)
            .is_err()
        );
    }
}
