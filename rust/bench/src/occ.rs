//! The gbrain-owned optimistic transaction layer (FoundationDB style), shared by every base store.
//!
//! A transaction reads from a base-store snapshot (so it never blocks) and records the keys and
//! ranges it read plus the writes it makes in memory. Commit sends the transaction to ONE ordered
//! commit pipeline (a dedicated thread). For each transaction in arrival order the pipeline
//! checks the read set against every write committed after the transaction's snapshot AND every
//! write already accepted in the current batch, then gives it the next commit version. The whole
//! batch goes to the base store as one durable write transaction (group commit), together with
//! the commit log (version -> encoded write set) and `meta/version`. Only after the fsync does the
//! pipeline acknowledge the callers and publish the new version. Callers never hold the base
//! store's writer; a conflict is a typed `Error::Conflict` and the typed operations (`Db::run`)
//! re-run the closure from a fresh snapshot with a bounded budget and backoff.

use crate::kv::*;
use std::collections::{BTreeMap, VecDeque};
use std::ops::Bound;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, Sender, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const META_VERSION: &[u8] = b"m/version";

#[derive(Clone, Debug)]
pub struct Options {
    /// Append every batch to the commit log table (needed by a future follower; costs disk).
    pub commit_log: bool,
    pub max_batch_txns: usize,
    pub max_batch_bytes: usize,
    /// Attempts a typed operation makes before it reports `RetryBudgetExhausted`.
    pub retry_attempts: u32,
    /// How many recently written keys the conflict index remembers. A transaction whose snapshot
    /// is older than the forgotten history conflicts (and is retried) instead of risking a miss.
    pub history_keys: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            commit_log: true,
            max_batch_txns: 256,
            max_batch_bytes: 32 << 20,
            retry_attempts: 200,
            history_keys: 200_000,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WriteOp {
    Put(Vec<u8>),
    Delete,
    /// Atomic add on an 8-byte little-endian i64, applied by the pipeline against the latest
    /// committed value. It reads nothing, so it cannot conflict (the hot-key answer).
    AddI64(i64),
}

#[derive(Default)]
pub struct Stats {
    pub commits: AtomicU64,
    pub conflicts: AtomicU64,
    pub retries: AtomicU64,
    pub gave_up: AtomicU64,
    pub batches: AtomicU64,
    pub batched_txns: AtomicU64,
    pub max_batch: AtomicU64,
    pub store_commit_ns: AtomicU64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StatsSnapshot {
    pub commits: u64,
    pub conflicts: u64,
    pub retries: u64,
    pub gave_up: u64,
    pub batches: u64,
    pub batched_txns: u64,
    pub max_batch: u64,
    pub store_commit_ns: u64,
}

impl Stats {
    pub fn snapshot(&self) -> StatsSnapshot {
        let l = |a: &AtomicU64| a.load(Ordering::Relaxed);
        StatsSnapshot {
            commits: l(&self.commits),
            conflicts: l(&self.conflicts),
            retries: l(&self.retries),
            gave_up: l(&self.gave_up),
            batches: l(&self.batches),
            batched_txns: l(&self.batched_txns),
            max_batch: l(&self.max_batch),
            store_commit_ns: l(&self.store_commit_ns),
        }
    }
}

/// Last committed version recorded inside the snapshot itself.
pub fn read_version(snap: &dyn Snapshot) -> Result<u64> {
    match snap.get(Table::Data, META_VERSION)? {
        Some(v) if v.len() == 8 => Ok(u64::from_be_bytes(v.try_into().unwrap())),
        Some(_) => Err(Error::Corrupt("meta/version".into())),
        None => Ok(0),
    }
}

// ---------------------------------------------------------------------------------------------
// Conflict index
// ---------------------------------------------------------------------------------------------

/// Last commit version of every recently written key, ordered so a range read can be validated.
pub struct ConflictIndex {
    last_write: BTreeMap<Vec<u8>, u64>,
    history: VecDeque<(u64, Vec<u8>)>,
    /// Writes at versions <= floor may have been forgotten.
    floor: u64,
    max_keys: usize,
}

impl ConflictIndex {
    pub fn new(floor: u64, max_keys: usize) -> Self {
        Self {
            last_write: BTreeMap::new(),
            history: VecDeque::new(),
            floor,
            max_keys,
        }
    }

    pub fn record_write(&mut self, version: u64, key: &[u8]) {
        self.last_write.insert(key.to_vec(), version);
        self.history.push_back((version, key.to_vec()));
    }

    pub fn reset(&mut self, floor: u64) {
        self.last_write.clear();
        self.history.clear();
        self.floor = floor;
    }

    pub fn prune(&mut self) {
        while self.last_write.len() > self.max_keys {
            let Some((v, k)) = self.history.pop_front() else {
                break;
            };
            if self.last_write.get(&k) == Some(&v) {
                self.last_write.remove(&k);
            }
            self.floor = self.floor.max(v);
        }
    }

    /// True if anything the request read changed after its snapshot version.
    pub fn conflicts(&self, snapshot_version: u64, reads: &[(Vec<u8>, Vec<u8>)]) -> bool {
        if reads.is_empty() {
            return false;
        }
        if snapshot_version < self.floor {
            return true; // history this old was forgotten: be conservative
        }
        reads.iter().any(|(start, end)| {
            self.last_write
                .range::<[u8], _>((
                    Bound::Included(start.as_slice()),
                    Bound::Excluded(end.as_slice()),
                ))
                .any(|(_, v)| *v > snapshot_version)
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

pub struct CommitRequest {
    pub snapshot_version: u64,
    pub reads: Vec<(Vec<u8>, Vec<u8>)>,
    pub writes: Vec<(Vec<u8>, WriteOp)>,
}

/// What a transaction observed, kept only when tracing is on (the simulation test uses it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Observed {
    Get(Vec<u8>, Option<Vec<u8>>),
    Range {
        start: Vec<u8>,
        end: Vec<u8>,
        limit: usize,
        rows: Vec<(Vec<u8>, Vec<u8>)>,
    },
}

pub struct Txn {
    snap: Box<dyn Snapshot>,
    version: u64,
    reads: Vec<(Vec<u8>, Vec<u8>)>,
    writes: BTreeMap<Vec<u8>, WriteOp>,
    trace: Option<Vec<Observed>>,
}

impl Txn {
    pub fn begin(store: &dyn BaseStore) -> Result<Txn> {
        let snap = store.snapshot()?;
        let version = read_version(snap.as_ref())?;
        Ok(Txn {
            snap,
            version,
            reads: Vec::new(),
            writes: BTreeMap::new(),
            trace: None,
        })
    }

    pub fn enable_trace(&mut self) {
        self.trace = Some(Vec::new());
    }

    pub fn take_trace(&mut self) -> Vec<Observed> {
        self.trace.take().unwrap_or_default()
    }

    /// The version this transaction reads at.
    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn is_read_only(&self) -> bool {
        self.writes.is_empty()
    }

    pub fn get(&mut self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        if let Some(op) = self.writes.get(key) {
            return match op {
                WriteOp::Put(v) => Ok(Some(v.clone())),
                WriteOp::Delete => Ok(None),
                WriteOp::AddI64(_) => Err(Error::Unsupported(
                    "read of a key with a pending atomic add",
                )),
            };
        }
        self.reads.push((key.to_vec(), key_successor(key)));
        let v = self.snap.get(Table::Data, key)?;
        if let Some(t) = &mut self.trace {
            t.push(Observed::Get(key.to_vec(), v.clone()));
        }
        Ok(v)
    }

    /// Up to `limit` entries in `[start, end)`, in key order, including this transaction's own writes.
    pub fn range(
        &mut self,
        start: &[u8],
        end: &[u8],
        limit: usize,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        if limit == 0 || start >= end {
            return Ok(Vec::new());
        }
        let bounds = (Bound::Included(start), Bound::Excluded(end));
        let overlay: Vec<(&Vec<u8>, &WriteOp)> = self.writes.range::<[u8], _>(bounds).collect();
        if overlay
            .iter()
            .any(|(_, op)| matches!(op, WriteOp::AddI64(_)))
        {
            return Err(Error::Unsupported(
                "range over a key with a pending atomic add",
            ));
        }
        let mut merged: BTreeMap<Vec<u8>, Vec<u8>> = BTreeMap::new();
        let want = limit + overlay.len();
        self.snap
            .scan(Table::Data, start, end, false, &mut |k, v| {
                merged.insert(k.to_vec(), v.to_vec());
                merged.len() < want
            })?;
        for (k, op) in overlay {
            match op {
                WriteOp::Put(v) => {
                    merged.insert(k.clone(), v.clone());
                }
                WriteOp::Delete => {
                    merged.remove(k);
                }
                WriteOp::AddI64(_) => unreachable!(),
            }
        }
        let rows: Vec<(Vec<u8>, Vec<u8>)> = merged.into_iter().take(limit).collect();
        // Everything up to the last returned key was observed; if the page was not full, the whole range was.
        let read_end = if rows.len() == limit {
            key_successor(&rows[rows.len() - 1].0)
        } else {
            end.to_vec()
        };
        self.reads.push((start.to_vec(), read_end));
        if let Some(t) = &mut self.trace {
            t.push(Observed::Range {
                start: start.to_vec(),
                end: end.to_vec(),
                limit,
                rows: rows.clone(),
            });
        }
        Ok(rows)
    }

    pub fn put(&mut self, key: Vec<u8>, value: Vec<u8>) {
        self.writes.insert(key, WriteOp::Put(value));
    }

    pub fn delete(&mut self, key: Vec<u8>) {
        self.writes.insert(key, WriteOp::Delete);
    }

    /// Atomic add that cannot conflict. Must not follow a put or delete of the same key.
    pub fn add_i64(&mut self, key: Vec<u8>, delta: i64) -> Result<()> {
        match self.writes.get_mut(&key) {
            None => {
                self.writes.insert(key, WriteOp::AddI64(delta));
                Ok(())
            }
            Some(WriteOp::AddI64(d)) => {
                *d += delta;
                Ok(())
            }
            Some(_) => Err(Error::Unsupported(
                "atomic add after put or delete of the same key",
            )),
        }
    }

    pub fn into_request(self) -> CommitRequest {
        CommitRequest {
            snapshot_version: self.version,
            reads: self.reads,
            writes: self.writes.into_iter().collect(),
        }
    }
}

/// A transaction's resolved writes: key and `Some(value)` for a put, `None` for a delete.
pub type WriteSet = Vec<(Vec<u8>, Option<Vec<u8>>)>;

pub fn encode_write_set(writes: &[(Vec<u8>, Option<Vec<u8>>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(writes.len() as u32).to_le_bytes());
    for (k, v) in writes {
        out.extend_from_slice(&(k.len() as u32).to_le_bytes());
        out.extend_from_slice(k);
        match v {
            Some(v) => {
                out.push(1);
                out.extend_from_slice(&(v.len() as u32).to_le_bytes());
                out.extend_from_slice(v);
            }
            None => out.push(0),
        }
    }
    out
}

pub fn decode_write_set(buf: &[u8]) -> Result<WriteSet> {
    fn take<'a>(buf: &'a [u8], pos: &mut usize, n: usize) -> Result<&'a [u8]> {
        let s = buf
            .get(*pos..*pos + n)
            .ok_or_else(|| Error::Corrupt("commit log entry truncated".into()))?;
        *pos += n;
        Ok(s)
    }
    let mut pos = 0;
    let n = u32::from_le_bytes(take(buf, &mut pos, 4)?.try_into().unwrap()) as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let kl = u32::from_le_bytes(take(buf, &mut pos, 4)?.try_into().unwrap()) as usize;
        let k = take(buf, &mut pos, kl)?.to_vec();
        let tag = take(buf, &mut pos, 1)?[0];
        let v = if tag == 1 {
            let vl = u32::from_le_bytes(take(buf, &mut pos, 4)?.try_into().unwrap()) as usize;
            Some(take(buf, &mut pos, vl)?.to_vec())
        } else {
            None
        };
        out.push((k, v));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// The commit pipeline core (pure and synchronous, so the simulation can drive it directly)
// ---------------------------------------------------------------------------------------------

pub struct Committer {
    store: Arc<dyn BaseStore>,
    idx: ConflictIndex,
    version: u64,
    opts: Options,
}

impl Committer {
    pub fn new(store: Arc<dyn BaseStore>, opts: Options) -> Result<Self> {
        let version = read_version(store.snapshot()?.as_ref())?;
        Ok(Self {
            idx: ConflictIndex::new(version, opts.history_keys),
            store,
            version,
            opts,
        })
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    /// Validate in order, assign versions, write the batch durably in one base-store transaction.
    /// Returns one result per request, in order: the commit version or `Conflict`.
    pub fn commit_batch(
        &mut self,
        reqs: Vec<CommitRequest>,
        stats: Option<&Stats>,
    ) -> Vec<Result<u64>> {
        let mut results: Vec<Result<u64>> = Vec::with_capacity(reqs.len());
        let mut batch = WriteBatch::default();
        let mut next = self.version;
        let mut accepted = 0usize;
        let mut snap: Option<Box<dyn Snapshot>> = None;

        for req in reqs {
            // The index already holds every committed write and every write accepted earlier in
            // this batch, so one check covers both.
            if self.idx.conflicts(req.snapshot_version, &req.reads) {
                results.push(Err(Error::Conflict));
                continue;
            }
            next += 1;
            let mut resolved: Vec<(Vec<u8>, Option<Vec<u8>>)> =
                Vec::with_capacity(req.writes.len());
            let mut failed = None;
            for (key, op) in req.writes {
                let value = match op {
                    WriteOp::Put(v) => Some(v),
                    WriteOp::Delete => None,
                    WriteOp::AddI64(delta) => {
                        match self.resolve_add(&batch, &mut snap, &key, delta) {
                            Ok(v) => Some(v),
                            Err(e) => {
                                failed = Some(e);
                                break;
                            }
                        }
                    }
                };
                resolved.push((key, value));
            }
            if let Some(e) = failed {
                next -= 1;
                results.push(Err(e));
                continue;
            }
            for (key, value) in &resolved {
                self.idx.record_write(next, key);
                match value {
                    Some(v) => batch.put(Table::Data, key.clone(), v.clone()),
                    None => batch.delete(Table::Data, key.clone()),
                }
            }
            if self.opts.commit_log {
                batch.put(
                    Table::Log,
                    next.to_be_bytes().to_vec(),
                    encode_write_set(&resolved),
                );
            }
            results.push(Ok(next));
            accepted += 1;
        }
        drop(snap);

        if accepted > 0 {
            batch.put(
                Table::Data,
                META_VERSION.to_vec(),
                next.to_be_bytes().to_vec(),
            );
            let t0 = Instant::now();
            let res = self.store.commit(&batch);
            if let Some(s) = stats {
                s.store_commit_ns
                    .fetch_add(t0.elapsed().as_nanos() as u64, Ordering::Relaxed);
            }
            match res {
                Ok(()) => {
                    self.version = next;
                    self.idx.prune();
                    if let Some(s) = stats {
                        s.batches.fetch_add(1, Ordering::Relaxed);
                        s.batched_txns.fetch_add(accepted as u64, Ordering::Relaxed);
                        s.max_batch.fetch_max(accepted as u64, Ordering::Relaxed);
                        s.commits.fetch_add(accepted as u64, Ordering::Relaxed);
                    }
                }
                Err(e) => {
                    // Nothing in this batch is durable. Forget the index (spurious conflicts are
                    // safe) and fail every accepted transaction.
                    self.idx.reset(self.version);
                    let msg = e.to_string();
                    for r in results.iter_mut() {
                        if r.is_ok() {
                            *r = Err(Error::Store(msg.clone()));
                        }
                    }
                }
            }
        }
        results
    }

    fn resolve_add(
        &self,
        batch: &WriteBatch,
        snap: &mut Option<Box<dyn Snapshot>>,
        key: &[u8],
        delta: i64,
    ) -> Result<Vec<u8>> {
        // Latest value: newest write to this key earlier in the batch, else the committed value.
        let earlier = batch
            .ops
            .iter()
            .rev()
            .find(|op| op.table == Table::Data && op.key == key)
            .map(|op| op.value.clone());
        let current = match earlier {
            Some(v) => v,
            None => {
                if snap.is_none() {
                    *snap = Some(self.store.snapshot()?);
                }
                snap.as_ref().unwrap().get(Table::Data, key)?
            }
        };
        let base = match current {
            None => 0i64,
            Some(v) if v.len() == 8 => i64::from_le_bytes(v.try_into().unwrap()),
            Some(_) => return Err(Error::Corrupt("atomic add on a non-counter value".into())),
        };
        Ok(base.wrapping_add(delta).to_le_bytes().to_vec())
    }
}

// ---------------------------------------------------------------------------------------------
// The database handle
// ---------------------------------------------------------------------------------------------

struct Pending {
    req: CommitRequest,
    reply: SyncSender<Result<u64>>,
}

pub struct Ticket {
    rx: Receiver<Result<u64>>,
}

impl Ticket {
    pub fn wait(self) -> Result<u64> {
        self.rx.recv().unwrap_or(Err(Error::Closed))
    }
}

pub struct Db {
    store: Arc<dyn BaseStore>,
    tx: Option<Sender<Pending>>,
    thread: Option<JoinHandle<()>>,
    pub stats: Arc<Stats>,
    published: Arc<AtomicU64>,
    opts: Options,
}

impl Db {
    pub fn open(store: Arc<dyn BaseStore>, opts: Options) -> Result<Db> {
        let mut committer = Committer::new(store.clone(), opts.clone())?;
        let published = Arc::new(AtomicU64::new(committer.version()));
        let stats = Arc::new(Stats::default());
        let (tx, rx) = channel::<Pending>();
        let (pub2, stats2) = (published.clone(), stats.clone());
        let (max_txns, max_bytes) = (opts.max_batch_txns, opts.max_batch_bytes);
        let thread = std::thread::Builder::new()
            .name("gbrain-commit-pipeline".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let mut pending = vec![first];
                    let mut bytes = approx_bytes(&pending[0].req);
                    while pending.len() < max_txns && bytes < max_bytes {
                        match rx.try_recv() {
                            Ok(p) => {
                                bytes += approx_bytes(&p.req);
                                pending.push(p);
                            }
                            Err(_) => break,
                        }
                    }
                    let (reqs, replies): (Vec<_>, Vec<_>) =
                        pending.into_iter().map(|p| (p.req, p.reply)).unzip();
                    let results = committer.commit_batch(reqs, Some(&stats2));
                    // Durable now: publish the version, then acknowledge.
                    pub2.store(committer.version(), Ordering::Release);
                    for (r, reply) in results.into_iter().zip(replies) {
                        let _ = reply.send(r);
                    }
                }
            })
            .map_err(store_err)?;
        Ok(Db {
            store,
            tx: Some(tx),
            thread: Some(thread),
            stats,
            published,
            opts,
        })
    }

    pub fn store_name(&self) -> &'static str {
        self.store.name()
    }

    pub fn store(&self) -> &Arc<dyn BaseStore> {
        &self.store
    }

    pub fn options(&self) -> &Options {
        &self.opts
    }

    /// Latest durable version published by the pipeline.
    pub fn published_version(&self) -> u64 {
        self.published.load(Ordering::Acquire)
    }

    pub fn begin(&self) -> Result<Txn> {
        Txn::begin(self.store.as_ref())
    }

    /// A plain snapshot read: no transaction, no read set, never blocks.
    pub fn read<T>(&self, f: impl FnOnce(&dyn Snapshot) -> Result<T>) -> Result<T> {
        let snap = self.store.snapshot()?;
        f(snap.as_ref())
    }

    /// Queue a transaction for commit without waiting. Read-only transactions finish at once.
    pub fn submit(&self, txn: Txn) -> Result<Ticket> {
        let (rtx, rrx) = sync_channel(1);
        if txn.is_read_only() {
            let _ = rtx.send(Ok(txn.version()));
            return Ok(Ticket { rx: rrx });
        }
        let req = txn.into_request();
        self.tx
            .as_ref()
            .ok_or(Error::Closed)?
            .send(Pending { req, reply: rtx })
            .map_err(|_| Error::Closed)?;
        Ok(Ticket { rx: rrx })
    }

    /// Commit once. May return `Error::Conflict`; callers that want retries use `run`.
    pub fn commit(&self, txn: Txn) -> Result<u64> {
        let t = self.submit(txn)?;
        let r = t.wait();
        if matches!(r, Err(Error::Conflict)) {
            self.stats.conflicts.fetch_add(1, Ordering::Relaxed);
        }
        r
    }

    /// The typed-operation entry point: run `f` in a transaction and commit. On a conflict, rerun
    /// `f` from a new snapshot (never re-applying old writes) with bounded attempts and backoff.
    /// Callers never see a busy error; at worst they see `RetryBudgetExhausted`.
    pub fn run<T>(&self, f: impl FnMut(&mut Txn) -> Result<T>) -> Result<T> {
        self.run_versioned(f).map(|(out, _)| out)
    }

    /// Like `run`, also returning the commit version (the snapshot version for a read-only run).
    pub fn run_versioned<T>(&self, mut f: impl FnMut(&mut Txn) -> Result<T>) -> Result<(T, u64)> {
        let mut attempt = 0u32;
        loop {
            let mut txn = self.begin()?;
            let out = f(&mut txn)?;
            match self.commit(txn) {
                Ok(version) => return Ok((out, version)),
                Err(Error::Conflict) => {
                    attempt += 1;
                    if attempt >= self.opts.retry_attempts {
                        self.stats.gave_up.fetch_add(1, Ordering::Relaxed);
                        return Err(Error::RetryBudgetExhausted { attempts: attempt });
                    }
                    self.stats.retries.fetch_add(1, Ordering::Relaxed);
                    backoff(attempt);
                }
                Err(e) => return Err(e),
            }
        }
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn approx_bytes(r: &CommitRequest) -> usize {
    r.writes
        .iter()
        .map(|(k, op)| {
            k.len()
                + match op {
                    WriteOp::Put(v) => v.len(),
                    _ => 8,
                }
        })
        .sum()
}

/// Randomised exponential backoff: up to 20us * 2^attempt, capped at 5 ms.
fn backoff(attempt: u32) {
    use std::cell::Cell;
    thread_local! { static SEED: Cell<u64> = const { Cell::new(0) }; }
    let r = SEED.with(|s| {
        let mut x = s.get();
        if x == 0 {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(1);
            x = nanos ^ ((&x as *const u64 as u64) << 7) ^ 0x9E37_79B9_7F4A_7C15;
        }
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        x
    });
    let cap_us = (20u64 << attempt.min(8)).min(5_000);
    std::thread::sleep(Duration::from_micros(1 + r % cap_us));
}
