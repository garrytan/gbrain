//! The redb implementation of `Kv`. This is the only file that names redb types.
//!
//! All records live in one redb table, `kv`, keyed by the store's byte keys. The commit sequence is
//! kept under key `M\0seq` and is bumped inside every write transaction, so it commits atomically
//! with the records it counts.

use crate::error::{
    READ_ONLY_TRANSACTION, Result, STORE_CLOSED, STORE_CORRUPT, STORE_IO, STORE_LOCKED, StoreError,
};
use crate::kv::{FileBackend, Kv, KvRead, KvWrite};
use redb::{
    Database, Durability, ReadOnlyDatabase, ReadTransaction, ReadableDatabase, ReadableTable,
    StorageBackend, TableDefinition, WriteTransaction,
};
use std::path::Path;
use std::sync::Arc;

const TABLE: TableDefinition<&[u8], &[u8]> = TableDefinition::new("kv");
/// The commit sequence. It sorts just before the store's id counters (`M` + `next_...`), which
/// every commit that creates a record also writes, so such a commit changes one B-tree leaf for
/// both instead of two. No store key equals it: a store meta key is `M` and a name, and no name
/// starts with byte 0. Puts and scans treat it as reserved, like every key that starts with byte 0.
const SEQ_KEY: &[u8] = b"M\0seq";
/// Where record files written before store format 3 keep the commit sequence. The first commit
/// on such a file (the format upgrade) moves it to `SEQ_KEY` in the same transaction, so a crash
/// never leaves an older build a file whose sequence it cannot find.
const LEGACY_SEQ_KEY: &[u8] = b"\0seq";

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
        redb::Error::RepairAborted => StoreError::new(
            STORE_IO,
            "the record file was not closed cleanly and a read-only open does not repair it; open it once for writing first",
        ),
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

/// The record file opened only to read (`Store::open_dir_read_only`). redb takes no write lock,
/// runs no recovery and commits nothing on close, so the file keeps every byte; a plain
/// `RedbKv` open commits redb's allocator state when it closes, even when nothing was written.
/// Every write is refused with `read_only_transaction`.
pub struct RedbReadOnlyKv {
    db: ReadOnlyDatabase,
}

impl RedbReadOnlyKv {
    /// Opens the existing record file at `path`. Errors: `store_io` when the file is missing,
    /// cannot be read or was not closed cleanly, `store_locked` when a writable handle has it
    /// open, `store_corrupt`.
    pub fn open_path(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Err(StoreError::new(
                STORE_IO,
                format!("{} holds no record file to read", path.display()),
            ));
        }
        let db = Database::builder().open_read_only(path).map_err(map)?;
        Ok(Self { db })
    }
}

impl Kv for RedbReadOnlyKv {
    fn snapshot(&self) -> Result<Box<dyn KvRead>> {
        let tx = self.db.begin_read().map_err(map)?;
        Ok(Box::new(Snapshot { tx }))
    }

    fn versioned_snapshot(&self) -> Result<(Box<dyn KvRead + Send>, u64)> {
        versioned(self.db.begin_read().map_err(map)?)
    }

    fn begin_write(&self) -> Result<Box<dyn KvWrite>> {
        Err(StoreError::new(
            READ_ONLY_TRANSACTION,
            "this brain was opened read-only; nothing was written",
        ))
    }

    fn version(&self) -> Result<u64> {
        let snapshot = Snapshot {
            tx: self.db.begin_read().map_err(map)?,
        };
        Ok(read_seq(&mut |key| snapshot.get(key))?.0)
    }
}

/// A new record file that the store snapshot copy fills (`snapshot.rs`). It is the one writer of
/// a file nothing else has open, so it writes keys the `KvWrite` rules refuse to a store (the
/// copy carries the source's commit sequence over as it is) and skips the per-commit sequence
/// bump. Batches commit without a sync; `finish` writes the sequence and syncs once, so a file
/// that never reached `finish` is not a snapshot.
pub struct RedbSink {
    db: Database,
}

impl RedbSink {
    /// Creates the record file at `path`; refuses a path that already holds one.
    pub fn create_path(path: &Path) -> Result<Self> {
        if path.exists() {
            return Err(StoreError::invalid(format!(
                "{} already exists; a snapshot never writes over a file",
                path.display()
            )));
        }
        Self::init(Database::builder().create(path).map_err(map)?)
    }

    /// Creates a record file on any byte file: the seam for fault-injection tests.
    pub fn create_backend(backend: Box<dyn FileBackend>) -> Result<Self> {
        Self::init(
            Database::builder()
                .create_with_backend(Backend(backend))
                .map_err(map)?,
        )
    }

    fn init(db: Database) -> Result<Self> {
        let tx = db.begin_write().map_err(map)?;
        tx.open_table(TABLE).map_err(map)?;
        tx.commit().map_err(map)?;
        Ok(Self { db })
    }

    /// Adds `entries`, in one transaction that is not synced. A key the adapter keeps for itself
    /// is refused.
    pub fn put_batch(&self, entries: &[(Vec<u8>, Vec<u8>)]) -> Result<()> {
        let mut tx = self.db.begin_write().map_err(map)?;
        tx.set_durability(Durability::None)
            .map_err(|e| StoreError::io(format!("record store: {e}")))?;
        {
            let mut table = tx.open_table(TABLE).map_err(map)?;
            for (key, value) in entries {
                reject_reserved(key)?;
                table
                    .insert(key.as_slice(), value.as_slice())
                    .map_err(map)?;
            }
        }
        tx.commit().map_err(map)?;
        Ok(())
    }

    /// Writes the commit sequence `version`, syncs every earlier batch with it and closes the
    /// file cleanly.
    pub fn finish(self, version: u64) -> Result<()> {
        let mut tx = self.db.begin_write().map_err(map)?;
        tx.set_durability(Durability::Immediate)
            .map_err(|e| StoreError::io(format!("record store: {e}")))?;
        tx.open_table(TABLE)
            .map_err(map)?
            .insert(SEQ_KEY, version.to_be_bytes().as_slice())
            .map_err(map)?;
        tx.commit().map_err(map)?;
        drop(self.db);
        Ok(())
    }
}

/// Reads one record from the file at `path` without changing a byte of it: no lock is taken
/// for writing, no recovery runs and nothing is committed on close (a plain open commits redb's
/// allocator state when it closes). `None` when the file is missing, needs recovery, is open
/// elsewhere or cannot be read this way; the caller then opens it normally and gets that
/// open's own answer.
pub fn peek(path: &Path, key: &[u8]) -> Option<Vec<u8>> {
    if !path.exists() {
        return None;
    }
    let db = Database::builder().open_read_only(path).ok()?;
    let tx = db.begin_read().ok()?;
    let table = tx.open_table(TABLE).ok()?;
    let value = table.get(key).ok()??;
    Some(value.value().to_vec())
}

/// Reads one record by key, from whichever transaction the caller holds.
type KeyLookup<'a> = dyn FnMut(&[u8]) -> Result<Option<Vec<u8>>> + 'a;

/// Reads the commit sequence through `get`, from `SEQ_KEY` or, in a file not yet written by this
/// build, from `LEGACY_SEQ_KEY`. Returns the sequence and whether it came from the legacy key.
fn read_seq(get: &mut KeyLookup<'_>) -> Result<(u64, bool)> {
    if let Some(bytes) = get(SEQ_KEY)? {
        return Ok((decode_seq(&bytes)?, false));
    }
    match get(LEGACY_SEQ_KEY)? {
        Some(bytes) => Ok((decode_seq(&bytes)?, true)),
        None => Ok((0, false)),
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
            if k.value() != SEQ_KEY && !f(k.value(), v.value()) {
                break;
            }
        }
    } else {
        for item in range {
            let (k, v) = item.map_err(map)?;
            if k.value() != SEQ_KEY && !f(k.value(), v.value()) {
                break;
            }
        }
    }
    Ok(())
}

/// Refuses a key the adapter keeps for itself (`OccKv` applies the same rule to its writes).
pub(crate) fn reject_reserved(key: &[u8]) -> Result<()> {
    if key.first() == Some(&0) || key == SEQ_KEY {
        return Err(StoreError::invalid(
            "keys starting with byte 0, and the commit sequence key, are reserved",
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
        let start = std::time::Instant::now();
        let next = {
            let mut table = self.tx.open_table(TABLE).map_err(map)?;
            let (current, legacy) = read_seq(&mut |key| {
                Ok(table
                    .get(key)
                    .map_err(map)?
                    .map(|guard| guard.value().to_vec()))
            })?;
            if legacy {
                table.remove(LEGACY_SEQ_KEY).map_err(map)?;
            }
            let next = current + 1;
            table
                .insert(SEQ_KEY, next.to_be_bytes().as_slice())
                .map_err(map)?;
            next
        };
        self.tx
            .set_durability(Durability::Immediate)
            .map_err(|e| StoreError::io(format!("record store: {e}")))?;
        let redb_start = std::time::Instant::now();
        self.tx.commit().map_err(map)?;
        crate::commit_profile::note_commit(start, redb_start);
        Ok(next)
    }
}

/// A read transaction as a snapshot that can move to another thread, with the commit sequence it
/// sees (read from inside the snapshot, so the two always agree).
fn versioned(tx: ReadTransaction) -> Result<(Box<dyn KvRead + Send>, u64)> {
    let snapshot = Snapshot { tx };
    let (version, _) = read_seq(&mut |key| snapshot.get(key))?;
    Ok((Box::new(snapshot), version))
}

impl Kv for RedbKv {
    fn snapshot(&self) -> Result<Box<dyn KvRead>> {
        let tx = self.db.begin_read().map_err(map)?;
        Ok(Box::new(Snapshot { tx }))
    }

    fn versioned_snapshot(&self) -> Result<(Box<dyn KvRead + Send>, u64)> {
        versioned(self.db.begin_read().map_err(map)?)
    }

    fn begin_write(&self) -> Result<Box<dyn KvWrite>> {
        let tx = self.db.begin_write().map_err(map)?;
        Ok(Box::new(Writer { tx }))
    }

    fn version(&self) -> Result<u64> {
        let snapshot = Snapshot {
            tx: self.db.begin_read().map_err(map)?,
        };
        Ok(read_seq(&mut |key| snapshot.get(key))?.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_legacy_commit_sequence_moves_only_with_the_next_commit() {
        let dir = std::env::temp_dir().join(format!("redb-seq-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("records.redb");
        {
            let db = Database::create(&path).unwrap();
            let tx = db.begin_write().unwrap();
            tx.open_table(TABLE)
                .unwrap()
                .insert(LEGACY_SEQ_KEY, 41u64.to_be_bytes().as_slice())
                .unwrap();
            tx.commit().unwrap();
        }
        let legacy_at = |kv: &RedbKv| {
            let read = kv.db.begin_read().unwrap();
            let table = read.open_table(TABLE).unwrap();
            (
                table.get(LEGACY_SEQ_KEY).unwrap().is_some(),
                table.get(SEQ_KEY).unwrap().is_some(),
            )
        };
        let kv = RedbKv::open_path(&path).unwrap();
        // Opening reads the legacy key and writes nothing.
        assert_eq!(kv.version().unwrap(), 41);
        assert_eq!(kv.versioned_snapshot().unwrap().1, 41);
        assert_eq!(legacy_at(&kv), (true, false));
        // The next commit counts from it and moves it in the same transaction.
        assert_eq!(kv.begin_write().unwrap().commit().unwrap(), 42);
        assert_eq!(legacy_at(&kv), (false, true));
        assert_eq!(kv.version().unwrap(), 42);
        drop(kv);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
