//! Transactions and the page-key lock queue (core).
//!
//! Members: transaction, transactionDirect, lockPageKeys. The TypeScript wrapper
//! (`src/core/rust-engine.ts`) owns the callback, the writer gate and the re-entry guard; this file
//! owns what the store does while a transaction is open. The full contract is in
//! `rust/docs/store/transactions.md`.
//!
//! One open transaction is a [`Transaction`]: the store's single write transaction (the `base`,
//! taken with `Kv::begin_write_exclusive`, so it holds the writer until it ends) plus a stack of in-memory
//! layers above it. A [`Store`] bound to a transaction ([`Store::begin_transaction`]) runs every
//! family method against it unchanged:
//!
//! - `Store::write(f)` runs `f` as one statement: a layer is pushed, `f` writes into it, and the
//!   layer merges into the layer below when `f` returns `Ok` and is dropped when it returns `Err`.
//!   A failed statement leaves the transaction usable, as a PGLite savepoint does.
//! - `Store::read()` reads the merged view (statement, then savepoints top down, then the base),
//!   so the transaction reads its own writes.
//! - A savepoint ([`Store::savepoint`]) is another layer. Releasing it merges it into its parent;
//!   rolling it back drops it. Only [`Store::commit_transaction`] calls the record store's commit.
//!
//! Allocators never roll back. A counter is a meta record (`keys::meta`) whose name starts with
//! `next_` and whose value is 8 bytes (the big-endian next id). Ids come from `KvWrite::allocate`,
//! which a bound statement sends straight to the base, under every layer, so dropping a layer
//! does not give its ids back (and, with concurrent writes on, the ids are shared with the other
//! writers). A counter written directly is remembered at its highest value and written back into
//! the layer below when a layer is dropped. When the whole transaction rolls back (or its last
//! handle goes away without ending it), the base write that held the writer puts back every key the
//! transaction wrote, raises every counter it advanced (`KvWrite::raise_counter`) and commits, so
//! the writer is released only after the counters are saved. An id handed out inside a
//! rolled-back transaction is never handed out again, also after a reopen.
//!
//! Keys: `keys::LOCK_QUEUE` (`w`) is reserved for this file. No `w` record is written: a page-key
//! lock is held in memory by the transaction that took it, because an explicit transaction holds
//! the store's writer exclusively (`Kv::begin_write_exclusive`; with concurrent writes on, no
//! other commit lands until it ends), so no other writer can reach a held key before the
//! transaction ends. The tag stays reserved for a lock queue that outlives a transaction; its
//! bytes after the tag are this file's to define then.
//!
//! A scan callback must not call the store: the merged scan holds the transaction's state lock
//! while it runs.
//!
//! Time: a bound store reads one time for the whole transaction, the time it began
//! ([`TransactionClock`]), as PGLite's `now()` returns the transaction's start time. Two rows written
//! in one transaction carry the same `created_at`. Fresh identifiers still come from the brain's
//! own source.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Bound;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::commit_log::{CommitMeta, CommitPosition};
use crate::env::Env;
use crate::error::{
    INVALID_STATE, READ_ONLY_TRANSACTION, Result, SOURCE_CHANGED, SOURCE_NOT_FOUND, STORE_CLOSED,
    StoreError,
};
use crate::kv::{Kv, KvRead, KvWrite};
use crate::{Store, keys, sources};

/// The clock of a bound store: the transaction's start time for every read of the time, and the
/// brain's own identifiers.
pub(crate) struct TransactionClock {
    started_us: i64,
    inner: Arc<dyn Env>,
}

impl TransactionClock {
    pub(crate) fn starting_now(inner: Arc<dyn Env>) -> Self {
        TransactionClock {
            started_us: inner.now_micros(),
            inner,
        }
    }
}

impl Env for TransactionClock {
    fn now_micros(&self) -> i64 {
        self.started_us
    }

    /// The moment of the call, never before the transaction's start.
    fn clock_micros(&self) -> i64 {
        self.inner.clock_micros().max(self.started_us)
    }

    fn new_uuid(&self) -> String {
        self.inner.new_uuid()
    }
}

/// Overlay writes: `None` is a delete.
type Writes = BTreeMap<Vec<u8>, Option<Vec<u8>>>;

/// A page key a transaction holds: `(source_id, slug)`. Ordered by source, then slug.
pub type HeldKey = (String, String);

/// One page key to lock, as `lockPageKeys` passes it after its checks (exact source, valid slug).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PageKeyHint {
    pub source_id: String,
    pub slug: String,
    /// The source incarnation the caller expects. Checked only when the call is `hinted`.
    pub incarnation: Option<String>,
}

#[derive(Default)]
struct Layer {
    writes: Writes,
    locks: BTreeSet<HeldKey>,
    /// What the layer's statements say about themselves for the commit record (multi-user mode):
    /// kept and dropped with the layer's writes.
    meta: CommitMeta,
}

struct State {
    /// The record store's write transaction. `None` once the transaction has ended.
    base: Option<Box<dyn KvWrite>>,
    /// Page keys held by the transaction itself (taken outside any savepoint).
    root_locks: BTreeSet<HeldKey>,
    savepoints: Vec<Layer>,
    /// The layer of the statement that is running, above every savepoint.
    statement: Option<Layer>,
    /// The highest value each counter took in this transaction.
    counters: BTreeMap<Vec<u8>, u64>,
    /// The highest value each sequence took through `allocate`. Allocations go to the base
    /// directly and never roll back with a layer; only a whole-transaction rollback writes
    /// these forward.
    allocated: BTreeMap<Vec<u8>, u64>,
    /// The value each key held before the transaction first wrote it into the base (`None`:
    /// absent). A rollback that must write sequences forward puts these back in the same base
    /// write, so it never releases the writer before the sequences are saved.
    undo: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    /// The commit meta of the statements merged into the base (`Layer::meta`).
    meta: CommitMeta,
}

/// An open transaction. Shared by the bound [`Store`] and every reader it hands out.
pub struct Transaction {
    state: Mutex<State>,
    /// Held for a whole statement, savepoint change, commit or rollback, so two of them never
    /// interleave on one layer stack. Readers do not take it.
    exclusive: Mutex<()>,
    kv: Arc<dyn Kv>,
    /// Set at `begin_transaction` or by `set_transaction_read_only`; never cleared while it is open.
    read_only: AtomicBool,
    /// Opened read-only, so it never wrote and its commit writes nothing.
    opened_read_only: bool,
}

/// A transaction whose handles all went away without a commit or a rollback rolls back the same
/// way, so its ids are written forward before the writer is released.
impl Drop for Transaction {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap_or_else(|e| e.into_inner());
        let _ = state.roll_back();
    }
}

fn closed() -> StoreError {
    StoreError::new(STORE_CLOSED, "the transaction has ended")
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
thread_local! {
    /// Test seam: runs on the rolling-back thread right after the rollback releases the writer.
    static ROLLBACK_RELEASED_WRITER: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Where a rollback has released the store's writer: the test seam runs here.
fn rollback_released_writer() {
    #[cfg(test)]
    if let Some(hook) = ROLLBACK_RELEASED_WRITER.with(|h| h.borrow_mut().take()) {
        hook();
    }
}

/// True for an allocator record: `M` + `next_...` holding 8 bytes.
fn counter_value(key: &[u8], value: &[u8]) -> Option<u64> {
    if key.first() != Some(&keys::META) || !key[1..].starts_with(b"next_") {
        return None;
    }
    keys::be8(value)
}

fn in_range(key: &[u8], start: &[u8], end: &[u8]) -> bool {
    key >= start && key < end
}

impl State {
    fn base(&self) -> Result<&dyn KvWrite> {
        self.base.as_deref().ok_or_else(closed)
    }

    /// The overlay layers, top first.
    fn layers_top_down(&self) -> impl Iterator<Item = &Layer> {
        self.statement.iter().chain(self.savepoints.iter().rev())
    }

    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let base = self.base()?;
        for layer in self.layers_top_down() {
            if let Some(value) = layer.writes.get(key) {
                return Ok(value.clone());
            }
        }
        base.get(key)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        let base = self.base()?;
        if start >= end {
            return Ok(());
        }
        // The overlay entries in range, the higher layer winning.
        let mut overlay: Writes = BTreeMap::new();
        let range = (
            Bound::Included(start.to_vec()),
            Bound::Excluded(end.to_vec()),
        );
        for layer in self.statement.iter().chain(self.savepoints.iter().rev()) {
            for (key, value) in layer.writes.range::<Vec<u8>, _>(range.clone()) {
                overlay.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
        if overlay.is_empty() {
            return base.scan(start, end, reverse, f);
        }
        let entries: Vec<(Vec<u8>, Option<Vec<u8>>)> = if reverse {
            overlay.into_iter().rev().collect()
        } else {
            overlay.into_iter().collect()
        };
        // `before(a, b)`: `a` comes first in scan order.
        let before = |a: &[u8], b: &[u8]| if reverse { a > b } else { a < b };
        let mut next = 0usize;
        let mut stopped = false;
        base.scan(start, end, reverse, &mut |key, value| {
            while next < entries.len() && before(&entries[next].0, key) {
                let (k, v) = &entries[next];
                next += 1;
                if let Some(v) = v
                    && !f(k, v)
                {
                    stopped = true;
                    return false;
                }
            }
            if next < entries.len() && entries[next].0 == key {
                let (k, v) = &entries[next];
                next += 1;
                return match v {
                    Some(v) => {
                        let go = f(k, v);
                        stopped = !go;
                        go
                    }
                    None => true,
                };
            }
            let go = f(key, value);
            stopped = !go;
            go
        })?;
        if !stopped {
            for (key, value) in &entries[next..] {
                if let Some(value) = value
                    && in_range(key, start, end)
                    && !f(key, value)
                {
                    break;
                }
            }
        }
        Ok(())
    }

    /// Writes into the top layer: the statement, else the top savepoint, else the base.
    fn write_top(&mut self, key: &[u8], value: Option<&[u8]>) -> Result<()> {
        if self.base.is_none() {
            return Err(closed());
        }
        if let Some(v) = value.and_then(|v| counter_value(key, v)) {
            let seen = self.counters.entry(key.to_vec()).or_insert(v);
            *seen = (*seen).max(v);
        }
        let layer = match self.statement.as_mut() {
            Some(layer) => Some(layer),
            None => self.savepoints.last_mut(),
        };
        match layer {
            Some(layer) => {
                layer.writes.insert(key.to_vec(), value.map(<[u8]>::to_vec));
                Ok(())
            }
            None => self.write_base(key, value),
        }
    }

    /// Writes into the base, first keeping what the key held before (`undo`).
    fn write_base(&mut self, key: &[u8], value: Option<&[u8]>) -> Result<()> {
        let base = self.base.as_mut().ok_or_else(closed)?;
        if !self.undo.contains_key(key) {
            self.undo.insert(key.to_vec(), base.get(key)?);
        }
        match value {
            Some(v) => base.put(key, v),
            None => base.delete(key),
        }
    }

    /// Takes `count` ids from the base's allocator and remembers the highest value the sequence
    /// took, so a rollback writes it forward.
    fn allocate(&mut self, key: &[u8], count: u64) -> Result<u64> {
        if self
            .layers_top_down()
            .any(|layer| layer.writes.contains_key(key))
        {
            return Err(StoreError::new(
                INVALID_STATE,
                "an id sequence key was also written directly inside the transaction",
            ));
        }
        let base = self.base.as_mut().ok_or_else(closed)?;
        let first = base.allocate(key, count)?;
        let end = first + count;
        let seen = self.allocated.entry(key.to_vec()).or_insert(end);
        *seen = (*seen).max(end);
        Ok(first)
    }

    /// Merges `layer` into what is now the top (the statement's parent savepoint, or the base).
    fn merge_down(&mut self, layer: Layer) -> Result<()> {
        if let Some(parent) = self.savepoints.last_mut() {
            parent.writes.extend(layer.writes);
            parent.locks.extend(layer.locks);
            parent.meta.absorb(layer.meta);
            return Ok(());
        }
        self.root_locks.extend(layer.locks);
        self.meta.absorb(layer.meta);
        self.base()?;
        for (key, value) in layer.writes {
            self.write_base(&key, value.as_deref())?;
        }
        Ok(())
    }

    /// Ends the transaction without keeping its writes. With no sequence to write forward the
    /// base is dropped. Otherwise, in the same base write and so before the writer is released,
    /// every key the transaction wrote gets its earlier value back, every sequence is raised to
    /// the highest value the transaction took, and that write commits: no other writer can take
    /// an id the transaction handed out. Rolling back an ended transaction does nothing.
    fn roll_back(&mut self) -> Result<()> {
        let Some(mut base) = self.base.take() else {
            return Ok(());
        };
        self.savepoints.clear();
        self.statement = None;
        self.root_locks.clear();
        // A rollback carries no write: its commit (counters only) names no request.
        self.meta = CommitMeta::default();
        let undo = std::mem::take(&mut self.undo);
        let mut counters = std::mem::take(&mut self.counters);
        for (key, value) in std::mem::take(&mut self.allocated) {
            let seen = counters.entry(key).or_insert(value);
            *seen = (*seen).max(value);
        }
        if counters.is_empty() {
            return Ok(());
        }
        for (key, before) in undo {
            match before {
                Some(v) => base.put(&key, &v)?,
                None => base.delete(&key)?,
            }
        }
        for (key, value) in counters {
            base.raise_counter(&key, value)?;
        }
        base.commit()?;
        Ok(())
    }

    /// After a layer is dropped: every counter is at least the highest value this transaction
    /// gave it, so an id handed out by the dropped layer is not handed out again.
    fn restore_counters(&mut self) -> Result<()> {
        let counters: Vec<(Vec<u8>, u64)> =
            self.counters.iter().map(|(k, v)| (k.clone(), *v)).collect();
        for (key, value) in counters {
            let visible = self
                .get(&key)?
                .and_then(|bytes| keys::be8(&bytes))
                .unwrap_or(0);
            if visible < value {
                self.write_top(&key, Some(&value.to_be_bytes()))?;
            }
        }
        Ok(())
    }

    fn held(&self) -> Vec<HeldKey> {
        let mut all = self.root_locks.clone();
        for layer in &self.savepoints {
            all.extend(layer.locks.iter().cloned());
        }
        all.into_iter().collect()
    }
}

/// Entries a scan copies out under the state lock before it hands them to the caller.
const SCAN_BATCH: usize = 256;

/// A merged scan that holds the state lock only while it copies a batch of entries, never while
/// `f` runs, so `f` may read through the same transaction (a vector scan reads each take's row).
/// The next batch starts after the last key handed out.
fn scan_unlocked(
    state: &Mutex<State>,
    start: &[u8],
    end: &[u8],
    reverse: bool,
    f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
) -> Result<()> {
    let (mut lo, mut hi) = (start.to_vec(), end.to_vec());
    loop {
        let mut batch: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        lock(state).scan(&lo, &hi, reverse, &mut |k, v| {
            batch.push((k.to_vec(), v.to_vec()));
            batch.len() < SCAN_BATCH
        })?;
        let full = batch.len() == SCAN_BATCH;
        let Some((last, _)) = batch.last() else {
            return Ok(());
        };
        if reverse {
            hi = last.clone();
        } else {
            lo = last.clone();
            lo.push(0);
        }
        for (k, v) in &batch {
            if !f(k, v) {
                return Ok(());
            }
        }
        if !full {
            return Ok(());
        }
    }
}

/// The view a bound store reads through: the transaction's merged state, read under its lock for
/// each call (a scan only while it copies a batch: `scan_unlocked`).
struct TxReader(Arc<Transaction>);

impl KvRead for TxReader {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        lock(&self.0.state).get(key)
    }
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        scan_unlocked(&self.0.state, start, end, reverse, f)
    }
}

/// The `KvWrite` a statement's closure gets: writes go to the statement layer, reads see the
/// merged view. `commit` is the statement's end, not the caller's to call.
struct StatementWriter<'a>(&'a Transaction);

impl KvRead for StatementWriter<'_> {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        lock(&self.0.state).get(key)
    }
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        scan_unlocked(&self.0.state, start, end, reverse, f)
    }
}

impl KvWrite for StatementWriter<'_> {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        lock(&self.0.state).write_top(key, Some(value))
    }
    fn delete(&mut self, key: &[u8]) -> Result<()> {
        lock(&self.0.state).write_top(key, None)
    }
    /// Ids come from the record store's own allocator, under every layer: an allocator never
    /// rolls back, and on a store with concurrent writers the ids are shared with them.
    fn allocate(&mut self, key: &[u8], count: u64) -> Result<u64> {
        lock(&self.0.state).allocate(key, count)
    }
    fn commit(self: Box<Self>) -> Result<u64> {
        Err(StoreError::new(
            INVALID_STATE,
            "a statement inside a transaction commits with the transaction",
        ))
    }
    /// The statement's meta joins its layer, so it is kept or dropped with the statement.
    fn set_commit_meta(&mut self, meta: CommitMeta) {
        if let Some(layer) = lock(&self.0.state).statement.as_mut() {
            layer.meta.absorb(meta);
        }
    }
}

impl Transaction {
    pub(crate) fn reader(self: &Arc<Self>) -> Box<dyn KvRead> {
        Box::new(TxReader(self.clone()))
    }

    /// Runs `f` as one statement of the transaction (see the module docs).
    pub(crate) fn statement<T>(&self, f: impl FnOnce(&mut dyn KvWrite) -> Result<T>) -> Result<T> {
        let _exclusive = lock(&self.exclusive);
        {
            let mut state = lock(&self.state);
            state.base()?;
            if self.read_only.load(Ordering::SeqCst) {
                return Err(StoreError::new(
                    READ_ONLY_TRANSACTION,
                    "cannot execute a write in a read-only transaction",
                ));
            }
            state.statement = Some(Layer::default());
        }
        let result = f(&mut StatementWriter(self));
        let mut state = lock(&self.state);
        let Some(layer) = state.statement.take() else {
            return Err(closed());
        };
        match result {
            Ok(value) => {
                state.merge_down(layer)?;
                Ok(value)
            }
            Err(error) => {
                drop(layer);
                if state.base.is_some() {
                    state.restore_counters()?;
                }
                Err(error)
            }
        }
    }
}

impl Store {
    fn transaction(&self) -> Result<&Arc<Transaction>> {
        self.bound.as_ref().ok_or_else(|| {
            StoreError::new(INVALID_STATE, "this store is not bound to a transaction")
        })
    }

    /// Opens the write transaction and returns a store bound to it. Waits for the writer (a write
    /// that is already running) before it returns. `read_only` refuses every write with
    /// `read_only_transaction`; it still holds the writer, so its reads see one consistent state.
    pub fn begin_transaction(&self, read_only: bool) -> Result<Store> {
        if self.bound.is_some() {
            return Err(StoreError::new(
                INVALID_STATE,
                "a transaction is already open on this store; nest with a savepoint",
            ));
        }
        let base = self.kv.begin_write_exclusive()?;
        let tx = Arc::new(Transaction {
            state: Mutex::new(State {
                base: Some(base),
                root_locks: BTreeSet::new(),
                savepoints: Vec::new(),
                statement: None,
                counters: BTreeMap::new(),
                allocated: BTreeMap::new(),
                undo: BTreeMap::new(),
                meta: CommitMeta::default(),
            }),
            exclusive: Mutex::new(()),
            kv: self.kv.clone(),
            read_only: AtomicBool::new(read_only),
            opened_read_only: read_only,
        });
        Ok(self.bound_to(tx))
    }

    /// `SET TRANSACTION READ ONLY`: from this call on, the bound transaction refuses every write
    /// with `read_only_transaction`, as Postgres refuses one with SQLSTATE 25006. The writes it
    /// already made stay; it commits nothing more. `store_closed` once the transaction ended.
    pub fn set_transaction_read_only(&self) -> Result<()> {
        let tx = self.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        lock(&tx.state).base()?;
        tx.read_only.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// True while the bound transaction is open.
    pub fn transaction_open(&self) -> bool {
        self.bound
            .as_ref()
            .is_some_and(|tx| lock(&tx.state).base.is_some())
    }

    /// Opens a savepoint and returns its depth (1 for the first).
    pub fn savepoint(&self) -> Result<u32> {
        let tx = self.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        let mut state = lock(&tx.state);
        state.base()?;
        state.savepoints.push(Layer::default());
        Ok(state.savepoints.len() as u32)
    }

    fn top_savepoint(state: &State, depth: u32) -> Result<()> {
        state.base()?;
        if depth == 0 || state.savepoints.len() as u32 != depth {
            return Err(StoreError::new(
                INVALID_STATE,
                format!(
                    "savepoint {depth} is not the innermost open savepoint ({} open)",
                    state.savepoints.len()
                ),
            ));
        }
        Ok(())
    }

    /// Releases the innermost savepoint: its writes and page keys move to its parent.
    pub fn release_savepoint(&self, depth: u32) -> Result<()> {
        let tx = self.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        let mut state = lock(&tx.state);
        Self::top_savepoint(&state, depth)?;
        let layer = state.savepoints.pop().unwrap_or_default();
        state.merge_down(layer)
    }

    /// Rolls back the innermost savepoint: its writes and page keys are dropped; the counters it
    /// advanced stay advanced.
    pub fn rollback_savepoint(&self, depth: u32) -> Result<()> {
        let tx = self.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        let mut state = lock(&tx.state);
        Self::top_savepoint(&state, depth)?;
        state.savepoints.pop();
        // The dropped writes take the vector generation back with them; the cached index was
        // built from them.
        self.vectors.clear();
        state.restore_counters()
    }

    /// Commits the transaction and returns the commit sequence. Savepoints still open are
    /// released first. A transaction opened read-only commits nothing and returns the current
    /// sequence; one made read-only later commits the writes it made before.
    pub fn commit_transaction(&self) -> Result<u64> {
        self.commit_transaction_at().map(|p| p.sequence)
    }

    /// [`Store::commit_transaction`] with the commit's own position (`commit_log.rs`). A
    /// transaction opened read-only commits nothing and reports `CommitPosition::end_of` the
    /// current sequence.
    pub fn commit_transaction_at(&self) -> Result<CommitPosition> {
        let tx = self.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        let mut state = lock(&tx.state);
        state.base()?;
        while let Some(layer) = state.savepoints.pop() {
            state.merge_down(layer)?;
        }
        let base = state.base.take().ok_or_else(closed)?;
        state.root_locks.clear();
        state.counters.clear();
        state.allocated.clear();
        state.undo.clear();
        let meta = std::mem::take(&mut state.meta);
        if tx.opened_read_only {
            drop(base);
            return Ok(CommitPosition::end_of(tx.kv.version()?));
        }
        let mut base = base;
        if !meta.is_empty() {
            base.set_commit_meta(meta);
        }
        base.commit_position()
    }

    /// Rolls the transaction back. Counters it advanced are written forward before the writer is
    /// released (`State::roll_back`), so no id it handed out is reused. Rolling back an ended
    /// transaction is a no-op.
    pub fn rollback_transaction(&self) -> Result<()> {
        let tx = self.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        let ended = {
            let mut state = lock(&tx.state);
            let open = state.base.is_some();
            let result = state.roll_back();
            if open {
                self.vectors.clear();
            }
            result
        };
        rollback_released_writer();
        ended
    }

    /// `lockPageKeys` inside a transaction (`pages.rs` keeps the plain key check `lock_page_keys`). `keys` arrive checked, deduplicated and sorted by the
    /// wrapper; keys the transaction already holds may be passed again. Each source must exist
    /// (`source_not_found`, message `Page source does not exist: <id>`); when `hinted`, its
    /// incarnation must match the hint (`source_changed`, message `Page source was recreated:
    /// <id>`). The keys are held by the innermost savepoint (or the transaction) until it ends.
    /// Returns every key the transaction holds, sorted.
    pub fn hold_page_keys(&self, keys: &[PageKeyHint], hinted: bool) -> Result<Vec<HeldKey>> {
        let tx = self.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        let mut state = lock(&tx.state);
        state.base()?;
        let mut ordered: Vec<&PageKeyHint> = keys.iter().collect();
        ordered.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        // Each source is read once; every key is checked against it, so a later hinted key of a
        // source is held to the same incarnation check as the first.
        let mut incarnations: BTreeMap<&str, String> = BTreeMap::new();
        for key in &ordered {
            if !incarnations.contains_key(key.source_id.as_str()) {
                let record = sources::read_source(&StateRead(&state), &key.source_id)?;
                let Some(record) = record else {
                    return Err(StoreError::new(
                        SOURCE_NOT_FOUND,
                        format!("Page source does not exist: {}", key.source_id),
                    ));
                };
                incarnations.insert(&key.source_id, record.incarnation);
            }
            let incarnation = &incarnations[key.source_id.as_str()];
            if hinted && key.incarnation.as_deref() != Some(incarnation.as_str()) {
                return Err(StoreError::new(
                    SOURCE_CHANGED,
                    format!("Page source was recreated: {}", key.source_id),
                ));
            }
        }
        let held: BTreeSet<HeldKey> = ordered
            .iter()
            .map(|k| (k.source_id.clone(), k.slug.clone()))
            .collect();
        match state.savepoints.last_mut() {
            Some(layer) => layer.locks.extend(held),
            None => state.root_locks.extend(held),
        }
        Ok(state.held())
    }

    /// Every page key the transaction holds, sorted by source then slug.
    pub fn held_page_keys(&self) -> Result<Vec<HeldKey>> {
        let tx = self.transaction()?;
        let state = lock(&tx.state);
        state.base()?;
        Ok(state.held())
    }
}

/// Reads the merged state through a guard the caller already holds.
struct StateRead<'a>(&'a State);

impl KvRead for StateRead<'_> {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.0.get(key)
    }
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        self.0.scan(start, end, reverse, f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::STORE_IO;
    use crate::test_support::store;

    fn collect(read: &dyn KvRead, start: &[u8], end: &[u8], reverse: bool) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        read.scan(start, end, reverse, &mut |k, _| {
            out.push(k.to_vec());
            true
        })
        .unwrap();
        out
    }

    #[test]
    fn the_merged_scan_interleaves_overlay_and_base_in_both_directions() {
        // Tag `y` holds no record (keys.rs), so a fresh brain's seeded records stay out of the scan.
        let s = store();
        s.write(|tx| {
            for k in [b"ya", b"yc", b"ye"] {
                tx.put(k, b"base")?;
            }
            Ok(())
        })
        .unwrap();
        let t = s.begin_transaction(false).unwrap();
        t.write(|tx| tx.put(b"yb", b"one")).unwrap();
        let depth = t.savepoint().unwrap();
        t.write(|tx| {
            tx.put(b"yd", b"two")?;
            tx.delete(b"yc")?;
            tx.put(b"yf", b"three")
        })
        .unwrap();
        let read = t.read().unwrap();
        let forward = collect(&*read, b"y", b"z", false);
        assert_eq!(
            forward,
            vec![
                b"ya".to_vec(),
                b"yb".to_vec(),
                b"yd".to_vec(),
                b"ye".to_vec(),
                b"yf".to_vec()
            ]
        );
        let mut backward = forward.clone();
        backward.reverse();
        assert_eq!(collect(&*read, b"y", b"z", true), backward);
        // Early stop is honored inside the overlay and inside the base.
        let mut first_two = Vec::new();
        read.scan(b"y", b"z", false, &mut |k, _| {
            first_two.push(k.to_vec());
            first_two.len() < 2
        })
        .unwrap();
        assert_eq!(first_two, vec![b"ya".to_vec(), b"yb".to_vec()]);
        // A range cut excludes overlay keys outside it.
        assert_eq!(
            collect(&*read, b"yc", b"yf", false),
            vec![b"yd".to_vec(), b"ye".to_vec()]
        );
        t.rollback_savepoint(depth).unwrap();
        assert_eq!(
            collect(&*t.read().unwrap(), b"y", b"z", false),
            vec![
                b"ya".to_vec(),
                b"yb".to_vec(),
                b"yc".to_vec(),
                b"ye".to_vec()
            ]
        );
        // Nothing is visible outside before commit; everything after.
        assert_eq!(s.read().unwrap().get(b"yb").unwrap(), None);
        t.commit_transaction().unwrap();
        assert_eq!(s.read().unwrap().get(b"yb").unwrap(), Some(b"one".to_vec()));
        assert_eq!(s.read().unwrap().get(b"yd").unwrap(), None);
    }

    #[test]
    fn a_failed_statement_drops_only_its_own_writes() {
        let s = store();
        let t = s.begin_transaction(false).unwrap();
        t.write(|tx| tx.put(b"xa", b"kept")).unwrap();
        let err = t
            .write(|tx| -> Result<()> {
                tx.put(b"xb", b"lost")?;
                Err(StoreError::invalid("boom"))
            })
            .unwrap_err();
        assert_eq!(err.message, "boom");
        let read = t.read().unwrap();
        assert_eq!(read.get(b"xa").unwrap(), Some(b"kept".to_vec()));
        assert_eq!(read.get(b"xb").unwrap(), None);
        t.commit_transaction().unwrap();
        assert_eq!(
            s.read().unwrap().get(b"xa").unwrap(),
            Some(b"kept".to_vec())
        );
    }

    #[test]
    fn a_counter_never_goes_back_after_a_dropped_layer() {
        let s = store();
        let t = s.begin_transaction(false).unwrap();
        let first = t
            .write(|tx| crate::pages::next_id(tx, "next_probe_id"))
            .unwrap();
        let depth = t.savepoint().unwrap();
        let second = t
            .write(|tx| crate::pages::next_id(tx, "next_probe_id"))
            .unwrap();
        t.rollback_savepoint(depth).unwrap();
        let _ = t.write(|tx| -> Result<()> {
            crate::pages::next_id(tx, "next_probe_id")?;
            Err(StoreError::invalid("boom"))
        });
        let fourth = t
            .write(|tx| crate::pages::next_id(tx, "next_probe_id"))
            .unwrap();
        assert_eq!((first, second, fourth), (1, 2, 4));
        t.rollback_transaction().unwrap();
        let after = s
            .write(|tx| crate::pages::next_id(tx, "next_probe_id"))
            .unwrap();
        assert_eq!(after, 5);
    }

    /// A rollback writes its id sequences forward before it lets another writer in: a writer that
    /// starts the moment the rollback releases the writer never gets an id the rolled-back
    /// transaction handed out.
    #[test]
    fn a_rollback_writes_its_ids_forward_before_another_writer_can_take_one() {
        let s = std::sync::Arc::new(store());
        let t = s.begin_transaction(false).unwrap();
        let handed = t
            .write(|tx| crate::pages::next_id(tx, "next_probe_id"))
            .unwrap();
        let taken = std::sync::Arc::new(std::sync::Mutex::new(None));
        let (other, seen) = (s.clone(), taken.clone());
        ROLLBACK_RELEASED_WRITER.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                let id = other
                    .write(|tx| crate::pages::next_id(tx, "next_probe_id"))
                    .unwrap();
                *seen.lock().unwrap() = Some(id);
            }))
        });
        t.rollback_transaction().unwrap();
        let taken = taken.lock().unwrap().expect("the next writer ran");
        assert!(
            taken > handed,
            "the next writer took id {taken}, which the rolled-back transaction handed out ({handed})"
        );
    }

    /// A transaction whose last handle goes away without a commit or a rollback writes its id
    /// sequences forward too.
    #[test]
    fn a_dropped_transaction_writes_its_ids_forward() {
        let s = store();
        let t = s.begin_transaction(false).unwrap();
        let handed = t
            .write(|tx| crate::pages::next_id(tx, "next_probe_id"))
            .unwrap();
        drop(t);
        let next = s
            .write(|tx| crate::pages::next_id(tx, "next_probe_id"))
            .unwrap();
        assert!(next > handed, "id {next} was handed out again");
    }

    fn note(title: &str) -> crate::pages::PageInput {
        serde_json::from_value(
            serde_json::json!({"type": "note", "title": title, "compiled_truth": "b"}),
        )
        .unwrap()
    }

    // Why a failed commit cannot hand out a reused id (RA1 fix 8, the failed-commit edge): a
    // commit that fails releases the writer without raising the id sequences, but no writer can
    // use that gap. redb poisons the store on a failed commit, so every later write in the
    // process fails until it is reopened (this test); and the sequence and the rows are written
    // in one commit, so after a reopen the counter matches the stored rows (the next test). A
    // future backend that does not poison the store on a failed commit must revisit this: there,
    // a writer could start in the gap and take an id the failed transaction handed out.
    #[test]
    fn a_failed_commit_poisons_every_later_write_in_the_process() {
        let file = crate::test_support::FlakyFile::default();
        let s = crate::test_support::store_on_file(&file);
        let t = s.begin_transaction(false).unwrap();
        t.put_page("notes/t", &note("t"), &Default::default())
            .unwrap();
        file.fail_sync
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(t.commit_transaction().unwrap_err().code, STORE_IO);
        for _ in 0..2 {
            let refused = s
                .write(|tx| crate::pages::next_id(tx, "next_page_id"))
                .unwrap_err();
            assert_eq!(refused.code, STORE_IO);
            assert!(refused.message.contains("re-open"), "{}", refused.message);
        }
    }

    // See the comment above: the id sequence and the rows commit atomically, so after a reopen a
    // failed commit left both or neither, and the next id follows the stored rows.
    #[test]
    fn after_a_failed_commit_and_a_reopen_the_id_counter_matches_the_stored_rows() {
        let file = crate::test_support::FlakyFile::default();
        let s = crate::test_support::store_on_file(&file);
        let t = s.begin_transaction(false).unwrap();
        let handed = t
            .put_page("notes/t", &note("t"), &Default::default())
            .unwrap()["id"]
            .as_u64()
            .unwrap();
        file.fail_sync
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(t.commit_transaction().is_err());
        drop(t);
        drop(s);
        let s = crate::test_support::store_on_file(&file);
        let stored = s
            .read_page_snapshot("notes/t", &Default::default())
            .unwrap()
            .map(|p| p["page"]["id"].as_u64().unwrap());
        let next = s
            .put_page("notes/o", &note("o"), &Default::default())
            .unwrap()["id"]
            .as_u64()
            .unwrap();
        match stored {
            // The bytes reached the file before the sync failed: the row and its id step are kept.
            Some(id) => assert_eq!((id, next), (handed, handed + 1)),
            // Neither reached it: the id is free again and nothing stored refers to it.
            None => assert_eq!(next, handed),
        }
    }

    #[test]
    fn a_transaction_reads_one_time_its_start_while_the_brain_clock_moves_on() {
        let s = store();
        let t = s.begin_transaction(false).unwrap();
        let started = t.env.now_micros();
        std::thread::sleep(std::time::Duration::from_millis(3));
        assert_eq!(t.env.now_micros(), started);
        assert!(s.env.now_micros() > started);
        assert_ne!(t.env.new_uuid(), t.env.new_uuid());
        t.rollback_transaction().unwrap();
    }

    #[test]
    fn a_read_only_transaction_refuses_writes_and_an_ended_one_is_closed() {
        let s = store();
        let t = s.begin_transaction(true).unwrap();
        assert_eq!(
            t.write(|tx| tx.put(b"xa", b"v")).unwrap_err().code,
            READ_ONLY_TRANSACTION
        );
        assert!(t.read().unwrap().get(b"xa").unwrap().is_none());
        t.commit_transaction().unwrap();
        assert!(!t.transaction_open());
        assert_eq!(t.read().unwrap().get(b"xa").unwrap_err().code, STORE_CLOSED);
        assert_eq!(t.savepoint().unwrap_err().code, STORE_CLOSED);
        t.rollback_transaction().unwrap();
        // The writer was given back: a plain write goes through.
        s.write(|tx| tx.put(b"xa", b"v")).unwrap();
    }

    #[test]
    fn set_transaction_read_only_refuses_later_writes_and_keeps_earlier_ones() {
        let s = store();
        let t = s.begin_transaction(false).unwrap();
        t.write(|tx| tx.put(b"xb", b"before")).unwrap();
        t.set_transaction_read_only().unwrap();
        let refused = t.write(|tx| tx.put(b"xc", b"after")).unwrap_err();
        assert_eq!(refused.code, READ_ONLY_TRANSACTION);
        assert!(t.read().unwrap().get(b"xc").unwrap().is_none());
        t.commit_transaction().unwrap();
        let read = s.read().unwrap();
        assert_eq!(read.get(b"xb").unwrap().as_deref(), Some(&b"before"[..]));
        assert!(read.get(b"xc").unwrap().is_none());
        assert_eq!(
            t.set_transaction_read_only().unwrap_err().code,
            STORE_CLOSED
        );
        assert_eq!(
            s.set_transaction_read_only().unwrap_err().code,
            INVALID_STATE
        );
    }

    #[test]
    fn page_keys_are_held_sorted_and_dropped_with_their_savepoint() {
        let s = store();
        let t = s.begin_transaction(false).unwrap();
        let key = |slug: &str| PageKeyHint {
            source_id: "default".into(),
            slug: slug.into(),
            incarnation: None,
        };
        t.hold_page_keys(&[key("b"), key("a")], false).unwrap();
        let depth = t.savepoint().unwrap();
        let held = t.hold_page_keys(&[key("c")], false).unwrap();
        assert_eq!(
            held.iter().map(|k| k.1.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        t.rollback_savepoint(depth).unwrap();
        assert_eq!(t.held_page_keys().unwrap().len(), 2);
        let missing = PageKeyHint {
            source_id: "nope".into(),
            ..key("a")
        };
        let err = t.hold_page_keys(&[missing], false).unwrap_err();
        assert_eq!(
            (err.code, err.message.as_str()),
            (SOURCE_NOT_FOUND, "Page source does not exist: nope")
        );
        let stale = PageKeyHint {
            incarnation: Some("old".into()),
            ..key("a")
        };
        assert_eq!(
            t.hold_page_keys(&[stale], true).unwrap_err().code,
            SOURCE_CHANGED
        );
        t.commit_transaction().unwrap();
    }
}
