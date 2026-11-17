//! Open, close, FORMAT, the single-owner lock, and the key-value trait the store stands on.

mod common;

use common::{TempDir, open};
use gbrain_store::error::{FORMAT_UNKNOWN, STORE_LOCKED};
use gbrain_store::kv::{Kv, collect_prefix, prefix_end};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{FORMAT_VERSION, OpenOptions, Store};
use std::sync::Arc;

#[test]
fn a_fresh_directory_becomes_a_brain_with_an_id_and_a_format_file() {
    let dir = TempDir::new("fresh");
    let store = open(&dir);
    assert!(store.info().created);
    assert_eq!(store.info().format_version, FORMAT_VERSION);
    let format = std::fs::read_to_string(dir.path().join("brain/FORMAT")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&format).unwrap();
    assert_eq!(json["brain_id"], store.brain_id());
    assert_eq!(json["format_version"], FORMAT_VERSION);
    assert_eq!(json["engine_abi"], 1);
    assert_eq!(store.brain_id().len(), 36);
}

#[test]
fn reopening_keeps_the_brain_id_and_says_it_was_not_created() {
    let dir = TempDir::new("reopen");
    let first = open(&dir);
    let id = first.brain_id().to_string();
    first.close();
    let second = open(&dir);
    assert_eq!(second.brain_id(), id);
    assert!(!second.info().created);
}

#[test]
fn a_second_open_of_a_live_brain_is_refused_and_the_first_keeps_working() {
    let dir = TempDir::new("locked");
    let first = open(&dir);
    let error = Store::open_dir(&dir.path().join("brain"), OpenOptions::default())
        .err()
        .expect("second open must fail");
    assert_eq!(error.code, STORE_LOCKED, "{error}");
    assert!(first.commit_version().is_ok());
    first.close();
    // Once the owner closes, the brain opens again.
    assert!(Store::open_dir(&dir.path().join("brain"), OpenOptions::default()).is_ok());
}

#[test]
fn an_unknown_format_is_refused_before_the_records_are_touched() {
    let dir = TempDir::new("newer");
    let brain = dir.path().join("brain");
    open(&dir).close();
    let records = brain.join("records.redb");
    let before = std::fs::read(&records).unwrap();
    let format = std::fs::read_to_string(brain.join("FORMAT")).unwrap();
    let newer = format.replace("\"format_version\": 1", "\"format_version\": 99");
    assert_ne!(newer, format);
    std::fs::write(brain.join("FORMAT"), &newer).unwrap();
    let error = Store::open_dir(&brain, OpenOptions::default())
        .err()
        .expect("refused");
    assert_eq!(error.code, FORMAT_UNKNOWN, "{error}");
    assert!(error.message.contains("99"), "{error}");
    assert_eq!(
        std::fs::read(&records).unwrap(),
        before,
        "records untouched"
    );
    assert_eq!(
        std::fs::read_to_string(brain.join("FORMAT")).unwrap(),
        newer
    );
}

#[test]
fn a_garbled_format_file_is_refused_too() {
    let dir = TempDir::new("garbled");
    let brain = dir.path().join("brain");
    open(&dir).close();
    std::fs::write(brain.join("FORMAT"), "not json").unwrap();
    let error = Store::open_dir(&brain, OpenOptions::default())
        .err()
        .expect("refused");
    assert_eq!(error.code, FORMAT_UNKNOWN);
}

#[test]
fn a_deleted_format_file_is_rebuilt_from_the_records() {
    let dir = TempDir::new("repair");
    let brain = dir.path().join("brain");
    let first = open(&dir);
    let id = first.brain_id().to_string();
    first.close();
    std::fs::remove_file(brain.join("FORMAT")).unwrap();
    let again = open(&dir);
    assert_eq!(again.brain_id(), id);
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(brain.join("FORMAT")).unwrap()).unwrap();
    assert_eq!(json["brain_id"], id.as_str());
}

#[test]
fn a_format_file_naming_another_brain_is_corruption_not_a_silent_overwrite() {
    let dir = TempDir::new("mixed");
    let brain = dir.path().join("brain");
    open(&dir).close();
    let format = std::fs::read_to_string(brain.join("FORMAT")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&format).unwrap();
    let id = json["brain_id"].as_str().unwrap();
    std::fs::write(
        brain.join("FORMAT"),
        format.replace(id, "00000000-0000-4000-8000-000000000000"),
    )
    .unwrap();
    let error = Store::open_dir(&brain, OpenOptions::default())
        .err()
        .expect("refused");
    assert_eq!(error.code, "store_corrupt");
}

// ---- the key-value trait -------------------------------------------------------------------

fn kv(dir: &TempDir) -> RedbKv {
    RedbKv::open_path(&dir.path().join("kv.redb")).unwrap()
}

#[test]
fn kv_commit_is_durable_ordered_and_counted() {
    let dir = TempDir::new("kv");
    let db = kv(&dir);
    assert_eq!(db.version().unwrap(), 0);
    let mut tx = db.begin_write().unwrap();
    for key in ["b", "a", "c"] {
        tx.put(key.as_bytes(), key.to_uppercase().as_bytes())
            .unwrap();
    }
    assert_eq!(tx.commit().unwrap(), 1);
    let mut tx = db.begin_write().unwrap();
    tx.delete(b"b").unwrap();
    assert_eq!(tx.commit().unwrap(), 2);
    let snapshot = db.snapshot().unwrap();
    assert_eq!(snapshot.get(b"b").unwrap(), None);
    let forward = collect_prefix(&*snapshot, b"", false, 10).unwrap();
    assert_eq!(
        forward
            .iter()
            .map(|(k, _)| k.as_slice())
            .collect::<Vec<_>>(),
        [b"a".as_slice(), b"c".as_slice()]
    );
    let reverse = collect_prefix(&*snapshot, b"", true, 1).unwrap();
    assert_eq!(reverse[0].0, b"c");
    drop(snapshot);
    let mut tx = db.begin_write().unwrap();
    assert!(
        tx.put(b"\0seq", b"x").is_err(),
        "the adapter's keys are reserved"
    );
    drop(tx);
    drop(db);
    let db = kv(&dir);
    assert_eq!(db.version().unwrap(), 2, "the sequence survives a reopen");
}

#[test]
fn kv_dropping_a_write_rolls_it_back_and_snapshots_do_not_see_later_commits() {
    let dir = TempDir::new("kv-rollback");
    let db = kv(&dir);
    let mut tx = db.begin_write().unwrap();
    tx.put(b"k", b"1").unwrap();
    tx.commit().unwrap();
    let early = db.snapshot().unwrap();
    let mut tx = db.begin_write().unwrap();
    tx.put(b"k", b"2").unwrap();
    assert_eq!(
        tx.get(b"k").unwrap().unwrap(),
        b"2",
        "a write reads its own puts"
    );
    drop(tx);
    assert_eq!(db.snapshot().unwrap().get(b"k").unwrap().unwrap(), b"1");
    let mut tx = db.begin_write().unwrap();
    tx.put(b"k", b"3").unwrap();
    tx.commit().unwrap();
    assert_eq!(
        early.get(b"k").unwrap().unwrap(),
        b"1",
        "snapshot isolation"
    );
    assert_eq!(db.snapshot().unwrap().get(b"k").unwrap().unwrap(), b"3");
    assert_eq!(
        db.version().unwrap(),
        2,
        "a rolled-back write is not counted"
    );
}

#[test]
fn kv_prefix_helpers() {
    assert_eq!(prefix_end(b"ab"), Some(b"ac".to_vec()));
    assert_eq!(prefix_end(&[1, 0xFF]), Some(vec![2]));
    assert_eq!(prefix_end(&[0xFF, 0xFF]), None);
    let dir = TempDir::new("kv-prefix");
    let db: Arc<dyn Kv> = Arc::new(kv(&dir));
    let mut tx = db.begin_write().unwrap();
    for key in ["a1", "a2", "b1"] {
        tx.put(key.as_bytes(), b"").unwrap();
    }
    tx.commit().unwrap();
    let snapshot = db.snapshot().unwrap();
    assert_eq!(
        collect_prefix(&*snapshot, b"a", false, 10).unwrap().len(),
        2
    );
    assert_eq!(collect_prefix(&*snapshot, b"a", false, 1).unwrap().len(), 1);
    assert_eq!(
        collect_prefix(&*snapshot, b"zz", false, 10).unwrap().len(),
        0
    );
}
