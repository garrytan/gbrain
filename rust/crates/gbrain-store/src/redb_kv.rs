//! The redb implementation of `Kv`. This is the only file that names redb types.
//!
//! All records live in one redb table, `kv`, keyed by the store's byte keys. The commit sequence is
//! kept under key `M\0seq` and is bumped inside every write transaction, so it commits atomically
//! with the records it counts.

use crate::commit_log::{
    AcceptHook, CommitClock, CommitMeta, CommitPosition, LogOpRef, LogSettings, LogState,
};
use crate::error::{
    READ_ONLY_TRANSACTION, Result, STORE_CLOSED, STORE_CORRUPT, STORE_IO, STORE_LOCKED, StoreError,
};
use crate::kv::{FileBackend, Kv, KvRead, KvWrite};
use redb::{
    Database, Durability, ReadOnlyDatabase, ReadTransaction, ReadableDatabase, ReadableTable,
    StorageBackend, TableDefinition, WriteTransaction,
};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

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
/// The newest durable commit time (8-byte big-endian i64; multi-user mode, `commit_log::CommitClock`),
/// written in the same transaction as the commit it times. Reserved like `SEQ_KEY`: no store key
/// equals it and no scan reaches it. Absent on a brain no commit clock ever ran on.
pub const COMMIT_TIME_KEY: &[u8] = b"M\0ctime";

/// The newest durable commit time `read` holds.
pub fn read_commit_time(read: &dyn KvRead) -> Result<Option<i64>> {
    match read.get(COMMIT_TIME_KEY)? {
        None => Ok(None),
        Some(bytes) => Ok(Some(i64::from_be_bytes(
            bytes.as_slice().try_into().map_err(|_| {
                StoreError::new(STORE_CORRUPT, "the commit time record is malformed")
            })?,
        ))),
    }
}

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
    /// The commit log, once enabled (`Kv::enable_commit_log`); `None` keeps every commit as it
    /// was before the log existed. Only a writer, which holds redb's write lock, takes it.
    log: Arc<CommitLog>,
}

/// The single-writer store's commit log state.
#[derive(Default)]
struct CommitLog {
    state: Mutex<Option<LogState>>,
    on: AtomicBool,
    /// A commit failed after its log bookkeeping was planned: the next writer reloads it.
    dirty: AtomicBool,
    /// The commit clock, once installed (`Kv::set_commit_clock`).
    clock: Mutex<Option<Arc<CommitClock>>>,
    /// Serializes a timed or logged commit from its accept step to its bookkeeping.
    finish: Arc<Mutex<()>>,
}

impl RedbKv {
    /// A follower's write (`follower.rs`): runs `f` on a raw writer (no commit log, no commit clock:
    /// the follower copies its primary's records, it does not make its own) and commits it with
    /// commit sequence `sequence` instead of the next one, and the durable commit time raised to
    /// at least `commit_time`. A sequence below the current one is refused. Not for a record file a
    /// store keeps a log or a clock on.
    pub fn replica_write<T>(
        &self,
        sequence: u64,
        commit_time: Option<i64>,
        f: impl FnOnce(&mut dyn KvWrite) -> Result<T>,
    ) -> Result<T> {
        self.replica_commit(sequence, false, commit_time, f)
    }

    /// `replica_write` that may also move the commit sequence back: a follower installing a
    /// snapshot of another history (`follower.rs`), which replaces every key in the same write.
    /// The durable commit time never moves back.
    pub fn replica_reset<T>(
        &self,
        sequence: u64,
        commit_time: Option<i64>,
        f: impl FnOnce(&mut dyn KvWrite) -> Result<T>,
    ) -> Result<T> {
        self.replica_commit(sequence, true, commit_time, f)
    }

    fn replica_commit<T>(
        &self,
        sequence: u64,
        allow_back: bool,
        commit_time: Option<i64>,
        f: impl FnOnce(&mut dyn KvWrite) -> Result<T>,
    ) -> Result<T> {
        if self.log.on.load(Ordering::Acquire)
            || self
                .log
                .clock
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_some()
        {
            return Err(StoreError::new(
                crate::error::INVALID_STATE,
                "a replica write runs only on a follower's record file",
            ));
        }
        let tx = self.db.begin_write().map_err(map)?;
        let mut w = Box::new(Writer {
            tx,
            logged: None,
            clock: None,
            commit_time: None,
            finish: self.log.finish.clone(),
            pinned_sequence: Some(sequence),
            allow_back,
        });
        let value = f(&mut *w)?;
        if let Some(time) = commit_time {
            let current = read_commit_time(&*w)?.unwrap_or(i64::MIN);
            w.commit_time = Some(current.max(time));
        }
        w.bump_and_commit()?;
        Ok(value)
    }

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
        Ok(Self {
            db: Arc::new(db),
            log: Arc::new(CommitLog::default()),
        })
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

    /// Writes the commit sequence `version` (and the source's durable commit time, when it kept
    /// one), syncs every earlier batch with it and closes the file cleanly.
    pub fn finish(self, version: u64, commit_time: Option<i64>) -> Result<()> {
        let mut tx = self.db.begin_write().map_err(map)?;
        tx.set_durability(Durability::Immediate)
            .map_err(|e| StoreError::io(format!("record store: {e}")))?;
        {
            let mut table = tx.open_table(TABLE).map_err(map)?;
            table
                .insert(SEQ_KEY, version.to_be_bytes().as_slice())
                .map_err(map)?;
            if let Some(time) = commit_time {
                table
                    .insert(COMMIT_TIME_KEY, time.to_be_bytes().as_slice())
                    .map_err(map)?;
            }
        }
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
            if k.value() != SEQ_KEY && k.value() != COMMIT_TIME_KEY && !f(k.value(), v.value()) {
                break;
            }
        }
    } else {
        for item in range {
            let (k, v) = item.map_err(map)?;
            if k.value() != SEQ_KEY && k.value() != COMMIT_TIME_KEY && !f(k.value(), v.value()) {
                break;
            }
        }
    }
    Ok(())
}

/// Refuses a key the adapter keeps for itself (`OccKv` applies the same rule to its writes).
pub(crate) fn reject_reserved(key: &[u8]) -> Result<()> {
    if key.first() == Some(&0) || key == SEQ_KEY || key == COMMIT_TIME_KEY {
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
    /// Set when the store keeps a commit log: the final value (`None`: deleted) of each key this
    /// write changed, and what it says about itself.
    logged: Option<Logged>,
    /// The commit clock, when one is installed: this commit's time, reported before it is durable.
    clock: Option<Arc<CommitClock>>,
    /// The commit time set by the optimistic pipeline over this store (`KvWrite::set_commit_time`).
    commit_time: Option<i64>,
    /// Held from a timed or logged commit's accept step to its bookkeeping (`CommitLog::finish`).
    finish: Arc<Mutex<()>>,
    /// A replica write (`RedbKv::replica_write`): the commit takes this sequence instead of the
    /// next one.
    pinned_sequence: Option<u64>,
    /// With `pinned_sequence`: the sequence may also move back (`RedbKv::replica_reset`).
    allow_back: bool,
}

struct Logged {
    log: Arc<CommitLog>,
    ops: BTreeMap<Vec<u8>, LoggedOp>,
    meta: CommitMeta,
}

/// What a logged single-writer commit did to one key: its final value, its delete, or (when the
/// write did nothing else to the key) an id sequence raised to at least a value.
enum LoggedOp {
    Put(Vec<u8>),
    Delete,
    Raise(u64),
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
        if let Some(logged) = &mut self.logged {
            logged
                .ops
                .insert(key.to_vec(), LoggedOp::Put(value.to_vec()));
        }
        Ok(())
    }

    fn raise_counter(&mut self, key: &[u8], value: u64) -> Result<()> {
        // As the default, plus: with the log on, a raise on a key this write did not otherwise
        // touch is logged as the raise itself (replayed as a max), not as the value it read.
        let current = match self.get(key)? {
            Some(bytes) => crate::keys::be8(&bytes)
                .ok_or_else(|| StoreError::new(STORE_CORRUPT, "bad id counter"))?,
            None => 0,
        };
        let raised_alone = self
            .logged
            .as_ref()
            .map(|l| matches!(l.ops.get(key), None | Some(LoggedOp::Raise(_))));
        if current < value {
            self.put(key, &value.to_be_bytes())?;
        }
        if raised_alone == Some(true)
            && let Some(logged) = &mut self.logged
        {
            let prior = match logged.ops.get(key) {
                Some(LoggedOp::Raise(m)) => *m,
                _ => 0,
            };
            logged
                .ops
                .insert(key.to_vec(), LoggedOp::Raise(prior.max(value)));
        }
        Ok(())
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        reject_reserved(key)?;
        let mut table = self.tx.open_table(TABLE).map_err(map)?;
        table.remove(key).map_err(map)?;
        if let Some(logged) = &mut self.logged {
            logged.ops.insert(key.to_vec(), LoggedOp::Delete);
        }
        Ok(())
    }

    fn set_commit_meta(&mut self, meta: CommitMeta) {
        if let Some(logged) = &mut self.logged {
            logged.meta = meta;
        }
    }

    fn set_commit_time(&mut self, time: i64) {
        self.commit_time = Some(time);
    }

    fn commit(self: Box<Self>) -> Result<u64> {
        self.commit_position().map(|p| p.sequence)
    }

    fn commit_position(mut self: Box<Self>) -> Result<CommitPosition> {
        let clock = self.clock.take();
        let logged = self.logged.take();
        if clock.is_none() && logged.is_none() {
            // Multi-user mode off: the commit as it always was.
            return self
                .bump_and_commit()
                .map(|next| CommitPosition::new(next, 0));
        }
        // The commit's time, its record, the file commit and the bookkeeping after it happen under
        // one lock: redb releases its write lock when the file commit returns, so without this the
        // next writer could time or log its commit against state this one has not published yet.
        let finish = self.finish.clone();
        let _finish = finish.lock().unwrap_or_else(|p| p.into_inner());
        let (current, _) = read_seq(&mut |key| self.get(key))?;
        let position = CommitPosition::new(current + 1, 0);
        if let Some(clock) = &clock {
            // The accept step: this writer holds redb's write lock, so no later commit is accepted first.
            self.commit_time = Some(clock.accept(position, None));
        }
        // With the log on: the record of this commit, its trims and the meta record go into the
        // same redb transaction as the records (`commit_log.rs`).
        let mut log = None;
        if let Some(Logged {
            log: shared,
            ops,
            meta,
        }) = logged
        {
            let Some(commit_time) = self.commit_time else {
                return Err(StoreError::new(
                    STORE_CORRUPT,
                    "the commit log is on but the commit has no commit time",
                ));
            };
            let mut guard = shared.state.lock().unwrap_or_else(|p| p.into_inner());
            let Some(state) = guard.as_mut() else {
                return Err(StoreError::new(
                    STORE_CORRUPT,
                    "the commit log was enabled but holds no state",
                ));
            };
            if shared.dirty.load(Ordering::Acquire) {
                *state = LogState::load(&*self, state.settings.clone())?;
                shared.dirty.store(false, Ordering::Release);
            }
            let origin = state.origin_for(&meta);
            let value = crate::commit_log::encode_record(
                &origin,
                commit_time,
                &meta.write_ids,
                ops.iter().map(|(k, v)| {
                    (
                        k.as_slice(),
                        match v {
                            LoggedOp::Put(v) => LogOpRef::Put(v),
                            LoggedOp::Delete => LogOpRef::Delete,
                            LoggedOp::Raise(m) => LogOpRef::RaiseCounter(*m),
                        },
                    )
                }),
            );
            let append = state.write(&mut *self, &[(position, value)])?;
            drop(guard);
            log = Some((shared, append));
        }
        let time = self.commit_time;
        match self.bump_and_commit() {
            Ok(next) => {
                if let (Some(clock), Some(time)) = (&clock, time) {
                    clock.committed(time);
                }
                if let Some((shared, append)) = log {
                    let mut guard = shared.state.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(state) = guard.as_mut() {
                        state.applied(append);
                    }
                }
                Ok(CommitPosition::new(next, 0))
            }
            Err(e) => {
                // A failed commit leaves no time behind (the clock keeps its last durable time) and
                // its log bookkeeping is reloaded before the next commit.
                if let Some((shared, _)) = log {
                    shared.dirty.store(true, Ordering::Release);
                }
                Err(e)
            }
        }
    }
}

impl Writer {
    /// Bumps the commit sequence in this transaction and commits it durably.
    fn bump_and_commit(mut self: Box<Self>) -> Result<u64> {
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
            let next = match self.pinned_sequence {
                Some(pinned) if pinned < current && !self.allow_back => {
                    return Err(StoreError::new(
                        STORE_CORRUPT,
                        format!(
                            "a replica write would move the commit sequence back from {current} to {pinned}"
                        ),
                    ));
                }
                Some(pinned) => pinned,
                None => current + 1,
            };
            table
                .insert(SEQ_KEY, next.to_be_bytes().as_slice())
                .map_err(map)?;
            if let Some(time) = self.commit_time {
                table
                    .insert(COMMIT_TIME_KEY, time.to_be_bytes().as_slice())
                    .map_err(map)?;
            }
            next
        };
        self.tx
            .set_durability(Durability::Immediate)
            .map_err(|e| StoreError::io(format!("record store: {e}")))?;
        self.tx.commit().map_err(map)?;
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
        let logged = self.log.on.load(Ordering::Acquire).then(|| Logged {
            log: self.log.clone(),
            ops: BTreeMap::new(),
            meta: CommitMeta::default(),
        });
        let clock = self
            .log
            .clock
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        Ok(Box::new(Writer {
            tx,
            logged,
            clock,
            commit_time: None,
            finish: self.log.finish.clone(),
            pinned_sequence: None,
            allow_back: false,
        }))
    }

    fn version(&self) -> Result<u64> {
        let snapshot = Snapshot {
            tx: self.db.begin_read().map_err(map)?,
        };
        Ok(read_seq(&mut |key| snapshot.get(key))?.0)
    }

    fn enable_commit_log(&self, settings: LogSettings) -> Result<()> {
        if self
            .log
            .clock
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_none()
        {
            return Err(StoreError::new(
                crate::error::INVALID_STATE,
                "the commit log needs the commit clock (`Kv::set_commit_clock`) first",
            ));
        }
        let state = LogState::load(&*self.snapshot()?, settings)?;
        *self.log.state.lock().unwrap_or_else(|p| p.into_inner()) = Some(state);
        self.log.dirty.store(false, Ordering::Release);
        self.log.on.store(true, Ordering::Release);
        Ok(())
    }

    fn commit_log_enabled(&self) -> bool {
        self.log.on.load(Ordering::Acquire)
    }

    fn clear_commit_clock(&self) {
        *self.log.clock.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    fn set_commit_clock(
        &self,
        clock: Arc<dyn crate::env::Env>,
        hook: Option<AcceptHook>,
    ) -> Result<()> {
        let mut slot = self.log.clock.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_none() {
            let last = crate::commit_log::floor_time(&*self.snapshot()?)?;
            *slot = Some(Arc::new(CommitClock::new(clock, last)));
        }
        if let Some(c) = slot.as_ref() {
            c.set_hook(hook);
        }
        Ok(())
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
