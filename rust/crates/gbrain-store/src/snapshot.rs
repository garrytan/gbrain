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
use crate::format::{self, RECORDS_FILE};
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
/// the files it names and then the directory, and nothing else. On Unix the call keeps the directory
/// open (`O_DIRECTORY | O_NOFOLLOW`) from the moment it creates it and removes the files relative to
/// that handle, so a path that is renamed or replaced by a link afterwards cannot send a removal
/// anywhere else. Where that is not available it removes nothing and reports the target left behind.
pub(crate) struct Reservation {
    pub(crate) root: PathBuf,
    pub(crate) kept: bool,
    /// The open directory this call created.
    #[cfg(unix)]
    dir: fs::File,
    /// Device and inode of that directory.
    #[cfg(unix)]
    identity: (u64, u64),
}

impl Reservation {
    /// Checks `target` and creates it, mode 0700. It must not exist, its parent must not be a
    /// symbolic link, and it must not lie inside the brain directory or hold it.
    pub(crate) fn make(source: &Path, target: &Path) -> Result<Reservation> {
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
        // Before anything is made: the snapshot trusts only directories the caller's own user (or
        // root) controls, so a directory another user can write to is refused here.
        #[cfg(unix)]
        check_trusted(root.parent().unwrap_or(Path::new("/")))?;
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
        // From here the directory exists: a failure removes it again, and only if it is still the
        // one just made (the handle and the path agree).
        #[cfg(test)]
        tests::after_create(&root);
        #[cfg(unix)]
        let reservation = {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
            let opened = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&root);
            let made = opened.and_then(|dir| {
                let meta = dir.metadata()?;
                let named = fs::symlink_metadata(&root)?;
                if named.file_type().is_symlink()
                    || (named.dev(), named.ino()) != (meta.dev(), meta.ino())
                {
                    return Err(std::io::ErrorKind::PermissionDenied.into());
                }
                Ok((dir, (meta.dev(), meta.ino())))
            });
            // What was opened must be the empty directory just made. Another directory renamed
            // into the target's place (the brain itself, for one) is refused and left exactly as
            // it is: nothing is armed to remove it.
            if made.is_ok() && fs::read_dir(&root).is_ok_and(|mut entries| entries.next().is_some())
            {
                return Err(StoreError::io(format!(
                    "snapshot target {} was not empty when this call claimed it; it was not touched",
                    root.display()
                )));
            }
            match made {
                Ok((dir, identity)) => Reservation {
                    root,
                    kept: false,
                    dir,
                    identity,
                },
                Err(e) => {
                    let _ = fs::remove_dir(&root);
                    return Err(io("opening it", e));
                }
            }
        };
        #[cfg(not(unix))]
        let reservation = Reservation { root, kept: false };
        // The new entry is durable in its parent before anything is written into it; a parent that
        // cannot be synced fails the call, and the drop of `reservation` removes the directory.
        sync_dir(reservation.root.parent().unwrap_or(Path::new(".")))?;
        Ok(reservation)
    }

    /// Whether the path still names the directory this call created. A path that was renamed or
    /// replaced makes the call fail; nothing more is written through it.
    pub(crate) fn verify(&self) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let same = fs::symlink_metadata(&self.root).is_ok_and(|meta| {
                meta.is_dir()
                    && !meta.file_type().is_symlink()
                    && (meta.dev(), meta.ino()) == self.identity
            });
            if !same {
                return Err(StoreError::io(format!(
                    "snapshot target {} no longer names the directory this call made; the snapshot stopped",
                    self.root.display()
                )));
            }
        }
        Ok(())
    }

    /// Publishes `name` in the directory this call made: written to a new `<name>.tmp`, synced,
    /// renamed into place and the directory synced, all relative to the held handle on Unix, so a
    /// path swapped during the copy can never receive the file.
    pub(crate) fn publish(&self, name: &str, body: &[u8]) -> Result<()> {
        let io = |what: &str, e: std::io::Error| {
            StoreError::io(format!("snapshot: {what} {name}: {}", e.kind()))
        };
        let temp = format!("{name}.tmp");
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let cstr = |text: &str| {
                std::ffi::CString::new(text)
                    .map_err(|_| io("naming", std::io::ErrorKind::InvalidInput.into()))
            };
            let (temp_c, name_c) = (cstr(&temp)?, cstr(name)?);
            let fd = self.dir.as_raw_fd();
            // SAFETY: `fd` is open for the call and the names are NUL-terminated strings that
            // outlive it; the new descriptor is owned by the `File` made from it.
            let mut file = unsafe {
                let raw = libc::openat(
                    fd,
                    temp_c.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600 as libc::c_uint,
                );
                if raw < 0 {
                    return Err(io("creating", std::io::Error::last_os_error()));
                }
                fs::File::from_raw_fd(raw)
            };
            file.write_all(body).map_err(|e| io("writing", e))?;
            file.sync_all().map_err(|e| io("syncing", e))?;
            drop(file);
            // SAFETY: as above.
            if unsafe { libc::renameat(fd, temp_c.as_ptr(), fd, name_c.as_ptr()) } != 0 {
                return Err(io("publishing", std::io::Error::last_os_error()));
            }
            self.dir
                .sync_all()
                .map_err(|e| io("syncing the directory for", e))
        }
        #[cfg(not(unix))]
        {
            let temp = self.root.join(temp);
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| io("creating", e))?;
            file.write_all(body).map_err(|e| io("writing", e))?;
            file.sync_all().map_err(|e| io("syncing", e))?;
            fs::rename(&temp, self.root.join(name)).map_err(|e| io("publishing", e))?;
            sync_dir(&self.root)
        }
    }

    /// Removes what this call made. The files go relative to the open directory handle; the
    /// directory entry goes only while the path still has the device and inode of that directory.
    /// A path that names something else is left alone, and so is anything that did not finish: the
    /// error names the target that remains. Platforms without directory-relative removal remove
    /// nothing and say so.
    pub(crate) fn cleanup(&mut self) -> Result<()> {
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
        #[cfg(not(unix))]
        return Err(left("this platform has no directory-relative removal"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            #[cfg(test)]
            tests::after_validation(&self.root);
            let mut failure = None;
            for name in [
                RECORDS_FILE,
                format::FORMAT_FILE,
                "FORMAT.tmp",
                MANIFEST_FILE,
                "SNAPSHOT.json.tmp",
                // A diverged-tail export (`diverged_tail.rs`) publishes these in the same directory.
                crate::diverged_tail::TAIL_FILE,
                "tail.jsonl.tmp",
                crate::diverged_tail::EXPORT_MANIFEST_FILE,
                "MANIFEST.json.tmp",
            ] {
                match unlink_in(&self.dir, name) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => failure = failure.or(Some(format!("{name}: {}", e.kind()))),
                }
            }
            if let Some(what) = failure {
                return Err(left(&what));
            }
            match fs::symlink_metadata(&self.root) {
                Ok(meta)
                    if meta.is_dir()
                        && !meta.file_type().is_symlink()
                        && (meta.dev(), meta.ino()) == self.identity =>
                {
                    fs::remove_dir(&self.root)
                        .map_err(|e| left(&format!("the directory: {}", e.kind())))
                }
                Ok(_) => Err(left(
                    "the path no longer names the directory this call made, and it was left in place",
                )),
                // The path is gone; the directory this call made is empty, and nothing else was touched.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(left(&format!("{}", e.kind()))),
            }
        }
    }
}

/// The snapshot trusts only directories the caller's own user (or root) controls. Every directory
/// from `/` down to `parent` must be owned by the current user or by root and must not be group- or
/// world-writable, except that a root-owned sticky directory (such as `/tmp`) may be written by
/// others above the parent. The parent itself is held to the strict rule: owned by the current
/// user, not group- or world-writable, no sticky exception. A directory that fails the rule is
/// named, with its owner or mode and the way out.
#[cfg(unix)]
fn check_trusted(parent: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: `geteuid` takes no arguments and cannot fail.
    let me = unsafe { libc::geteuid() };
    let refuse =
        |message: String| Err(StoreError::invalid(format!("refusing snapshot: {message}")));
    let mut chain: Vec<&Path> = parent.ancestors().collect();
    chain.reverse();
    for path in chain {
        let meta = fs::symlink_metadata(path).map_err(|e| {
            StoreError::io(format!(
                "snapshot target: reading {}: {}",
                path.display(),
                e.kind()
            ))
        })?;
        let (owner, mode) = (meta.uid(), meta.mode() & 0o7777);
        let direct = path == parent;
        if owner != me && (direct || owner != 0) {
            let trusted = if direct { "you" } else { "you or root" };
            return refuse(format!(
                "{} is owned by uid {owner}, not {trusted} (uid {me}); choose a directory you own",
                path.display()
            ));
        }
        if mode & 0o022 != 0 && !(!direct && owner == 0 && mode & 0o1000 != 0) {
            let (who, fix) = match (mode & 0o020 != 0, mode & 0o002 != 0) {
                (true, true) => ("group- and world-writable", "group and world write"),
                (true, false) => ("group-writable", "group write"),
                _ => ("world-writable", "world write"),
            };
            return refuse(format!(
                "{} is {who} (mode {mode:04o}); remove {fix} or choose a directory you own",
                path.display()
            ));
        }
    }
    Ok(())
}

/// Removes `name` from the open directory `dir` (`unlinkat`), never following a path.
#[cfg(unix)]
fn unlink_in(dir: &fs::File, name: &str) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let name = std::ffi::CString::new(name)
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: `dir` is an open descriptor for the duration of the call and `name` is a
    // NUL-terminated string that outlives it.
    let rc = unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
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
        let copied = format::read(dir)?
            .ok_or_else(|| StoreError::new(INVALID_STATE, "the brain has no FORMAT file"))
            .and_then(|record| {
                copy_kv(
                    &*self.kv,
                    record,
                    &reservation,
                    op,
                    reopen,
                    make_sink,
                    self.env.now_micros(),
                )
            });
        match copied {
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
}

/// The copy of `snapshot_with`, from any record file (a follower's diverged-tail export uses it
/// too): `record` is the brain's `FORMAT`, `created_at_us` the manifest's time.
pub(crate) fn copy_kv(
    kv: &dyn crate::kv::Kv,
    record: format::FormatRecord,
    claim: &Reservation,
    op: &SnapshotOp,
    reopen: bool,
    make_sink: impl FnOnce(&Path) -> Result<RedbSink>,
    created_at_us: i64,
) -> Result<SnapshotManifest> {
    {
        let root = claim.root.as_path();
        claim.verify()?;
        let sink = make_sink(&root.join(RECORDS_FILE))?;
        let (read, generation) = kv.versioned_snapshot()?;
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
        // The durable commit time (multi-user mode) is an adapter key no scan reaches: carried over
        // from the same pinned state, so the copy keeps its clock floor. Absent stays absent.
        let commit_time = crate::redb_kv::read_commit_time(pin.read())?;

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
        sink.finish(generation, commit_time)?;
        claim.verify()?;
        if reopen {
            drop(RedbReadOnlyKv::open_path(&root.join(RECORDS_FILE))?);
        }
        if op.is_cancelled() {
            return Err(SnapshotOp::cancelled());
        }
        let mut format_body = serde_json::to_vec_pretty(&record)?;
        format_body.push(b'\n');
        claim.publish(format::FORMAT_FILE, &format_body)?;
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
            created_at_us,
        };
        let mut manifest_body = serde_json::to_vec_pretty(&manifest)?;
        manifest_body.push(b'\n');
        claim.publish(MANIFEST_FILE, &manifest_body)?;
        // A path swapped after the last check still never received a byte (the files went through the
        // held handle), but the copy is then somewhere the caller did not name: that is a failure.
        claim.verify()?;
        Ok(manifest)
    }
}

#[cfg(test)]
mod tests;
