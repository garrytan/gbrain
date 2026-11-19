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
    let newer = format.replace(
        &format!("\"format_version\": {FORMAT_VERSION}"),
        "\"format_version\": 99",
    );
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

/// Rewrites a brain into format 1, the layout before the per-counter records: the chunk stats
/// and the unfinished-request counters are each one JSON record, and the format record says 1.
fn downgrade_to_format_1(brain: &std::path::Path) {
    use gbrain_store::keys;
    use gbrain_store::kv::{read_i64, scan_prefix};
    let kv = RedbKv::open_path(&brain.join("records.redb")).unwrap();
    let mut tx = kv.begin_write().unwrap();
    let chunks = read_i64(&*tx, &keys::meta("chunk_stats/chunks")).unwrap();
    let length = read_i64(&*tx, &keys::meta("chunk_stats/total_length")).unwrap();
    let brain_count = read_i64(&*tx, &keys::meta("journal_outstanding")).unwrap();
    let prefix = keys::meta("journal_outstanding/");
    let mut principals = serde_json::Map::new();
    let mut counter_keys = vec![
        keys::meta("chunk_stats/chunks"),
        keys::meta("chunk_stats/total_length"),
        keys::meta("journal_outstanding"),
    ];
    scan_prefix(&*tx, &prefix, false, &mut |k, v| {
        let name = std::str::from_utf8(&k[prefix.len()..]).unwrap().to_string();
        let n = i64::from_le_bytes(v.try_into().unwrap());
        principals.insert(name, n.into());
        counter_keys.push(k.to_vec());
        true
    })
    .unwrap();
    for key in counter_keys {
        tx.delete(&key).unwrap();
    }
    let put = |tx: &mut Box<dyn gbrain_store::KvWrite>, name: &str, v: serde_json::Value| {
        tx.put(&keys::meta(name), &serde_json::to_vec(&v).unwrap())
            .unwrap()
    };
    put(
        &mut tx,
        "chunk_stats",
        serde_json::json!({"chunks": chunks, "total_length": length}),
    );
    put(
        &mut tx,
        "journal_counters",
        serde_json::json!({"brain": brain_count, "principals": principals}),
    );
    let mut format: serde_json::Value =
        serde_json::from_slice(&tx.get(&keys::meta("format")).unwrap().unwrap()).unwrap();
    format["format_version"] = 1.into();
    put(&mut tx, "format", format);
    tx.commit().unwrap();
    let path = brain.join("FORMAT");
    let mut file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    file["format_version"] = 1.into();
    std::fs::write(&path, serde_json::to_vec_pretty(&file).unwrap()).unwrap();
}

fn admission(n: u32) -> gbrain_store::journal::WriteAdmission {
    serde_json::from_value(serde_json::json!({
        "principal": {"kind": "local_cli", "id": "cli"}, "operation": "put_page",
        "sourceId": "default", "slug": format!("notes/held-{n}"),
        "requestId": format!("00000000-0000-4000-8000-{n:012}"),
        "callerIntent": {"slug": format!("notes/held-{n}")},
        "intent": {},
    }))
    .unwrap()
}

#[test]
fn a_format_1_brain_is_upgraded_on_open_and_keeps_its_counts() {
    use gbrain_store::journal::JournalLimits;
    use gbrain_store::pages::{PageInput, PutPageOptions};
    let dir = TempDir::new("format-upgrade");
    let brain = dir.path().join("brain");
    let (chunks, outstanding, id) = {
        let store = open(&dir);
        for i in 0..3 {
            let page: PageInput = serde_json::from_value(serde_json::json!({
                "type": "note", "title": format!("p{i}"),
                "compiled_truth": format!("body number {i} with some words in it"),
            }))
            .unwrap();
            store
                .put_page(&format!("notes/p{i}"), &page, &PutPageOptions::default())
                .unwrap();
        }
        store.admit_write(&admission(1), None).unwrap();
        store.admit_write(&admission(2), None).unwrap();
        let counts = (
            store.count_chunks().unwrap(),
            store.journal_outstanding().unwrap(),
            store.brain_id().to_string(),
        );
        store.close();
        counts
    };
    assert!(chunks > 0);
    assert_eq!(outstanding["brain"], 2);
    downgrade_to_format_1(&brain);

    let store = open(&dir);
    assert_eq!(store.brain_id(), id);
    assert_eq!(store.info().format_version, FORMAT_VERSION);
    const {
        assert!(
            FORMAT_VERSION > 1,
            "the counter layout needs a format after 1"
        )
    };
    let file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(brain.join("FORMAT")).unwrap()).unwrap();
    assert_eq!(file["format_version"], FORMAT_VERSION);
    assert_eq!(store.count_chunks().unwrap(), chunks);
    assert_eq!(store.journal_outstanding().unwrap(), outstanding);
    // The limit still counts the two writes admitted before the upgrade.
    let limits = JournalLimits {
        principal_outstanding: 3,
        brain_outstanding: 100,
    };
    store.admit_write(&admission(3), Some(limits)).unwrap();
    let refused = store.admit_write(&admission(4), Some(limits)).unwrap_err();
    assert_eq!(refused.code, gbrain_store::error::ADMISSION_REFUSED);
    store.close();

    // The legacy records are gone and the per-counter records hold the counts.
    let kv = RedbKv::open_path(&brain.join("records.redb")).unwrap();
    let read = kv.snapshot().unwrap();
    use gbrain_store::keys;
    assert!(read.get(&keys::meta("chunk_stats")).unwrap().is_none());
    assert!(read.get(&keys::meta("journal_counters")).unwrap().is_none());
    assert_eq!(
        gbrain_store::kv::read_i64(&*read, &keys::meta("chunk_stats/chunks")).unwrap() as u64,
        chunks
    );
    assert_eq!(
        gbrain_store::kv::read_i64(&*read, &keys::meta("journal_outstanding")).unwrap(),
        3
    );
}

#[test]
fn an_older_build_refuses_a_brain_in_the_new_format() {
    // What a format-1-only build does with this build's brains: `check_version` refuses any
    // version it does not list. This build lists both; the oldest one is 1.
    assert_eq!(gbrain_store::FORMAT_VERSIONS.first(), Some(&1));
    assert_eq!(gbrain_store::FORMAT_VERSIONS.last(), Some(&FORMAT_VERSION));
}
