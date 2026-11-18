//! The narrow key-value trait the whole store is written against.
//!
//! Nothing above this module, and nothing outside `redb_kv`, names a redb type. A key is a byte
//! string; a scan is a half-open byte range, forward or reverse. One writer at a time: a second
//! `begin_write` waits for the first to commit or drop. A snapshot never sees a later commit.
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
}

pub trait Kv: Send + Sync {
    fn snapshot(&self) -> Result<Box<dyn KvRead>>;
    fn begin_write(&self) -> Result<Box<dyn KvWrite>>;
    /// The commit sequence of the latest commit (0 on a database nothing was committed to).
    fn version(&self) -> Result<u64>;
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
