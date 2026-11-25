//! Group commit for the single-writer record file.
//!
//! `RedbKv` admits one write transaction at a time, and each one ends in its own durable commit
//! (one `fdatasync`). `GroupKv` keeps the one-at-a-time rule but lets the writers that queue up
//! behind a write share its commit: a group of writes is one redb write transaction and one
//! durable commit.
//!
//! Each write (`begin_write` .. `commit`) is a statement of the group's transaction. It runs alone
//! (writers still take turns), reads the transaction as the statements before it left it, and
//! keeps its own writes in an overlay. Its `commit` moves the overlay into the transaction:
//! - when no writer is waiting for a turn, it commits the transaction (one `fdatasync` for the
//!   whole group) and returns that commit's result;
//! - otherwise it hands the transaction to the next writer and waits until the group commits.
//!   Either way the call returns only after its group's durable commit, with that commit's
//!   result: nothing is acknowledged before the `fdatasync` that covers it.
//!
//! A write that ends without `commit` (an error in its body) drops its overlay; the writes of the
//! group before it are kept. A group is one transaction, so a failed commit fails every write of
//! the group, and readers never see a write before its group commits. A failed commit may or may
//! not have reached the disk, so, as `occ_kv.rs` does, the store then refuses every later write
//! until the brain is opened again. A crash keeps every acknowledged group and the group in flight
//! entirely or not at all.
//!
//! With one writer at a time nothing waits, so every group is one write and the record file sees
//! the same commits it saw without `GroupKv`. The commit sequence counts groups: writes of one
//! group share it.
//!
//! An exclusive write (`begin_write_exclusive`, the base of an explicit transaction) never joins a
//! group: it waits for the open group to commit, holds the writer alone and commits on its own.

use crate::error::{Result, StoreError};
use crate::kv::{Kv, KvRead, KvWrite};
use crate::redb_kv::reject_reserved;
use std::collections::{BTreeMap, HashMap};
use std::ops::Bound;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

/// Largest number of writes in one group.
const MAX_GROUP_WRITES: usize = 256;
/// Largest number of overlay bytes in one group.
const MAX_GROUP_BYTES: usize = 64 << 20;

/// Overlay writes: `None` is a delete.
type Writes = BTreeMap<Vec<u8>, Option<Vec<u8>>>;

#[derive(Default)]
struct State {
    /// The open group's transaction, while no write holds it.
    open: Option<Box<dyn KvWrite>>,
    /// A write holds the open group's transaction.
    holding: bool,
    /// The open group's transaction is committing.
    committing: bool,
    /// Writers waiting in `begin_write` for their turn.
    waiting: usize,
    /// An exclusive write is waiting or running: no write joins a group meanwhile.
    exclusive: bool,
    /// The open group's id.
    group: u64,
    /// Writes applied to the open group.
    members: usize,
    /// Overlay bytes applied to the open group.
    bytes: usize,
    /// An error that broke the open group's transaction; the group fails with it.
    poison: Option<StoreError>,
    /// A group commit failed: that group may or may not be on disk, so nothing may build on it
    /// and every later write is refused until the brain is opened again (as `occ_kv.rs` does).
    stopped: bool,
    /// Each committed group's result and how many of its writes have not read it yet.
    results: HashMap<u64, (Result<u64>, usize)>,
}

struct Shared {
    base: Arc<dyn Kv>,
    state: Mutex<State>,
    turn: Condvar,
}

fn lock(shared: &Shared) -> MutexGuard<'_, State> {
    shared.state.lock().unwrap_or_else(|e| e.into_inner())
}

/// The record file with group commit (see the module docs).
pub struct GroupKv {
    shared: Arc<Shared>,
}

impl GroupKv {
    pub fn new(base: Arc<dyn Kv>) -> Self {
        GroupKv {
            shared: Arc::new(Shared {
                base,
                state: Mutex::new(State::default()),
                turn: Condvar::new(),
            }),
        }
    }
}

impl Shared {
    /// Ends the open group: commits its transaction (or drops it when it broke) and records the
    /// result for its writes. Called with the state locked and no write holding the transaction;
    /// returns with it locked again.
    fn commit_group<'a>(&'a self, mut st: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        let Some(txn) = st.open.take() else {
            return st;
        };
        if st.members == 0 {
            // No write was kept: end the empty transaction without a commit.
            drop(txn);
            st.poison = None;
            st.bytes = 0;
            self.turn.notify_all();
            return st;
        }
        let group = st.group;
        let members = st.members;
        let poison = st.poison.take();
        st.committing = true;
        drop(st);
        let result = match poison {
            Some(e) => {
                drop(txn);
                Err(e)
            }
            None => txn.commit(),
        };
        let mut st = lock(self);
        let result = match result {
            Ok(seq) => Ok(seq),
            Err(e) if poison_only(&e) => Err(e),
            Err(e) => {
                st.stopped = true;
                Err(StoreError::io(format!(
                    "record store commit failed: {}",
                    e.message
                )))
            }
        };
        st.committing = false;
        st.members = 0;
        st.bytes = 0;
        st.results.insert(group, (result, members));
        self.turn.notify_all();
        st
    }

    /// Takes the result of `group` for one of its writes.
    fn take_result(st: &mut State, group: u64) -> Option<Result<u64>> {
        let (result, left) = st.results.get_mut(&group)?;
        let out = result.clone();
        *left -= 1;
        if *left == 0 {
            st.results.remove(&group);
        }
        Some(out)
    }

    /// Whether the write that just left the transaction should commit the group now.
    fn should_commit(st: &State) -> bool {
        st.waiting == 0
            || st.exclusive
            || st.members >= MAX_GROUP_WRITES
            || st.bytes >= MAX_GROUP_BYTES
            || st.poison.is_some()
    }
}

impl Kv for GroupKv {
    fn snapshot(&self) -> Result<Box<dyn KvRead>> {
        self.shared.base.snapshot()
    }

    fn versioned_snapshot(&self) -> Result<(Box<dyn KvRead + Send>, u64)> {
        self.shared.base.versioned_snapshot()
    }

    fn begin_write(&self) -> Result<Box<dyn KvWrite>> {
        let shared = &self.shared;
        let mut st = lock(shared);
        st.waiting += 1;
        while st.holding || st.committing || st.exclusive {
            st = shared.turn.wait(st).unwrap_or_else(|e| e.into_inner());
        }
        st.waiting -= 1;
        if st.stopped {
            shared.turn.notify_all();
            return Err(stopped());
        }
        if st.open.is_none() {
            match shared.base.begin_write() {
                Ok(txn) => {
                    st.open = Some(txn);
                    st.group += 1;
                    st.members = 0;
                    st.bytes = 0;
                }
                Err(e) => {
                    shared.turn.notify_all();
                    return Err(e);
                }
            }
        }
        let txn = st.open.take();
        st.holding = true;
        Ok(Box::new(Statement {
            shared: shared.clone(),
            txn,
            writes: Writes::new(),
            bytes: 0,
            group: st.group,
        }))
    }

    fn begin_write_exclusive(&self) -> Result<Box<dyn KvWrite>> {
        let shared = &self.shared;
        let mut st = lock(shared);
        // Wait for any other exclusive write, then stop new writes from joining the open group.
        while st.exclusive {
            st = shared.turn.wait(st).unwrap_or_else(|e| e.into_inner());
        }
        st.exclusive = true;
        // The open group ends: its last write commits it, or no write holds it and it commits here.
        loop {
            if st.holding || st.committing {
                st = shared.turn.wait(st).unwrap_or_else(|e| e.into_inner());
                continue;
            }
            if st.open.is_some() {
                st = shared.commit_group(st);
                continue;
            }
            break;
        }
        if st.stopped {
            st.exclusive = false;
            shared.turn.notify_all();
            return Err(stopped());
        }
        drop(st);
        match shared.base.begin_write_exclusive() {
            Ok(inner) => Ok(Box::new(Exclusive {
                shared: shared.clone(),
                inner: Some(inner),
            })),
            Err(e) => {
                let mut st = lock(shared);
                st.exclusive = false;
                shared.turn.notify_all();
                Err(e)
            }
        }
    }

    fn version(&self) -> Result<u64> {
        self.shared.base.version()
    }
}

fn stopped() -> StoreError {
    StoreError::io("an earlier commit failed; open the brain again")
}

/// Whether a group's error came from a broken write (`poison`), not from the commit: such a
/// group never reached the record file, so the store goes on.
fn poison_only(e: &StoreError) -> bool {
    e.message.starts_with(POISON_PREFIX)
}

const POISON_PREFIX: &str = "a write of this group failed while it was kept: ";

/// One write of a group.
struct Statement {
    shared: Arc<Shared>,
    /// The group's transaction, held for the whole write.
    txn: Option<Box<dyn KvWrite>>,
    writes: Writes,
    bytes: usize,
    group: u64,
}

impl Statement {
    fn base(&self) -> &dyn KvWrite {
        self.txn
            .as_deref()
            .expect("a write holds its group's transaction")
    }

    /// Gives the transaction back (with or without this write's overlay) and leaves the turn.
    /// Returns the group's result when this write was applied and its group committed.
    fn finish(&mut self, applied: bool) -> Option<Result<u64>> {
        let mut txn = self.txn.take()?;
        let shared = self.shared.clone();
        let mut poison = None;
        if applied {
            for (key, value) in std::mem::take(&mut self.writes) {
                let step = match value {
                    Some(value) => txn.put(&key, &value),
                    None => txn.delete(&key),
                };
                if let Err(e) = step {
                    poison = Some(e);
                    break;
                }
            }
        }
        let mut st = lock(&shared);
        st.open = Some(txn);
        st.holding = false;
        if applied {
            st.members += 1;
            st.bytes += self.bytes;
            if let Some(e) = poison {
                st.poison.get_or_insert(StoreError::new(
                    e.code,
                    format!("{POISON_PREFIX}{}", e.message),
                ));
            }
        }
        if Shared::should_commit(&st) {
            st = shared.commit_group(st);
        } else {
            shared.turn.notify_all();
        }
        if !applied {
            return None;
        }
        loop {
            if let Some(result) = Shared::take_result(&mut st, self.group) {
                return Some(result);
            }
            st = shared.turn.wait(st).unwrap_or_else(|e| e.into_inner());
        }
    }
}

impl Drop for Statement {
    fn drop(&mut self) {
        self.finish(false);
    }
}

impl KvRead for Statement {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        if let Some(value) = self.writes.get(key) {
            return Ok(value.clone());
        }
        self.base().get(key)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        merged_scan(self.base(), &self.writes, start, end, reverse, f)
    }
}

impl KvWrite for Statement {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        reject_reserved(key)?;
        self.bytes += key.len() + value.len();
        self.writes.insert(key.to_vec(), Some(value.to_vec()));
        Ok(())
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        reject_reserved(key)?;
        self.bytes += key.len();
        self.writes.insert(key.to_vec(), None);
        Ok(())
    }

    fn commit(mut self: Box<Self>) -> Result<u64> {
        self.finish(true).unwrap_or_else(|| {
            Err(StoreError::io(
                "the write's group ended before it committed",
            ))
        })
    }
}

/// An exclusive write: the record file's own transaction, with the group commit held off.
struct Exclusive {
    shared: Arc<Shared>,
    inner: Option<Box<dyn KvWrite>>,
}

impl Exclusive {
    fn inner(&self) -> &dyn KvWrite {
        self.inner
            .as_deref()
            .expect("an exclusive write holds its transaction")
    }
    fn inner_mut(&mut self) -> &mut dyn KvWrite {
        self.inner
            .as_deref_mut()
            .expect("an exclusive write holds its transaction")
    }
    fn release(&self) {
        let mut st = lock(&self.shared);
        st.exclusive = false;
        self.shared.turn.notify_all();
    }
}

impl Drop for Exclusive {
    fn drop(&mut self) {
        if self.inner.take().is_some() {
            self.release();
        }
    }
}

impl KvRead for Exclusive {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.inner().get(key)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        self.inner().scan(start, end, reverse, f)
    }
}

impl KvWrite for Exclusive {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        self.inner_mut().put(key, value)
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        self.inner_mut().delete(key)
    }

    fn commit(mut self: Box<Self>) -> Result<u64> {
        let inner = self
            .inner
            .take()
            .expect("an exclusive write holds its transaction");
        let result = inner.commit();
        self.release();
        result
    }

    fn allocate(&mut self, key: &[u8], count: u64) -> Result<u64> {
        self.inner_mut().allocate(key, count)
    }

    fn raise_counter(&mut self, key: &[u8], value: u64) -> Result<()> {
        self.inner_mut().raise_counter(key, value)
    }

    fn add_i64(&mut self, key: &[u8], delta: i64) -> Result<()> {
        self.inner_mut().add_i64(key, delta)
    }

    fn counter_below(&mut self, key: &[u8], cap: i64) -> Result<Option<i64>> {
        self.inner_mut().counter_below(key, cap)
    }
}

/// `base`'s entries in `[start, end)` with `overlay` on top, in key order (or reverse order), until
/// `f` returns false. An overlay `None` hides the key.
fn merged_scan(
    base: &dyn KvRead,
    overlay: &Writes,
    start: &[u8],
    end: &[u8],
    reverse: bool,
    f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
) -> Result<()> {
    if start >= end {
        return Ok(());
    }
    let range = (
        Bound::Included(start.to_vec()),
        Bound::Excluded(end.to_vec()),
    );
    let mut entries: Vec<(&Vec<u8>, &Option<Vec<u8>>)> =
        overlay.range::<Vec<u8>, _>(range).collect();
    if entries.is_empty() {
        return base.scan(start, end, reverse, f);
    }
    if reverse {
        entries.reverse();
    }
    let before = |a: &[u8], b: &[u8]| if reverse { a > b } else { a < b };
    let mut next = 0usize;
    let mut stopped = false;
    base.scan(start, end, reverse, &mut |key, value| {
        while next < entries.len() && before(entries[next].0, key) {
            let (k, v) = entries[next];
            next += 1;
            if let Some(v) = v
                && !f(k, v)
            {
                stopped = true;
                return false;
            }
        }
        if next < entries.len() && entries[next].0.as_slice() == key {
            let (k, v) = entries[next];
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
                && !f(key, value)
            {
                break;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
