//! Helpers for the unit tests inside this crate: a store on an in-memory file, so a test can call
//! the `pub(crate)` helpers and hooks that the integration tests in `tests/` cannot reach.

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
    let kv = RedbKv::open_backend(Box::<MemFile>::default()).unwrap();
    Store::open_kv(Arc::new(kv), Arc::new(SystemEnv), OpenOptions::default()).unwrap()
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
pub(crate) fn store_on(file: &FlakyFile) -> Store {
    let kv = RedbKv::open_backend(Box::new(file.clone())).unwrap();
    Store::open_kv(Arc::new(kv), Arc::new(SystemEnv), OpenOptions::default()).unwrap()
}
