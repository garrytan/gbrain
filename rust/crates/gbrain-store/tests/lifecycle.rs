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
fn a_read_only_open_refuses_a_brain_that_needs_the_format_upgrade_and_changes_nothing() {
    use gbrain_store::error::READ_ONLY_TRANSACTION;
    let dir = TempDir::new("format-read-only");
    let brain = dir.path().join("brain");
    open(&dir).close();
    downgrade_to_format_1(&brain);
    let records = std::fs::read(brain.join("records.redb")).unwrap();
    let format = std::fs::read(brain.join("FORMAT")).unwrap();
    let error = Store::open_dir_read_only(&brain)
        .err()
        .expect("the upgrade is a write");
    assert_eq!(error.code, READ_ONLY_TRANSACTION, "{error}");
    assert!(records == std::fs::read(brain.join("records.redb")).unwrap());
    assert_eq!(format, std::fs::read(brain.join("FORMAT")).unwrap());
    // A plain open still upgrades it.
    assert_eq!(open(&dir).info().format_version, FORMAT_VERSION);
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
    // What an older build does with this build's brains: `check_version` refuses any version it
    // does not list. This build lists 1 to 4; the oldest one is 1.
    assert_eq!(gbrain_store::FORMAT_VERSIONS, &[1, 2, 3, 4, 5]);
    assert_eq!(gbrain_store::FORMAT_VERSIONS.first(), Some(&1));
    assert_eq!(gbrain_store::FORMAT_VERSIONS.last(), Some(&FORMAT_VERSION));
}

/// Rewrites a closed brain the way store format 2 kept it: JSON projection jobs, the commit
/// sequence at `\0seq`, and format 2 in both format records.
fn downgrade_to_format_2(brain: &std::path::Path) {
    use gbrain_store::keys;
    use redb::ReadableTable;
    let table: redb::TableDefinition<&[u8], &[u8]> = redb::TableDefinition::new("kv");
    let db = redb::Database::create(brain.join("records.redb")).unwrap();
    let tx = db.begin_write().unwrap();
    {
        let mut t = tx.open_table(table).unwrap();
        let seq = t
            .remove(b"M\0seq".as_slice())
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        t.insert(b"\0seq".as_slice(), seq.as_slice()).unwrap();
        let jobs: Vec<(Vec<u8>, Vec<u8>)> = t
            .range(b"d\x04".as_slice()..b"d\x05".as_slice())
            .unwrap()
            .map(|item| {
                let (k, v) = item.unwrap();
                (k.value().to_vec(), v.value().to_vec())
            })
            .collect();
        assert!(!jobs.is_empty());
        for (key, value) in jobs {
            // A trigger job: the compact tag, flags "UUID revision, canonical reason", the time,
            // the 16 UUID bytes.
            assert_eq!((value.len(), value[0], value[1]), (26, 1, 3));
            let stamp = i64::from_be_bytes(value[2..10].try_into().unwrap());
            let hex: String = value[10..].iter().map(|b| format!("{b:02x}")).collect();
            let revision = format!(
                "{}-{}-{}-{}-{}",
                &hex[..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..]
            );
            let json = serde_json::json!({
                "revision": revision, "reason": "canonical_change", "updated_at_us": stamp,
            });
            t.insert(
                key.as_slice(),
                serde_json::to_vec(&json).unwrap().as_slice(),
            )
            .unwrap();
        }
        let format_key = keys::meta("format");
        let mut format: serde_json::Value =
            serde_json::from_slice(t.get(format_key.as_slice()).unwrap().unwrap().value()).unwrap();
        format["format_version"] = 2.into();
        t.insert(
            format_key.as_slice(),
            serde_json::to_vec(&format).unwrap().as_slice(),
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let path = brain.join("FORMAT");
    let mut file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    file["format_version"] = 2.into();
    std::fs::write(&path, serde_json::to_vec_pretty(&file).unwrap()).unwrap();
}

/// The projection window with its read-time high-water mark left out.
fn window(store: &Store) -> Vec<serde_json::Value> {
    let cursor: gbrain_store::persistence::ProjectionWindowCursor =
        serde_json::from_value(serde_json::json!({
            "after": {"source_incarnation": "00000000-0000-0000-0000-000000000000", "slug": ""},
        }))
        .unwrap();
    let mut rows = store.select_projection_window_jobs(&cursor, false).unwrap();
    for row in &mut rows {
        row.as_object_mut().unwrap().remove("high_water");
    }
    rows
}

#[test]
fn a_format_2_brain_keeps_its_projection_jobs_and_commit_sequence_through_the_upgrade() {
    use gbrain_store::pages::{PageInput, PutPageOptions};
    let dir = TempDir::new("format-2-upgrade");
    let brain = dir.path().join("brain");
    let (jobs, version) = {
        let store = open(&dir);
        for i in 0..3 {
            let page: PageInput = serde_json::from_value(serde_json::json!({
                "type": "note", "title": format!("p{i}"), "compiled_truth": format!("body {i}"),
            }))
            .unwrap();
            // Not indexed, so each page keeps its projection job.
            let options = PutPageOptions {
                index: Some(false),
                ..PutPageOptions::default()
            };
            store
                .put_page(&format!("notes/p{i}"), &page, &options)
                .unwrap();
        }
        let answer = (window(&store), store.commit_version().unwrap());
        store.close();
        answer
    };
    assert_eq!(
        jobs.len(),
        6,
        "three recent rows and three window rows: {jobs:?}"
    );
    downgrade_to_format_2(&brain);

    // No background keyword build, so the commit count below is the upgrade's alone.
    let store = open_without_builder(&dir);
    assert_eq!(store.info().format_version, FORMAT_VERSION);
    const { assert!(FORMAT_VERSION > 2, "the compact jobs need a format after 2") };
    // The sequence carries over from `\0seq`; the upgrade is one more counted commit.
    assert_eq!(store.commit_version().unwrap(), version + 1);
    assert_eq!(window(&store), jobs);
    store.close();
    let db = redb::Database::create(brain.join("records.redb")).unwrap();
    let table: redb::TableDefinition<&[u8], &[u8]> = redb::TableDefinition::new("kv");
    let read = redb::ReadableDatabase::begin_read(&db).unwrap();
    let t = read.open_table(table).unwrap();
    assert!(t.get(b"\0seq".as_slice()).unwrap().is_none());
    assert!(t.get(b"M\0seq".as_slice()).unwrap().is_some());
    for item in t.range(b"d\x04".as_slice()..b"d\x05".as_slice()).unwrap() {
        assert_eq!(
            item.unwrap().1.value().len(),
            26,
            "every job is rewritten compact"
        );
    }
}

#[test]
fn the_commit_sequence_key_is_reserved_and_hidden_from_scans() {
    let dir = TempDir::new("seq-reserved");
    let kv = RedbKv::open_path(&dir.path().join("records.redb")).unwrap();
    let mut tx = kv.begin_write().unwrap();
    assert!(tx.put(b"M\0seq", b"x").is_err());
    tx.put(b"Ma", b"1").unwrap();
    tx.commit().unwrap();
    let mut tx = kv.begin_write().unwrap();
    tx.put(b"Mb", b"2").unwrap();
    tx.commit().unwrap();
    assert_eq!(kv.version().unwrap(), 2);
    let all = collect_prefix(&*kv.snapshot().unwrap(), b"M", false, usize::MAX).unwrap();
    let keys: Vec<&[u8]> = all.iter().map(|(k, _)| k.as_slice()).collect();
    assert_eq!(keys, vec![b"Ma".as_slice(), b"Mb".as_slice()]);
}

fn open_without_builder(dir: &TempDir) -> Store {
    let options = OpenOptions {
        keyword_index_builder: false,
        ..OpenOptions::default()
    };
    Store::open_dir(&dir.path().join("brain"), options).unwrap()
}

/// Rewrites a brain into format 3, the layout before keyword postings: no `R` records, and the
/// format record and `FORMAT` say 3.
/// Rewrites a brain as format 3. With `drop_index` its `R` records are deleted, as a format-3
/// build keeps none; without it they stay, as records a format-3 store must not be trusted with.
fn downgrade_to_format_3(brain: &std::path::Path, drop_index: bool) {
    use gbrain_store::keys;
    use gbrain_store::kv::scan_prefix;
    let kv = RedbKv::open_path(&brain.join("records.redb")).unwrap();
    let mut tx = kv.begin_write().unwrap();
    let mut index = Vec::new();
    scan_prefix(&*tx, &[keys::TRIGRAM], false, &mut |k, _| {
        index.push(k.to_vec());
        true
    })
    .unwrap();
    assert!(index.len() > 1, "the brain kept postings");
    for key in index.into_iter().filter(|_| drop_index) {
        tx.delete(&key).unwrap();
    }
    let mut format: serde_json::Value =
        serde_json::from_slice(&tx.get(&keys::meta("format")).unwrap().unwrap()).unwrap();
    format["format_version"] = 3.into();
    tx.put(&keys::meta("format"), &serde_json::to_vec(&format).unwrap())
        .unwrap();
    tx.commit().unwrap();
    let path = brain.join("FORMAT");
    let mut file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    file["format_version"] = 3.into();
    std::fs::write(&path, serde_json::to_vec_pretty(&file).unwrap()).unwrap();
}

fn keyword_answers(store: &Store) -> String {
    let options = serde_json::from_value(serde_json::json!({})).unwrap();
    let chunks = store.search_keyword_chunks("apple", &options).unwrap();
    let pages = store.search_keyword_pages("apple", &options).unwrap();
    serde_json::to_string(&(chunks, pages)).unwrap()
}

#[test]
fn a_format_3_brain_builds_its_keyword_index_in_the_background_after_the_upgrade() {
    use gbrain_store::pages::{PageInput, PutPageOptions};
    let dir = TempDir::new("format-3-upgrade");
    let brain = dir.path().join("brain");
    let answers = {
        let store = open(&dir);
        for i in 0..40 {
            let page: PageInput = serde_json::from_value(serde_json::json!({
                "type": "note", "title": format!("Apple {i}"),
                "compiled_truth": format!("apple body {i} with pear words"),
            }))
            .unwrap();
            store
                .put_page(&format!("notes/p{i}"), &page, &PutPageOptions::default())
                .unwrap();
        }
        let answers = keyword_answers(&store);
        store.close();
        answers
    };
    downgrade_to_format_3(&brain, true);

    // The upgrade leaves an empty, incomplete index; nothing serves until the build ends.
    let store = open_without_builder(&dir);
    assert_eq!(store.info().format_version, FORMAT_VERSION);
    const { assert!(FORMAT_VERSION > 3, "keyword postings need a format after 3") };
    let state = store.keyword_index_state().unwrap().unwrap();
    assert!(!state.complete && state.cursor == Some(0), "{state:?}");
    assert_eq!(
        keyword_answers(&store),
        answers,
        "the scan answers while incomplete"
    );
    store.close();
    let file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(brain.join("FORMAT")).unwrap()).unwrap();
    assert_eq!(file["format_version"], FORMAT_VERSION);

    // A default open runs the build in the background.
    let store = open(&dir);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while !store.keyword_index_state().unwrap().unwrap().complete {
        assert!(
            std::time::Instant::now() < deadline,
            "the build did not finish"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let report = store.keyword_index_verify(None).unwrap();
    assert!(report.ok && report.pages == 40, "{report:?}");
    assert_eq!(keyword_answers(&store), answers);
    store.close();
    // Closing stops the build thread and releases the brain.
    open(&dir).close();
}

#[test]
fn a_rebuild_interrupted_by_close_resumes_on_the_next_open() {
    use gbrain_store::pages::{PageInput, PutPageOptions};
    let dir = TempDir::new("index-rebuild-close");
    let store = open_without_builder(&dir);
    for i in 0..30 {
        let page: PageInput = serde_json::from_value(serde_json::json!({
            "type": "note", "title": format!("Page {i}"), "compiled_truth": format!("apple {i}"),
        }))
        .unwrap();
        store
            .put_page(&format!("notes/p{i}"), &page, &PutPageOptions::default())
            .unwrap();
    }
    store.keyword_index_rebuild().unwrap();
    let state = store.keyword_index_build_step(7).unwrap().unwrap();
    assert!(!state.complete);
    store.close();
    let store = open_without_builder(&dir);
    assert_eq!(store.keyword_index_state().unwrap().unwrap(), state);
    while !store.keyword_index_build_step(7).unwrap().unwrap().complete {}
    assert!(store.keyword_index_verify(None).unwrap().ok);
}

/// The upgrade to format 4 clears whatever `R` records a format-3 store holds, even a complete
/// state of the current index version, and starts the build from page 0: a format-3 build did
/// not keep them, so they may be stale.
#[test]
fn the_upgrade_does_not_trust_index_records_in_a_format_3_brain() {
    use gbrain_store::keys;
    use gbrain_store::kv::scan_prefix;
    use gbrain_store::pages::{PageInput, PutPageOptions};
    let dir = TempDir::new("format-3-stale-index");
    let brain = dir.path().join("brain");
    {
        let store = open_without_builder(&dir);
        let page: PageInput = serde_json::from_value(serde_json::json!({
            "type": "note", "title": "Apple", "compiled_truth": "apple pear",
        }))
        .unwrap();
        store
            .put_page("notes/apple", &page, &PutPageOptions::default())
            .unwrap();
        assert!(store.keyword_index_state().unwrap().unwrap().complete);
        store.close();
    }
    downgrade_to_format_3(&brain, false);
    let store = open_without_builder(&dir);
    let state = store.keyword_index_state().unwrap().unwrap();
    assert!(!state.complete && state.cursor == Some(0), "{state:?}");
    store.close();
    let kv = RedbKv::open_path(&brain.join("records.redb")).unwrap();
    let mut left = Vec::new();
    scan_prefix(
        &*kv.snapshot().unwrap(),
        &[keys::TRIGRAM],
        false,
        &mut |k, _| {
            left.push(k.to_vec());
            true
        },
    )
    .unwrap();
    assert_eq!(
        left,
        [keys::keyword_index_state()],
        "only the new state is left"
    );
}

/// Rewrites a brain's format record and `FORMAT` to `version`, leaving every other record as it is.
fn stamp_format(brain: &std::path::Path, version: u32) {
    use gbrain_store::keys;
    let kv = RedbKv::open_path(&brain.join("records.redb")).unwrap();
    let mut tx = kv.begin_write().unwrap();
    let mut format: serde_json::Value =
        serde_json::from_slice(&tx.get(&keys::meta("format")).unwrap().unwrap()).unwrap();
    format["format_version"] = version.into();
    tx.put(&keys::meta("format"), &serde_json::to_vec(&format).unwrap())
        .unwrap();
    tx.commit().unwrap();
    let path = brain.join("FORMAT");
    let mut file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    file["format_version"] = version.into();
    std::fs::write(&path, serde_json::to_vec_pretty(&file).unwrap()).unwrap();
}

#[test]
fn a_format_4_brain_upgrades_to_format_5_and_keeps_its_takes_and_its_keyword_index() {
    use gbrain_store::cli_reads::import::RowTrustLookup;
    use gbrain_store::pages::{PageInput, PutPageOptions};
    use gbrain_store::takes::{ListTakesOptions, TakeInput};
    let dir = TempDir::new("format-4-upgrade");
    let brain = dir.path().join("brain");
    let take = |store: &Store, page_id: u64, row: i32, claim: &str| {
        let rows: Vec<TakeInput> = serde_json::from_value(serde_json::json!([{
            "page_id": page_id, "row_num": row, "claim": claim, "kind": "take", "holder": "h",
            "weight": 0.5, "active": true,
        }]))
        .unwrap();
        store.add_takes_batch(&rows).unwrap();
    };
    let (answers, ids) = {
        let store = open_without_builder(&dir);
        let page: PageInput = serde_json::from_value(serde_json::json!({
            "type": "note", "title": "Apple", "compiled_truth": "apple body with pear words",
        }))
        .unwrap();
        let page = store
            .put_page("notes/apple", &page, &PutPageOptions::default())
            .unwrap();
        let page_id = page["id"].as_u64().unwrap();
        // An undeclared take is stored with no trust field, byte for byte as format 4 stored it.
        take(&store, page_id, 1, "plain");
        let names = ["gbrain.write_trust_tier", "gbrain.write_trust_promotion"].map(String::from);
        let tier = ["operator_curated", "operator_curated"].map(String::from);
        store.apply_write_trust(&names, &tier).unwrap();
        take(&store, page_id, 2, "curated");
        store.clear_write_trust();
        let options: ListTakesOptions =
            serde_json::from_value(serde_json::json!({ "page_id": page_id, "limit": 10 })).unwrap();
        let mut rows = store.list_takes(&options).unwrap();
        rows.sort_by_key(|r| r["row_num"].as_i64());
        let ids: Vec<u64> = rows.iter().map(|r| r["id"].as_u64().unwrap()).collect();
        assert!(store.keyword_index_state().unwrap().unwrap().complete);
        let answers = keyword_answers(&store);
        store.close();
        (answers, ids)
    };
    stamp_format(&brain, 4);

    let store = open_without_builder(&dir);
    assert_eq!(store.info().format_version, 5);
    assert_eq!(FORMAT_VERSION, 5, "take trust tiers are store format 5");
    // 4 to 5 rewrites nothing: the keyword index stays complete, with no rebuild to wait for.
    let state = store.keyword_index_state().unwrap().unwrap();
    assert!(state.complete, "{state:?}");
    assert_eq!(keyword_answers(&store), answers);
    // The take stored with no tier reads `unknown`; the stamped take keeps its tier.
    let tiers: Vec<String> = store
        .read_row_trust_rows(&RowTrustLookup {
            table: "takes".into(),
            ids: ids.clone(),
        })
        .unwrap()
        .into_iter()
        .map(|r| r.trust_tier)
        .collect();
    assert_eq!(tiers, ["unknown", "operator_curated"]);
    store.close();
    let file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(brain.join("FORMAT")).unwrap()).unwrap();
    assert_eq!(file["format_version"], 5);
}
