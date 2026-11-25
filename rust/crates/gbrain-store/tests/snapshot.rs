//! The store snapshot: one committed generation, copied while writers keep going; cancel, refusals,
//! and what a copy of a seeded store carries (`rust/docs/store/snapshot.md`).

mod common;

use common::TempDir;
use gbrain_store::error::{INVALID_ARGUMENT, INVALID_STATE, SNAPSHOT_CANCELLED};
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::snapshot::{MANIFEST_FILE, SnapshotOp};
use gbrain_store::verify::{Verdict, verify_store_dir};
use gbrain_store::{OpenOptions, Store};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

fn page(title: &str) -> PageInput {
    serde_json::from_value(serde_json::json!({
        "type": "note", "title": title, "compiled_truth": format!("{title} body with some words in it"),
    }))
    .unwrap()
}

fn put(store: &Store, n: u32) {
    store
        .put_page(
            &format!("notes/p{n}"),
            &page(&format!("Page {n}")),
            &PutPageOptions::default(),
        )
        .unwrap();
}

fn brain(dir: &TempDir) -> PathBuf {
    dir.path().join("brain")
}

fn options(concurrent: bool) -> OpenOptions {
    OpenOptions {
        concurrent_writes: concurrent,
        keyword_index_builder: false,
        ..OpenOptions::default()
    }
}

fn has_page(store: &Store, n: u32) -> bool {
    let scope: ReadScope = serde_json::from_value(serde_json::json!({})).unwrap();
    store
        .read_page_snapshot(&format!("notes/p{n}"), &scope)
        .unwrap()
        .is_some()
}

fn names(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

/// A copy holds the commits up to the pin and none after it: a commit made while the copy is
/// paused between batches is in the source and not in the copy, whichever write layer the store runs.
#[test]
fn commits_during_a_paused_copy_are_absent_and_the_generation_is_the_pin() {
    for concurrent in [false, true] {
        let dir = TempDir::new("snap-pause");
        let store = Arc::new(Store::open_dir(&brain(&dir), options(concurrent)).unwrap());
        for n in 0..30 {
            put(&store, n);
        }
        let pin = store.commit_version().unwrap();
        let writer = store.clone();
        let wrote = Arc::new(AtomicU64::new(0));
        let flag = wrote.clone();
        let op = SnapshotOp::new()
            .with_batch_bytes(4096)
            .with_batch_hook(Arc::new(move |batch| {
                if batch == 1 {
                    put(&writer, 1000);
                    flag.store(writer.commit_version().unwrap(), Ordering::SeqCst);
                }
            }));
        let target = dir.path().join("copy");
        let manifest = store.snapshot_to(&target, &op).unwrap();
        assert!(
            wrote.load(Ordering::SeqCst) > pin,
            "the write ran during the copy"
        );
        assert_eq!(manifest.generation, pin, "concurrent={concurrent}");
        assert!(has_page(&store, 1000));
        assert!(!op.progress().pinned);
        assert!(op.progress().keys > 0);

        let copy = Store::open_dir_read_only(&target).unwrap();
        assert!(
            has_page(&copy, 29),
            "the copy holds what was committed at the pin"
        );
        assert!(
            !has_page(&copy, 1000),
            "the copy holds nothing committed after it"
        );
        assert_eq!(copy.commit_version().unwrap(), pin);
        assert_eq!(copy.brain_id(), store.brain_id());
        copy.close();
        assert_eq!(names(&target), ["FORMAT", MANIFEST_FILE, "records.redb"]);
        let report = verify_store_dir(&target, Some(&manifest)).unwrap();
        assert_eq!(report.verdict, Verdict::Ok, "{report:?}");
    }
}

/// A cancel mid-copy ends the call with `snapshot_cancelled`, leaves no target and no open read.
#[test]
fn a_cancel_mid_copy_leaves_no_target_and_no_read_open() {
    let dir = TempDir::new("snap-cancel");
    let store = Store::open_dir(&brain(&dir), options(false)).unwrap();
    for n in 0..30 {
        put(&store, n);
    }
    // The hook cancels the op the call runs on, so the op is built around a slot it fills.
    let slot: Arc<std::sync::OnceLock<Arc<SnapshotOp>>> = Arc::default();
    let seen = slot.clone();
    let op = Arc::new(
        SnapshotOp::new()
            .with_batch_bytes(4096)
            .with_batch_hook(Arc::new(move |batch| {
                if batch == 2 {
                    seen.get().unwrap().cancel();
                }
            })),
    );
    slot.set(op.clone()).ok();
    let target = dir.path().join("copy");
    let error = store.snapshot_to(&target, &op).unwrap_err();
    assert_eq!(error.code, SNAPSHOT_CANCELLED);
    assert!(!target.exists(), "no directory and no file is left");
    assert!(
        !op.progress().pinned,
        "the source read is released at the return"
    );
    // The source is as it was: it still takes writes and a second snapshot works.
    put(&store, 99);
    let again = store.snapshot_to(&target, &SnapshotOp::new()).unwrap();
    assert_eq!(again.generation, store.commit_version().unwrap());
}

#[test]
fn a_cancel_before_the_call_starts_copies_nothing() {
    let dir = TempDir::new("snap-precancel");
    let store = Store::open_dir(&brain(&dir), options(false)).unwrap();
    let op = SnapshotOp::new();
    op.cancel();
    let target = dir.path().join("copy");
    assert_eq!(
        store.snapshot_to(&target, &op).unwrap_err().code,
        SNAPSHOT_CANCELLED
    );
    assert!(!target.exists());
}

#[test]
fn a_target_that_exists_overlaps_or_sits_under_a_symlink_is_refused_and_nothing_is_touched() {
    let dir = TempDir::new("snap-refuse");
    let store = Store::open_dir(&brain(&dir), options(false)).unwrap();
    put(&store, 1);
    let refuse = |target: &Path| {
        let error = store.snapshot_to(target, &SnapshotOp::new()).unwrap_err();
        assert_eq!(error.code, INVALID_ARGUMENT, "{}", error.message);
        assert!(
            !error.message.contains(dir.path().to_str().unwrap()),
            "no path in an error"
        );
    };
    // An existing directory, file and dangling symlink.
    std::fs::create_dir(dir.path().join("taken")).unwrap();
    refuse(&dir.path().join("taken"));
    std::fs::write(dir.path().join("file"), b"x").unwrap();
    refuse(&dir.path().join("file"));
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(dir.path().join("nowhere"), dir.path().join("dangling"))
            .unwrap();
        refuse(&dir.path().join("dangling"));
        std::os::unix::fs::symlink(dir.path(), dir.path().join("link")).unwrap();
        refuse(&dir.path().join("link").join("copy"));
    }
    // Inside the brain directory, and a directory that holds the brain directory.
    refuse(&brain(&dir).join("copy"));
    refuse(dir.path());
    assert!(!brain(&dir).join("copy").exists());
    assert!(
        store
            .snapshot_to(&dir.path().join("fine"), &SnapshotOp::new())
            .is_ok()
    );
}

#[test]
fn a_store_that_was_not_opened_on_a_directory_cannot_snapshot() {
    let dir = TempDir::new("snap-state");
    let store = Store::open_dir(&brain(&dir), options(false)).unwrap();
    let in_memory = Store::open_kv(
        Arc::new(gbrain_store::redb_kv::RedbKv::open_path(&dir.path().join("loose.redb")).unwrap()),
        Arc::new(gbrain_store::SystemEnv),
        OpenOptions::default(),
    )
    .unwrap();
    let error = in_memory
        .snapshot_to(&dir.path().join("copy"), &SnapshotOp::new())
        .unwrap_err();
    assert_eq!(error.code, INVALID_STATE);
    drop(store);
}
