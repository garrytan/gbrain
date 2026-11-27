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
mod access_key_split;
pub mod access_member_links;
pub mod access_members;
pub mod access_migrations;
pub mod access_policy;
pub mod access_rules;
pub mod atom_state;
mod cascade;
pub mod chronicle_reads;
pub mod chunks;
pub mod cli_reads;
pub mod concept_rebuild;
pub mod config;
pub mod env;
pub mod error;
#[cfg(test)]
mod fingerprint_fixture;
#[cfg(feature = "fjall")]
pub mod fjall_kv;
pub mod format;
pub mod git_gap_census;
pub mod journal;
pub(crate) mod jsonb;
pub mod keys;
pub mod keyspaces;
pub mod kv;
pub mod link_slug_reads;
pub mod links;
pub mod occ_kv;
mod owner_only;
mod owner_only_marks;
mod page_columns;
mod page_index;
mod page_projection;
mod page_withdrawals;
pub mod pages;
pub mod read_shared;
pub mod redb_kv;
pub mod retrieval_feedback;
pub mod search;
pub mod seed;
pub mod shared_skill_catalog;
pub mod shared_skill_members;
pub mod shared_skill_publication;
pub mod slug_spelling_repair;
pub mod slug_spellings;
pub mod snapshot;
pub mod sources;
#[cfg(test)]
mod test_support;
pub mod timeline;

// One module per planned family (docs/designs/RUST_ENGINE_INTERFACES.md). Each is listed once, here,
// so building a family never edits this list.
pub mod access_read_log;
pub mod alias_fanout_reads;
pub mod aliases;
pub mod budget_ledger;
pub mod chat_usage;
pub mod chronicle_ledger;
pub mod chronicle_state;
pub mod chunk_queries;
pub mod code_edges;
pub mod contradictions;
pub mod cycle_window;
#[cfg(test)]
mod derivation_walks;
pub mod dream;
pub mod dream_config;
pub mod dream_reads;
pub mod drift_conflicts;
pub mod edge_proposals;
pub mod embedding_catalog;
pub mod embedding_install;
pub mod embeddings;
pub mod engine_migration;
pub mod entity_identities;
pub mod eval_capture;
pub mod eval_harness_catalog;
pub mod eval_harness_reads;
pub mod extract_bookkeeping;
pub mod extraction;
pub mod facts;
pub mod federation_exposure;
pub mod field_usage;
pub mod generations;
pub mod guest_marks;
pub mod guest_sources;
pub mod handover_reads;
pub mod identity_auto;
pub mod identity_reviews;
pub mod import_members;
pub mod jobs;
pub mod keyword;
pub mod label_door;
pub mod large_page;
pub mod link_queries;
pub mod list_reads;
pub mod meeting_pages;
pub mod memory_mutation_reads;
pub mod mention_state;
pub mod moved_page_reads;
pub mod ontology;
pub mod page_body;
pub mod page_embedding_budget;
pub mod page_extraction_state;
pub mod page_mutation_reads;
pub mod page_ops;
pub mod page_visibility;
pub mod persistence;
pub mod purge_version_bodies;
pub mod raw_files;
pub mod reason_tombstones;
pub mod relations;
pub mod remote_links;
pub mod repair_attribution;
pub mod repair_failed_writes;
pub mod repair_fence_scans;
pub mod repair_plan_scans;
pub mod repair_scans;
pub mod repair_secret_spans;
pub mod repair_twin_merge;
pub mod repair_versions;
pub mod restore;
pub mod salience;
pub mod schema_detect;
pub mod secret_store;
pub mod session_state;
pub mod source_cr_mode;
pub mod stats;
pub mod synopsis_tier;
pub mod tail_reads;
pub mod takes;
pub mod telemetry;
pub mod timeline_queries;
pub mod transactions;
pub mod trust;
pub mod vectors;
pub mod verify;
mod version_prune;
pub mod volunteer_events;
pub mod wanted_links;
pub mod write_attribution;
pub mod write_guards;
pub mod write_misc;
mod write_receipt;
pub mod write_trust;

use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
    /// Run the keyword index build on a background thread while the index is incomplete
    /// (`keyword/index_build.rs`). Off, the index is built only by
    /// [`Store::keyword_index_build_step`]; writes keep it in step either way.
    pub keyword_index_builder: bool,
    /// Config rows a fresh brain starts with besides `version`, in the order given: the
    /// caller's embedding identity (`embedding_model`, `embedding_dimensions`) and
    /// `chunk_strategy`, the rows the SQL engines' schema seeds. The store has no default of
    /// its own; an existing brain keeps the rows it has.
    pub initial_config: Vec<(String, String)>,
    /// The caller's write-gate detector version (the TypeScript `WRITE_GATE_DETECTOR_VERSION`). A fresh
    /// brain records the write gate's scan baseline under it, as migration v227 does on the SQL engines;
    /// `None` records it under `DEFAULT_WRITE_GATE_DETECTOR_VERSION`.
    pub write_gate_detector_version: Option<u32>,
    /// False: the directory must already hold a brain (its record file); `open_dir` creates no file or folder
    /// and refuses with `store_missing` otherwise, also when the store moves away during the open. True (the default) creates a missing brain, as before.
    pub create_missing: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            schema_version: DEFAULT_SCHEMA_VERSION,
            engine_abi: 1,
            catalog_version: 0,
            created_by: format!("gbrain-store {}", env!("CARGO_PKG_VERSION")),
            concurrent_writes: false,
            keyword_index_builder: true,
            initial_config: Vec::new(),
            write_gate_detector_version: None,
            create_missing: true,
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
    /// What `open` told the caller. Shared with the store's views; a restore that rotates the brain id
    /// updates it, so the open handle never reports the id the restore replaced.
    info: Arc<Mutex<StoreInfo>>,
    /// The open transaction this store runs on (`transactions.rs`); `None` for the brain's own
    /// store, whose writes each commit on their own.
    pub(crate) bound: Option<Arc<transactions::Transaction>>,
    /// The keyword index build this store runs (`keyword/index_build.rs`); dropping the store
    /// stops it after its current batch. `None` on a bound store and on the builder's own store.
    builder: Mutex<Option<keyword::Builder>>,
    /// `OpenOptions::keyword_index_builder` as this store was opened (false on the stores above).
    runs_builder: bool,
    /// True when the open-time scan could not store the member-access flag and this process reads
    /// it as `'1'` (`access_flag::scan_at_open`).
    pub(crate) flag_assumed: bool,
    /// The brain directory, when the store was opened on one (`open_dir`, `open_dir_read_only`):
    /// the snapshot copies its `FORMAT` (`snapshot.rs`). `None` over `open_kv`.
    pub(crate) dir: Option<PathBuf>,
}

/// The record file of a brain directory, with one writer or many. Only for the storage bake-off:
/// a build with the `fjall` feature (never the addon's) keeps the records in a fjall database
/// instead when `GBRAIN_RUST_BAKEOFF_STORE=fjall`.
/// The record file of `dir`; with `create` false only one that is already there (never created).
fn open_records_as(dir: &Path, concurrent: bool, create: bool) -> Result<Arc<dyn Kv>> {
    #[cfg(feature = "fjall")]
    if std::env::var("GBRAIN_RUST_BAKEOFF_STORE").is_ok_and(|v| v == "fjall") {
        let kv = fjall_kv::FjallKv::open_dir(&dir.join("records.fjall"))?;
        return Ok(if concurrent {
            Arc::new(occ_kv::OccKv::new_fjall(kv)?)
        } else {
            Arc::new(kv)
        });
    }
    let path = dir.join(format::RECORDS_FILE);
    let kv = if create {
        redb_kv::RedbKv::open_path(&path)?
    } else {
        redb_kv::RedbKv::open_existing_path(&path)?
    };
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
    let bytes = serde_json::to_vec(value)?;
    // `get_json` and every other reader decode with serde_json's nesting limit, so a record nested
    // deeper than that would be stored and then read back only as `store_corrupt`. Refuse it here,
    // before anything is written, as the caller's own input.
    if json_depth(&bytes) > READABLE_JSON_DEPTH {
        return Err(StoreError::invalid(format!(
            "a value nested more than {READABLE_JSON_DEPTH} levels deep (with the record around it) cannot be stored"
        )));
    }
    tx.put(key, &bytes)
}

/// The deepest nesting serde_json reads back with its default recursion limit (128 frames: a record
/// 128 levels deep fails with "recursion limit exceeded").
const READABLE_JSON_DEPTH: usize = 127;

/// The deepest array or object nesting of serialized JSON, ignoring brackets inside strings.
fn json_depth(bytes: &[u8]) -> usize {
    let (mut depth, mut max, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for &b in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                max = max.max(depth);
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    max
}

impl Store {
    /// Opens the brain in directory `dir`, creating it when it holds no brain yet.
    ///
    /// Errors: `store_locked` when another handle or process owns it, `format_unknown` for a
    /// `FORMAT` or format record this build does not read, `store_io` and `store_corrupt`.
    pub fn open_dir(dir: &Path, options: OpenOptions) -> Result<Store> {
        Store::open_dir_in(dir, options, FORMAT_VERSIONS)
    }

    /// `open_dir` for a build that opens only the formats in `known`: the seam the older-build
    /// tests use (`format::check_version_in`).
    pub(crate) fn open_dir_in(dir: &Path, options: OpenOptions, known: &[u32]) -> Result<Store> {
        // With `create_missing` false nothing below creates a file or folder: the directory and its
        // record file must be there, and a store moved away mid-open is refused, not recreated.
        if !options.create_missing && !dir.join(format::RECORDS_FILE).is_file() {
            return Err(StoreError::new(
                error::STORE_MISSING,
                format!(
                    "{} holds no brain (no {}); nothing was created",
                    dir.display(),
                    format::RECORDS_FILE
                ),
            ));
        }
        if options.create_missing {
            fs::create_dir_all(dir)
                .map_err(|e| StoreError::io(format!("creating {}: {e}", dir.display())))?;
        }
        // FORMAT is judged before the record file is opened: a newer brain is never touched.
        let existing = format::read_in(dir, known)?;
        if existing.is_none() {
            // Without FORMAT the record file says which format it is. Read that without
            // opening the file for writing, so a newer brain is refused with every byte as it was.
            let peeked = redb_kv::peek(&dir.join(format::RECORDS_FILE), &keys::meta("format"));
            if let Some(stored) =
                peeked.and_then(|b| serde_json::from_slice::<StoredFormat>(&b).ok())
            {
                format::check_version_in(stored.format_version, known)?;
            }
        }
        let kv = open_records_as(dir, options.concurrent_writes, options.create_missing)?;
        let mut store = Store::open_kv_in(kv, Arc::new(SystemEnv), options.clone(), known)?;
        store.dir = Some(dir.to_path_buf());
        // FORMAT follows the records: written when missing (a crash before it, or a deleted
        // file) and repaired when it is behind the records.
        let record = store.format_record(&options)?;
        match existing {
            // A restore that rotated the brain id committed the record first: FORMAT still names
            // the id the record says it rotated from, and is rebuilt from the record below.
            Some(on_disk)
                if on_disk.brain_id != record.brain_id
                    && !store.rotated_from(&on_disk.brain_id)? =>
            {
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

    /// Opens an existing brain in `dir` only to read: no byte of the record file or of `FORMAT`
    /// changes, and the keyword index builder does not run. A write through the store is refused
    /// with `read_only_transaction`, and so is an open that would have to write: a brain with no
    /// records yet, one on an older format (a plain open upgrades it) or one whose keyword index
    /// must be reset. An incomplete keyword index stays incomplete; the members scan for it.
    ///
    /// Errors: those of `open_dir`, `store_io` when `dir` holds no record file or the file was not
    /// closed cleanly (redb repairs only on a writable open), and `store_locked` while a writable
    /// handle has the brain open.
    pub fn open_dir_read_only(dir: &Path) -> Result<Store> {
        let existing = format::read_in(dir, FORMAT_VERSIONS)?;
        let kv = Arc::new(redb_kv::RedbReadOnlyKv::open_path(
            &dir.join(format::RECORDS_FILE),
        )?);
        let options = OpenOptions {
            keyword_index_builder: false,
            ..OpenOptions::default()
        };
        let mut store = Store::open_kv_in(kv, Arc::new(SystemEnv), options, FORMAT_VERSIONS)?;
        store.dir = Some(dir.to_path_buf());
        if let Some(on_disk) = existing
            && on_disk.brain_id != store.brain_id()
            && !store.rotated_from(&on_disk.brain_id)?
        {
            return Err(StoreError::new(
                error::STORE_CORRUPT,
                "FORMAT names a different brain than the record file",
            ));
        }
        Ok(store)
    }

    /// Opens a brain on any `Kv`: the entry point for the simulation and for tests that run the
    /// store on a fault-injecting disk. Creates the brain's records when the store is empty.
    pub fn open_kv(kv: Arc<dyn Kv>, env: Arc<dyn Env>, options: OpenOptions) -> Result<Store> {
        Store::open_kv_in(kv, env, options, FORMAT_VERSIONS)
    }

    fn open_kv_in(
        kv: Arc<dyn Kv>,
        env: Arc<dyn Env>,
        options: OpenOptions,
        known: &[u32],
    ) -> Result<Store> {
        let snapshot = kv.snapshot()?;
        let stored: Option<StoredFormat> = get_json(&*snapshot, &keys::meta("format"))?;
        drop(snapshot);
        let (stored, created) = match stored {
            Some(stored) => {
                format::check_version_in(stored.format_version, known)?;
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
                    rotated_from: None,
                };
                let mut tx = kv.begin_write()?;
                // Another handle may have created the brain between the read and this write.
                if let Some(raced) = get_json::<StoredFormat>(&*tx, &keys::meta("format"))? {
                    format::check_version_in(raced.format_version, known)?;
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
        // Sweep records kept before their source index existed get it.
        page_body::purge_record::backfill_source_index(&*kv)?;
        let index = keyword::open_index(&*kv)?;
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
            info: Arc::new(Mutex::new(StoreInfo {
                brain_id: stored.brain_id,
                format_version: stored.format_version,
                schema_version,
                created,
            })),
            bound: None,
            builder: Mutex::new(None),
            runs_builder: options.keyword_index_builder,
            flag_assumed,
            dir: None,
        })
        .inspect(|store| {
            if index.needs_build && store.runs_builder {
                store.start_keyword_index_builder();
            }
        })
    }

    /// A store on the same records with no transaction and no builder: the build thread's handle.
    fn sibling(&self) -> Store {
        Store {
            kv: self.kv.clone(),
            env: self.env.clone(),
            vectors: vectors::VectorCache::default(),
            write_context: write_trust::WriteContextSlot::default(),
            info: Arc::clone(&self.info),
            bound: None,
            builder: Mutex::new(None),
            runs_builder: false,
            flag_assumed: self.flag_assumed,
            dir: self.dir.clone(),
        }
    }

    /// Whether the format record says this brain's id was rotated away from `id` (a restore gave
    /// it a fresh one and `FORMAT` has not caught up yet).
    fn rotated_from(&self, id: &str) -> Result<bool> {
        let stored: Option<StoredFormat> = get_json(&*self.kv.snapshot()?, &keys::meta("format"))?;
        Ok(stored.is_some_and(|s| s.rotated_from.as_deref() == Some(id)))
    }

    /// Starts the background build unless one is running on this store.
    fn start_keyword_index_builder(&self) {
        let mut slot = self.builder.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|b| !b.finished()) {
            return;
        }
        *slot = Some(keyword::Builder::start(self.sibling()));
    }

    /// The keyword index state (`None`: this store keeps no index state).
    pub fn keyword_index_state(&self) -> Result<Option<keyword::KeywordIndexState>> {
        Ok(keyword::read_index_state(&*self.read()?)?.map(Into::into))
    }

    /// Runs one build batch of at most `max_pages` pages in its own write transaction and returns
    /// the state it leaves: what the background build does, for callers that step it themselves.
    pub fn keyword_index_build_step(
        &self,
        max_pages: usize,
    ) -> Result<Option<keyword::KeywordIndexState>> {
        Ok(self
            .write(|w| keyword::build_batch(w, max_pages))?
            .map(Into::into))
    }

    /// Compares the stored keyword postings with the postings rebuilt from the first `max_pages`
    /// pages (every page when `None`). Reads one snapshot; writes nothing.
    pub fn keyword_index_verify(
        &self,
        max_pages: Option<u64>,
    ) -> Result<keyword::KeywordIndexReport> {
        keyword::verify_index(&*self.read()?, max_pages)
    }

    /// Drops every keyword posting and marks the index incomplete in one transaction, then starts
    /// the build (when this store runs builds). Searches scan until the build completes.
    pub fn keyword_index_rebuild(&self) -> Result<()> {
        self.write(keyword::reset_index)?;
        if self.runs_builder {
            self.start_keyword_index_builder();
        }
        Ok(())
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
            // writes, so its store starts with an empty cache of its own, which a savepoint or
            // transaction rollback clears (`transactions.rs`).
            vectors: vectors::VectorCache::default(),
            // The write trust context belongs to the transaction's handle, not the shared store: it
            // starts empty and ends with the handle (`write_trust.rs`, "Lifetime").
            write_context: write_trust::WriteContextSlot::default(),
            info: Arc::clone(&self.info),
            bound: Some(tx),
            builder: Mutex::new(None),
            runs_builder: false,
            flag_assumed: self.flag_assumed,
            dir: self.dir.clone(),
        }
    }

    pub fn info(&self) -> StoreInfo {
        self.info.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn brain_id(&self) -> String {
        self.info().brain_id
    }

    /// A restore gave the committed store a fresh brain id (`restore_quarantine`).
    pub(crate) fn set_brain_id(&self, id: &str) {
        self.info.lock().unwrap_or_else(|e| e.into_inner()).brain_id = id.to_string();
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
        let read = match &self.bound {
            Some(tx) => tx.reader(),
            None => self.kv.snapshot()?,
        };
        // A process whose open-time scan could not store the member-access flag reads it as '1'
        // everywhere, the privacy policies' own reads of it included (`access_flag.rs`).
        Ok(if self.flag_assumed {
            access_flag::AssumedFlagRead::wrap(read)
        } else {
            read
        })
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
    ///
    /// Either way `f` writes through the store's write handle chain ([`write_chain`]), made fresh
    /// for each run: a put of a page record that names readers sets the member-access flag in the
    /// same write (`access_flag::FlaggingWriter`).
    pub(crate) fn write<T>(&self, f: impl FnMut(&mut dyn KvWrite) -> Result<T>) -> Result<T> {
        self.write_under(None, f)
    }

    /// [`Store::write`] under the trust context `trust` instead of the handle's write settings. The
    /// shadow seed (`seed.rs`) copies rows with the tiers another engine stored for them.
    pub(crate) fn write_as<T>(
        &self,
        trust: crate::trust::WriteTrust,
        f: impl FnMut(&mut dyn KvWrite) -> Result<T>,
    ) -> Result<T> {
        self.write_under(Some(trust), f)
    }

    /// The body of [`Store::write`] and [`Store::write_as`]: `trust` is the context to stamp under,
    /// or `None` for the handle's write settings.
    fn write_under<T>(
        &self,
        trust: Option<crate::trust::WriteTrust>,
        mut f: impl FnMut(&mut dyn KvWrite) -> Result<T>,
    ) -> Result<T> {
        let stamp_trust = || -> Result<crate::trust::WriteTrust> {
            match &trust {
                Some(trust) => Ok(trust.clone()),
                None => self.write_trust(),
            }
        };
        if let Some(tx) = &self.bound {
            // A bound store's env is the transaction's clock (`transactions.rs`, "Time").
            let _clock = crate::env::transaction_clock::open(self.env.clone());
            let _trust = crate::write_trust::stamp_context::open(stamp_trust()?);
            return tx.statement(|w| write_chain(w, &mut f));
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
                let _trust = crate::write_trust::stamp_context::open(stamp_trust()?);
                match write_chain(&mut *tx, &mut f) {
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
        let info = self.info();
        Ok(FormatRecord {
            format_version: info.format_version,
            engine_abi: options.engine_abi,
            catalog_version: options.catalog_version,
            schema_version: info.schema_version,
            brain_id: info.brain_id,
            created_by: options.created_by.clone(),
        })
    }
}

/// Runs `f` on the store's write handle chain over `inner`: every `Store::write` run (one OCC
/// attempt, or one bound statement) goes through it, and it ends the run's handle work before
/// the run is kept. Today the chain is `keyword::IndexingWriter(access_flag::FlaggingWriter(inner))`; a
/// wrapper added later goes inside it (`IndexingWriter(FlaggingWriter(OtherWriter(inner)))`), and each wrapper forwards the special
/// `KvWrite` primitives (`allocate`, `raise_counter`, `add_i64`, `counter_below`).
fn write_chain<T>(
    inner: &mut dyn KvWrite,
    f: &mut impl FnMut(&mut dyn KvWrite) -> Result<T>,
) -> Result<T> {
    let mut flagging = access_flag::FlaggingWriter(inner);
    let mut indexing = keyword::IndexingWriter::new(&mut flagging);
    let value = f(&mut indexing)?;
    indexing.flush()?;
    Ok(value)
}

/// The format record kept inside the store (the copy `FORMAT` is rebuilt from).
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub(crate) struct StoredFormat {
    pub format_version: u32,
    pub brain_id: String,
    pub created_at_us: i64,
    /// Set by a restore that gave the brain a fresh id: the id it had before. `FORMAT` is rebuilt
    /// from this record, so one that still names this id is stale, not another brain's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotated_from: Option<String>,
}

/// The config key of the write gate's scan baseline (TypeScript `WRITE_GATE_SCAN_BASELINE_KEY`).
pub const WRITE_GATE_SCAN_BASELINE_KEY: &str = "write_gate.scan_baseline";

/// The detector version a fresh brain's scan baseline carries when the caller names none (the TypeScript
/// `WRITE_GATE_DETECTOR_VERSION` when this store was written).
pub const DEFAULT_WRITE_GATE_DETECTOR_VERSION: u32 = 2;

/// Upgrades a brain in an older format to `FORMAT_VERSION` in one write transaction, so a crash
/// leaves either the old brain or the new one. Format 1 to 2 folds the JSON counter records into
/// the per-counter records; 2 to 3 rewrites the projection jobs in their compact form
/// (`format.rs`); an upgrade from format 3 or older starts an empty, incomplete keyword index
/// (`keyword/index_build.rs`), 4 to 5 rewrites nothing (a take stored before its trust tier
/// reads `unknown`), so a format-4 brain keeps its postings, and 5 to 6 carries over the records
/// the v0.60.766.0 addon's shadow seed kept in other shapes (`seed/format_5.rs`), 6 to 7 moves the
/// loop mutes off the take purge prefix (`facts/key_split.rs`) and 7 to 8 moves the shared-skill
/// token secret off the member links' prefix (`access_key_split.rs`). The format record is re-read inside the transaction:
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
    if stored.format_version <= 2 {
        persistence::projection_queue::compact_format_2_jobs(&mut *tx)?;
    }
    if stored.format_version <= 3 {
        // Format 4 keeps keyword postings: the build starts from an empty, incomplete index.
        keyword::reset_index(&mut *tx)?;
    }
    // Format 5 stores a take's trust tier in its record. A take stored before reads `unknown`, the
    // column default, so the step rewrites nothing; the number keeps an older build from rewriting
    // a take without its tier.
    // Format 6: the records the v0.60.766.0 addon's shadow seed wrote at format 5 in other shapes
    // are carried over to this build's, or the brain is refused with the re-seed steps.
    if stored.format_version <= 5 {
        let from = stored.format_version;
        seed::carry_over_format_5(&mut *tx).map_err(|e| {
            carry_over_failure(
                e,
                format!("store format {from} was not upgraded: carrying over its records failed"),
                format!(
                    "this brain was written by an older gbrain Rust addon (store format {from}) and holds a record this build cannot carry over"
                ),
            )
        })?;
    }
    // Format 7: the loop mutes leave the take purge ledger's `F 0x10` prefix for `F 0x11`, or the
    // brain is refused naming the record that is neither.
    if stored.format_version <= 6 {
        let from = stored.format_version;
        facts::key_split::split_take_purges_from_loop_mutes(&mut *tx).map_err(|e| {
            carry_over_failure(
                e,
                format!("store format {from} was not upgraded: sorting its take purges from its loop mutes failed"),
                format!(
                    "this brain (store format {from}) holds a record this build cannot sort into the take purge ledger or the loop mutes"
                ),
            )
        })?;
    }
    // Format 8: the shared-skill token secret leaves the member links' `x 0x04` prefix for `x 0x0d`,
    // or the brain is refused naming the record that is neither.
    if stored.format_version <= 7 {
        let from = stored.format_version;
        access_key_split::split_token_secret_from_member_links(&mut *tx).map_err(|e| {
            carry_over_failure(
                e,
                format!("store format {from} was not upgraded: sorting its token secret from its member links failed"),
                format!(
                    "this brain (store format {from}) holds a record this build cannot sort into the access member links or the shared-skill token secret"
                ),
            )
        })?;
    }
    stored.format_version = FORMAT_VERSION;
    put_json(&mut *tx, &keys::meta("format"), &stored)?;
    tx.commit()?;
    Ok(stored)
}

/// What the open reports when a format carry-over step fails. A record the step cannot convert is
/// `shadow_reseed_required`, naming the record and the re-seed steps. A file system or storage
/// engine failure (`StoreError::is_storage_failure`) keeps its own code and says nothing about
/// re-seeding, because it is not about the records and a re-seed would not fix it. Either way the
/// transaction is dropped and nothing changed.
fn carry_over_failure(e: StoreError, failed: String, refused: String) -> StoreError {
    if e.is_storage_failure() {
        return StoreError::new(
            e.code,
            format!("{failed}: {}; nothing was changed", e.message),
        );
    }
    StoreError::new(
        error::SHADOW_RESEED_REQUIRED,
        format!(
            "{refused}: {}; nothing was changed. Re-seed the shadow store: {}",
            e.message,
            seed::RESEED_STEPS
        ),
    )
}

/// Records a fresh brain starts with, written in the same transaction as its format record: the
/// schema version config (`getConfig('version')`), the caller's `initial_config` rows, the trust backfill
/// completion and the write-gate scan baseline (what migrations v226 and v227 write on an empty brain), the
/// `default` source, the shared-skill catalog token secret and a complete, empty keyword index.
fn seed(tx: &mut dyn KvWrite, env: &dyn Env, options: &OpenOptions) -> Result<()> {
    tx.put(
        &keys::text(keys::CONFIG, &["version"]),
        options.schema_version.to_string().as_bytes(),
    )?;
    // Migration v226 marks the trust backfill complete on an empty brain (`trust.backfill_completed_at`, millisecond ISO
    // text), so doctor `trust_tiers` does not ask a fresh brain to run it. A caller's `initial_config` row of the same
    // key wins.
    let now = env::iso(env.now_micros());
    tx.put(
        &keys::text(keys::CONFIG, &["trust.backfill_completed_at"]),
        format!("{}Z", &now[..now.len() - 4]).as_bytes(),
    )?;
    // Migration v227: no row is older than the write gate, so the legacy trust scan and `trust claim-sources` have
    // nothing to cover (`write_gate.scan_baseline`), recorded under the caller's detector version.
    tx.put(
        &keys::text(keys::CONFIG, &[WRITE_GATE_SCAN_BASELINE_KEY]),
        scan_baseline(
            options
                .write_gate_detector_version
                .unwrap_or(DEFAULT_WRITE_GATE_DETECTOR_VERSION),
        )
        .as_bytes(),
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
    sources::seed_default_source(tx, env)?;
    shared_skill_members::seed_state(tx, env)?;
    // No documents yet, so the keyword index is complete.
    keyword::seed_complete_index(tx)
}

/// The scan baseline of an empty brain, as Postgres prints the `jsonb` that migration v227 stores
/// (shorter keys first): the gate is live from the first row, so the legacy scan has nothing to read.
fn scan_baseline(detector: u32) -> String {
    format!(
        r#"{{"until": {{"facts": 0, "pages": 0, "takes": 0, "timeline_entries": 0}}, "detector_version": {detector}}}"#
    )
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

/// What an older build does with a newer brain (rust/docs/store/format.md, "Older builds"): it
/// refuses before it writes anything, with `format_unknown`, and leaves every file as it was.
/// `Store::open_dir_in` opens with the format list an older build was shipped with.
#[cfg(test)]
mod older_build_tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn fresh_dir(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/test-tmp")
            .join(format!("{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// Every file under `dir`, by path, with its bytes.
    fn files(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut out = BTreeMap::new();
        let mut todo = vec![dir.to_path_buf()];
        while let Some(at) = todo.pop() {
            for entry in fs::read_dir(&at).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    todo.push(path);
                } else {
                    out.insert(path.clone(), fs::read(&path).unwrap());
                }
            }
        }
        out
    }

    /// A closed brain with one committed record, stamped `version` in `FORMAT` and in its format
    /// record. At `FORMAT_VERSION` it is this build's own format; above it, the stamp is all an
    /// older build looks at before it refuses.
    fn brain_at(name: &str, version: u32) -> PathBuf {
        let dir = fresh_dir(name).join("brain");
        let store = Store::open_dir(&dir, OpenOptions::default()).unwrap();
        store
            .write(|tx| {
                tx.put(&keys::meta("test/older-build"), b"kept")?;
                let mut stored: StoredFormat = get_json(&*tx, &keys::meta("format"))?.unwrap();
                stored.format_version = version;
                put_json(tx, &keys::meta("format"), &stored)
            })
            .unwrap();
        drop(store);
        let mut record = format::read(&dir).unwrap().unwrap();
        record.format_version = version;
        format::write(&dir, &record).unwrap();
        dir
    }

    fn assert_refused(dir: &Path, known: &[u32], version: u32) {
        let before = files(dir);
        let err = Store::open_dir_in(dir, OpenOptions::default(), known)
            .err()
            .expect("an older build must refuse a newer brain");
        assert_eq!(err.code, crate::error::FORMAT_UNKNOWN);
        assert_eq!(
            err.message,
            format!(
                "this brain has store format {version}, newer than the formats this build opens ({known:?}); nothing was changed"
            )
        );
        let after = files(dir);
        let changed: Vec<String> = before
            .keys()
            .chain(after.keys())
            .filter(|path| before.get(*path) != after.get(*path))
            .map(|path| {
                let (a, b) = (before.get(path), after.get(path));
                let first = match (a, b) {
                    (Some(a), Some(b)) => a
                        .iter()
                        .zip(b.iter())
                        .position(|(x, y)| x != y)
                        .map(|i| (i, a[i], b[i])),
                    _ => None,
                };
                format!(
                    "{} ({:?} -> {:?} bytes, first differing byte {first:?})",
                    path.strip_prefix(dir).unwrap_or(path).display(),
                    a.map(Vec::len),
                    b.map(Vec::len)
                )
            })
            .collect();
        assert!(
            changed.is_empty(),
            "a refused open changed files: {changed:?}"
        );
    }

    #[test]
    fn a_format_2_build_refuses_a_format_3_brain_and_changes_no_byte() {
        let dir = brain_at("older-2-vs-3", 3);
        assert_refused(&dir, &[1, 2], 3);
        // Without FORMAT the format record decides, still before any write.
        fs::remove_file(dir.join(format::FORMAT_FILE)).unwrap();
        assert_refused(&dir, &[1, 2], 3);
        // The brain is whole: this build opens it, rebuilds FORMAT and reads the record.
        let store = Store::open_dir(&dir, OpenOptions::default()).unwrap();
        let kept = store.read().unwrap().get(&keys::meta("test/older-build"));
        assert_eq!(kept.unwrap().as_deref(), Some(&b"kept"[..]));
        drop(store);
        let _ = fs::remove_dir_all(dir.parent().unwrap());
    }

    /// An open that must find its brain refuses an empty or missing directory and creates nothing; the default still
    /// creates one.
    #[test]
    fn an_open_without_create_missing_refuses_a_directory_without_a_brain_and_creates_nothing() {
        let root = fresh_dir("create-missing");
        let missing = root.join("gone");
        let options = || OpenOptions {
            create_missing: false,
            keyword_index_builder: false,
            ..OpenOptions::default()
        };
        let err = Store::open_dir(&missing, options()).err().unwrap();
        assert_eq!(err.code, error::STORE_MISSING);
        assert!(!missing.exists(), "the refused open created the directory");
        fs::create_dir_all(&missing).unwrap();
        assert_eq!(
            Store::open_dir(&missing, options()).err().unwrap().code,
            error::STORE_MISSING
        );
        assert_eq!(
            fs::read_dir(&missing).unwrap().count(),
            0,
            "the refused open wrote into the folder"
        );
        // A FORMAT file without the record file is no brain either; the open writes nothing.
        fs::write(missing.join(format::FORMAT_FILE), b"{}").unwrap();
        assert_eq!(
            Store::open_dir(&missing, options()).err().unwrap().code,
            error::STORE_MISSING
        );
        assert!(
            !missing.join(format::RECORDS_FILE).exists(),
            "the refused open created the record file"
        );
        fs::remove_file(missing.join(format::FORMAT_FILE)).unwrap();
        // The default creates it, and then an open that must find it does.
        drop(
            Store::open_dir(
                &missing,
                OpenOptions {
                    keyword_index_builder: false,
                    ..OpenOptions::default()
                },
            )
            .unwrap(),
        );
        drop(Store::open_dir(&missing, options()).unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn every_build_refuses_the_next_format_and_changes_no_byte() {
        for n in 1..=FORMAT_VERSION {
            let known: Vec<u32> = (1..=n).collect();
            let dir = brain_at(&format!("older-{n}-vs-next"), n + 1);
            assert_refused(&dir, &known, n + 1);
            fs::remove_file(dir.join(format::FORMAT_FILE)).unwrap();
            assert_refused(&dir, &known, n + 1);
            let _ = fs::remove_dir_all(dir.parent().unwrap());
        }
        // This build's own list: formats 1 to 8 in a row, then the formats it adds (formats the
        // trunk allotted to other lanes are skipped), in order, ending at FORMAT_VERSION.
        assert_eq!(&FORMAT_VERSIONS[..8], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(FORMAT_VERSIONS.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(FORMAT_VERSIONS.last(), Some(&FORMAT_VERSION));
    }
}

#[cfg(test)]
mod json_depth_tests {
    use super::json_depth;

    #[test]
    fn brackets_inside_strings_and_escaped_quotes_do_not_count() {
        assert_eq!(json_depth(br#"1"#), 0);
        assert_eq!(json_depth(br#"{"a":[1,{"b":[]}]}"#), 4);
        assert_eq!(json_depth(br#"{"a":"[[[{{{","b":"\"[["}"#), 1);
        assert_eq!(json_depth(br#"["\\",[[]]]"#), 3);
    }
}
