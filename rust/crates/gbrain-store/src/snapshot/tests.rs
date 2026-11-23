//! A snapshot whose destination fails leaves nothing behind: no target, no `SNAPSHOT.json`, no
//! read held on the source. The sink is a byte file that fails on demand.

use super::*;
use crate::error::STORE_IO;
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
