//! A follower: a copy of a commit log brain that learns every change from its primary's commit
//! log (multi-user mode, `commit_log.rs`; rust/docs/store/commit-log.md, "Followers and promotion").
//!
//! The follower is a replica of the whole brain, log included: it keeps the primary's records (with
//! its own retention), the primary's commit sequence and the durable commit time, so after
//! promotion its next commit is `(cursor.sequence + 1, 0)` and its own followers continue from the
//! same positions. Its cursor is its own log's `newest`, written in the same redb transaction as
//! the data it applied, so a crash leaves it at a consistent position and a record at or before
//! the cursor is skipped (applying twice is a no-op).
//!
//! - `apply_page` / `apply_raw`: the next records, all in one redb transaction (data ops, the
//!   records, the log meta, the commit sequence, `M\0ctime`). A gap or another history
//!   (`commit_log::lineage_continues`) refuses with `snapshot_required` and changes nothing.
//! - `install_snapshot`: replaces the whole record file with a snapshot of the same brain
//!   (`Store::snapshot_to`) in one redb transaction, validated and copied from one held read state.
//!   It never moves the follower backwards.
//! - `promote`: starts a new timeline at the cursor and opens the brain as a logged multi-user
//!   `Store`. Its commit clock starts above max(`M\0ctime`, the newest record's time). Fencing the
//!   old primary is the caller's job (lane L5's leases); the store does not do it.
//!
//! A follower never opens a `Store` for writing while it follows: that would make commits of its
//! own the primary's log never had.

use crate::commit_log::{
    self, CommitPosition, CommitRecord, LogMeta, LogPage, LogSettings, LogState, Timeline,
    decode_record, is_log_key, read_meta,
};
use crate::error::{INVALID_STATE, Result, STORE_CORRUPT, StoreError};
use crate::format;
use crate::kv::{Kv, KvRead};
use crate::redb_kv::{RedbKv, RedbReadOnlyKv, read_commit_time};
use crate::snapshot::SnapshotManifest;
use crate::{OpenOptions, Store, StoredFormat, get_json, keys};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The code of every refusal that needs a snapshot first: a gap, a cursor the log no longer
/// reaches, or another history.
pub const SNAPSHOT_REQUIRED: &str = "snapshot_required";

/// What one `apply_*` call did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    /// Records applied.
    pub applied: usize,
    /// Records at or before the cursor, skipped.
    pub skipped: usize,
    /// The cursor after the call.
    pub cursor: CommitPosition,
}

/// A follower of one brain (module docs).
pub struct Follower {
    dir: Option<PathBuf>,
    kv: RedbKv,
    /// The follower's own log bookkeeping (retention), `None` while it holds no brain yet.
    state: Mutex<Option<LogState>>,
    retention_bytes: u64,
}

fn snapshot_required(why: String) -> StoreError {
    StoreError::new(SNAPSHOT_REQUIRED, why)
}

/// A follower holds only a commit log brain of a format this build reads.
fn admit_format(stored: &StoredFormat) -> Result<()> {
    format::check_version_in(stored.format_version, format::OPENED_FORMATS)?;
    let Some(log) = stored.log else {
        return Err(StoreError::new(
            INVALID_STATE,
            "this brain keeps no commit log, so it cannot be a follower",
        ));
    };
    if stored.format_version != format::LOG_FORMAT_VERSION {
        return Err(StoreError::new(
            STORE_CORRUPT,
            "the format record names a commit log on a format without one",
        ));
    }
    format::check_version(log.base_format)
}

fn every_key(read: &dyn KvRead) -> Result<BTreeSet<Vec<u8>>> {
    let mut keys = BTreeSet::new();
    read.scan(&[1], &[0xFF; 64], false, &mut |k, _| {
        keys.insert(k.to_vec());
        true
    })?;
    Ok(keys)
}

impl Follower {
    /// Opens the follower in `dir` (`records.redb`), creating an empty one when there is none. An
    /// empty follower accepts only a snapshot. A brain that keeps no commit log is refused.
    pub fn open(dir: &Path) -> Result<Follower> {
        std::fs::create_dir_all(dir)
            .map_err(|e| StoreError::io(format!("follower directory: {e}")))?;
        // As a store's open: a brain of a format this build does not read is refused before its
        // record file is opened for writing.
        format::read_in(dir, format::OPENED_FORMATS)?;
        let records = dir.join(format::RECORDS_FILE);
        if let Some(bytes) = crate::redb_kv::peek(&records, &keys::meta("format")) {
            let stored: StoredFormat = serde_json::from_slice(&bytes)
                .map_err(|e| StoreError::new(STORE_CORRUPT, format!("the format record: {e}")))?;
            admit_format(&stored)?;
        }
        let kv = RedbKv::open_path(&records)?;
        Follower::over(kv, Some(dir.to_path_buf()))
    }

    /// A follower over a record file the caller opened (tests run it on a simulated disk). It has
    /// no directory, so it cannot be promoted or keep `FORMAT`.
    pub fn over(kv: RedbKv, dir: Option<PathBuf>) -> Result<Follower> {
        let follower = Follower {
            dir,
            kv,
            state: Mutex::new(None),
            retention_bytes: commit_log::DEFAULT_RETENTION_BYTES,
        };
        follower.reload()?;
        Ok(follower)
    }

    /// Sets the follower's own retention cap (its log keeps at most this many bytes of records).
    pub fn with_retention(mut self, bytes: u64) -> Result<Follower> {
        self.retention_bytes = bytes;
        self.reload()?;
        Ok(self)
    }

    fn reload(&self) -> Result<()> {
        let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        *guard = self.load_state()?;
        Ok(())
    }

    /// The follower's bookkeeping from what its record file holds now. Callers hold `state`'s
    /// lock, so no other call writes between this read and their use of it.
    fn load_state(&self) -> Result<Option<LogState>> {
        let read = self.kv.snapshot()?;
        let stored: Option<StoredFormat> = get_json(&*read, &keys::meta("format"))?;
        if let Some(stored) = &stored {
            admit_format(stored)?;
        }
        let state = match (stored, read_meta(&*read)?) {
            (None, _) => None,
            (Some(_), None) => {
                return Err(StoreError::new(
                    INVALID_STATE,
                    "this brain keeps no commit log, so it cannot be a follower",
                ));
            }
            (Some(_), Some(_)) => Some(LogState::load(
                &*read,
                LogSettings {
                    retention_bytes: self.retention_bytes,
                    ..LogSettings::default()
                },
            )?),
        };
        Ok(state)
    }

    /// The brain the follower holds (`None` while it is empty).
    pub fn brain_id(&self) -> Result<Option<String>> {
        Ok(
            get_json::<StoredFormat>(&*self.kv.snapshot()?, &keys::meta("format"))?
                .map(|f| f.brain_id),
        )
    }

    /// The newest commit the follower holds (`None` while it is empty).
    pub fn cursor(&self) -> Option<CommitPosition> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|s| s.meta().newest)
    }

    /// The history the follower applied (`LogMeta::lineage`).
    pub fn lineage(&self) -> Vec<Timeline> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|s| s.meta().lineage.clone())
            .unwrap_or_default()
    }

    /// The newest durable commit time the follower holds: the floor its promotion starts above.
    pub fn last_commit_time(&self) -> Result<i64> {
        commit_log::floor_time(&*self.kv.snapshot()?)
    }

    /// The commit sequence the follower is at.
    pub fn sequence(&self) -> Result<u64> {
        self.kv.version()
    }

    /// The follower's record file, for reads (never write to it).
    pub fn records(&self) -> &RedbKv {
        &self.kv
    }

    /// Applies a page the primary's `Store::read_commit_log` returned.
    pub fn apply_page(&self, page: &LogPage) -> Result<Applied> {
        if page.snapshot_required {
            return Err(snapshot_required(
                "the primary's log no longer reaches this follower's cursor".into(),
            ));
        }
        let raw: Vec<(CommitPosition, Vec<u8>)> = page
            .records
            .iter()
            .map(|r| (r.position, commit_log::encode_commit_record(r)))
            .collect();
        self.apply_raw(&page.brain_id, &page.lineage, &raw)
    }

    /// Applies records as the primary stored them (position and value), with the primary's brain
    /// id and history. All of them commit in one redb transaction, or none does.
    pub fn apply_raw(
        &self,
        brain_id: &str,
        lineage: &[Timeline],
        records: &[(CommitPosition, Vec<u8>)],
    ) -> Result<Applied> {
        let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(state) = guard.as_mut() else {
            return Err(snapshot_required(
                "this follower holds no brain yet: install a snapshot first".into(),
            ));
        };
        let mine = get_json::<StoredFormat>(&*self.kv.snapshot()?, &keys::meta("format"))?
            .map(|f| f.brain_id)
            .unwrap_or_default();
        if brain_id != mine {
            return Err(StoreError::new(
                INVALID_STATE,
                format!("these records belong to brain {brain_id:?}, not this follower's {mine:?}"),
            ));
        }
        let cursor = state.meta().newest;
        if !commit_log::lineage_continues(&state.meta().lineage, cursor, lineage) {
            return Err(snapshot_required(format!(
                "the primary's history left this follower's at or before {}",
                cursor.token()
            )));
        }
        let mut fresh: Vec<(CommitRecord, &Vec<u8>)> = Vec::new();
        let mut skipped = 0;
        let mut prev = cursor;
        for (position, value) in records {
            let record = decode_record(&commit_log::record_key(*position), value)?;
            if record.position <= prev {
                skipped += 1;
                continue;
            }
            if !record.position.follows(prev) {
                return Err(snapshot_required(format!(
                    "the next record would be {} after {}",
                    record.position.token(),
                    prev.token()
                )));
            }
            prev = record.position;
            fresh.push((record, value));
        }
        if fresh.is_empty() {
            return Ok(Applied {
                applied: 0,
                skipped,
                cursor,
            });
        }
        let sequence = prev.sequence;
        let time = fresh.iter().map(|(r, _)| r.commit_time).max();
        let mut next_state = LogState::clone(state);
        next_state.set_lineage(lineage.to_vec());
        let outcome = self.kv.replica_write(sequence, time, |tx| {
            for (record, _) in &fresh {
                if let Some((key, _)) = record.ops.iter().find(|(k, _)| is_log_key(k)) {
                    return Err(StoreError::new(
                        STORE_CORRUPT,
                        format!(
                            "a commit record changes the log's own key {}",
                            key.escape_ascii()
                        ),
                    ));
                }
                commit_log::apply_record(tx, record)?;
            }
            let encoded: Vec<(CommitPosition, Vec<u8>)> = fresh
                .iter()
                .map(|(r, v)| (r.position, (*v).clone()))
                .collect();
            next_state.write(tx, &encoded)
        });
        match outcome {
            Ok(append) => {
                next_state.applied(append);
                *state = next_state;
                Ok(Applied {
                    applied: fresh.len(),
                    skipped,
                    cursor: prev,
                })
            }
            Err(e) => {
                // The bookkeeping is reloaded from what the file holds now, under the same lock.
                if let Ok(fresh) = self.load_state() {
                    *guard = fresh;
                }
                Err(e)
            }
        }
    }

    /// Installs a snapshot (`Store::snapshot_to` of the primary, or of another follower of the same
    /// brain): validated and copied from one held read state, in one redb transaction that replaces
    /// every key the follower holds. `manifest`, when given, must match what the held state holds.
    /// Refuses, changing nothing: a brain without a log, another brain, a snapshot behind the
    /// follower, an inconsistent log, or a manifest mismatch.
    pub fn install_snapshot(
        &self,
        snapshot_dir: &Path,
        manifest: Option<&SnapshotManifest>,
    ) -> Result<CommitPosition> {
        let source = RedbReadOnlyKv::open_path(&snapshot_dir.join(format::RECORDS_FILE))?;
        // One read state for every check and the copy.
        let (read, sequence) = source.versioned_snapshot()?;
        let bad = |why: String| StoreError::new(INVALID_STATE, format!("snapshot refused: {why}"));
        let stored: StoredFormat = get_json(&*read, &keys::meta("format"))?
            .ok_or_else(|| bad("it holds no brain".into()))?;
        let Some(log) = stored.log else {
            return Err(bad("the brain keeps no commit log".into()));
        };
        if stored.format_version != format::LOG_FORMAT_VERSION {
            return Err(bad(format!("store format {}", stored.format_version)));
        }
        format::check_version(log.base_format)?;
        let meta: LogMeta =
            read_meta(&*read)?.ok_or_else(|| bad("the log has no meta record".into()))?;
        if meta.newest.sequence != sequence {
            return Err(bad(format!(
                "the log ends at {} but the record file at sequence {sequence}",
                meta.newest.token()
            )));
        }
        // The log's bounds agree with each other and with the format record.
        if log.since != meta.since
            || meta.since > meta.newest
            || meta
                .trimmed_through
                .is_some_and(|t| t < meta.since || t > meta.newest)
        {
            return Err(bad("its log bounds disagree".into()));
        }
        // Every retained record decodes, gap-free, up to `newest`.
        let page = commit_log::read_commit_log(
            &*read,
            meta.trimmed_through.or(Some(meta.since)),
            usize::MAX,
        );
        let records = match page {
            Ok(page) if !page.snapshot_required => page.records,
            Ok(_) => return Err(bad("its log does not reach its own start".into())),
            Err(e) => return Err(bad(format!("its log does not read: {}", e.message))),
        };
        if let Some(last) = records.last()
            && last.position != meta.newest
        {
            return Err(bad("its newest record is not its log's newest".into()));
        }
        let time = read_commit_time(&*read)?;
        if let (Some(last), Some(t)) = (records.last(), time)
            && t < last.commit_time
        {
            return Err(bad(
                "its durable commit time is below its newest record's".into()
            ));
        }
        // Its FORMAT, read and checked against the held records now, published after the copy.
        let snapshot_format =
            format::read(snapshot_dir)?.ok_or_else(|| bad("it has no FORMAT".into()))?;
        if snapshot_format.brain_id != stored.brain_id
            || snapshot_format.format_version != format::LOG_FORMAT_VERSION
        {
            return Err(bad("its FORMAT does not match its records".into()));
        }
        let snapshot_keys = every_key(&*read)?;
        if let Some(m) = manifest
            && (m.brain_id != stored.brain_id
                || m.generation != sequence
                || m.keys != snapshot_keys.len() as u64)
        {
            return Err(bad("it does not match its manifest".into()));
        }
        // Against the follower as it is now.
        let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mine = self.kv.snapshot()?;
        let mut other_history = false;
        if let Some(current) = get_json::<StoredFormat>(&*mine, &keys::meta("format"))? {
            if current.brain_id != stored.brain_id {
                return Err(bad("it is another brain".into()));
            }
            // Behind the follower on the same history: refused (it would lose commits). On
            // another history (`lineage_continues` fails) the snapshot is the way back to the
            // primary's, wherever it ends.
            if let Some(state) = guard.as_ref() {
                let cursor = state.meta().newest;
                let same_history =
                    commit_log::lineage_continues(&state.meta().lineage, cursor, &meta.lineage);
                other_history = !same_history;
                if same_history && meta.newest < cursor {
                    return Err(bad(format!(
                        "it ends at {}, behind this follower at {}",
                        meta.newest.token(),
                        cursor.token()
                    )));
                }
            }
        }
        let drop_keys: Vec<Vec<u8>> = every_key(&*mine)?
            .into_iter()
            .filter(|k| !snapshot_keys.contains(k))
            .collect();
        drop(mine);
        // Both keep the larger of the follower's durable time and the snapshot's, so the floor
        // never moves back. Only a snapshot of another history may move the sequence back.
        let copy = |tx: &mut dyn crate::kv::KvWrite| -> Result<()> {
            for k in &drop_keys {
                tx.delete(k)?;
            }
            let mut failure = None;
            read.scan(&[1], &[0xFF; 64], false, &mut |k, v| match tx.put(k, v) {
                Ok(()) => true,
                Err(e) => {
                    failure = Some(e);
                    false
                }
            })?;
            failure.map_or(Ok(()), Err)
        };
        let outcome = if other_history {
            self.kv.replica_reset(sequence, time, copy)
        } else {
            self.kv.replica_write(sequence, time, copy)
        };
        // The bookkeeping follows what the file holds, still under the lock.
        let reloaded = self.load_state();
        outcome?;
        *guard = reloaded?;
        drop(guard);
        // FORMAT follows the records (a promotion's open also repairs it). The records are
        // installed even if this fails: say so.
        if let Some(dir) = &self.dir {
            format::write(dir, &snapshot_format).map_err(|e| {
                StoreError::io(format!(
                    "the snapshot was installed, but its FORMAT was not written ({}); a promotion's open rewrites it",
                    e.message
                ))
            })?;
        }
        Ok(meta.newest)
    }

    /// Promotes the follower: starts a new timeline at its cursor (so followers that hold commits
    /// past it are told to install a snapshot) and opens the brain as a logged multi-user `Store`
    /// with `options` (which must turn on multi-user mode and the commit log). Fence the old
    /// primary first: the store does not.
    pub fn promote(self, options: OpenOptions) -> Result<Store> {
        let Some(dir) = self.dir.clone() else {
            return Err(StoreError::new(
                INVALID_STATE,
                "a follower without a directory cannot be promoted",
            ));
        };
        if !(options.multiuser && options.multiuser_writes.commit_log) {
            return Err(StoreError::invalid(
                "promotion needs multi-user mode and the commit log (GBRAIN_RUST_MULTIUSER=1, GBRAIN_RUST_COMMIT_LOG=1)",
            ));
        }
        // Every check the open will make that could refuse it, before the follower changes.
        if options
            .multiuser_writes
            .host_id
            .as_deref()
            .is_none_or(str::is_empty)
        {
            return Err(StoreError::invalid(crate::HOST_ID_REQUIRED));
        }
        if let (Some(on_disk), Some(mine)) = (format::read(&dir)?, self.brain_id()?)
            && on_disk.brain_id != mine
        {
            return Err(StoreError::new(
                STORE_CORRUPT,
                "FORMAT names a different brain than the follower's records",
            ));
        }
        {
            let mut guard = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let Some(state) = guard.as_mut() else {
                return Err(StoreError::new(
                    INVALID_STATE,
                    "an empty follower cannot be promoted",
                ));
            };
            let cursor = state.meta().newest;
            let mut lineage = state.meta().lineage.clone();
            lineage.push(Timeline {
                id: commit_log::uuid_v7(&crate::env::SystemEnv),
                from: cursor,
            });
            let sequence = self.kv.version()?;
            let mut meta = state.meta().clone();
            meta.lineage = lineage;
            self.kv.replica_write(sequence, None, |tx| {
                tx.put(&commit_log::meta_key(), &serde_json::to_vec(&meta)?)
            })?;
        }
        drop(self);
        Store::open_dir(&dir, options)
    }
}
