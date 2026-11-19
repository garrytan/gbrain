//! The record store of the gbrain Rust engine.
//!
//! Layers, from the bottom:
//! - `kv`: the narrow key-value trait everything is written against (`redb_kv` is the redb
//!   implementation and the only file that names redb);
//! - `Store`: one open brain. It owns the format record, the brain id and every typed operation.
//!
//! This crate has no JavaScript types. `gbrain-napi` turns each `Store` method into an async
//! addon method and each `StoreError::code` into a JavaScript `Error.code`.

mod cascade;
pub mod chunks;
pub mod cli_reads;
pub mod config;
pub mod env;
pub mod error;
#[cfg(feature = "fjall")]
pub mod fjall_kv;
pub mod format;
pub mod journal;
pub mod keys;
pub mod kv;
pub mod links;
pub mod occ_kv;
mod page_columns;
mod page_index;
mod page_projection;
pub mod pages;
pub mod redb_kv;
pub mod search;
pub mod sources;
#[cfg(test)]
mod test_support;
pub mod timeline;

// One module per planned family (docs/designs/RUST_ENGINE_INTERFACES.md). Each is listed once, here,
// so building a family never edits this list.
pub mod alias_fanout_reads;
pub mod aliases;
pub mod chat_usage;
pub mod chunk_queries;
pub mod code_edges;
pub mod contradictions;
pub mod dream;
pub mod embeddings;
pub mod eval_capture;
pub mod extraction;
pub mod facts;
pub mod field_usage;
pub mod import_members;
pub mod jobs;
pub mod keyword;
pub mod link_queries;
pub mod ontology;
pub mod page_body;
pub mod page_ops;
pub mod persistence;
pub mod raw_files;
pub mod relations;
pub mod salience;
pub mod stats;
pub mod takes;
pub mod telemetry;
pub mod timeline_queries;
pub mod transactions;
pub mod trust;
pub mod vectors;
pub mod wanted_links;
pub mod write_guards;
pub mod write_misc;
pub mod write_trust;

use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fs;
use std::path::Path;
use std::sync::Arc;

pub use crate::env::{Env, SystemEnv};
pub use crate::error::{Result, StoreError};
pub use crate::format::{FORMAT_VERSION, FORMAT_VERSIONS, FormatRecord};
pub use crate::kv::{FileBackend, Kv, KvRead, KvWrite};

/// The TypeScript schema version a fresh brain reports as `getConfig('version')`
/// (`LATEST_SCHEMA_VERSION`, `src/core/schema-migrations/latest.generated.ts`). The binding passes
/// the live value at open; this is the default for tests.
pub const DEFAULT_SCHEMA_VERSION: u32 = 319;

#[derive(Debug, Clone)]
pub struct OpenOptions {
    /// What a fresh brain stores as config `version`.
    pub schema_version: u32,
    /// Recorded in `FORMAT` when a brain is created.
    pub engine_abi: u32,
    pub catalog_version: u32,
    pub created_by: String,
    /// Opt-in: let many write transactions run at once (`occ_kv`). Off, the brain admits one
    /// writer at a time, as before. The binding turns it on with
    /// `GBRAIN_RUST_CONCURRENT_WRITES=1`.
    pub concurrent_writes: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            schema_version: DEFAULT_SCHEMA_VERSION,
            engine_abi: 1,
            catalog_version: 0,
            created_by: format!("gbrain-store {}", env!("CARGO_PKG_VERSION")),
            concurrent_writes: false,
        }
    }
}

/// What `open` tells the caller about the brain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoreInfo {
    pub brain_id: String,
    pub format_version: u32,
    pub schema_version: u32,
    /// True when this open created the brain.
    pub created: bool,
}

/// One open brain. All methods take `&self` and the store is shared across threads. A brain opened
/// with `open_dir` and `concurrent_writes` runs any number of write transactions at once
/// (`occ_kv`): conflicting writes serialize as under Postgres row locks, disjoint writes do not
/// wait. Without it the brain admits one write transaction at a time. A brain opened over another
/// `Kv` with `open_kv` gets that `Kv`'s concurrency. Reads are snapshot reads and never wait.
pub struct Store {
    pub(crate) kv: Arc<dyn Kv>,
    pub(crate) env: Arc<dyn Env>,
    /// Decoded vectors, kept across reads (`vectors.rs`). It is fed from committed snapshots
    /// only.
    #[allow(dead_code)] // the vector search family reads it
    pub(crate) vectors: vectors::VectorCache,
    /// The write trust context: the transaction-local trust settings (`write_trust.rs`).
    pub(crate) write_context: write_trust::WriteContextSlot,
    info: StoreInfo,
    /// The open transaction this store runs on (`transactions.rs`); `None` for the brain's own
    /// store, whose writes each commit on their own.
    pub(crate) bound: Option<Arc<transactions::Transaction>>,
}

/// The record file of a brain directory, with one writer or many. Only for the storage bake-off:
/// a build with the `fjall` feature (never the addon's) keeps the records in a fjall database
/// instead when `GBRAIN_RUST_BAKEOFF_STORE=fjall`.
fn open_records(dir: &Path, concurrent: bool) -> Result<Arc<dyn Kv>> {
    #[cfg(feature = "fjall")]
    if std::env::var("GBRAIN_RUST_BAKEOFF_STORE").is_ok_and(|v| v == "fjall") {
        let kv = fjall_kv::FjallKv::open_dir(&dir.join("records.fjall"))?;
        return Ok(if concurrent {
            Arc::new(occ_kv::OccKv::new_fjall(kv)?)
        } else {
            Arc::new(kv)
        });
    }
    let kv = redb_kv::RedbKv::open_path(&dir.join(format::RECORDS_FILE))?;
    Ok(if concurrent {
        Arc::new(occ_kv::OccKv::new(kv)?)
    } else {
        Arc::new(kv)
    })
}

/// How many times `Store::write` runs a transaction that keeps losing conflicts.
const WRITE_RETRY_LIMIT: u32 = 1_000;

pub(crate) fn get_json<T: DeserializeOwned>(read: &dyn KvRead, key: &[u8]) -> Result<Option<T>> {
    match read.get(key)? {
        Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        None => Ok(None),
    }
}

pub(crate) fn put_json<T: Serialize>(tx: &mut dyn KvWrite, key: &[u8], value: &T) -> Result<()> {
    tx.put(key, &serde_json::to_vec(value)?)
}

impl Store {
    /// Opens the brain in directory `dir`, creating it when it holds no brain yet.
    ///
    /// Errors: `store_locked` when another handle or process owns it, `format_unknown` for a
    /// `FORMAT` or format record this build does not read, `store_io` and `store_corrupt`.
    pub fn open_dir(dir: &Path, options: OpenOptions) -> Result<Store> {
        fs::create_dir_all(dir)
            .map_err(|e| StoreError::io(format!("creating {}: {e}", dir.display())))?;
        // FORMAT is judged before the record file is opened: a newer brain is never touched.
        let existing = format::read(dir)?;
        let kv = open_records(dir, options.concurrent_writes)?;
        let store = Store::open_kv(kv, Arc::new(SystemEnv), options.clone())?;
        // FORMAT follows the records: written when missing (a crash before it, or a deleted
        // file) and repaired when it is behind the records.
        let record = store.format_record(&options)?;
        match existing {
            Some(on_disk) if on_disk.brain_id != record.brain_id => {
                return Err(StoreError::new(
                    error::STORE_CORRUPT,
                    "FORMAT names a different brain than the record file",
                ));
            }
            Some(on_disk) if on_disk == record => {}
            _ => format::write(dir, &record)?,
        }
        Ok(store)
    }

    /// Opens a brain on any `Kv`: the entry point for the simulation and for tests that run the
    /// store on a fault-injecting disk. Creates the brain's records when the store is empty.
    pub fn open_kv(kv: Arc<dyn Kv>, env: Arc<dyn Env>, options: OpenOptions) -> Result<Store> {
        let snapshot = kv.snapshot()?;
        let stored: Option<StoredFormat> = get_json(&*snapshot, &keys::meta("format"))?;
        drop(snapshot);
        let (stored, created) = match stored {
            Some(stored) => {
                format::check_version(stored.format_version)?;
                let stored = if stored.format_version < FORMAT_VERSION {
                    upgrade_format(&*kv)?
                } else {
                    stored
                };
                (stored, false)
            }
            None => {
                let fresh = StoredFormat {
                    format_version: FORMAT_VERSION,
                    brain_id: env.new_uuid(),
                    created_at_us: env.now_micros(),
                };
                let mut tx = kv.begin_write()?;
                // Another handle may have created the brain between the read and this write.
                if let Some(raced) = get_json::<StoredFormat>(&*tx, &keys::meta("format"))? {
                    format::check_version(raced.format_version)?;
                    drop(tx);
                    (raced, false)
                } else {
                    put_json(&mut *tx, &keys::meta("format"), &fresh)?;
                    seed(&mut *tx, &*env, &options)?;
                    tx.commit()?;
                    (fresh, true)
                }
            }
        };
        // The schema version is the config the TypeScript migrations keep; a brain that has none
        // (it never was seeded) reports 0.
        let schema_version = config::read_config(&*kv.snapshot()?, "version")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        Ok(Store {
            kv,
            env,
            vectors: vectors::VectorCache::default(),
            write_context: write_trust::WriteContextSlot::default(),
            info: StoreInfo {
                brain_id: stored.brain_id,
                format_version: stored.format_version,
                schema_version,
                created,
            },
            bound: None,
        })
    }

    /// A store on the same brain whose reads and writes run inside `tx` (`transactions.rs`).
    pub(crate) fn bound_to(&self, tx: Arc<transactions::Transaction>) -> Store {
        Store {
            kv: self.kv.clone(),
            // One time for the whole transaction, as PGLite's now() (`transactions.rs`, "Time").
            env: Arc::new(transactions::TransactionClock::starting_now(
                self.env.clone(),
            )),
            // The cache holds committed snapshots only; a transaction reads its own uncommitted
            // writes, so its store starts with an empty cache of its own.
            vectors: vectors::VectorCache::default(),
            // The write trust context belongs to the transaction's handle, not the shared store: it
            // starts empty and ends with the handle (`write_trust.rs`, "Lifetime").
            write_context: write_trust::WriteContextSlot::default(),
            info: self.info.clone(),
            bound: Some(tx),
        }
    }

    pub fn info(&self) -> &StoreInfo {
        &self.info
    }

    pub fn brain_id(&self) -> &str {
        &self.info.brain_id
    }

    /// The commit sequence of the latest commit.
    pub fn commit_version(&self) -> Result<u64> {
        self.kv.version()
    }

    /// Commits, conflicts and batch sizes of the concurrent write path since open (`None` when
    /// the brain was opened over a single-writer `Kv`).
    pub fn occ_stats(&self) -> Option<occ_kv::OccStatsSnapshot> {
        self.kv.occ_stats()
    }

    /// Releases the brain: the record file closes and its lock is given up when the last
    /// reference to the underlying engine is dropped.
    pub fn close(self) {}

    /// A consistent state to read: a snapshot, or the bound transaction's own view (its writes
    /// included).
    pub(crate) fn read(&self) -> Result<Box<dyn KvRead>> {
        if let Some(tx) = &self.bound {
            return Ok(tx.reader());
        }
        self.kv.snapshot()
    }

    /// Runs `f` in a write transaction and commits when it returns `Ok`. An `Err` rolls back.
    /// On a store bound to a transaction, `f` is one statement of it: kept when it returns `Ok`,
    /// dropped when it returns `Err`, committed with the transaction.
    ///
    /// On a store with concurrent writers (`OccKv`) a transaction that read something another
    /// commit changed is run again from a fresh snapshot, so `f` may run more than once; only the
    /// last run's writes are kept. Before each rerun it queues for the keys it lost on, the way a
    /// Postgres writer waits on a row lock. Callers never see `write_conflict` unless a write
    /// loses `WRITE_RETRY_LIMIT` times in a row. A bound statement runs once: the transaction
    /// holds the store's exclusive writer, so nothing can conflict with it.
    pub(crate) fn write<T>(&self, mut f: impl FnMut(&mut dyn KvWrite) -> Result<T>) -> Result<T> {
        if let Some(tx) = &self.bound {
            // A bound store's env is the transaction's clock (`transactions.rs`, "Time").
            let _clock = crate::env::transaction_clock::open(self.env.clone());
            let _trust = crate::write_trust::stamp_context::open(self.write_trust()?);
            return tx.statement(f);
        }
        let mut locked: std::collections::BTreeSet<Vec<u8>> = std::collections::BTreeSet::new();
        let mut attempt = 0u32;
        loop {
            let mut tx = if locked.is_empty() {
                self.kv.begin_write()?
            } else {
                self.kv.begin_write_locked(&locked)?
            };
            let outcome = {
                let _clock = crate::env::transaction_clock::open(self.env.clone());
                let _trust = crate::write_trust::stamp_context::open(self.write_trust()?);
                match f(&mut *tx) {
                    Ok(value) => tx.commit().map(|_| value),
                    Err(e) => Err(e),
                }
            };
            match outcome {
                Err(e) if e.code == error::WRITE_CONFLICT => {
                    attempt += 1;
                    if attempt >= WRITE_RETRY_LIMIT {
                        return Err(StoreError::new(
                            error::WRITE_CONFLICT,
                            format!("gave up after {attempt} attempts: {}", e.message),
                        ));
                    }
                    if let Some(key) = occ_kv::conflict_key(&e) {
                        locked.insert(key);
                    }
                }
                other => return other,
            }
        }
    }

    fn format_record(&self, options: &OpenOptions) -> Result<FormatRecord> {
        Ok(FormatRecord {
            format_version: self.info.format_version,
            engine_abi: options.engine_abi,
            catalog_version: options.catalog_version,
            schema_version: self.info.schema_version,
            brain_id: self.info.brain_id.clone(),
            created_by: options.created_by.clone(),
        })
    }
}

/// The format record kept inside the store (the copy `FORMAT` is rebuilt from).
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub(crate) struct StoredFormat {
    pub format_version: u32,
    pub brain_id: String,
    pub created_at_us: i64,
}

/// Records a fresh brain starts with, written in the same transaction as its format record: the
/// schema version config (`getConfig('version')`) and the `default` source.
/// Upgrades a brain in an older format to `FORMAT_VERSION` in one write transaction, so a crash
/// leaves either the old brain or the new one. Format 1 to 2 folds the JSON counter records into
/// the per-counter records (`format.rs`). The format record is re-read inside the transaction:
/// another handle on the same records may have upgraded the brain first.
fn upgrade_format(kv: &dyn Kv) -> Result<StoredFormat> {
    let mut tx = kv.begin_write_exclusive()?;
    let mut stored: StoredFormat = get_json(&*tx, &keys::meta("format"))?
        .ok_or_else(|| StoreError::new(error::STORE_CORRUPT, "the format record went missing"))?;
    format::check_version(stored.format_version)?;
    if stored.format_version >= FORMAT_VERSION {
        return Ok(stored);
    }
    if stored.format_version == 1 {
        chunks::fold_format_1_stats(&mut *tx)?;
        journal::fold_format_1_counters(&mut *tx)?;
    }
    stored.format_version = FORMAT_VERSION;
    put_json(&mut *tx, &keys::meta("format"), &stored)?;
    tx.commit()?;
    Ok(stored)
}

fn seed(tx: &mut dyn KvWrite, env: &dyn Env, options: &OpenOptions) -> Result<()> {
    tx.put(
        &keys::text(keys::CONFIG, &["version"]),
        options.schema_version.to_string().as_bytes(),
    )?;
    sources::seed_default_source(tx, env)
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    fn open(name: &str) -> (Store, std::path::PathBuf) {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/test-tmp")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let options = OpenOptions {
            concurrent_writes: true,
            ..OpenOptions::default()
        };
        let store = Store::open_dir(&dir.join("brain"), options).unwrap();
        (store, dir)
    }

    fn key(n: u8) -> Vec<u8> {
        keys::meta(&format!("test/{n}"))
    }

    #[test]
    fn a_write_does_not_wait_for_another_open_write_on_other_keys() {
        let (store, dir) = open("occ-parallel");
        let store = Arc::new(store);
        let (inside_tx, inside) = channel();
        let (release_tx, release) = channel::<()>();
        let a = {
            let store = store.clone();
            std::thread::spawn(move || {
                store
                    .write(|tx| {
                        tx.put(&key(1), b"a")?;
                        let _ = inside_tx.send(());
                        let _ = release.recv_timeout(Duration::from_secs(30));
                        Ok(())
                    })
                    .unwrap()
            })
        };
        inside.recv().unwrap();
        // A is mid-transaction. On a single-writer store this write would block until A ends.
        let (done_tx, done) = channel();
        let b = {
            let store = store.clone();
            std::thread::spawn(move || {
                store.write(|tx| tx.put(&key(2), b"b")).unwrap();
                let _ = done_tx.send(());
            })
        };
        done.recv_timeout(Duration::from_secs(10))
            .expect("a disjoint write waited for an open write");
        release_tx.send(()).unwrap();
        a.join().unwrap();
        b.join().unwrap();
        let read = store.read().unwrap();
        assert_eq!(read.get(&key(1)).unwrap().as_deref(), Some(&b"a"[..]));
        assert_eq!(read.get(&key(2)).unwrap().as_deref(), Some(&b"b"[..]));
        drop(read);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_write_whose_read_went_stale_runs_again_and_is_the_last_writer() {
        let (store, dir) = open("occ-stale");
        let store = Arc::new(store);
        store.write(|tx| tx.put(&key(1), b"0")).unwrap();
        let (inside_tx, inside) = channel();
        let (release_tx, release) = channel::<()>();
        let a = {
            let store = store.clone();
            std::thread::spawn(move || {
                let mut runs = 0;
                store
                    .write(|tx| {
                        runs += 1;
                        let seen = tx.get(&key(1))?.unwrap();
                        if runs == 1 {
                            let _ = inside_tx.send(());
                            let _ = release.recv_timeout(Duration::from_secs(30));
                        }
                        let mut next = seen.clone();
                        next.extend_from_slice(b"+a");
                        tx.put(&key(1), &next)
                    })
                    .unwrap();
                runs
            })
        };
        inside.recv().unwrap();
        // B changes what A read while A is open.
        store
            .write(|tx| {
                let mut v = tx.get(&key(1))?.unwrap();
                v.extend_from_slice(b"+b");
                tx.put(&key(1), &v)
            })
            .unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(a.join().unwrap(), 2, "the stale write was not run again");
        // As under a Postgres row lock: A saw B's update and wrote after it. Nothing is lost.
        let read = store.read().unwrap();
        assert_eq!(read.get(&key(1)).unwrap().as_deref(), Some(&b"0+b+a"[..]));
        drop(read);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_modify_write_increments_from_many_threads_are_never_lost() {
        let (store, dir) = open("occ-increments");
        let store = Arc::new(store);
        let threads: Vec<_> = (0..16)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        store
                            .write(|tx| {
                                let n = tx
                                    .get(&key(1))?
                                    .map(|b| u64::from_be_bytes(b.try_into().unwrap()))
                                    .unwrap_or(0);
                                tx.put(&key(1), &(n + 1).to_be_bytes())
                            })
                            .unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let read = store.read().unwrap();
        let n = u64::from_be_bytes(read.get(&key(1)).unwrap().unwrap().try_into().unwrap());
        assert_eq!(n, 16 * 50);
        let stats = store.occ_stats().unwrap();
        assert!(stats.batches <= stats.commits);
        drop(read);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_skew_is_refused_as_serializable_postgres_would() {
        // Two writers each read both keys and write one. One of them must see the other's write.
        let (store, dir) = open("occ-skew");
        let store = Arc::new(store);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (1..=2u8)
            .map(|me| {
                let (store, barrier) = (store.clone(), barrier.clone());
                std::thread::spawn(move || {
                    let mut first = true;
                    store
                        .write(|tx| {
                            let other = tx.get(&key(3 - me))?;
                            if first {
                                first = false;
                                barrier.wait();
                            }
                            if other.is_none() {
                                tx.put(&key(me), b"on")?;
                            }
                            Ok(())
                        })
                        .unwrap();
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let read = store.read().unwrap();
        let on = (1..=2)
            .filter(|n| read.get(&key(*n)).unwrap().is_some())
            .count();
        assert_eq!(on, 1, "both writers acted on a stale read");
        drop(read);
        drop(store);
        let _ = std::fs::remove_dir_all(dir);
    }
}
