//! The store snapshot: a copy of one committed generation of an open brain, taken while writers
//! keep going. It is the primitive the shadow restore drill and `gbrain backup` of a Rust brain
//! both use (docs/designs/RUST_ENGINE.md, row 21b). Read `rust/docs/store/snapshot.md` first.
//!
//! ```text
//!   Store::snapshot_to(target, op)
//!     mkdir(target, 0700)        the reservation: it must create the directory
//!     one pinned read + its commit sequence N        (Kv::versioned_snapshot)
//!     keys in order -> new records.redb, 64 MiB batches, one sync at the end
//!     per tag: streaming sha256 over the actual keys, never a fixed tag list
//!     seeded store: per-relation digest, streamed (seed::relation_digest_stream)
//!     read released -> sequence N written -> FORMAT -> fsync -> SNAPSHOT.json last
//! ```
//!
//! A directory without `SNAPSHOT.json` is incomplete and nothing may use it. A cancel or an error
//! removes what this call created and returns only after the read is released and the new file
//! is closed: a caller that sees the return can delete its scratch space. The copy is logical, from
//! one pinned read; a raw copy of an open `records.redb` is unsafe and is not offered here.
//!
//! Every read of the source goes through the `Kv`'s versioned snapshot, so the copy holds
//! exactly the commits up to the pinned sequence, on a single writer (redb) and on the
//! concurrent-writer layer (OCC) alike. The store's own pages are kept by redb while the read
//! is held: a long copy on a busy brain grows the source file, which is why the caller bounds
//! disk space and age (`src/core/rust-engine/store-snapshot.ts`).

use crate::error::{INVALID_STATE, Result, SNAPSHOT_CANCELLED, STORE_CORRUPT, StoreError};
use crate::format::{self, FormatRecord, RECORDS_FILE};
use crate::kv::KvRead;
use crate::redb_kv::{RedbReadOnlyKv, RedbSink};
use crate::seed::{MANIFEST, SeedManifest, relation_digest_stream_until};
use crate::{Store, StoredFormat, config, get_json, keys};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

/// The manifest file, written last.
pub const MANIFEST_FILE: &str = "SNAPSHOT.json";
/// The manifest layout this build writes and reads.
pub const MANIFEST_VERSION: u32 = 1;
/// The longest pause a test seam may put after each batch.
pub const MAX_BATCH_DELAY_MS: u64 = 1000;
/// Bytes of keys and values one batch holds.
const BATCH_BYTES: usize = 64 << 20;
/// No batch is smaller than this, so a test seam cannot make a copy take a transaction per key.
const MIN_BATCH_BYTES: usize = 4096;
/// Sorts after every key: no store key starts with byte 0xFF, so none reaches this bound.
pub(crate) const KEY_END: [u8; 1024] = [0xFF; 1024];

/// Whole numbers as JavaScript sends them: a number past 2^32 arrives as a float with no fraction,
/// which serde's integer types refuse. A fraction, a negative count or a value past 2^53 is still refused.
mod whole {
    use serde::de::{Deserializer, Error, Visitor};
    use std::fmt;

    struct Whole(bool);

    impl Visitor<'_> for Whole {
        type Value = i64;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a whole number")
        }
        fn visit_i64<E: Error>(self, v: i64) -> Result<i64, E> {
            if self.0 && v < 0 {
                return Err(E::custom("a count cannot be negative"));
            }
            Ok(v)
        }
        fn visit_u64<E: Error>(self, v: u64) -> Result<i64, E> {
            i64::try_from(v).map_err(E::custom)
        }
        fn visit_f64<E: Error>(self, v: f64) -> Result<i64, E> {
            if v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0 {
                self.visit_i64(v as i64)
            } else {
                Err(E::custom("not a whole number JavaScript can hold exactly"))
            }
        }
    }

    pub fn u64<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        d.deserialize_any(Whole(true)).map(|v| v as u64)
    }

    pub fn i64<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
        d.deserialize_any(Whole(false))
    }
}

/// Count and digest of the keys under one tag byte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TagDigest {
    #[serde(deserialize_with = "whole::u64")]
    pub keys: u64,
    /// Lowercase hex sha256 over each entry's `u64be(len key) || key || u64be(len value) || value`,
    /// in key order.
    pub sha256: String,
}

/// Count and digest of one seeded relation's digest entries (`seed::relation_digest_stream`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelationDigest {
    #[serde(deserialize_with = "whole::u64")]
    pub rows: u64,
    pub sha256: String,
}

/// What `SNAPSHOT.json` holds and what `snapshotTo` returns. Every field but `created_at_us` is
/// compared by `verify_store_dir`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotManifest {
    pub version: u32,
    pub brain_id: String,
    /// The commit sequence the copy was taken at.
    #[serde(deserialize_with = "whole::u64")]
    pub generation: u64,
    /// The store format of the records (the format record inside them).
    pub engine_format_version: u32,
    pub schema_version: u32,
    #[serde(deserialize_with = "whole::u64")]
    pub keys: u64,
    /// Bytes of keys and values.
    #[serde(deserialize_with = "whole::u64")]
    pub bytes: u64,
    /// By tag byte, as two lowercase hex digits. Every tag the copy holds, and no other.
    pub tags: BTreeMap<String, TagDigest>,
    /// Only for a store that holds a seed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relations: Option<BTreeMap<String, RelationDigest>>,
    #[serde(deserialize_with = "whole::i64")]
    pub created_at_us: i64,
}

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl SnapshotManifest {
    /// Refuses a manifest this build did not write: another version, a tag or digest that is not
    /// lowercase hex, counts that do not add up. The message names the field, never a value.
    pub fn validate(&self) -> Result<()> {
        let bad = |what: &str| {
            Err(StoreError::invalid(format!(
                "the snapshot manifest is not valid: {what}"
            )))
        };
        if self.version != MANIFEST_VERSION {
            return bad("version");
        }
        if self.brain_id.is_empty() {
            return bad("brain_id");
        }
        let mut total = 0u64;
        for (tag, digest) in &self.tags {
            if !is_hex(tag, 2) || !is_hex(&digest.sha256, 64) {
                return bad("tags");
            }
            total = total.saturating_add(digest.keys);
        }
        if total != self.keys {
            return bad("keys");
        }
        for (name, digest) in self.relations.iter().flatten() {
            if name.is_empty() || !is_hex(&digest.sha256, 64) {
                return bad("relations");
            }
        }
        Ok(())
    }
}

/// What a running snapshot has done. Read from any thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SnapshotProgress {
    pub keys: u64,
    pub bytes: u64,
    /// True while the snapshot holds its read of the source. It turns false before the call
    /// returns, on success, cancel and error alike.
    pub pinned: bool,
}

/// One snapshot call's cancel token and progress counters. The caller keeps it (an `Arc`) and
/// may cancel from another thread; the call checks it for every key it reads and after every
/// batch.
#[derive(Default)]
pub struct SnapshotOp {
    cancel: AtomicBool,
    keys: AtomicU64,
    bytes: AtomicU64,
    pinned: AtomicBool,
    batch_delay_ms: u64,
    batch_bytes: Option<usize>,
    on_batch: Option<Arc<dyn Fn(u64) + Send + Sync>>,
}

impl SnapshotOp {
    pub fn new() -> Self {
        Self::default()
    }

    /// Test seam: pause this long after every batch (at most [`MAX_BATCH_DELAY_MS`]).
    #[doc(hidden)]
    pub fn with_batch_delay_ms(mut self, ms: u64) -> Self {
        self.batch_delay_ms = ms.min(MAX_BATCH_DELAY_MS);
        self
    }

    /// Test seam: end a batch at this many bytes instead of 64 MiB (at least 4 KiB).
    #[doc(hidden)]
    pub fn with_batch_bytes(mut self, bytes: usize) -> Self {
        self.batch_bytes = Some(bytes.max(MIN_BATCH_BYTES));
        self
    }

    /// Test seam: called with the batch number (from 1) after each batch is written.
    #[doc(hidden)]
    pub fn with_batch_hook(mut self, hook: Arc<dyn Fn(u64) + Send + Sync>) -> Self {
        self.on_batch = Some(hook);
        self
    }

    /// Asks the snapshot to stop. It ends with `snapshot_cancelled` once it has removed what it
    /// wrote and released its read. A cancel after the snapshot has finished does nothing.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    pub fn progress(&self) -> SnapshotProgress {
        SnapshotProgress {
            keys: self.keys.load(Ordering::SeqCst),
            bytes: self.bytes.load(Ordering::SeqCst),
            pinned: self.pinned.load(Ordering::SeqCst),
        }
    }

    fn cancelled() -> StoreError {
        StoreError::new(
            SNAPSHOT_CANCELLED,
            "the snapshot was cancelled; what it wrote was removed",
        )
    }
}

/// The pinned read. The flag a caller watches turns false only after the read is dropped.
struct Pinned<'a> {
    read: Option<Box<dyn KvRead + Send>>,
    flag: &'a AtomicBool,
}

impl<'a> Pinned<'a> {
    fn new(read: Box<dyn KvRead + Send>, flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self {
            read: Some(read),
            flag,
        }
    }

    fn read(&self) -> &dyn KvRead {
        self.read.as_deref().expect("the pinned read is held")
    }
}

impl Drop for Pinned<'_> {
    fn drop(&mut self) {
        self.read = None;
        self.flag.store(false, Ordering::SeqCst);
    }
}

/// Counts and digests of every key a read holds, tag by tag, as keys arrive in order. The copy
/// and `verify_store_dir` use the same one, so a copy is compared with the bytes it was made of.
#[derive(Default)]
pub(crate) struct Inventory {
    tags: BTreeMap<u8, (u64, Sha256)>,
    keys: u64,
    bytes: u64,
}

impl Inventory {
    pub(crate) fn absorb(&mut self, key: &[u8], value: &[u8]) {
        let Some(&tag) = key.first() else { return };
        let (count, hasher) = self.tags.entry(tag).or_default();
        *count += 1;
        hasher.update((key.len() as u64).to_be_bytes());
        hasher.update(key);
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value);
        self.keys += 1;
        self.bytes += (key.len() + value.len()) as u64;
    }

    /// Every key of `read` (but the reserved ones, which no scan reaches), in key order.
    pub(crate) fn scan(&mut self, read: &dyn KvRead) -> Result<()> {
        read.scan(&[1], &KEY_END, false, &mut |k, v| {
            self.absorb(k, v);
            true
        })
    }

    pub(crate) fn finish(self) -> (u64, u64, BTreeMap<String, TagDigest>) {
        let tags = self
            .tags
            .into_iter()
            .map(|(tag, (keys, hasher))| {
                (
                    format!("{tag:02x}"),
                    TagDigest {
                        keys,
                        sha256: hex(&hasher.finalize()),
                    },
                )
            })
            .collect();
        (self.keys, self.bytes, tags)
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The digest of every relation the seed manifest names; `None` for a store with no seed. With an
/// `op`, a cancel ends the pass at the next entry with `snapshot_cancelled`, so the pinned read is
/// not held for the relations that remain.
pub(crate) fn relation_digests(
    read: &dyn KvRead,
    op: Option<&SnapshotOp>,
) -> Result<Option<BTreeMap<String, RelationDigest>>> {
    let Some(manifest) = get_json::<SeedManifest>(read, &keys::meta(MANIFEST))? else {
        return Ok(None);
    };
    let mut out = BTreeMap::new();
    let stop = || op.is_some_and(SnapshotOp::is_cancelled);
    for relation in manifest.relations.keys() {
        let Some(digest) = relation_digest_stream_until(read, relation, None, None, &stop)? else {
            return Err(SnapshotOp::cancelled());
        };
        if stop() {
            return Err(SnapshotOp::cancelled());
        }
        out.insert(
            relation.clone(),
            RelationDigest {
                rows: digest.rows,
                sha256: digest.digest,
            },
        );
    }
    Ok(Some(out))
}

/// The target directory this call made. `cleanup` (and, as a fallback, dropping the claim) removes
/// the files it names and the directory, and nothing else, and only while the path still names the
/// directory this call created.
struct Reservation {
    root: PathBuf,
    kept: bool,
    /// Device and inode of the directory this call created.
    #[cfg(unix)]
    identity: (u64, u64),
}

impl Reservation {
    /// Checks `target` and creates it, mode 0700. It must not exist, its parent must not be a
    /// symbolic link, and it must not lie inside the brain directory or hold it.
    fn make(source: &Path, target: &Path) -> Result<Reservation> {
        let invalid = |what: &str| Err(StoreError::invalid(format!("snapshot target: {what}")));
        let io = |what: &str, e: std::io::Error| {
            StoreError::io(format!("snapshot target: {what}: {}", e.kind()))
        };
        let Some(name) = target.file_name() else {
            return invalid("it has no name");
        };
        let parent = match target.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
        let meta = fs::symlink_metadata(parent).map_err(|e| io("its parent", e))?;
        if meta.file_type().is_symlink() {
            return invalid("its parent is a symbolic link");
        }
        let root = fs::canonicalize(parent)
            .map_err(|e| io("its parent", e))?
            .join(name);
        let source = fs::canonicalize(source).map_err(|e| io("the brain directory", e))?;
        if root.starts_with(&source) || source.starts_with(&root) {
            return invalid("it overlaps the brain directory");
        }
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        match builder.create(&root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return invalid("it already exists");
            }
            Err(e) => return Err(io("creating it", e)),
        }
        let reservation = Reservation {
            #[cfg(unix)]
            identity: identity(&fs::symlink_metadata(&root).map_err(|e| io("reading it", e))?),
            root,
            kept: false,
        };
        // The new entry is durable in its parent before anything is written into it; a parent that
        // cannot be synced fails the call, and the drop of `reservation` removes the directory.
        sync_dir(reservation.root.parent().unwrap_or(Path::new(".")))?;
        Ok(reservation)
    }

    /// Removes what this call made. It leaves the path alone when it no longer names the directory
    /// this call created (it was renamed away or replaced, for example by a link), and it reports a
    /// removal that did not finish, naming the target that remains.
    fn cleanup(&mut self) -> Result<()> {
        if self.kept {
            return Ok(());
        }
        self.kept = true;
        let left = |what: &str| {
            StoreError::io(format!(
                "snapshot target {} was not removed: {what}",
                self.root.display()
            ))
        };
        let meta = match fs::symlink_metadata(&self.root) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(left(&format!("{}", e.kind()))),
        };
        #[cfg(unix)]
        let same = identity(&meta) == self.identity;
        #[cfg(not(unix))]
        let same = true;
        if !meta.is_dir() || meta.file_type().is_symlink() || !same {
            return Err(left("it no longer names the directory this call made"));
        }
        let mut failure = None;
        for name in [
            RECORDS_FILE,
            format::FORMAT_FILE,
            "FORMAT.tmp",
            MANIFEST_FILE,
            "SNAPSHOT.json.tmp",
        ] {
            match fs::remove_file(self.root.join(name)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => failure = failure.or(Some(format!("{name}: {}", e.kind()))),
            }
        }
        match fs::remove_dir(&self.root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => failure = failure.or(Some(format!("the directory: {}", e.kind()))),
        }
        failure.map_or(Ok(()), |what| Err(left(&what)))
    }
}

#[cfg(unix)]
fn identity(meta: &fs::Metadata) -> (u64, u64) {
    (
        std::os::unix::fs::MetadataExt::dev(meta),
        std::os::unix::fs::MetadataExt::ino(meta),
    )
}

impl Drop for Reservation {
    /// The fallback for a path that leaves without `cleanup` (a panic); a failure is not reported.
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

/// Makes the directory's entries durable. A failure to open or sync it is an error on a platform
/// that can sync a directory; a platform that cannot open one (Windows) skips it.
fn sync_dir(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        let io = |what: &str, e: std::io::Error| {
            StoreError::io(format!("snapshot: {what} {}: {}", dir.display(), e.kind()))
        };
        let handle = fs::File::open(dir).map_err(|e| io("opening", e))?;
        handle.sync_all().map_err(|e| io("syncing", e))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

fn write_manifest(root: &Path, manifest: &SnapshotManifest) -> Result<()> {
    let io = |what: &str, e: std::io::Error| StoreError::io(format!("{what}: {}", e.kind()));
    let temp = root.join("SNAPSHOT.json.tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| io("creating the manifest", e))?;
    let mut body = serde_json::to_vec_pretty(manifest)?;
    body.push(b'\n');
    file.write_all(&body)
        .map_err(|e| io("writing the manifest", e))?;
    file.sync_all().map_err(|e| io("syncing the manifest", e))?;
    fs::rename(&temp, root.join(MANIFEST_FILE)).map_err(|e| io("publishing the manifest", e))?;
    sync_dir(root)
}

impl Store {
    /// Copies the brain's records at the latest committed generation into the new directory
    /// `target`: `records.redb`, `FORMAT` and, last, `SNAPSHOT.json`. Writers are never blocked
    /// and none of their commits after the pin appears in the copy. `op` cancels the call and
    /// reports its progress.
    ///
    /// Errors: `invalid_argument` for a target that exists, sits under a symbolic link or
    /// overlaps the brain directory; `invalid_state` for a store with no directory or inside a
    /// transaction; `snapshot_cancelled`; `store_io` (a full disk among them) and `store_corrupt`.
    /// On any error the call has removed what it made and released its read before it returns.
    pub fn snapshot_to(&self, target: &Path, op: &SnapshotOp) -> Result<SnapshotManifest> {
        self.snapshot_with(target, op, true, RedbSink::create_path)
    }

    /// `snapshot_to` over a sink the caller makes: the seam fault-injection tests use. `reopen`
    /// says the sink is the record file in `target`, which is opened read-only once it is
    /// finished: redb ignores a failure to mark the file closed, and a file that was not closed
    /// cleanly is not a snapshot.
    pub(crate) fn snapshot_with(
        &self,
        target: &Path,
        op: &SnapshotOp,
        reopen: bool,
        make_sink: impl FnOnce(&Path) -> Result<RedbSink>,
    ) -> Result<SnapshotManifest> {
        if self.bound.is_some() {
            return Err(StoreError::new(
                INVALID_STATE,
                "a snapshot is taken from the brain's own store, not inside a transaction",
            ));
        }
        let Some(dir) = self.dir.as_deref() else {
            return Err(StoreError::new(
                INVALID_STATE,
                "this store was not opened on a brain directory, so it has no FORMAT to copy",
            ));
        };
        let mut reservation = Reservation::make(dir, target)?;
        match self.copy(dir, &reservation.root.clone(), op, reopen, make_sink) {
            Ok(manifest) => {
                reservation.kept = true;
                Ok(manifest)
            }
            // The copy has dropped its sink and its read. A removal that did not finish is the
            // error the caller sees, with the target that remains named, not a clean cancel.
            Err(error) => match reservation.cleanup() {
                Ok(()) => Err(error),
                Err(left) => Err(StoreError::io(format!(
                    "{} (the copy stopped with {})",
                    left.message, error.code
                ))),
            },
        }
    }

    fn copy(
        &self,
        dir: &Path,
        root: &Path,
        op: &SnapshotOp,
        reopen: bool,
        make_sink: impl FnOnce(&Path) -> Result<RedbSink>,
    ) -> Result<SnapshotManifest> {
        let record = format::read(dir)?
            .ok_or_else(|| StoreError::new(INVALID_STATE, "the brain has no FORMAT file"))?;
        let sink = make_sink(&root.join(RECORDS_FILE))?;
        let (read, generation) = self.kv.versioned_snapshot()?;
        let pin = Pinned::new(read, &op.pinned);
        let stored: StoredFormat = get_json(pin.read(), &keys::meta("format"))?
            .ok_or_else(|| StoreError::new(STORE_CORRUPT, "the format record is missing"))?;
        if stored.brain_id != record.brain_id {
            return Err(StoreError::new(
                STORE_CORRUPT,
                "FORMAT names a different brain than the record file",
            ));
        }
        let schema_version = config::read_config(pin.read(), "version")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        let batch_bytes = op.batch_bytes.unwrap_or(BATCH_BYTES);
        let mut inventory = Inventory::default();
        let mut from = vec![1u8];
        let mut number = 0u64;
        loop {
            let mut batch: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
            let (mut size, mut resume, mut stopped) = (0usize, None, false);
            pin.read().scan(&from, &KEY_END, false, &mut |k, v| {
                if op.is_cancelled() {
                    stopped = true;
                    return false;
                }
                size += k.len() + v.len();
                batch.push((k.to_vec(), v.to_vec()));
                if size >= batch_bytes {
                    let mut next = k.to_vec();
                    next.push(0);
                    resume = Some(next);
                    return false;
                }
                true
            })?;
            if stopped {
                return Err(SnapshotOp::cancelled());
            }
            for (key, value) in &batch {
                inventory.absorb(key, value);
            }
            sink.put_batch(&batch)?;
            op.keys.fetch_add(batch.len() as u64, Ordering::SeqCst);
            op.bytes.fetch_add(size as u64, Ordering::SeqCst);
            number += 1;
            if let Some(hook) = &op.on_batch {
                hook(number);
            }
            if op.batch_delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(op.batch_delay_ms));
            }
            if op.is_cancelled() {
                return Err(SnapshotOp::cancelled());
            }
            match resume {
                Some(next) => from = next,
                None => break,
            }
        }
        let relations = relation_digests(pin.read(), Some(op))?;
        // The source pass is over: give the source its pages back before the copy is finished.
        drop(pin);
        if op.is_cancelled() {
            return Err(SnapshotOp::cancelled());
        }
        let (keys, bytes, tags) = inventory.finish();
        sink.finish(generation)?;
        if reopen {
            drop(RedbReadOnlyKv::open_path(&root.join(RECORDS_FILE))?);
        }
        if op.is_cancelled() {
            return Err(SnapshotOp::cancelled());
        }
        write_format(root, &record)?;
        let manifest = SnapshotManifest {
            version: MANIFEST_VERSION,
            brain_id: stored.brain_id,
            generation,
            engine_format_version: stored.format_version,
            schema_version,
            keys,
            bytes,
            tags,
            relations,
            created_at_us: self.env.now_micros(),
        };
        write_manifest(root, &manifest)?;
        Ok(manifest)
    }
}

fn write_format(root: &Path, record: &FormatRecord) -> Result<()> {
    format::write(root, record)?;
    sync_dir(root)
}

#[cfg(test)]
mod tests;
