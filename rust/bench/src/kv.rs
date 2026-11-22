//! The base store contract: a plain ordered key-value store with atomic, durable batches and
//! point-in-time snapshots. Nothing above this file knows which store is underneath.
//!
//! Two tables exist: `Data` (records plus `meta/version`) and `Log` (the commit log,
//! version -> encoded write set). Every batch writes both in one base-store transaction.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Table {
    Data,
    Log,
}

#[derive(Debug)]
pub enum Error {
    /// The optimistic layer refused a commit: something this transaction read changed.
    Conflict,
    /// A typed operation kept conflicting until its retry budget ran out.
    RetryBudgetExhausted { attempts: u32 },
    /// The base store failed (I/O, corruption, refusal to open).
    Store(String),
    /// A record could not be decoded.
    Corrupt(String),
    /// The caller used the transaction in a way the layer does not support.
    Unsupported(&'static str),
    /// The commit pipeline is gone (store closing).
    Closed,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Conflict => write!(f, "conflict"),
            Error::RetryBudgetExhausted { attempts } => {
                write!(f, "retry budget exhausted after {attempts} attempts")
            }
            Error::Store(s) => write!(f, "store error: {s}"),
            Error::Corrupt(s) => write!(f, "corrupt record: {s}"),
            Error::Unsupported(s) => write!(f, "unsupported: {s}"),
            Error::Closed => write!(f, "commit pipeline closed"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

pub fn store_err<E: fmt::Display>(e: E) -> Error {
    Error::Store(e.to_string())
}

/// One operation of an atomic batch: `value == None` deletes the key.
pub struct BatchOp {
    pub table: Table,
    pub key: Vec<u8>,
    pub value: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct WriteBatch {
    pub ops: Vec<BatchOp>,
}

impl WriteBatch {
    pub fn put(&mut self, table: Table, key: Vec<u8>, value: Vec<u8>) {
        self.ops.push(BatchOp {
            table,
            key,
            value: Some(value),
        });
    }
    pub fn delete(&mut self, table: Table, key: Vec<u8>) {
        self.ops.push(BatchOp {
            table,
            key,
            value: None,
        });
    }
}

/// A consistent, never-blocking view of the store at one point in time.
pub trait Snapshot {
    fn get(&self, table: Table, key: &[u8]) -> Result<Option<Vec<u8>>>;
    /// Visit keys in `[start, end)` in order (reverse order if `reverse`); stop when `f` returns false.
    fn scan(
        &self,
        table: Table,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()>;
}

pub trait BaseStore: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    fn snapshot(&self) -> Result<Box<dyn Snapshot>>;
    /// Apply every op atomically and make it durable (fsync) before returning.
    /// Only the commit pipeline thread calls this, so it is never contended.
    fn commit(&self, batch: &WriteBatch) -> Result<()>;
}

/// Smallest key strictly greater than `key` (append a zero byte).
pub fn key_successor(key: &[u8]) -> Vec<u8> {
    let mut k = key.to_vec();
    k.push(0);
    k
}

/// Exclusive end of the set of keys that start with `prefix` (None if the prefix is all 0xFF).
pub fn prefix_end(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut k = prefix.to_vec();
    while let Some(last) = k.pop() {
        if last < 0xFF {
            k.push(last + 1);
            return Some(k);
        }
    }
    None
}
