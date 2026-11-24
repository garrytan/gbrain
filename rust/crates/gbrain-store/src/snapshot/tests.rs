//! A snapshot whose destination fails leaves nothing behind: no target, no `SNAPSHOT.json`, no
//! read held on the source. The sink is a byte file that fails on demand.

use super::*;
use crate::error::{SNAPSHOT_CANCELLED, STORE_IO};
use crate::kv::FileBackend;
use crate::{OpenOptions, Store};
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;

/// A byte file in memory that fails its `limit`th write, or every sync.
#[derive(Debug)]
struct FaultyFile {
    data: Mutex<Vec<u8>>,
    writes: Arc<AtomicUsize>,
    limit: usize,
    fail_sync: bool,
}

impl FileBackend for FaultyFile {
    fn size(&self) -> std::io::Result<u64> {
        Ok(self.data.lock().unwrap().len() as u64)
    }
    fn read_at(&self, offset: u64, out: &mut [u8]) -> std::io::Result<()> {
        let data = self.data.lock().unwrap();
        let start = offset as usize;
        let end = start + out.len();
        if end > data.len() {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        out.copy_from_slice(&data[start..end]);
        Ok(())
    }
    fn write_at(&self, offset: u64, bytes: &[u8]) -> std::io::Result<()> {
        if self.writes.fetch_add(1, Ordering::SeqCst) >= self.limit {
            return Err(std::io::Error::other("disk full"));
        }
        let mut data = self.data.lock().unwrap();
        let end = offset as usize + bytes.len();
        if data.len() < end {
            data.resize(end, 0);
        }
        data[offset as usize..end].copy_from_slice(bytes);
        Ok(())
    }
    fn set_len(&self, len: u64) -> std::io::Result<()> {
        self.data.lock().unwrap().resize(len as usize, 0);
        Ok(())
    }
    fn sync(&self) -> std::io::Result<()> {
        if self.fail_sync {
            return Err(std::io::Error::other("sync failed"));
        }
        Ok(())
    }
}

fn brain(name: &str) -> (Store, PathBuf) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/test-tmp")
        .join(format!("{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let options = OpenOptions {
        keyword_index_builder: false,
        ..OpenOptions::default()
    };
    let store = Store::open_dir(&root.join("brain"), options).unwrap();
    for n in 0..25 {
        store
            .write(|tx| tx.put(&keys::meta(&format!("test/{n}")), &[7u8; 300]))
            .unwrap();
    }
    (store, root)
}

#[test]
fn a_destination_that_fails_leaves_no_target_no_manifest_and_no_read() {
    let (store, root) = brain("snap-faulty");
    let target = root.join("copy");
    let writes = Arc::new(AtomicUsize::new(0));
    let sink = |limit: usize, fail_sync: bool, writes: &Arc<AtomicUsize>| {
        let file = FaultyFile {
            data: Mutex::default(),
            writes: writes.clone(),
            limit,
            fail_sync,
        };
        move |_: &Path| RedbSink::create_backend(Box::new(file))
    };
    // A run that never fails counts the writes, so the limits below fall inside the copy.
    let op = SnapshotOp::new().with_batch_bytes(4096);
    store
        .snapshot_with(&target, &op, false, sink(usize::MAX, false, &writes))
        .unwrap();
    let total = writes.load(Ordering::SeqCst);
    assert!(total > 8, "{total}");
    fs::remove_dir_all(&target).unwrap();

    for (limit, fail_sync) in [
        (1, false),
        (total / 4, false),
        (total / 2, false),
        (total * 3 / 4, false),
        (usize::MAX, true),
    ] {
        let op = SnapshotOp::new().with_batch_bytes(4096);
        let error = store
            .snapshot_with(&target, &op, false, sink(limit, fail_sync, &Arc::default()))
            .err()
            .unwrap_or_else(|| panic!("limit {limit} sync {fail_sync} of {total} succeeded"));
        assert_eq!(error.code, STORE_IO, "limit {limit}: {error:?}");
        assert!(!target.exists(), "limit {limit}: the target is gone");
        assert!(!op.progress().pinned, "limit {limit}: the read is released");
    }
    // The store is untouched by the failures.
    assert!(store.snapshot_to(&target, &SnapshotOp::new()).is_ok());
    drop(store);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_manifest_that_does_not_add_up_is_refused_by_name_without_values() {
    let (store, root) = brain("snap-manifest");
    let manifest = store
        .snapshot_to(&root.join("copy"), &SnapshotOp::new())
        .unwrap();
    manifest.validate().unwrap();
    for (what, damage) in [
        (
            "version",
            (|m: &mut SnapshotManifest| m.version = 9) as fn(&mut SnapshotManifest),
        ),
        ("keys", |m| m.keys += 1),
        ("tags", |m| {
            m.tags.insert(
                "zz".into(),
                TagDigest {
                    keys: 0,
                    sha256: "0".repeat(64),
                },
            );
        }),
        ("tags", |m| {
            m.tags
                .values_mut()
                .next()
                .unwrap()
                .sha256
                .make_ascii_uppercase()
        }),
        ("brain_id", |m| m.brain_id.clear()),
    ] {
        let mut broken = manifest.clone();
        damage(&mut broken);
        let error = broken.validate().unwrap_err();
        assert!(error.message.ends_with(what), "{what}: {}", error.message);
    }
    // An unknown field or a missing one is a parse error: the layout is strict.
    let mut value = serde_json::to_value(&manifest).unwrap();
    value["extra"] = 1.into();
    assert!(serde_json::from_value::<SnapshotManifest>(value).is_err());
    let mut value = serde_json::to_value(&manifest).unwrap();
    value.as_object_mut().unwrap().remove("generation");
    assert!(serde_json::from_value::<SnapshotManifest>(value).is_err());
    drop(store);
    let _ = fs::remove_dir_all(root);
}

/// A number past 2^32 reaches the addon as a float with no fraction: the manifest reads it.
#[test]
fn a_manifest_read_from_javascript_numbers_accepts_whole_floats_only() {
    let (store, root) = brain("snap-floats");
    let manifest = store
        .snapshot_to(&root.join("copy"), &SnapshotOp::new())
        .unwrap();
    let text = serde_json::to_string(&manifest).unwrap();
    let big = format!("{}.0", manifest.created_at_us);
    assert!(text.contains(&manifest.created_at_us.to_string()));
    let floated = text.replace(&manifest.created_at_us.to_string(), &big);
    assert_eq!(
        serde_json::from_str::<SnapshotManifest>(&floated).unwrap(),
        manifest
    );
    for bad in ["1.5", "-1", "1e300"] {
        let broken = text.replace(
            &format!("\"generation\":{}", manifest.generation),
            &format!("\"generation\":{bad}"),
        );
        assert!(
            serde_json::from_str::<SnapshotManifest>(&broken).is_err(),
            "{bad}"
        );
    }
    drop(store);
    let _ = fs::remove_dir_all(root);
}

/// A read that cancels `op` after the first entry of any scan, as a client that leaves mid-pass does.
struct CancelAfterFirstEntry<'a> {
    inner: &'a dyn KvRead,
    op: &'a SnapshotOp,
}

impl KvRead for CancelAfterFirstEntry<'_> {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.inner.get(key)
    }
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        self.inner.scan(start, end, reverse, &mut |k, v| {
            let more = f(k, v);
            self.op.cancel();
            more
        })
    }
}

/// The relation pass runs while the source read is pinned, so a cancel has to end it at the next
/// entry, not after the relations that remain.
#[test]
fn a_cancel_during_the_relation_pass_ends_it_at_the_next_entry() {
    // A seed needs an empty store, so this one has no pages.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/test-tmp")
        .join(format!("snap-relation-cancel-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let options = OpenOptions {
        keyword_index_builder: false,
        ..OpenOptions::default()
    };
    let store = Store::open_dir(&root.join("brain"), options).unwrap();
    let row = |k: &str| -> crate::seed::SeedRow {
        [("key", k), ("value", "1")]
            .iter()
            .map(|(a, b)| ((*a).to_owned(), Some((*b).to_owned())))
            .collect()
    };
    let digests = [1u8, 2, 3].map(|n| crate::seed::DigestInput {
        sort: format!("{n:02x}"),
        digest: format!("{n:02x}").repeat(32),
    });
    store
        .import_relation_with_digests(
            "seed-1",
            "config",
            vec![row("a"), row("b"), row("c")],
            &digests,
        )
        .unwrap();
    let (read, _) = store.kv.versioned_snapshot().unwrap();
    // No cancel: every entry is hashed.
    let whole = relation_digests(&*read, Some(&SnapshotOp::new()))
        .unwrap()
        .unwrap();
    assert_eq!(whole["config"].rows, 3);
    // A cancel after the first entry: the second entry is never hashed.
    let op = SnapshotOp::new();
    let error = relation_digests(
        &CancelAfterFirstEntry {
            inner: &*read,
            op: &op,
        },
        Some(&op),
    )
    .unwrap_err();
    assert_eq!(error.code, SNAPSHOT_CANCELLED, "{error:?}");
    // A cancel that came before the pass ends it before the first relation is read.
    let op = SnapshotOp::new();
    op.cancel();
    assert_eq!(
        relation_digests(&*read, Some(&op)).unwrap_err().code,
        SNAPSHOT_CANCELLED
    );
    drop(read);
    drop(store);
    let _ = fs::remove_dir_all(root);
}

/// Runs a snapshot of `store` into `target` slowly, and lets `mischief` act once the copy has
/// started; `mischief` then cancels the call.
fn cancelled_with(store: &Store, target: &Path, mischief: impl FnOnce() + Send) -> StoreError {
    let op = SnapshotOp::new()
        .with_batch_bytes(4096)
        .with_batch_delay_ms(150);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            while op.progress().keys == 0 {
                std::thread::sleep(Duration::from_millis(5));
            }
            mischief();
            op.cancel();
        });
        store.snapshot_to(target, &op).unwrap_err()
    })
}

/// A removal that cannot finish is the error the caller sees, with the target named; it is not a
/// clean cancel.
#[cfg(unix)]
#[test]
fn a_cleanup_that_cannot_finish_is_reported_with_the_target_that_remains() {
    use std::os::unix::fs::PermissionsExt;
    let (store, root) = brain("snap-cleanup-fails");
    let target = root.join("copy");
    let shut = target.clone();
    let error = cancelled_with(&store, &target, move || {
        fs::set_permissions(&shut, fs::Permissions::from_mode(0o500)).unwrap();
    });
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(error.code, STORE_IO, "{error:?}");
    assert!(error.message.contains("copy"), "{}", error.message);
    assert!(error.message.contains("not removed"), "{}", error.message);
    assert!(target.join(RECORDS_FILE).exists(), "the remains are real");
    drop(store);
    let _ = fs::remove_dir_all(root);
}

/// A path that stopped naming the directory this call made is not cleaned: here it was swapped for
/// a link to the brain itself, and a cancel must leave the brain's files alone.
#[cfg(unix)]
#[test]
fn a_target_swapped_for_a_link_to_the_brain_is_not_cleaned_through() {
    let (store, root) = brain("snap-link-swap");
    let target = root.join("copy");
    let (moved, brain_dir) = (root.join("moved"), root.join("brain"));
    let (from, to) = (target.clone(), brain_dir.clone());
    let to_moved = moved.clone();
    let error = cancelled_with(&store, &target, move || {
        fs::rename(&from, &to_moved).unwrap();
        std::os::unix::fs::symlink(&to, &from).unwrap();
    });
    assert_eq!(error.code, STORE_IO, "{error:?}");
    assert!(
        error.message.contains("no longer names the directory"),
        "{}",
        error.message
    );
    assert!(brain_dir.join(RECORDS_FILE).exists(), "the brain's records");
    assert!(
        brain_dir.join(format::FORMAT_FILE).exists(),
        "the brain's FORMAT"
    );
    assert!(moved.join(RECORDS_FILE).exists(), "the moved copy is left");
    drop(store);
    let _ = fs::remove_dir_all(root);
}

/// A directory that cannot be synced is an error, not a skipped step.
#[cfg(unix)]
#[test]
fn a_directory_that_cannot_be_synced_is_an_error() {
    let (store, root) = brain("snap-sync-dir");
    assert!(sync_dir(&root).is_ok());
    let error = sync_dir(&root.join("missing")).unwrap_err();
    assert_eq!(error.code, STORE_IO, "{error:?}");
    drop(store);
    let _ = fs::remove_dir_all(root);
}
