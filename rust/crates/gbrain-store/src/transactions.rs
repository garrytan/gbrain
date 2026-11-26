//! Transactions and the page-key lock queue (core).
//!
//! Members: transaction, transactionDirect, lockPageKeys. The TypeScript wrapper
//! (`src/core/rust-engine.ts`) owns the callback, the writer gate and the re-entry guard; this file
//! owns what the store does while a transaction is open. The full contract is in
//! `rust/docs/store/transactions.md`.
//!
//! One open transaction is an [`OpenTransaction`]: the store's write transaction (the `base`) plus a
//! stack of in-memory layers above it. A [`Store`] bound to a transaction ([`Store::begin_transaction`])
//! runs every family method against it unchanged:
//!
//! - `Store::write(f)` runs `f` as one statement: a layer is pushed, `f` writes into it, and the
//!   layer merges into the layer below when `f` returns `Ok` and is dropped when it returns `Err`.
//!   A failed statement leaves the transaction usable, as a PGLite savepoint does.
//! - `Store::read()` reads the merged view (statement, then savepoints top down, then the base),
//!   so the transaction reads its own writes.
//! - A savepoint ([`Store::savepoint`]) is another layer. Releasing it merges it into its parent;
//!   rolling it back drops it. Only [`Store::commit_transaction`] calls the record store's commit.
//!
//! Two modes ([`TxnMode`]):
//!
//! - **Serialized** (the default, and the only mode unless multi-user mode is on): the base is taken
//!   with `Kv::begin_write_exclusive`, so it holds the writer until it ends; with concurrent writes on,
//!   no other commit lands until it ends. Nothing can conflict with it.
//! - **Optimistic** (multi-user mode, `GBRAIN_RUST_MULTIUSER=1`): the base is an ordinary write of the
//!   concurrent store (`occ_kv.rs`): it reads from a snapshot and records every key and range it read,
//!   and its commit is validated in the ordered pipeline. A transaction that read something another
//!   commit changed is refused with `write_conflict` and nothing it wrote is kept; the wrapper runs the
//!   callback again. Layers keep counter operations typed (`Add`, `Max`) and their admission checks
//!   (`counter_below`) apart, and hand them to the base only when they merge, so concurrent counter
//!   bumps never conflict and a dropped layer leaves neither a delta nor a check. The first
//!   `write_conflict` a transaction sees dooms it: its commit refuses even when the callback swallowed
//!   the error. A deadline ([`TxnOptions::deadline`]) is checked at each statement and by the commit
//!   before it hands the write to the pipeline; once handed, the commit's own answer wins.
//!
//! Allocators never roll back. A counter is a meta record (`keys::meta`) whose name starts with
//! `next_` and whose value is 8 bytes (the big-endian next id). Ids come from `KvWrite::allocate`,
//! which a bound statement sends straight to the base, under every layer, so dropping a layer
//! does not give its ids back (and, with concurrent writes on, the ids are shared with the other
//! writers). A counter written directly is remembered at its highest value and written back into
//! the layer below when a layer is dropped. When a serialized transaction rolls back (or its last
//! handle goes away without ending it), the base write that held the writer puts back every key the
//! transaction wrote, raises every counter it advanced (`KvWrite::raise_counter`) and commits, so
//! the writer is released only after the counters are saved. An optimistic transaction that ends
//! without committing (a rollback, a drop, a refused or timed-out commit) writes nothing back: its
//! data is dropped, and a separate write that holds only `raise_counter` operations (they never
//! conflict and never overwrite another writer) raises every counter it advanced. Either way an id
//! handed out inside a transaction that did not commit is never handed out again, also after a reopen.
//!
//! Keys: `keys::LOCK_QUEUE` (`w`) is reserved for this file. No `w` record is written. A serialized
//! transaction holds a page key (`lockPageKeys`) in memory only: no other writer can reach a held key
//! before it ends. An optimistic transaction also takes the key in the brain's [`SingleFlight`] table,
//! so a second transaction that names the same key waits for it (bounded by its deadline) until the
//! holder commits or rolls back. Keys of one call are taken in sorted order. A transaction that already
//! holds a key waits for another only when it is older than the holder; a younger one is refused with
//! `write_conflict` and runs again, keeping its age (wait-die), so no wait cycle can form and a rerun
//! gets through once it is the oldest. The tag stays reserved for a lock queue that outlives a transaction.
//!
//! A scan callback must not call the store: the merged scan holds the transaction's state lock
//! while it runs.
//!
//! Time: a bound store reads one time for the whole transaction, the time it began
//! ([`TransactionClock`]), as PGLite's `now()` returns the transaction's start time. Two rows written
//! in one transaction carry the same `created_at`. Fresh identifiers still come from the brain's
//! own source.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::Bound;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::commit_log::{CommitMeta, CommitPosition};
use crate::env::Env;
use crate::error::{
    INVALID_STATE, READ_ONLY_TRANSACTION, Result, SOURCE_CHANGED, SOURCE_NOT_FOUND, STORE_CLOSED,
    STORE_CORRUPT, StoreError, WRITE_CONFLICT,
};
use crate::kv::{CounterCheck, Kv, KvRead, KvWrite};
use crate::write_origin::WriteOrigin;
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

// ---------------------------------------------------------------------------------------------
// Options (interface I-1)
// ---------------------------------------------------------------------------------------------

/// How an explicit transaction runs (see the module docs).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TxnMode {
    /// Holds the store's writer until it ends (today's transaction).
    #[default]
    Serialized,
    /// Reads from a snapshot and is validated at commit (multi-user mode only).
    Optimistic,
}

/// Options of [`Store::begin_with`].
#[derive(Debug, Clone, Default)]
pub struct TxnOptions {
    pub mode: TxnMode,
    /// Absolute; `None` waits without a bound (today).
    pub deadline: Option<Instant>,
    pub origin: Option<WriteOrigin>,
    /// Refuse every write with `read_only_transaction`.
    pub read_only: bool,
    /// Optimistic mode: keys an earlier run of the same callback lost a conflict on. The transaction
    /// first queues for them (the concurrent store's row-lock queue, `Kv::begin_write_locked_until`,
    /// bounded by `deadline`) and holds them until it ends, as a retried `Store::write` does, so many
    /// writers of one hot page wait in line instead of all running again together.
    pub retry_keys: Vec<Vec<u8>>,
    /// Optimistic mode: the single-flight age of an earlier run of the same callback
    /// ([`Store::transaction_age`]), so a rerun keeps its place: an older transaction waits for a key a
    /// younger one holds, a younger one that already holds a key is refused instead (wait-die). `None`
    /// takes a fresh age.
    pub age: Option<u64>,
}

/// A key [`Store::single_flight`] holds: the exact source and slug, as `lockPageKeys` takes them.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SingleFlightKey {
    pub source_id: String,
    pub slug: String,
}

/// An open explicit transaction (interface I-1): the bound store every family method runs on.
pub struct Transaction {
    store: Store,
}

impl Transaction {
    /// The store bound to the transaction: its reads see the transaction's writes.
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Commits and returns the commit sequence (lane L2 makes this a `CommitPosition`).
    pub fn commit(self) -> Result<u64> {
        self.store.commit_transaction()
    }

    /// Ends the transaction without keeping its writes.
    pub fn rollback(self) -> Result<()> {
        self.store.rollback_transaction()
    }

    /// Checks that `token` holds its lease now, and again at commit: the lease record is read inside
    /// the transaction (interface I-1 / I-5; `Store::assert_lease`).
    pub fn assert_lease(&self, token: &crate::leases::LeaseToken) -> Result<()> {
        self.store.assert_lease(token)
    }
}

/// The error a single-flight refusal returns.
fn single_flight_conflict(key: &HeldKey) -> StoreError {
    StoreError::new(
        WRITE_CONFLICT,
        format!(
            "write conflict on single-flight key {}/{}: an older transaction holds it and this one already holds other keys, so it runs again instead of waiting",
            key.0, key.1
        ),
    )
}

fn deadline_passed(deadline: Option<Instant>) -> bool {
    deadline.is_some_and(|at| Instant::now() >= at)
}

fn transaction_deadline() -> StoreError {
    StoreError::timeout(
        "transaction_deadline",
        "the transaction passed its deadline; nothing was committed",
    )
}

// ---------------------------------------------------------------------------------------------
// Single flight
// ---------------------------------------------------------------------------------------------

/// The page keys optimistic transactions hold, per open brain (see the module docs).
#[derive(Default)]
pub struct SingleFlight {
    /// Each held key's owner and the owner's age.
    held: Mutex<HashMap<HeldKey, (u64, u64)>>,
    released: Condvar,
}

/// Keys one acquisition took. Dropped without [`FlightGrant::keep`], it gives them back, so a
/// refusal, a timeout or an error part way frees exactly what this call took.
struct FlightGrant<'a> {
    table: &'a SingleFlight,
    owner: u64,
    keys: Vec<HeldKey>,
    /// True when the call waited for another holder.
    waited: bool,
}

impl FlightGrant<'_> {
    fn keep(mut self) {
        self.keys.clear();
    }
}

impl Drop for FlightGrant<'_> {
    fn drop(&mut self) {
        if !self.keys.is_empty() {
            self.table.release(self.owner, self.keys.iter());
        }
    }
}

impl SingleFlight {
    /// Takes `keys` (sorted, unique) for `owner` of age `age`. A key `owner` already holds is skipped.
    /// A key another owner holds is waited for, up to `deadline`, when the caller holds no key yet
    /// (`holds_keys` false and nothing taken by this call) or is older than the holder; otherwise the
    /// call is refused with `write_conflict` (wait-die: every wait goes from a holder to a younger
    /// holder, or from a transaction that holds nothing, so no wait cycle can form, and a rerun that
    /// keeps its age becomes the oldest and gets through).
    fn acquire(
        &self,
        owner: u64,
        age: u64,
        keys: &[HeldKey],
        holds_keys: bool,
        deadline: Option<Instant>,
    ) -> Result<FlightGrant<'_>> {
        let mut grant = FlightGrant {
            table: self,
            owner,
            keys: Vec::with_capacity(keys.len()),
            waited: false,
        };
        let mut held = lock(&self.held);
        for key in keys {
            let mut waited = false;
            loop {
                let holder_age = match held.get(key) {
                    None => break,
                    Some((o, _)) if *o == owner => break,
                    Some((_, a)) => *a,
                };
                if (holds_keys || !grant.keys.is_empty()) && age >= holder_age {
                    drop(held);
                    return Err(single_flight_conflict(key));
                }
                grant.waited = true;
                waited = true;
                held = match deadline {
                    None => self.released.wait(held).unwrap_or_else(|p| p.into_inner()),
                    Some(at) => {
                        let now = Instant::now();
                        if now >= at {
                            drop(held);
                            return Err(StoreError::timeout(
                                "key_wait",
                                format!(
                                    "the transaction waited for the page key {}/{} past its deadline; nothing was committed",
                                    key.0, key.1
                                ),
                            ));
                        }
                        self.released
                            .wait_timeout(held, at - now)
                            .unwrap_or_else(|p| p.into_inner())
                            .0
                    }
                };
            }
            // A key freed just as the deadline passed is not taken after it.
            if waited && deadline_passed(deadline) {
                drop(held);
                return Err(StoreError::timeout(
                    "key_wait",
                    format!(
                        "the transaction waited for the page key {}/{} past its deadline; nothing was committed",
                        key.0, key.1
                    ),
                ));
            }
            if !held.contains_key(key) {
                held.insert(key.clone(), (owner, age));
                grant.keys.push(key.clone());
            }
        }
        drop(held);
        Ok(grant)
    }

    /// Gives back the listed keys `owner` holds.
    fn release<'k>(&self, owner: u64, keys: impl Iterator<Item = &'k HeldKey>) {
        let mut held = lock(&self.held);
        for key in keys {
            if held.get(key).is_some_and(|(o, _)| *o == owner) {
                held.remove(key);
            }
        }
        drop(held);
        self.released.notify_all();
    }

    /// Gives back every key `owner` holds.
    fn release_all(&self, owner: u64) {
        let mut held = lock(&self.held);
        let before = held.len();
        held.retain(|_, (o, _)| *o != owner);
        let changed = held.len() != before;
        drop(held);
        if changed {
            self.released.notify_all();
        }
    }

    /// The holder of `key`, for tests.
    #[cfg(test)]
    pub(crate) fn holder(&self, key: &HeldKey) -> Option<u64> {
        lock(&self.held).get(key).map(|(o, _)| *o)
    }
}

/// Owner ids of optimistic transactions (single flight), unique per process.
static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------------------------

/// One buffered write of a layer. Serialized transactions only ever make `Set`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LayerOp {
    /// The value (`None`: deleted).
    Set(Option<Vec<u8>>),
    /// Add to an 8-byte little-endian i64 (absent = 0).
    Add(i64),
    /// Raise an 8-byte big-endian u64 (absent = 0) to at least this value.
    Max(u64),
}

fn decode_le_i64(bytes: Option<&[u8]>) -> Result<i64> {
    match bytes {
        None => Ok(0),
        Some(b) => Ok(i64::from_le_bytes(b.try_into().map_err(|_| {
            StoreError::new(STORE_CORRUPT, "a counter record is not 8 bytes")
        })?)),
    }
}

fn decode_be_u64(bytes: Option<&[u8]>) -> Result<u64> {
    match bytes {
        None => Ok(0),
        Some(b) => keys::be8(b)
            .ok_or_else(|| StoreError::new(STORE_CORRUPT, "an id sequence record is not 8 bytes")),
    }
}

/// The value `op` leaves on a key whose value below it is `below`.
fn resolve(op: &LayerOp, below: Option<&[u8]>) -> Result<Option<Vec<u8>>> {
    Ok(match op {
        LayerOp::Set(v) => v.clone(),
        LayerOp::Add(d) => Some(
            decode_le_i64(below)?
                .wrapping_add(*d)
                .to_le_bytes()
                .to_vec(),
        ),
        LayerOp::Max(m) => Some(decode_be_u64(below)?.max(*m).to_be_bytes().to_vec()),
    })
}

/// `upper` applied after `lower`, as one operation.
fn compose(lower: &LayerOp, upper: LayerOp) -> Result<LayerOp> {
    Ok(match (lower, upper) {
        (_, LayerOp::Set(v)) => LayerOp::Set(v),
        (LayerOp::Set(v), op) => LayerOp::Set(resolve(&op, v.as_deref())?),
        (LayerOp::Add(a), LayerOp::Add(b)) => LayerOp::Add(a.wrapping_add(b)),
        (LayerOp::Max(a), LayerOp::Max(b)) => LayerOp::Max((*a).max(b)),
        (LayerOp::Add(_), LayerOp::Max(_)) | (LayerOp::Max(_), LayerOp::Add(_)) => {
            return Err(StoreError::invalid(
                "a counter key is also an id sequence inside the transaction",
            ));
        }
    })
}

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
    writes: BTreeMap<Vec<u8>, LayerOp>,
    locks: BTreeSet<HeldKey>,
    /// Admission checks (`counter_below`) kept by this layer: `(key, bound)`, handed to the base when
    /// the layer merges into it (optimistic mode).
    guards: Vec<(Vec<u8>, i64)>,
    /// What the layer's statements say about themselves for the commit record (multi-user mode):
    /// kept and dropped with the layer's writes.
    meta: CommitMeta,
}

impl Layer {
    fn is_empty(&self) -> bool {
        self.writes.is_empty() && self.guards.is_empty()
    }
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
    /// directly and never roll back with a layer; only a whole-transaction end without a commit
    /// writes these forward.
    allocated: BTreeMap<Vec<u8>, u64>,
    /// Serialized mode: the value each key held before the transaction first wrote it into the base
    /// (`None`: absent). A rollback that must write sequences forward puts these back in the same
    /// base write, so it never releases the writer before the sequences are saved. Optimistic mode
    /// keeps none: its base writes nothing until it commits.
    undo: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    optimistic: bool,
    /// True once the transaction read or wrote anything (optimistic mode: a transaction that has not
    /// may take a fresh snapshot after a single-flight wait).
    touched: Cell<bool>,
    /// The commit meta of the statements merged into the base (`Layer::meta`).
    meta: CommitMeta,
}

/// An open transaction. Shared by the bound [`Store`] and every reader it hands out.
pub struct OpenTransaction {
    state: Mutex<State>,
    /// Held for a whole statement, savepoint change, commit or rollback, so two of them never
    /// interleave on one layer stack. Readers do not take it.
    exclusive: Mutex<()>,
    kv: Arc<dyn Kv>,
    /// Set at `begin_transaction` or by `set_transaction_read_only`; never cleared while it is open.
    read_only: AtomicBool,
    /// Opened read-only, so it never wrote and its commit writes nothing.
    opened_read_only: bool,
    optimistic: bool,
    deadline: Option<Instant>,
    /// The single-flight owner id (optimistic mode), its age and the brain's table.
    owner: u64,
    age: u64,
    flights: Arc<SingleFlight>,
    /// The first `write_conflict` (or deadline) the transaction met (optimistic mode): its commit
    /// returns it.
    doomed: Mutex<Option<StoreError>>,
    #[allow(dead_code)] // lane L2 stamps it on the write journal
    origin: Option<WriteOrigin>,
}

/// A transaction whose handles all went away without a commit or a rollback rolls back the same
/// way, so its ids are written forward before the writer is released.
impl Drop for OpenTransaction {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap_or_else(|e| e.into_inner());
        let _ = state.roll_back(&self.kv);
        if self.optimistic {
            self.flights.release_all(self.owner);
        }
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

#[cfg(test)]
thread_local! {
    /// Test seam: runs in an optimistic commit right after its savepoints merged, before the deadline
    /// is checked again.
    static AFTER_SAVEPOINT_MERGE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

fn after_savepoint_merge() {
    #[cfg(test)]
    if let Some(hook) = AFTER_SAVEPOINT_MERGE.with(|h| h.borrow_mut().take()) {
        hook();
    }
}

/// Where a rollback has released the store's writer: the test seam runs here.
fn rollback_released_writer() {
    #[cfg(test)]
    if let Some(hook) = ROLLBACK_RELEASED_WRITER.with(|h| h.borrow_mut().take()) {
        hook();
    }
}

fn is_counter_key(key: &[u8]) -> bool {
    key.first() == Some(&keys::META) && key[1..].starts_with(b"next_")
}

/// True for an allocator record: `M` + `next_...` holding 8 bytes.
fn counter_value(key: &[u8], value: &[u8]) -> Option<u64> {
    if !is_counter_key(key) {
        return None;
    }
    keys::be8(value)
}

fn in_range(key: &[u8], start: &[u8], end: &[u8]) -> bool {
    key >= start && key < end
}

/// Raises every listed id sequence in a write of its own that holds only `raise_counter`
/// operations, so it never conflicts and never overwrites another writer (optimistic mode).
fn raise_forward(kv: &Arc<dyn Kv>, counters: BTreeMap<Vec<u8>, u64>) -> Result<()> {
    if counters.is_empty() {
        return Ok(());
    }
    let mut write = kv.begin_write()?;
    for (key, value) in counters {
        write.raise_counter(&key, value)?;
    }
    write.commit()?;
    Ok(())
}

impl State {
    fn base(&self) -> Result<&dyn KvWrite> {
        self.base.as_deref().ok_or_else(closed)
    }

    /// The overlay layers, top first.
    fn layers_top_down(&self) -> impl Iterator<Item = &Layer> {
        self.statement.iter().chain(self.savepoints.iter().rev())
    }

    /// The overlay layers, bottom first.
    fn layers_bottom_up(&self) -> impl Iterator<Item = &Layer> {
        self.savepoints.iter().chain(self.statement.iter())
    }

    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let base = self.base()?;
        self.touched.set(true);
        let mut above: Vec<&LayerOp> = Vec::new();
        for layer in self.layers_top_down() {
            if let Some(op) = layer.writes.get(key) {
                if let LayerOp::Set(value) = op {
                    return Self::apply_above(value.clone(), &above);
                }
                above.push(op);
            }
        }
        let value = base.get(key)?;
        Self::apply_above(value, &above)
    }

    /// Applies the operations of the layers above a value, lowest first (`above` is top first).
    fn apply_above(mut value: Option<Vec<u8>>, above: &[&LayerOp]) -> Result<Option<Vec<u8>>> {
        for op in above.iter().rev() {
            value = resolve(op, value.as_deref())?;
        }
        Ok(value)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        let base = self.base()?;
        self.touched.set(true);
        if start >= end {
            return Ok(());
        }
        // The overlay entries in range, each layer applied over the ones below it.
        let mut overlay: BTreeMap<Vec<u8>, LayerOp> = BTreeMap::new();
        let range = (
            Bound::Included(start.to_vec()),
            Bound::Excluded(end.to_vec()),
        );
        for layer in self.layers_bottom_up() {
            for (key, op) in layer.writes.range::<Vec<u8>, _>(range.clone()) {
                let combined = match overlay.get(key) {
                    Some(lower) => compose(lower, op.clone())?,
                    None => op.clone(),
                };
                overlay.insert(key.clone(), combined);
            }
        }
        if overlay.is_empty() {
            return base.scan(start, end, reverse, f);
        }
        let entries: Vec<(Vec<u8>, LayerOp)> = if reverse {
            overlay.into_iter().rev().collect()
        } else {
            overlay.into_iter().collect()
        };
        // `before(a, b)`: `a` comes first in scan order.
        let before = |a: &[u8], b: &[u8]| if reverse { a > b } else { a < b };
        let mut next = 0usize;
        let mut stopped = false;
        let mut failure: Option<StoreError> = None;
        base.scan(start, end, reverse, &mut |key, value| {
            while next < entries.len() && before(&entries[next].0, key) {
                let (k, op) = &entries[next];
                next += 1;
                match resolve(op, None) {
                    Ok(Some(v)) => {
                        if !f(k, &v) {
                            stopped = true;
                            return false;
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        failure = Some(e);
                        stopped = true;
                        return false;
                    }
                }
            }
            if next < entries.len() && entries[next].0 == key {
                let (k, op) = &entries[next];
                next += 1;
                return match resolve(op, Some(value)) {
                    Ok(Some(v)) => {
                        let go = f(k, &v);
                        stopped = !go;
                        go
                    }
                    Ok(None) => true,
                    Err(e) => {
                        failure = Some(e);
                        stopped = true;
                        false
                    }
                };
            }
            let go = f(key, value);
            stopped = !go;
            go
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        if !stopped {
            for (key, op) in &entries[next..] {
                if !in_range(key, start, end) {
                    continue;
                }
                if let Some(v) = resolve(op, None)?
                    && !f(key, &v)
                {
                    break;
                }
            }
        }
        Ok(())
    }

    /// Writes into the top layer: the statement, else the top savepoint, else the base.
    fn write_top(&mut self, key: &[u8], value: Option<&[u8]>) -> Result<()> {
        self.write_top_op(key, LayerOp::Set(value.map(<[u8]>::to_vec)))
    }

    /// [`State::write_top`] for any layer operation.
    fn write_top_op(&mut self, key: &[u8], op: LayerOp) -> Result<()> {
        if self.base.is_none() {
            return Err(closed());
        }
        self.touched.set(true);
        let seen_value = match &op {
            LayerOp::Set(Some(v)) => counter_value(key, v),
            LayerOp::Max(m) if is_counter_key(key) => Some(*m),
            _ => None,
        };
        if let Some(v) = seen_value {
            let seen = self.counters.entry(key.to_vec()).or_insert(v);
            *seen = (*seen).max(v);
        }
        let layer = match self.statement.as_mut() {
            Some(layer) => Some(layer),
            None => self.savepoints.last_mut(),
        };
        match layer {
            Some(layer) => {
                let combined = match layer.writes.get(key) {
                    Some(lower) => compose(lower, op)?,
                    None => op,
                };
                layer.writes.insert(key.to_vec(), combined);
                Ok(())
            }
            None => self.apply_base(key, op),
        }
    }

    /// Hands one layer operation to the base.
    fn apply_base(&mut self, key: &[u8], op: LayerOp) -> Result<()> {
        match op {
            LayerOp::Set(value) => self.write_base(key, value.as_deref()),
            LayerOp::Add(delta) => self.base.as_mut().ok_or_else(closed)?.add_i64(key, delta),
            LayerOp::Max(value) => self
                .base
                .as_mut()
                .ok_or_else(closed)?
                .raise_counter(key, value),
        }
    }

    /// Writes into the base, first keeping what the key held before (`undo`, serialized mode only).
    fn write_base(&mut self, key: &[u8], value: Option<&[u8]>) -> Result<()> {
        let base = self.base.as_mut().ok_or_else(closed)?;
        if !self.optimistic && !self.undo.contains_key(key) {
            self.undo.insert(key.to_vec(), base.get(key)?);
        }
        match value {
            Some(v) => base.put(key, v),
            None => base.delete(key),
        }
    }

    /// Takes `count` ids from the base's allocator and remembers the highest value the sequence
    /// took, so an end without a commit writes it forward.
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
        self.touched.set(true);
        let base = self.base.as_mut().ok_or_else(closed)?;
        let first = base.allocate(key, count)?;
        let end = first + count;
        let seen = self.allocated.entry(key.to_vec()).or_insert(end);
        *seen = (*seen).max(end);
        Ok(first)
    }

    /// `counter_below` inside a statement (optimistic mode): decided over the layers and the base
    /// without a read of the counter when it passes; the check is kept by the top layer and reaches
    /// the base only when that layer merges into it.
    fn counter_below(&mut self, key: &[u8], cap: i64) -> Result<Option<i64>> {
        self.base()?;
        self.touched.set(true);
        let mut pending = 0i64;
        let mut plain = false;
        for layer in self.layers_top_down() {
            match layer.writes.get(key) {
                None => {}
                Some(LayerOp::Add(d)) => pending = pending.wrapping_add(*d),
                Some(_) => {
                    plain = true;
                    break;
                }
            }
        }
        if plain {
            let value = decode_le_i64(self.get(key)?.as_deref())?;
            return Ok((value >= cap).then_some(value));
        }
        let Some(base_cap) = cap.checked_sub(pending) else {
            // The cap minus the pending delta is out of range: decide on the value itself (a read).
            let value = decode_le_i64(self.get(key)?.as_deref())?;
            return Ok(match value.checked_add(pending) {
                Some(total) if total < cap => None,
                Some(total) => Some(total),
                None => Some(if pending > 0 { i64::MAX } else { i64::MIN }),
            });
        };
        let base = self.base.as_mut().ok_or_else(closed)?;
        match base.counter_check(key, base_cap)? {
            CounterCheck::Refused(value) => Ok(Some(value.wrapping_add(pending))),
            CounterCheck::Admitted { bound } => {
                let layer = match self.statement.as_mut() {
                    Some(layer) => Some(layer),
                    None => self.savepoints.last_mut(),
                };
                match layer {
                    Some(layer) => layer.guards.push((key.to_vec(), bound)),
                    None => self
                        .base
                        .as_mut()
                        .ok_or_else(closed)?
                        .add_guard(key, bound)?,
                }
                Ok(None)
            }
        }
    }

    /// Merges `layer` into what is now the top (the statement's parent savepoint, or the base).
    fn merge_down(&mut self, layer: Layer) -> Result<()> {
        if let Some(parent) = self.savepoints.last_mut() {
            for (key, op) in layer.writes {
                let combined = match parent.writes.get(&key) {
                    Some(lower) => compose(lower, op)?,
                    None => op,
                };
                parent.writes.insert(key, combined);
            }
            parent.locks.extend(layer.locks);
            parent.guards.extend(layer.guards);
            parent.meta.absorb(layer.meta);
            return Ok(());
        }
        self.root_locks.extend(layer.locks);
        self.meta.absorb(layer.meta);
        self.base()?;
        for (key, op) in layer.writes {
            self.apply_base(&key, op)?;
        }
        let base = self.base.as_mut().ok_or_else(closed)?;
        for (key, bound) in layer.guards {
            base.add_guard(&key, bound)?;
        }
        Ok(())
    }

    /// The counters and sequences to write forward when the transaction ends without a commit,
    /// taken out of the state.
    fn take_counters(&mut self) -> BTreeMap<Vec<u8>, u64> {
        let mut counters = std::mem::take(&mut self.counters);
        for (key, value) in std::mem::take(&mut self.allocated) {
            let seen = counters.entry(key).or_insert(value);
            *seen = (*seen).max(value);
        }
        counters
    }

    /// Ends the transaction without keeping its writes. Serialized: with no sequence to write
    /// forward the base is dropped; otherwise, in the same base write and so before the writer is
    /// released, every key the transaction wrote gets its earlier value back, every sequence is raised
    /// to the highest value the transaction took, and that write commits: no other writer can take an
    /// id the transaction handed out. Optimistic: the base is dropped and the sequences are raised in a
    /// write of their own (`raise_forward`). Rolling back an ended transaction does nothing.
    ///
    /// With the commit log on, a serialized rollback also drops its base (it never commits) and
    /// raises the sequences in a write of their own, as an optimistic one does: either way a
    /// rollback's only log record holds counter operations, never data.
    fn roll_back(&mut self, kv: &Arc<dyn Kv>) -> Result<()> {
        let Some(mut base) = self.base.take() else {
            return Ok(());
        };
        self.savepoints.clear();
        self.statement = None;
        self.root_locks.clear();
        // A rollback carries no write: its commit (counters only) names no request.
        self.meta = CommitMeta::default();
        let undo = std::mem::take(&mut self.undo);
        let counters = self.take_counters();
        if self.optimistic || kv.commit_log_enabled() {
            drop(base);
            return raise_forward(kv, counters);
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
            if self.optimistic {
                // Raised without a read, so it adds nothing to the read set.
                self.write_top_op(&key, LayerOp::Max(value))?;
                continue;
            }
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

    /// True when the transaction has observed nothing and written nothing (optimistic mode).
    fn pristine(&self) -> bool {
        !self.touched.get()
            && self.statement.is_none()
            && self.savepoints.iter().all(Layer::is_empty)
            && self.counters.is_empty()
            && self.allocated.is_empty()
            && self.undo.is_empty()
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
struct TxReader(Arc<OpenTransaction>);

impl KvRead for TxReader {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        // Noted while the state is locked, so a commit cannot pass its check in between.
        let state = lock(&self.0.state);
        self.0.note(state.get(key))
    }
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        let result = scan_unlocked(&self.0.state, start, end, reverse, f);
        self.0.note(result)
    }
}

/// The `KvWrite` a statement's closure gets: writes go to the statement layer, reads see the
/// merged view. `commit` is the statement's end, not the caller's to call.
struct StatementWriter<'a>(&'a OpenTransaction);

impl KvRead for StatementWriter<'_> {
    /// A conflict met here dooms the transaction at once, even when the statement catches it.
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let state = lock(&self.0.state);
        self.0.note(state.get(key))
    }
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        let result = scan_unlocked(&self.0.state, start, end, reverse, f);
        self.0.note(result)
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
    fn raise_counter(&mut self, key: &[u8], value: u64) -> Result<()> {
        if !self.0.optimistic {
            return serialized_raise_counter(self, key, value);
        }
        lock(&self.0.state).write_top_op(key, LayerOp::Max(value))
    }
    fn add_i64(&mut self, key: &[u8], delta: i64) -> Result<()> {
        if !self.0.optimistic {
            // The trait's own default, error message included.
            let value = crate::kv::read_i64(&*self, key)?.wrapping_add(delta);
            return self.put(key, &value.to_le_bytes());
        }
        lock(&self.0.state).write_top_op(key, LayerOp::Add(delta))
    }
    fn counter_below(&mut self, key: &[u8], cap: i64) -> Result<Option<i64>> {
        if !self.0.optimistic {
            let value = crate::kv::read_i64(&*self, key)?;
            return Ok((value >= cap).then_some(value));
        }
        let result = lock(&self.0.state).counter_below(key, cap);
        self.0.note(result)
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

/// The trait default of `raise_counter`, kept for serialized transactions (read, then put when lower).
fn serialized_raise_counter(w: &mut StatementWriter<'_>, key: &[u8], value: u64) -> Result<()> {
    let current = match w.get(key)? {
        Some(bytes) => {
            keys::be8(&bytes).ok_or_else(|| StoreError::new(STORE_CORRUPT, "bad id counter"))?
        }
        None => 0,
    };
    if current < value {
        w.put(key, &value.to_be_bytes())?;
    }
    Ok(())
}

impl OpenTransaction {
    pub(crate) fn reader(self: &Arc<Self>) -> Box<dyn KvRead> {
        Box::new(TxReader(self.clone()))
    }

    /// Dooms an optimistic transaction on its first `write_conflict` (or deadline), then passes the
    /// result on.
    fn note<T>(&self, result: Result<T>) -> Result<T> {
        if self.optimistic
            && let Err(error) = &result
            && (error.code == WRITE_CONFLICT || error.code == crate::error::TIMEOUT)
        {
            let mut doomed = lock(&self.doomed);
            if doomed.is_none() {
                *doomed = Some(error.clone());
            }
        }
        result
    }

    /// Why an optimistic transaction can no longer commit, if it cannot.
    fn refusal(&self) -> Option<StoreError> {
        if !self.optimistic {
            // A deadline is set only in multi-user mode; a brain whose records opened on the
            // single-writer store still keeps it.
            return deadline_passed(self.deadline).then(transaction_deadline);
        }
        if let Some(error) = lock(&self.doomed).clone() {
            return Some(error);
        }
        deadline_passed(self.deadline).then(transaction_deadline)
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
            if let Some(error) = self.refusal() {
                return self.note(Err(error));
            }
            state.statement = Some(Layer::default());
        }
        let result = self.note(f(&mut StatementWriter(self)));
        let mut state = lock(&self.state);
        let Some(layer) = state.statement.take() else {
            return Err(closed());
        };
        match result {
            Ok(value) => {
                if let Err(error) = state.merge_down(layer) {
                    // Part of the layer may be in the layer below: nothing of this transaction commits.
                    self.doom(&error);
                    return Err(error);
                }
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

    /// Marks the transaction as unable to commit (optimistic mode): its commit returns `error`.
    fn doom(&self, error: &StoreError) {
        if self.optimistic {
            let mut doomed = lock(&self.doomed);
            if doomed.is_none() {
                *doomed = Some(error.clone());
            }
        }
    }

    /// Gives back every single-flight key of this transaction (optimistic mode).
    fn release_flights(&self) {
        if self.optimistic {
            self.flights.release_all(self.owner);
        }
    }
}

impl Store {
    fn transaction(&self) -> Result<&Arc<OpenTransaction>> {
        self.bound.as_ref().ok_or_else(|| {
            StoreError::new(INVALID_STATE, "this store is not bound to a transaction")
        })
    }

    /// Opens the write transaction and returns a store bound to it. Waits for the writer (a write
    /// that is already running) before it returns. `read_only` refuses every write with
    /// `read_only_transaction`; it still holds the writer, so its reads see one consistent state.
    pub fn begin_transaction(&self, read_only: bool) -> Result<Store> {
        self.begin_bound(TxnOptions {
            read_only,
            ..TxnOptions::default()
        })
    }

    /// Opens an explicit transaction with `options` (interface I-1).
    pub fn begin_with(&self, options: TxnOptions) -> Result<Transaction> {
        Ok(Transaction {
            store: self.begin_bound(options)?,
        })
    }

    /// [`Store::begin_with`], returning the bound store itself (the binding's shape). An optimistic
    /// transaction on a single-writer store runs as a serialized one: its base already holds the
    /// writer.
    pub fn begin_bound(&self, options: TxnOptions) -> Result<Store> {
        if self.bound.is_some() {
            return Err(StoreError::new(
                INVALID_STATE,
                "a transaction is already open on this store; nest with a savepoint",
            ));
        }
        let optimistic = options.mode == TxnMode::Optimistic
            && self.multiuser()
            && self.kv.occ_stats().is_some();
        if deadline_passed(options.deadline) {
            return Err(transaction_deadline());
        }
        let base = if optimistic && !options.retry_keys.is_empty() {
            let keys: BTreeSet<Vec<u8>> = options.retry_keys.iter().cloned().collect();
            self.kv.begin_write_locked_until(&keys, options.deadline)?
        } else if optimistic {
            self.kv.begin_write()?
        } else {
            self.kv.begin_write_exclusive()?
        };
        let owner = NEXT_OWNER.fetch_add(1, Ordering::Relaxed);
        let tx = Arc::new(OpenTransaction {
            state: Mutex::new(State {
                base: Some(base),
                root_locks: BTreeSet::new(),
                savepoints: Vec::new(),
                statement: None,
                counters: BTreeMap::new(),
                allocated: BTreeMap::new(),
                undo: BTreeMap::new(),
                optimistic,
                touched: Cell::new(false),
                meta: CommitMeta::default(),
            }),
            exclusive: Mutex::new(()),
            kv: self.kv.clone(),
            read_only: AtomicBool::new(options.read_only),
            opened_read_only: options.read_only,
            optimistic,
            deadline: options.deadline,
            owner,
            age: options.age.unwrap_or(owner),
            flights: self.flights.clone(),
            doomed: Mutex::new(None),
            origin: options.origin,
        });
        Ok(self.bound_to(tx))
    }

    /// The single-flight age of the bound transaction: pass it as [`TxnOptions::age`] when the same
    /// callback runs again, so the rerun keeps its place. `invalid_state` on an unbound store.
    pub fn transaction_age(&self) -> Result<u64> {
        Ok(self.transaction()?.age)
    }

    /// True when this store is bound to an optimistic transaction.
    pub fn transaction_optimistic(&self) -> bool {
        self.bound.as_ref().is_some_and(|tx| tx.optimistic)
    }

    /// True when the bound optimistic transaction met a `write_conflict` (its commit will refuse and
    /// the wrapper should run the callback again). False on a serialized or unbound store.
    pub fn transaction_conflicted(&self) -> bool {
        self.bound.as_ref().is_some_and(|tx| {
            lock(&tx.doomed)
                .as_ref()
                .is_some_and(|e| e.code == WRITE_CONFLICT)
        })
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
        let merged = state.merge_down(layer);
        if let Err(error) = &merged {
            tx.doom(error);
        }
        merged
    }

    /// Rolls back the innermost savepoint: its writes, checks and page keys are dropped (an
    /// optimistic transaction gives the keys back to the single-flight table unless an outer layer
    /// holds them too); the counters it advanced stay advanced.
    pub fn rollback_savepoint(&self, depth: u32) -> Result<()> {
        let tx = self.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        let mut state = lock(&tx.state);
        Self::top_savepoint(&state, depth)?;
        let dropped = state.savepoints.pop().unwrap_or_default();
        if tx.optimistic && !dropped.locks.is_empty() {
            let still: BTreeSet<HeldKey> = state.held().into_iter().collect();
            tx.flights.release(
                tx.owner,
                dropped.locks.iter().filter(|k| !still.contains(*k)),
            );
        }
        // The dropped writes take the vector generation back with them; the cached index was
        // built from them.
        self.vectors.clear();
        state.restore_counters()
    }

    /// Commits the transaction and returns the commit sequence. Savepoints still open are
    /// released first. A transaction opened read-only commits nothing and returns the current
    /// sequence; one made read-only later commits the writes it made before.
    ///
    /// Optimistic mode: this is the one place that decides commit versus refusal. A doomed
    /// transaction, or one past its deadline when this runs, commits nothing; once the write is
    /// handed to the pipeline, the pipeline's answer is the result. Every end without a commit
    /// raises the transaction's id sequences (`raise_forward`) before its single-flight keys are
    /// given back.
    pub fn commit_transaction(&self) -> Result<u64> {
        self.commit_transaction_at().map(|p| p.sequence)
    }

    /// [`Store::commit_transaction`] with the commit's own position (`commit_log.rs`). A
    /// transaction that commits nothing (opened read-only) reports `CommitPosition::end_of` the
    /// sequence it saw.
    pub fn commit_transaction_at(&self) -> Result<CommitPosition> {
        let tx = self.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        let mut state = lock(&tx.state);
        state.base()?;
        if !tx.optimistic {
            // Only a transaction begun with a deadline (multi-user mode) can refuse here.
            if let Some(error) = tx.refusal() {
                state.roll_back(&tx.kv)?;
                drop(state);
                self.vectors.clear();
                return Err(error);
            }
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
            let at = base.commit_position()?;
            self.note_commit(at);
            return Ok(at);
        }
        // Every end that commits nothing below goes through this: data dropped, ids written
        // forward, single-flight keys given back last. A failure to write the ids forward is the
        // answer (a store failure, never a conflict to run again).
        let abort = |state: &mut State, error: StoreError| -> Result<CommitPosition> {
            let cleanup = state.roll_back(&tx.kv);
            self.vectors.clear();
            tx.release_flights();
            cleanup?;
            Err(error)
        };
        if let Some(error) = tx.refusal() {
            return abort(&mut state, error);
        }
        while let Some(layer) = state.savepoints.pop() {
            if let Err(error) = state.merge_down(layer) {
                return abort(&mut state, error);
            }
        }
        after_savepoint_merge();
        // Merging can take time: the deadline is checked again right before the commit is handed on.
        if deadline_passed(tx.deadline) {
            return abort(&mut state, transaction_deadline());
        }
        let base = state.base.take().ok_or_else(closed)?;
        state.root_locks.clear();
        state.undo.clear();
        let counters = state.take_counters();
        let meta = std::mem::take(&mut state.meta);
        drop(state);
        let outcome = if tx.opened_read_only {
            // The sequence it read at, not a later commit's.
            let seen = base.snapshot_sequence();
            drop(base);
            seen.map_or_else(|| tx.kv.version(), Ok)
                .map(CommitPosition::end_of)
        } else {
            let mut base = base;
            if !meta.is_empty() {
                base.set_commit_meta(meta);
            }
            base.commit_position()
        };
        // A definite refusal (a conflict, a record the pipeline could not apply) wrote nothing: its
        // ids are written forward. A store failure may or may not be on disk and stops the
        // pipeline, so nothing more is written then.
        let cleanup = match &outcome {
            Err(error) if error.code != crate::error::STORE_IO => raise_forward(&tx.kv, counters),
            _ => Ok(()),
        };
        if outcome.is_err() {
            self.vectors.clear();
        }
        tx.release_flights();
        cleanup?;
        if let Ok(at) = &outcome
            && !tx.opened_read_only
        {
            self.note_commit(*at);
        }
        outcome
    }

    /// The commit sequence a store bound to an optimistic transaction reads: its snapshot's, fixed for
    /// the transaction, and a dependency its commit checks (`KvWrite::observe_sequence`). `None` for
    /// any other store, which reads the latest commit.
    pub(crate) fn bound_commit_version(&self) -> Option<Result<u64>> {
        let tx = self.bound.as_ref().filter(|tx| tx.optimistic)?;
        let state = lock(&tx.state);
        Some(state.base().and_then(|base| {
            state.touched.set(true);
            base.observe_sequence()
                .ok_or_else(|| StoreError::new(INVALID_STATE, "the transaction reads no snapshot"))
        }))
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
            let result = state.roll_back(&tx.kv);
            if open {
                self.vectors.clear();
            }
            result
        };
        tx.release_flights();
        rollback_released_writer();
        ended
    }

    /// `lockPageKeys` inside a transaction (`pages.rs` keeps the plain key check `lock_page_keys`). `keys` arrive checked, deduplicated and sorted by the
    /// wrapper; keys the transaction already holds may be passed again. Each source must exist
    /// (`source_not_found`, message `Page source does not exist: <id>`); when `hinted`, its
    /// incarnation must match the hint (`source_changed`, message `Page source was recreated:
    /// <id>`). The keys are held by the innermost savepoint (or the transaction) until it ends.
    /// An optimistic transaction also takes them in the single-flight table first (see the module
    /// docs). Returns every key the transaction holds, sorted.
    pub fn hold_page_keys(&self, keys: &[PageKeyHint], hinted: bool) -> Result<Vec<HeldKey>> {
        let tx = self.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        let mut ordered: Vec<&PageKeyHint> = keys.iter().collect();
        ordered.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        let wanted: Vec<HeldKey> = ordered
            .iter()
            .map(|k| (k.source_id.clone(), k.slug.clone()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let grant = if tx.optimistic {
            Some(tx.note(self.take_flights(tx, &wanted))?)
        } else {
            None
        };
        let mut state = lock(&tx.state);
        state.base()?;
        if let Some(grant) = &grant
            && grant.waited
            && state.pristine()
        {
            // Nothing was read yet: read on from after the holder's commit, as a Postgres row lock
            // does, instead of conflicting for certain. The base keeps the retry keys it queued for.
            state.base.as_mut().ok_or_else(closed)?.refresh_snapshot()?;
        }
        // Each source is read once; every key is checked against it, so a later hinted key of a
        // source is held to the same incarnation check as the first.
        let mut incarnations: BTreeMap<&str, String> = BTreeMap::new();
        for key in &ordered {
            if !incarnations.contains_key(key.source_id.as_str()) {
                let record = tx.note(sources::read_source(&StateRead(&state), &key.source_id))?;
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
        let held: BTreeSet<HeldKey> = wanted.into_iter().collect();
        match state.savepoints.last_mut() {
            Some(layer) => layer.locks.extend(held),
            None => state.root_locks.extend(held),
        }
        if let Some(grant) = grant {
            grant.keep();
        }
        Ok(state.held())
    }

    /// Takes the single-flight keys of `wanted` this transaction does not hold yet. It may wait only
    /// while it holds none (see the module docs).
    fn take_flights<'t>(
        &self,
        tx: &'t OpenTransaction,
        wanted: &[HeldKey],
    ) -> Result<FlightGrant<'t>> {
        let already: BTreeSet<HeldKey> = {
            let state = lock(&tx.state);
            state.base()?;
            state.held().into_iter().collect()
        };
        let new: Vec<HeldKey> = wanted
            .iter()
            .filter(|k| !already.contains(*k))
            .cloned()
            .collect();
        tx.flights
            .acquire(tx.owner, tx.age, &new, !already.is_empty(), tx.deadline)
    }

    /// `single_flight(keys)` (interface I-1): holds exact page keys until `txn` commits or rolls
    /// back, with no source check (`lockPageKeys` adds its checks through [`Store::hold_page_keys`]).
    /// Keys are taken in sorted order; a transaction that already holds a key never waits. On a
    /// serialized transaction the keys are held in memory only (nothing else can write).
    pub fn single_flight(&self, txn: &Transaction, keys: &[SingleFlightKey]) -> Result<()> {
        let _ = self;
        let store = txn.store();
        let tx = store.transaction()?;
        let _exclusive = lock(&tx.exclusive);
        let wanted: Vec<HeldKey> = keys
            .iter()
            .map(|k| (k.source_id.clone(), k.slug.clone()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let grant = if tx.optimistic {
            Some(tx.note(store.take_flights(tx, &wanted))?)
        } else {
            None
        };
        let mut state = lock(&tx.state);
        state.base()?;
        if let Some(grant) = &grant
            && grant.waited
            && state.pristine()
        {
            state.base.as_mut().ok_or_else(closed)?.refresh_snapshot()?;
        }
        match state.savepoints.last_mut() {
            Some(layer) => layer.locks.extend(wanted),
            None => state.root_locks.extend(wanted),
        }
        if let Some(grant) = grant {
            grant.keep();
        }
        Ok(())
    }

    /// Every page key the transaction holds, sorted by source then slug.
    pub fn held_page_keys(&self) -> Result<Vec<HeldKey>> {
        let tx = self.transaction()?;
        let state = lock(&tx.state);
        state.base()?;
        Ok(state.held())
    }

    /// The single-flight table of this brain, for tests.
    #[cfg(test)]
    pub(crate) fn single_flight_table(&self) -> &SingleFlight {
        &self.flights
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
mod optimistic_tests;

#[cfg(test)]
mod review_tests;

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
