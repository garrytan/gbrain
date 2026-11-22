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

/// A fresh brain on an in-memory file, with the `default` source.
pub(crate) fn store() -> Store {
    let kv = RedbKv::open_backend(Box::<MemFile>::default()).unwrap();
    Store::open_kv(Arc::new(kv), Arc::new(SystemEnv), OpenOptions::default()).unwrap()
}
