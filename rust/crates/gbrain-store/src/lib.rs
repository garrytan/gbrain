//! The record store of the gbrain Rust engine.
//!
//! Layers, from the bottom:
//! - `kv`: the narrow key-value trait everything is written against (`redb_kv` is the redb
//!   implementation and the only file that names redb);
//! - `Store`: one open brain. It owns the format record, the brain id and every typed operation.
//!
//! This crate has no JavaScript types. `gbrain-napi` turns each `Store` method into an async
//! addon method and each `StoreError::code` into a JavaScript `Error.code`.

mod access_flag;
pub mod access_member_links;
pub mod access_member_sources;
pub mod access_members;
mod cascade;
pub mod chunks;
pub mod cli_reads;
pub mod config;
pub mod env;
pub mod error;
pub mod format;
pub mod journal;
pub mod keys;
pub mod kv;
pub mod links;
mod owner_only;
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
pub mod embedding_catalog;
pub mod embedding_install;
pub mod embeddings;
pub mod entity_identities;
pub mod eval_capture;
pub mod extraction;
pub mod facts;
pub mod field_usage;
pub mod generations;
pub mod import_members;
pub mod jobs;
pub mod keyword;
pub mod large_page;
pub mod link_queries;
pub mod ontology;
pub mod page_body;
pub mod page_embedding_budget;
pub mod page_ops;
pub mod page_visibility;
pub mod persistence;
pub mod raw_files;
pub mod relations;
pub mod salience;
pub mod session_state;
pub mod stats;
pub mod takes;
pub mod telemetry;
pub mod timeline_queries;
pub mod transactions;
pub mod trust;
pub mod vectors;
pub mod wanted_links;
pub mod write_attribution;
pub mod write_guards;
pub mod write_misc;
mod write_receipt;
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
    /// Config rows a fresh brain starts with besides `version`, in the order given: the
    /// caller's embedding identity (`embedding_model`, `embedding_dimensions`) and
    /// `chunk_strategy`, the rows the SQL engines' schema seeds. The store has no default of
    /// its own; an existing brain keeps the rows it has.
    pub initial_config: Vec<(String, String)>,
}

impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            schema_version: DEFAULT_SCHEMA_VERSION,
            engine_abi: 1,
            catalog_version: 0,
            created_by: format!("gbrain-store {}", env!("CARGO_PKG_VERSION")),
            initial_config: Vec::new(),
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

/// One open brain. All methods take `&self`; the store admits one write transaction at a time and
/// any number of snapshot reads.
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
    /// True when the open-time scan could not store the member-access flag and this process reads
    /// it as `'1'` (`access_flag::scan_at_open`).
    pub(crate) flag_assumed: bool,
}

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
        let kv = redb_kv::RedbKv::open_path(&dir.join(format::RECORDS_FILE))?;
        let store = Store::open_kv(Arc::new(kv), Arc::new(SystemEnv), options.clone())?;
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
        let flag_assumed = !created && access_flag::scan_at_open(&*kv)?;
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
            flag_assumed,
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
            flag_assumed: self.flag_assumed,
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

    /// Runs `f` in the write transaction and commits when it returns `Ok`. An `Err` rolls back.
    /// On a store bound to a transaction, `f` is one statement of it: kept when it returns `Ok`,
    /// dropped when it returns `Err`, committed with the transaction. Either way `f` writes
    /// through `access_flag::FlaggingWriter`, so a put of a page record that names readers sets the
    /// member-access flag in the same write.
    pub(crate) fn write<T>(&self, f: impl FnOnce(&mut dyn KvWrite) -> Result<T>) -> Result<T> {
        if let Some(tx) = &self.bound {
            // A bound store's env is the transaction's clock (`transactions.rs`, "Time").
            let _clock = crate::env::transaction_clock::open(self.env.clone());
            let _trust = crate::write_trust::stamp_context::open(self.write_trust()?);
            return tx.statement(|w| f(&mut access_flag::FlaggingWriter(w)));
        }
        let mut tx = self.kv.begin_write()?;
        let _clock = crate::env::transaction_clock::open(self.env.clone());
        let _trust = crate::write_trust::stamp_context::open(self.write_trust()?);
        let value = f(&mut access_flag::FlaggingWriter(&mut *tx))?;
        tx.commit()?;
        Ok(value)
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
/// schema version config (`getConfig('version')`), the caller's `initial_config` rows and the
/// `default` source.
fn seed(tx: &mut dyn KvWrite, env: &dyn Env, options: &OpenOptions) -> Result<()> {
    tx.put(
        &keys::text(keys::CONFIG, &["version"]),
        options.schema_version.to_string().as_bytes(),
    )?;
    for (key, value) in &options.initial_config {
        if key.is_empty() || key == "version" {
            return Err(StoreError::invalid(format!(
                "initial config key {key:?} is not allowed"
            )));
        }
        tx.put(&keys::text(keys::CONFIG, &[key.as_str()]), value.as_bytes())?;
    }
    access_flag::record_scan_done(tx)?;
    sources::seed_default_source(tx, env)
}
