//! The narrow key-value trait the whole store is written against.
//!
//! Nothing above this module, and nothing outside `redb_kv`, names a redb type. A key is a byte
//! string; a scan is a half-open byte range, forward or reverse. A snapshot never sees a later
//! commit. `RedbKv` admits one writer at a time: a second `begin_write` waits for the first to
//! commit or drop. `OccKv` admits many; a commit that read something a concurrent commit changed
//! fails with `write_conflict`, and `Store::write` runs it again.
//!
//! Keys that start with byte 0x00 belong to the engine adapter (the commit sequence). The store
//! never writes them and never scans them.

use crate::error::Result;
use std::fmt::Debug;

/// Read access to one consistent state.
pub trait KvRead {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>>;
    /// Calls `f` for each entry in `[start, end)`, in key order (or reverse order), until it
    /// returns false.
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()>;
}

/// The single write transaction. Dropping it without `commit` rolls everything back.
pub trait KvWrite: KvRead + Send {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()>;
    fn delete(&mut self, key: &[u8]) -> Result<()>;
    /// Makes every put and delete durable as one unit and returns the commit sequence: it grows
    /// by exactly one per successful commit and survives restarts. An `Err` means the commit
    /// may or may not have reached the disk; after a reopen it is all or nothing.
    fn commit(self: Box<Self>) -> Result<u64>;

    /// Takes `count` ids from the sequence kept under `key` (8-byte big-endian, the next id to
    /// hand out, 1 when absent) and returns the first. Like Postgres `nextval`: two transactions
    /// never get the same id, and ids taken by a transaction that does not commit may be lost.
    fn allocate(&mut self, key: &[u8], count: u64) -> Result<u64> {
        let first = match self.get(key)? {
            Some(bytes) => crate::keys::be8(&bytes).ok_or_else(|| {
                crate::error::StoreError::new(crate::error::STORE_CORRUPT, "bad id counter")
            })?,
            None => 1,
        };
        self.put(key, &(first + count).to_be_bytes())?;
        Ok(first)
    }

    /// Raises the id sequence under `key` (8-byte big-endian) to at least `value` without
    /// reading it, so it never conflicts. A transaction that rolls back writes its sequences
    /// forward with this, so no id it handed out is handed out again.
    fn raise_counter(&mut self, key: &[u8], value: u64) -> Result<()> {
        let current = match self.get(key)? {
            Some(bytes) => crate::keys::be8(&bytes).ok_or_else(|| {
                crate::error::StoreError::new(crate::error::STORE_CORRUPT, "bad id counter")
            })?,
            None => 0,
        };
        if current < value {
            self.put(key, &value.to_be_bytes())?;
        }
        Ok(())
    }

    /// Adds `delta` to the counter under `key` (8-byte little-endian i64, 0 when absent) without
    /// reading it, so concurrent adds never conflict.
    fn add_i64(&mut self, key: &[u8], delta: i64) -> Result<()> {
        let value = decode_i64(self.get(key)?)?.wrapping_add(delta);
        self.put(key, &value.to_le_bytes())
    }

    /// Admission check on a counter: `None` when the counter is below `cap` (and the write may
    /// go on), else `Some(value)`. A concurrent store re-checks the condition at commit instead
    /// of conflicting on every change to the counter.
    fn counter_below(&mut self, key: &[u8], cap: i64) -> Result<Option<i64>> {
        let value = decode_i64(self.get(key)?)?;
        Ok((value >= cap).then_some(value))
    }
}

/// The counter under `key` (8-byte little-endian i64, 0 when absent).
pub fn read_i64(read: &dyn KvRead, key: &[u8]) -> Result<i64> {
    decode_i64(read.get(key)?)
}

fn decode_i64(value: Option<Vec<u8>>) -> Result<i64> {
    match value {
        None => Ok(0),
        Some(bytes) => Ok(i64::from_le_bytes(bytes.as_slice().try_into().map_err(
            |_| crate::error::StoreError::new(crate::error::STORE_CORRUPT, "bad counter record"),
        )?)),
    }
}

pub trait Kv: Send + Sync {
    fn snapshot(&self) -> Result<Box<dyn KvRead>>;
    fn begin_write(&self) -> Result<Box<dyn KvWrite>>;
    /// Begins a write that runs again after it lost a conflict on `keys`. A store with concurrent
    /// writers first queues for those keys (a row lock); a single-writer store ignores them.
    fn begin_write_locked(
        &self,
        keys: &std::collections::BTreeSet<Vec<u8>>,
    ) -> Result<Box<dyn KvWrite>> {
        let _ = keys;
        self.begin_write()
    }
    /// Begins a write that holds the store's writer until it ends: nothing else commits while it
    /// is open, so it never conflicts and is never run again. An explicit transaction runs on
    /// one. A single-writer store's `begin_write` already is one.
    fn begin_write_exclusive(&self) -> Result<Box<dyn KvWrite>> {
        self.begin_write()
    }
    /// The commit sequence of the latest commit (0 on a database nothing was committed to).
    fn version(&self) -> Result<u64>;
    /// What a store with concurrent writers did since open; `None` for a single-writer store.
    fn occ_stats(&self) -> Option<crate::occ_kv::OccStatsSnapshot> {
        None
    }
}

/// The byte file a storage engine runs on. The binding uses a real file; the simulation passes a
/// fault-injecting one. Offsets and lengths are in bytes; `sync` must make every earlier write
/// durable.
pub trait FileBackend: Debug + Send + Sync + 'static {
    fn size(&self) -> std::io::Result<u64>;
    fn read_at(&self, offset: u64, out: &mut [u8]) -> std::io::Result<()>;
    fn write_at(&self, offset: u64, data: &[u8]) -> std::io::Result<()>;
    fn set_len(&self, len: u64) -> std::io::Result<()>;
    fn sync(&self) -> std::io::Result<()>;
}

/// The smallest key greater than every key that starts with `prefix`, or `None` when the prefix
/// is all 0xFF bytes.
pub fn prefix_end(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut end = prefix.to_vec();
    while let Some(last) = end.pop() {
        if last < 0xFF {
            end.push(last + 1);
            return Some(end);
        }
    }
    None
}

/// Scan every entry whose key starts with `prefix`.
pub fn scan_prefix(
    read: &dyn KvRead,
    prefix: &[u8],
    reverse: bool,
    f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
) -> Result<()> {
    match prefix_end(prefix) {
        Some(end) => read.scan(prefix, &end, reverse, f),
        None => read.scan(prefix, &[0xFF; 64], reverse, f),
    }
}

/// Collect the entries under `prefix` (up to `limit`) as owned pairs.
pub fn collect_prefix(
    read: &dyn KvRead,
    prefix: &[u8],
    reverse: bool,
    limit: usize,
) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
    let mut out = Vec::new();
    if limit == 0 {
        return Ok(out);
    }
    scan_prefix(read, prefix, reverse, &mut |k, v| {
        out.push((k.to_vec(), v.to_vec()));
        out.len() < limit
    })?;
    Ok(out)
}
