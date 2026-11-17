//! The redb implementation of `Kv`. This is the only file that names redb types.
//!
//! All records live in one redb table, `kv`, keyed by the store's byte keys. The commit sequence is
//! kept under key `\0seq` and is bumped inside every write transaction, so it commits atomically
//! with the records it counts.

use crate::error::{Result, STORE_CLOSED, STORE_CORRUPT, STORE_LOCKED, StoreError};
use crate::kv::{FileBackend, Kv, KvRead, KvWrite};
use redb::{
    Database, Durability, ReadTransaction, ReadableDatabase, ReadableTable, StorageBackend,
    TableDefinition, WriteTransaction,
};
use std::path::Path;
use std::sync::Arc;

const TABLE: TableDefinition<&[u8], &[u8]> = TableDefinition::new("kv");
const SEQ_KEY: &[u8] = b"\0seq";

fn map<E: Into<redb::Error>>(error: E) -> StoreError {
    match error.into() {
        redb::Error::DatabaseAlreadyOpen => StoreError::new(
            STORE_LOCKED,
            "another handle or process already has this brain open",
        ),
        redb::Error::Corrupted(why) => StoreError::new(
            STORE_CORRUPT,
            format!("the record file failed its integrity check: {why}"),
        ),
        redb::Error::DatabaseClosed => StoreError::new(STORE_CLOSED, "the record file is closed"),
        other => StoreError::io(format!("record store: {other}")),
    }
}

/// Adapts a `FileBackend` to redb's backend trait.
#[derive(Debug)]
struct Backend(Box<dyn FileBackend>);

impl StorageBackend for Backend {
    fn len(&self) -> std::io::Result<u64> {
        self.0.size()
    }
    fn read(&self, offset: u64, out: &mut [u8]) -> std::io::Result<()> {
        self.0.read_at(offset, out)
    }
    fn set_len(&self, len: u64) -> std::io::Result<()> {
        self.0.set_len(len)
    }
    fn sync_data(&self) -> std::io::Result<()> {
        self.0.sync()
    }
    fn write(&self, offset: u64, data: &[u8]) -> std::io::Result<()> {
        self.0.write_at(offset, data)
    }
}

pub struct RedbKv {
    db: Arc<Database>,
}

impl RedbKv {
    /// Opens (creating if absent) the record file at `path`. A second open of the same file,
    /// from any process, fails with `store_locked`.
    pub fn open_path(path: &Path) -> Result<Self> {
        let db = Database::builder().create(path).map_err(map)?;
        Self::init(db)
    }

    /// Opens (creating if absent) a database on any byte file.
    pub fn open_backend(backend: Box<dyn FileBackend>) -> Result<Self> {
        let db = Database::builder()
            .create_with_backend(Backend(backend))
            .map_err(map)?;
        Self::init(db)
    }

    fn init(db: Database) -> Result<Self> {
        // The table exists from the first open, so a snapshot never has to create it. This
        // commit is not counted in the commit sequence.
        let exists = db.begin_read().map_err(map)?.open_table(TABLE).is_ok();
        if !exists {
            let tx = db.begin_write().map_err(map)?;
            tx.open_table(TABLE).map_err(map)?;
            tx.commit().map_err(map)?;
        }
        Ok(Self { db: Arc::new(db) })
    }
}

fn scan_table(
    table: &impl ReadableTable<&'static [u8], &'static [u8]>,
    start: &[u8],
    end: &[u8],
    reverse: bool,
    f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
) -> Result<()> {
    // Keys that start with 0x00 are the adapter's own; a scan never reaches them.
    let start = if start.first().is_none_or(|b| *b == 0) {
        &[1u8][..]
    } else {
        start
    };
    if start >= end {
        return Ok(());
    }
    let range = table.range::<&[u8]>(start..end).map_err(map)?;
    if reverse {
        for item in range.rev() {
            let (k, v) = item.map_err(map)?;
            if !f(k.value(), v.value()) {
                break;
            }
        }
    } else {
        for item in range {
            let (k, v) = item.map_err(map)?;
            if !f(k.value(), v.value()) {
                break;
            }
        }
    }
    Ok(())
}

fn reject_reserved(key: &[u8]) -> Result<()> {
    if key.first() == Some(&0) {
        return Err(StoreError::invalid(
            "keys starting with byte 0 are reserved",
        ));
    }
    Ok(())
}

fn decode_seq(bytes: &[u8]) -> Result<u64> {
    let array: [u8; 8] = bytes
        .try_into()
        .map_err(|_| StoreError::new(STORE_CORRUPT, "the commit sequence record is malformed"))?;
    Ok(u64::from_be_bytes(array))
}

struct Snapshot {
    tx: ReadTransaction,
}

impl KvRead for Snapshot {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let table = self.tx.open_table(TABLE).map_err(map)?;
        let value = table.get(key).map_err(map)?;
        Ok(value.map(|guard| guard.value().to_vec()))
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        let table = self.tx.open_table(TABLE).map_err(map)?;
        scan_table(&table, start, end, reverse, f)
    }
}

struct Writer {
    tx: WriteTransaction,
}

impl KvRead for Writer {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let table = self.tx.open_table(TABLE).map_err(map)?;
        let value = table.get(key).map_err(map)?;
        Ok(value.map(|guard| guard.value().to_vec()))
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        let table = self.tx.open_table(TABLE).map_err(map)?;
        scan_table(&table, start, end, reverse, f)
    }
}

impl KvWrite for Writer {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        reject_reserved(key)?;
        let mut table = self.tx.open_table(TABLE).map_err(map)?;
        table.insert(key, value).map_err(map)?;
        Ok(())
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        reject_reserved(key)?;
        let mut table = self.tx.open_table(TABLE).map_err(map)?;
        table.remove(key).map_err(map)?;
        Ok(())
    }

    fn commit(mut self: Box<Self>) -> Result<u64> {
        let next = {
            let mut table = self.tx.open_table(TABLE).map_err(map)?;
            let current = match table.get(SEQ_KEY).map_err(map)? {
                Some(guard) => decode_seq(guard.value())?,
                None => 0,
            };
            let next = current + 1;
            table
                .insert(SEQ_KEY, next.to_be_bytes().as_slice())
                .map_err(map)?;
            next
        };
        self.tx
            .set_durability(Durability::Immediate)
            .map_err(|e| StoreError::io(format!("record store: {e}")))?;
        self.tx.commit().map_err(map)?;
        Ok(next)
    }
}

impl Kv for RedbKv {
    fn snapshot(&self) -> Result<Box<dyn KvRead>> {
        let tx = self.db.begin_read().map_err(map)?;
        Ok(Box::new(Snapshot { tx }))
    }

    fn begin_write(&self) -> Result<Box<dyn KvWrite>> {
        let tx = self.db.begin_write().map_err(map)?;
        Ok(Box::new(Writer { tx }))
    }

    fn version(&self) -> Result<u64> {
        let snapshot = Snapshot {
            tx: self.db.begin_read().map_err(map)?,
        };
        match snapshot.get(SEQ_KEY)? {
            Some(bytes) => decode_seq(&bytes),
            None => Ok(0),
        }
    }
}
