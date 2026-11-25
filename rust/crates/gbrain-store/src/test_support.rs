//! Helpers for the unit tests inside this crate: a store on an in-memory file, so a test can call
//! the `pub(crate)` helpers and hooks that the integration tests in `tests/` cannot reach.

use crate::env::Env;
use crate::kv::FileBackend;
use crate::redb_kv::RedbKv;
use crate::{OpenOptions, Store, SystemEnv};
use std::sync::{Arc, Mutex};

/// A byte file held in memory. Nothing survives the store.
#[derive(Debug, Default)]
struct MemFile(Mutex<Vec<u8>>);

impl FileBackend for MemFile {
    fn size(&self) -> std::io::Result<u64> {
        Ok(self.0.lock().unwrap().len() as u64)
    }
    fn read_at(&self, offset: u64, out: &mut [u8]) -> std::io::Result<()> {
        let data = self.0.lock().unwrap();
        let start = offset as usize;
        let end = start + out.len();
        if end > data.len() {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
        }
        out.copy_from_slice(&data[start..end]);
        Ok(())
    }
    fn write_at(&self, offset: u64, bytes: &[u8]) -> std::io::Result<()> {
        let mut data = self.0.lock().unwrap();
        let start = offset as usize;
        let end = start + bytes.len();
        if end > data.len() {
            data.resize(end, 0);
        }
        data[start..end].copy_from_slice(bytes);
        Ok(())
    }
    fn set_len(&self, len: u64) -> std::io::Result<()> {
        self.0.lock().unwrap().resize(len as usize, 0);
        Ok(())
    }
    fn sync(&self) -> std::io::Result<()> {
        Ok(())
    }
}

/// An empty record file in memory, to open and reopen a brain on.
pub(crate) fn mem_kv() -> Arc<dyn crate::kv::Kv> {
    Arc::new(RedbKv::open_backend(Box::<MemFile>::default()).unwrap())
}

/// A fresh brain on an in-memory file, with the `default` source.
pub(crate) fn store() -> Store {
    store_on(Arc::new(SystemEnv))
}

/// `store()` with the given clock and identifier source.
pub(crate) fn store_on(env: Arc<dyn crate::env::Env>) -> Store {
    let kv = RedbKv::open_backend(Box::<MemFile>::default()).unwrap();
    Store::open_kv(Arc::new(kv), env, OpenOptions::default()).unwrap()
}

/// A fresh brain on an in-memory file whose clock and ids come from `env`.
pub(crate) fn store_with_env(env: Arc<dyn Env>) -> Store {
    let kv = RedbKv::open_backend(Box::<MemFile>::default()).unwrap();
    Store::open_kv(Arc::new(kv), env, OpenOptions::default()).unwrap()
}

/// The concurrent-writer engine (`OccKv`) on an in-memory file, with no brain in it.
pub(crate) fn occ_kv() -> crate::occ_kv::OccKv {
    let kv = RedbKv::open_backend(Box::<MemFile>::default()).unwrap();
    crate::occ_kv::OccKv::new(kv).unwrap()
}

/// A fresh brain on an in-memory file behind the concurrent-writer engine (`OccKv`), so a write
/// that loses a conflict runs again.
pub(crate) fn occ_store() -> Store {
    Store::open_kv(
        Arc::new(occ_kv()),
        Arc::new(SystemEnv),
        OpenOptions::default(),
    )
    .unwrap()
}

/// An in-memory file whose next `sync` fails once `fail_sync` is set, so a commit fails on its
/// durability step. Clones share the bytes and the switch, so a test can arm it and reopen on it.
#[derive(Debug, Default, Clone)]
pub(crate) struct FlakyFile {
    file: Arc<MemFile>,
    pub(crate) fail_sync: Arc<std::sync::atomic::AtomicBool>,
}

impl FileBackend for FlakyFile {
    fn size(&self) -> std::io::Result<u64> {
        self.file.size()
    }
    fn read_at(&self, offset: u64, out: &mut [u8]) -> std::io::Result<()> {
        self.file.read_at(offset, out)
    }
    fn write_at(&self, offset: u64, bytes: &[u8]) -> std::io::Result<()> {
        self.file.write_at(offset, bytes)
    }
    fn set_len(&self, len: u64) -> std::io::Result<()> {
        self.file.set_len(len)
    }
    fn sync(&self) -> std::io::Result<()> {
        if self
            .fail_sync
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(std::io::Error::other("injected sync failure"));
        }
        Ok(())
    }
}

/// A brain on `file`: created on first open, opened again on the same bytes after that.
pub(crate) fn store_on_file(file: &FlakyFile) -> Store {
    let kv = RedbKv::open_backend(Box::new(file.clone())).unwrap();
    Store::open_kv(Arc::new(kv), Arc::new(SystemEnv), OpenOptions::default()).unwrap()
}

/// The calls of a write transaction `FaultyKv` can fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FaultOp {
    /// `get`, with the key read.
    Get,
    /// `scan`, with the start key.
    Scan,
    /// `put`, with the key written.
    Put,
    /// `delete`, with the key deleted.
    Delete,
}

/// A record store whose write transactions fail the way a failing disk does: a call in `ops`
/// inside a write transaction returns `code` once `fail_on` accepts its key (a scan's start
/// key), so a test can make one step of a format upgrade hit an I/O or storage error. Reads
/// through a snapshot, and every other call, go to the wrapped store.
pub(crate) struct FaultyKv {
    pub(crate) inner: Arc<dyn crate::kv::Kv>,
    pub(crate) code: &'static str,
    pub(crate) ops: &'static [FaultOp],
    pub(crate) fail_on: fn(&[u8]) -> bool,
}

struct FaultyWrite {
    inner: Box<dyn crate::kv::KvWrite>,
    code: &'static str,
    ops: &'static [FaultOp],
    fail_on: fn(&[u8]) -> bool,
}

impl FaultyWrite {
    fn check(&self, op: FaultOp, key: &[u8]) -> crate::Result<()> {
        if self.ops.contains(&op) && (self.fail_on)(key) {
            return Err(crate::StoreError::new(
                self.code,
                "injected storage failure",
            ));
        }
        Ok(())
    }
}

impl crate::kv::KvRead for FaultyWrite {
    fn get(&self, key: &[u8]) -> crate::Result<Option<Vec<u8>>> {
        self.check(FaultOp::Get, key)?;
        self.inner.get(key)
    }
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> crate::Result<()> {
        self.check(FaultOp::Scan, start)?;
        self.inner.scan(start, end, reverse, f)
    }
}

impl crate::kv::KvWrite for FaultyWrite {
    fn put(&mut self, key: &[u8], value: &[u8]) -> crate::Result<()> {
        self.check(FaultOp::Put, key)?;
        self.inner.put(key, value)
    }
    fn delete(&mut self, key: &[u8]) -> crate::Result<()> {
        self.check(FaultOp::Delete, key)?;
        self.inner.delete(key)
    }
    fn commit(self: Box<Self>) -> crate::Result<u64> {
        self.inner.commit()
    }
}

impl crate::kv::Kv for FaultyKv {
    fn snapshot(&self) -> crate::Result<Box<dyn crate::kv::KvRead>> {
        self.inner.snapshot()
    }
    fn versioned_snapshot(&self) -> crate::Result<(Box<dyn crate::kv::KvRead + Send>, u64)> {
        self.inner.versioned_snapshot()
    }
    fn begin_write(&self) -> crate::Result<Box<dyn crate::kv::KvWrite>> {
        self.begin_write_exclusive()
    }
    fn begin_write_exclusive(&self) -> crate::Result<Box<dyn crate::kv::KvWrite>> {
        Ok(Box::new(FaultyWrite {
            inner: self.inner.begin_write_exclusive()?,
            code: self.code,
            ops: self.ops,
            fail_on: self.fail_on,
        }))
    }
    fn version(&self) -> crate::Result<u64> {
        self.inner.version()
    }
}
