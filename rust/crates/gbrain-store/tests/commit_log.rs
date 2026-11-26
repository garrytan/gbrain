//! Commit positions, the commit log and write origin (multi-user mode, `commit_log.rs`).
//!
//! Every case runs on the single-writer store and on the optimistic store. A test-only follower
//! copies the brain at a log position and then learns every change only from `read_commit_log`;
//! it must hold exactly the leader's data (every key but the log's own) after every commit, after a
//! concurrent run, across a restart and across a base-format upgrade.

mod common;

use common::TempDir;
use gbrain_store::commit_log::{
    self, CommitMeta, CommitPosition, LogOp, LogSettings, WriteOrigin, is_log_key,
};
use gbrain_store::error::{FORMAT_UNKNOWN, WRITE_CONFLICT};
use gbrain_store::journal::{PageMutation, Principal, WriteAdmission};
use gbrain_store::kv::{Kv, KvRead};
use gbrain_store::occ_kv::OccKv;
use gbrain_store::persistence::WriteRequestInsert;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{LOG_FORMAT_VERSION, MultiUserWrites, OpenOptions, Store, SystemEnv, keys};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";
const OTHER_HOST: &str = "e0000000-0000-4000-8000-0000000000e1";
const MODES: [bool; 2] = [false, true];

type Data = BTreeMap<Vec<u8>, Vec<u8>>;

fn records_kv(path: &Path, concurrent: bool) -> Arc<dyn Kv> {
    let base = RedbKv::open_path(path).unwrap();
    if concurrent {
        Arc::new(OccKv::new(base).unwrap())
    } else {
        Arc::new(base)
    }
}

fn mu() -> MultiUserWrites {
    MultiUserWrites {
        commit_log: true,
        write_origin: true,
        host_id: Some(HOST.into()),
        log_retention_bytes: None,
    }
}

/// Multi-user mode is on exactly when a sub-switch is: the "off" cases open with the mode off too.
fn options(concurrent: bool, writes: MultiUserWrites) -> OpenOptions {
    OpenOptions {
        concurrent_writes: concurrent,
        keyword_index_builder: false,
        multiuser: writes.commit_log || writes.write_origin,
        multiuser_writes: writes,
        ..OpenOptions::default()
    }
}

/// A brain over a record file the test keeps its own handle on, so it can read raw keys.
fn leader(path: &Path, concurrent: bool, multiuser: MultiUserWrites) -> (Arc<dyn Kv>, Store) {
    let kv = records_kv(path, concurrent);
    let store = Store::open_kv(
        kv.clone(),
        Arc::new(SystemEnv),
        options(concurrent, multiuser),
    )
    .unwrap();
    (kv, store)
}

/// Every key the store holds but the commit log's own, from one snapshot.
fn data_of(read: &dyn KvRead) -> Data {
    let mut out = Data::new();
    read.scan(&[1], &[0xFF; 64], false, &mut |k, v| {
        if !is_log_key(k) {
            out.insert(k.to_vec(), v.to_vec());
        }
        true
    })
    .unwrap();
    out
}

fn data(kv: &dyn Kv) -> Data {
    data_of(&*kv.snapshot().unwrap())
}

/// The test follower: a second record file that starts as a copy of the leader at a log position
/// and then applies the leader's commit records in order, one redb commit per record.
struct Follower {
    kv: RedbKv,
    cursor: CommitPosition,
    applied: usize,
}

impl Follower {
    fn copy_of(leader: &dyn Kv, path: &Path) -> Self {
        let snapshot = leader.snapshot().unwrap();
        let meta = commit_log::read_meta(&*snapshot)
            .unwrap()
            .expect("a log brain");
        let kv = RedbKv::open_path(path).unwrap();
        let mut tx = kv.begin_write().unwrap();
        for (k, v) in data_of(&*snapshot) {
            tx.put(&k, &v).unwrap();
        }
        tx.commit().unwrap();
        Self {
            kv,
            cursor: meta.newest,
            applied: 0,
        }
    }

    fn catch_up(&mut self, leader: &Store) {
        loop {
            let page = leader.read_commit_log(Some(self.cursor), 7).unwrap();
            assert!(!page.snapshot_required, "the follower fell behind the log");
            if page.records.is_empty() {
                assert_eq!(page.newest, Some(self.cursor));
                return;
            }
            for record in page.records {
                assert!(record.position.follows(self.cursor), "a gap in the log");
                let mut tx = self.kv.begin_write().unwrap();
                commit_log::apply_record(&mut *tx, &record).unwrap();
                tx.commit().unwrap();
                self.cursor = record.position;
                self.applied += 1;
            }
        }
    }

    fn data(&self) -> Data {
        data(&self.kv)
    }
}

fn principal() -> Principal {
    Principal {
        kind: "local_cli".into(),
        id: "writer-1".into(),
    }
}

fn mutation(request: &str, slug: &str, body: &str) -> PageMutation {
    serde_json::from_value(json!({
        "principal": {"kind": "local_cli", "id": "writer-1"},
        "requestId": request,
        "slug": slug,
        "page": {"type": "note", "title": slug, "compiled_truth": body},
        "options": {},
    }))
    .unwrap()
}

fn admission(request: &str, slug: &str, origin: Option<Value>) -> WriteAdmission {
    let mut a = json!({
        "principal": {"kind": "local_cli", "id": "writer-1"},
        "operation": "put_page",
        "requestId": request,
        "slug": slug,
        "callerIntent": {"slug": slug},
    });
    if let Some(origin) = origin {
        a["origin"] = origin;
    }
    serde_json::from_value(a).unwrap()
}

fn uuid(n: u64) -> String {
    format!("a0000000-0000-4000-8000-{n:012x}")
}

/// A small deterministic generator (the workloads are seeded, not random per run).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// One seeded step: config puts of small and large values (the same few keys again and again),
/// config deletes, page mutations and plain admissions.
fn step(store: &Store, rng: &mut Rng, n: u64) {
    let key = format!("test.k{}", rng.below(4));
    match rng.below(5) {
        0 | 1 => {
            let size = if rng.below(4) == 0 { 300_000 } else { 40 };
            let value: String =
                std::iter::repeat_n(char::from(b'a' + (n % 26) as u8), size).collect();
            store.set_config(&key, &value).unwrap();
        }
        2 => {
            store.unset_config(&key).unwrap();
        }
        3 => {
            store
                .submit_page_mutation(
                    &mutation(
                        &uuid(n),
                        &format!("notes/p{}", rng.below(6)),
                        &format!("body {n}"),
                    ),
                    None,
                )
                .unwrap();
        }
        _ => {
            store
                .admit_write(&admission(&uuid(n), &format!("notes/a{n}"), None), None)
                .unwrap();
        }
    }
}

#[test]
fn a_follower_that_reads_only_the_log_matches_the_leader_after_every_commit() {
    for concurrent in MODES {
        let dir = TempDir::new("log-follow");
        let (kv, store) = leader(&dir.path().join("leader.redb"), concurrent, mu());
        assert!(store.info().commit_log);
        assert_eq!(store.info().format_version, LOG_FORMAT_VERSION);
        let mut follower = Follower::copy_of(&*kv, &dir.path().join("follower.redb"));
        let mut rng = Rng(0x5EED + concurrent as u64);
        for n in 0..120 {
            step(&store, &mut rng, n);
            follower.catch_up(&store);
            assert_eq!(
                follower.data(),
                data(&*kv),
                "step {n} (concurrent {concurrent})"
            );
        }
        // A step that changes nothing (an unset of an absent key) commits nothing on the optimistic
        // store, so it has no record there.
        assert!(follower.applied >= 90, "{}", follower.applied);
        // Restart: the leader reopens with the log, the follower goes on from its cursor.
        drop(store);
        drop(kv);
        let (kv, store) = leader(&dir.path().join("leader.redb"), concurrent, mu());
        for n in 120..160 {
            step(&store, &mut rng, n);
        }
        follower.catch_up(&store);
        assert_eq!(
            follower.data(),
            data(&*kv),
            "after the restart (concurrent {concurrent})"
        );
    }
}

#[test]
fn every_record_carries_the_open_origin_and_the_requests_it_wrote() {
    for concurrent in MODES {
        let dir = TempDir::new("log-origin");
        let path = dir.path().join("leader.redb");
        let (kv, store) = leader(&path, concurrent, mu());
        let since = store.commit_log_since().unwrap();
        store
            .submit_page_mutation(&mutation(&uuid(1), "notes/one", "one"), None)
            .unwrap();
        let page = store.read_commit_log(None, 100).unwrap();
        let last = page.records.last().unwrap();
        assert!(last.position > since);
        assert_eq!(last.origin.host_id, HOST);
        assert_eq!(last.origin.writer_id, "local_cli:writer-1");
        assert_eq!(last.write_ids, vec![uuid(1)]);
        let first = last.origin.incarnation.clone();
        assert_eq!(&first[14..15], "7", "a UUID v7: {first}");
        drop(store);
        drop(kv);
        // A new open is a new engine run.
        let (_kv, store) = leader(&path, concurrent, mu());
        store.set_config("test.x", "1").unwrap();
        let page = store.read_commit_log(None, 1000).unwrap();
        let last = page.records.last().unwrap();
        assert_ne!(last.origin.incarnation, first);
        assert_eq!(last.origin.host_id, HOST);
        // A write with no principal names none.
        assert_eq!(last.origin.writer_id, "");
        assert!(last.write_ids.is_empty());
        // The write alone: the clock floor is the commit time (`M\0ctime`), which every commit carries in its record
        // (I-4.v2), so no separate floor key rides in the ops (I-4.v2.1).
        assert_eq!(last.ops.len(), 1, "{:?}", last.ops);
        assert_eq!(
            last.ops[0],
            (
                keys::text(keys::CONFIG, &["test.x"]),
                LogOp::Put(b"1".to_vec())
            )
        );
    }
}

/// The raw request record the journal stored for `request_id`.
fn raw_request(kv: &dyn Kv, request_id: &str) -> Value {
    let snapshot = kv.snapshot().unwrap();
    let mut found = None;
    snapshot
        .scan(&keys::request(""), &[0xFF; 64], false, &mut |k, v| {
            if !k.starts_with(&keys::request("")) {
                return false;
            }
            let record: Value = serde_json::from_slice(v).unwrap();
            if record["request_id"] == request_id {
                found = Some(record);
                return false;
            }
            true
        })
        .unwrap();
    found.unwrap_or_else(|| panic!("no request record for {request_id}"))
}

fn insert_input(store: &Store, request: &str, host: Option<&str>) -> WriteRequestInsert {
    let incarnation = store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    serde_json::from_value(json!({
        "principalKind": "local_cli",
        "principalId": "parity-writer",
        "requestId": request,
        "operation": "put_page",
        "sourceId": "default",
        "sourceIncarnation": incarnation,
        "pageId": null,
        "slug": format!("notes/{request}"),
        "worktreeId": null,
        "topologyGeneration": null,
        "digest": "digest",
        "intent": {},
        "authority": {},
        "intentBytes": 10,
        "terminalReservation": 4096,
        "targetKind": "page",
        "protocolVersion": 1,
        "admitterVersion": "v-test",
        "admitterHostId": host,
        "counterKeys": ["principal:local_cli:parity-writer", "brain"],
        "clientRequestId": null,
        "state": "queued",
        "deferredRefreshId": null,
    }))
    .unwrap()
}

#[test]
fn journal_rows_carry_the_write_origin_only_with_the_switch_on() {
    for concurrent in MODES {
        let dir = TempDir::new("journal-origin");
        let (kv, store) = leader(&dir.path().join("on.redb"), concurrent, mu());
        // Native admission, page mutation, an override and the compatibility path (one row and
        // a group), each stamped.
        store
            .admit_write(&admission(&uuid(1), "notes/a", None), None)
            .unwrap();
        store
            .submit_page_mutation(&mutation(&uuid(2), "notes/b", "b"), None)
            .unwrap();
        store
            .admit_write(
                &admission(
                    &uuid(3),
                    "notes/c",
                    Some(json!({"hostId": OTHER_HOST, "incarnation": "client-run"})),
                ),
                None,
            )
            .unwrap();
        store
            .insert_write_request(&insert_input(&store, &uuid(4), None))
            .unwrap();
        store
            .insert_write_request_group(&[
                insert_input(&store, &uuid(5), Some(OTHER_HOST)),
                insert_input(&store, &uuid(6), None),
            ])
            .unwrap();
        for (n, host, writer) in [
            (1, HOST, "local_cli:writer-1"),
            (2, HOST, "local_cli:writer-1"),
            (3, OTHER_HOST, "local_cli:writer-1"),
            (4, HOST, "local_cli:parity-writer"),
            (5, OTHER_HOST, "local_cli:parity-writer"),
            (6, HOST, "local_cli:parity-writer"),
        ] {
            let record = raw_request(&*kv, &uuid(n));
            assert_eq!(record["admitter_host_id"], host, "request {n}");
            assert_eq!(record["writer_id"], writer, "request {n}");
            let run = record["admitter_incarnation"].as_str().unwrap();
            if n == 3 {
                assert_eq!(run, "client-run");
            } else {
                assert_eq!(&run[14..15], "7", "request {n}: {run}");
            }
        }
        // The row the members return shows the host id in its existing column.
        let row = store
            .get_write_request(&principal(), &uuid(1))
            .unwrap()
            .unwrap();
        assert_eq!(row["admitter_host_id"], HOST);

        // Off: nothing is stamped; the native row's extra stays empty and an origin field sent
        // by a caller is ignored.
        let (kv_off, off) = leader(
            &dir.path().join("off.redb"),
            concurrent,
            MultiUserWrites::default(),
        );
        assert!(!off.info().commit_log);
        off.admit_write(
            &admission(&uuid(1), "notes/a", Some(json!({"hostId": OTHER_HOST}))),
            None,
        )
        .unwrap();
        off.insert_write_request(&insert_input(&off, &uuid(4), None))
            .unwrap();
        let native = raw_request(&*kv_off, &uuid(1));
        for field in ["admitter_host_id", "admitter_incarnation", "writer_id"] {
            assert!(native.get(field).is_none(), "{field}: {native}");
        }
        let compat = raw_request(&*kv_off, &uuid(4));
        assert_eq!(compat["admitter_host_id"], Value::Null);
        assert!(compat.get("admitter_incarnation").is_none());
        assert!(compat.get("writer_id").is_none());
        let row = off
            .get_write_request(&principal(), &uuid(1))
            .unwrap()
            .unwrap();
        assert_eq!(row["admitter_host_id"], Value::Null);
        assert!(off.read_commit_log(None, 1).is_err());
        assert!(data(&*kv_off).keys().all(|k| !is_log_key(k)));
        let mut log_keys = 0;
        kv_off
            .snapshot()
            .unwrap()
            .scan(b"2", b"3", false, &mut |_, _| {
                log_keys += 1;
                true
            })
            .unwrap();
        assert_eq!(
            log_keys, 0,
            "a brain opened with the switch off holds no log key"
        );
    }
}

#[test]
fn multi_user_writes_without_a_host_id_are_refused_before_any_write() {
    for writes in [
        MultiUserWrites {
            host_id: None,
            ..mu()
        },
        MultiUserWrites {
            host_id: None,
            write_origin: false,
            ..mu()
        },
        MultiUserWrites {
            host_id: None,
            commit_log: false,
            ..mu()
        },
    ] {
        let dir = TempDir::new("origin-host");
        let kv = records_kv(&dir.path().join("r.redb"), false);
        let err = Store::open_kv(kv.clone(), Arc::new(SystemEnv), options(false, writes))
            .err()
            .unwrap();
        assert_eq!(err.code, gbrain_store::error::INVALID_ARGUMENT);
        assert_eq!(err.message, gbrain_store::HOST_ID_REQUIRED);
        assert_eq!(kv.version().unwrap(), 0, "the refused open wrote nothing");
    }
    // With the mode off, the same request is not refused and stamps nothing.
    let dir = TempDir::new("origin-host-off");
    let kv = records_kv(&dir.path().join("r.redb"), false);
    let store = Store::open_kv(
        kv.clone(),
        Arc::new(SystemEnv),
        OpenOptions {
            keyword_index_builder: false,
            multiuser_writes: MultiUserWrites {
                host_id: None,
                ..mu()
            },
            ..OpenOptions::default()
        },
    )
    .unwrap();
    store
        .admit_write(&admission(&uuid(1), "notes/a", None), None)
        .unwrap();
    assert!(raw_request(&*kv, &uuid(1)).get("writer_id").is_none());
}

#[test]
fn a_reused_adapter_opened_again_with_the_mode_off_writes_no_commit_time() {
    for concurrent in MODES {
        let dir = TempDir::new("reuse-off");
        let kv = records_kv(&dir.path().join("r.redb"), concurrent);
        let on = Store::open_kv(
            kv.clone(),
            Arc::new(SystemEnv),
            OpenOptions {
                concurrent_writes: concurrent,
                keyword_index_builder: false,
                multiuser: true,
                ..OpenOptions::default()
            },
        )
        .unwrap();
        on.set_config("test.a", "1").unwrap();
        let time = on.last_commit_time().unwrap();
        assert!(time.is_some());
        drop(on);
        let off = Store::open_kv(
            kv.clone(),
            Arc::new(SystemEnv),
            options(concurrent, MultiUserWrites::default()),
        )
        .unwrap();
        assert!(!off.multiuser());
        off.set_config("test.a", "2").unwrap();
        assert_eq!(
            off.last_commit_time().unwrap(),
            time,
            "concurrent {concurrent}: the off open moved the time"
        );
    }
}

#[test]
fn a_config_only_log_brain_that_needs_recovery_reopens_with_the_log() {
    let dir = TempDir::new("config-recover");
    let brain = dir.path().join("brain");
    // Multi-user mode on through the brain's own row only; the log asked for by the sub-switch.
    let opts = || OpenOptions {
        keyword_index_builder: false,
        multiuser: false,
        multiuser_writes: mu(),
        ..OpenOptions::default()
    };
    {
        let store = Store::open_dir(&brain, mu_only(false)).unwrap();
        store
            .set_config(gbrain_store::MULTIUSER_CONFIG_KEY, "true")
            .unwrap();
    }
    {
        let store = Store::open_dir(&brain, opts()).unwrap();
        assert!(store.multiuser() && store.info().commit_log);
        store.set_config("test.a", "1").unwrap();
        // An unclean stop: the handle goes away without closing the record file.
        std::mem::forget(store);
    }
    // In this process the forgotten handle still holds redb's lock; copy the files as a crash leaves them.
    let crashed = dir.path().join("crashed");
    std::fs::create_dir_all(&crashed).unwrap();
    for entry in std::fs::read_dir(&brain).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), crashed.join(entry.file_name())).unwrap();
    }
    assert!(
        gbrain_store::redb_kv::peek(&crashed.join("records.redb"), &keys::meta("format")).is_none(),
        "the copy must need recovery for this case"
    );
    let store = Store::open_dir(&crashed, opts()).unwrap();
    assert!(
        store.multiuser() && store.info().commit_log,
        "the recovered brain resolves its row and keeps its log"
    );
    assert_eq!(store.get_config("test.a").unwrap().as_deref(), Some("1"));
    store.set_config("test.b", "2").unwrap();
    let page = store.read_commit_log(None, usize::MAX).unwrap();
    assert!(!page.snapshot_required);
    drop(store);
    // Without the sub-switch it is refused as any log brain is.
    let err = Store::open_dir(
        &crashed,
        OpenOptions {
            keyword_index_builder: false,
            ..OpenOptions::default()
        },
    )
    .err()
    .unwrap();
    assert_eq!(err.code, FORMAT_UNKNOWN);
}

/// A raw store with the log activated before its first write (the activation commit holds only
/// the meta record, outside the data).
fn raw_logged(kv: &dyn Kv, retention: u64) -> CommitPosition {
    kv.set_commit_clock(Arc::new(SystemEnv), None).unwrap();
    let mut tx = kv.begin_write().unwrap();
    let since = CommitPosition::new(kv.version().unwrap() + 1, 0);
    commit_log::write_activation(&mut *tx, since).unwrap();
    assert_eq!(tx.commit_position().unwrap(), since);
    kv.enable_commit_log(LogSettings {
        retention_bytes: retention,
        default_origin: WriteOrigin {
            host_id: HOST.into(),
            incarnation: "run".into(),
            writer_id: String::new(),
        },
    })
    .unwrap();
    since
}

fn replay_from_empty(kv: &dyn Kv) -> Data {
    let read = kv.snapshot().unwrap();
    let page = commit_log::read_commit_log(&*read, None, usize::MAX).unwrap();
    assert!(!page.snapshot_required);
    let dir = TempDir::new("replay");
    let model = RedbKv::open_path(&dir.path().join("m.redb")).unwrap();
    for record in &page.records {
        let mut tx = model.begin_write().unwrap();
        commit_log::apply_record(&mut *tx, record).unwrap();
        tx.commit().unwrap();
    }
    data(&model)
}

#[test]
fn a_forced_group_commit_gives_each_transaction_its_own_position_and_record() {
    let dir = TempDir::new("forced-batch");
    let kv = Arc::new(OccKv::new(RedbKv::open_path(&dir.path().join("r.redb")).unwrap()).unwrap());
    raw_logged(&*kv, commit_log::DEFAULT_RETENTION_BYTES);
    let mut seed = kv.begin_write().unwrap();
    seed.put(b"a", b"0").unwrap();
    seed.put(b"b", b"0").unwrap();
    let seeded = seed.commit_position().unwrap();
    assert_eq!(seeded.index, 0);
    // Hold the pipeline, queue three commits, then let them go as one group commit. T1 reads b
    // and writes a; T2 reads a and writes b (write skew: whichever comes second loses); T3 reads
    // nothing and adds to a counter and raises an id sequence.
    let exclusive = kv.begin_write_exclusive().unwrap();
    let spawn = |reads: &'static [u8], write: &'static [u8], value: &'static [u8], meta: &str| {
        let kv = kv.clone();
        let mut tx = kv.begin_write().unwrap();
        tx.get(reads).unwrap();
        tx.put(write, value).unwrap();
        tx.put(write, value).unwrap();
        tx.set_commit_meta(CommitMeta {
            origin: None,
            write_ids: vec![meta.to_string()],
        });
        std::thread::spawn(move || tx.commit_position())
    };
    let t1 = spawn(b"b", b"a", b"t1", "w1");
    std::thread::sleep(std::time::Duration::from_millis(50));
    let t2 = spawn(b"a", b"b", b"t2", "w2");
    std::thread::sleep(std::time::Duration::from_millis(50));
    let t3 = {
        let mut tx = kv.begin_write().unwrap();
        tx.add_i64(b"n", 5).unwrap();
        tx.raise_counter(b"seq", 40).unwrap();
        tx.put(b"big", &vec![7u8; 200_000]).unwrap();
        std::thread::spawn(move || tx.commit_position())
    };
    std::thread::sleep(std::time::Duration::from_millis(100));
    drop(exclusive);
    let outcomes = [t1.join().unwrap(), t2.join().unwrap(), t3.join().unwrap()];
    let accepted: Vec<CommitPosition> = outcomes
        .iter()
        .filter_map(|o| o.as_ref().ok().copied())
        .collect();
    let refused: Vec<_> = outcomes.iter().filter_map(|o| o.as_ref().err()).collect();
    assert_eq!(refused.len(), 1, "{outcomes:?}");
    assert_eq!(refused[0].code, WRITE_CONFLICT);
    assert_eq!(accepted.len(), 2);
    let batch = seeded.sequence + 1;
    let mut sorted = accepted.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        vec![CommitPosition::new(batch, 0), CommitPosition::new(batch, 1)]
    );
    // A completion that commits nothing reports the end of the batch it saw.
    let empty = kv.begin_write().unwrap();
    assert_eq!(
        empty.commit_position().unwrap(),
        CommitPosition::end_of(batch)
    );
    let empty = kv.begin_write().unwrap();
    assert_eq!(empty.commit().unwrap(), batch);
    // The log holds exactly the two accepted transactions, at their positions, with their ops.
    let page = commit_log::read_commit_log(&*kv.snapshot().unwrap(), Some(seeded), 10).unwrap();
    assert_eq!(page.records.len(), 2);
    assert_eq!(page.newest, Some(CommitPosition::new(batch, 1)));
    let t3_record = page
        .records
        .iter()
        .find(|r| r.ops.iter().any(|(k, _)| k == b"n"))
        .unwrap();
    assert_eq!(
        t3_record.ops,
        vec![
            (b"big".to_vec(), LogOp::Put(vec![7u8; 200_000])),
            (b"n".to_vec(), LogOp::AddI64(5)),
            (b"seq".to_vec(), LogOp::RaiseCounter(40)),
        ]
    );
    assert_eq!(t3_record.origin.incarnation, "run");
    let other = page
        .records
        .iter()
        .find(|r| r.position != t3_record.position)
        .unwrap();
    assert_eq!(other.ops.len(), 1);
    assert!(other.write_ids == ["w1"] || other.write_ids == ["w2"]);
    assert_eq!(replay_from_empty(&*kv), data(&*kv));
}

#[test]
fn positions_are_unique_increasing_and_gap_free_on_both_stores() {
    for concurrent in MODES {
        let dir = TempDir::new("dense");
        let kv = records_kv(&dir.path().join("r.redb"), concurrent);
        let since = raw_logged(&*kv, commit_log::DEFAULT_RETENTION_BYTES);
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let kv = kv.clone();
                std::thread::spawn(move || {
                    let mut seen = Vec::new();
                    for i in 0..40u32 {
                        loop {
                            let mut tx = kv.begin_write().unwrap();
                            let key = format!("k{}", (t * 7 + i) % 5);
                            let old = tx.get(key.as_bytes()).unwrap().unwrap_or_default();
                            let mut value = old;
                            value.extend_from_slice(&vec![t as u8; 1000]);
                            value.truncate(150_000);
                            tx.put(key.as_bytes(), &value).unwrap();
                            if i % 9 == 0 {
                                tx.delete(format!("d{t}").as_bytes()).unwrap();
                            } else {
                                tx.put(format!("d{t}").as_bytes(), b"x").unwrap();
                            }
                            tx.add_i64(b"n", 1).unwrap();
                            match tx.commit_position() {
                                Ok(p) => {
                                    seen.push(p);
                                    break;
                                }
                                Err(e) if e.code == WRITE_CONFLICT => continue,
                                Err(e) => panic!("{e:?}"),
                            }
                        }
                    }
                    seen
                })
            })
            .collect();
        let mut all: Vec<CommitPosition> = threads
            .into_iter()
            .flat_map(|t| t.join().unwrap())
            .collect();
        all.sort();
        let before = all.len();
        all.dedup();
        assert_eq!(all.len(), before, "two commits shared a position");
        assert_eq!(all.len(), 320);
        let page = commit_log::read_commit_log(&*kv.snapshot().unwrap(), None, usize::MAX).unwrap();
        let logged: Vec<CommitPosition> = page.records.iter().map(|r| r.position).collect();
        assert_eq!(
            logged, all,
            "the log holds exactly the acknowledged commits, in order"
        );
        let mut prev = since;
        for p in &logged {
            assert!(p.follows(prev), "{} after {}", p.token(), prev.token());
            prev = *p;
        }
        if !concurrent {
            assert!(logged.iter().all(|p| p.index == 0));
        }
        assert_eq!(
            replay_from_empty(&*kv),
            data(&*kv),
            "concurrent {concurrent}"
        );
        let n = gbrain_store::kv::read_i64(&*kv.snapshot().unwrap(), b"n").unwrap();
        assert_eq!(n, 320);
    }
}

#[test]
fn retention_trims_to_the_cap_and_keeps_where_the_log_stands() {
    for concurrent in MODES {
        let dir = TempDir::new("retention");
        let path = dir.path().join("r.redb");
        let cap = 4_000;
        let (since, positions) = {
            let kv = records_kv(&path, concurrent);
            let since = raw_logged(&*kv, cap);
            let mut positions = Vec::new();
            for i in 0..20u8 {
                let mut tx = kv.begin_write().unwrap();
                tx.put(&[b'k', i], &[i; 300]).unwrap();
                positions.push(tx.commit_position().unwrap());
            }
            let read = kv.snapshot().unwrap();
            let meta = commit_log::read_meta(&*read).unwrap().unwrap();
            let page = commit_log::read_commit_log(&*read, None, usize::MAX).unwrap();
            assert!(page.snapshot_required, "the start of the log was trimmed");
            let oldest = page.oldest_retained.unwrap();
            assert!(oldest > positions[0]);
            assert_eq!(
                Some(oldest),
                positions
                    .iter()
                    .copied()
                    .find(|p| p.follows(meta.trimmed_through.unwrap()))
            );
            let mut bytes = 0;
            read.scan(
                &commit_log::record_key(CommitPosition::default()),
                b"3",
                false,
                &mut |k, v| {
                    bytes += k.len() + v.len();
                    true
                },
            )
            .unwrap();
            assert!(bytes <= cap as usize, "{bytes}");
            // One transaction over the cap: every record goes, the meta record still says where
            // the log stands.
            let mut tx = kv.begin_write().unwrap();
            tx.put(b"huge", &[1u8; 10_000]).unwrap();
            positions.push(tx.commit_position().unwrap());
            (since, positions)
        };
        // Reopen: the state comes back from the records and the meta record alone.
        let kv = records_kv(&path, concurrent);
        kv.set_commit_clock(Arc::new(SystemEnv), None).unwrap();
        kv.enable_commit_log(LogSettings {
            retention_bytes: cap,
            ..LogSettings::default()
        })
        .unwrap();
        let read = kv.snapshot().unwrap();
        let last = *positions.last().unwrap();
        let meta = commit_log::read_meta(&*read).unwrap().unwrap();
        assert_eq!(meta.since, since);
        assert_eq!(meta.newest, last);
        assert_eq!(meta.trimmed_through, Some(last));
        let at =
            |after: Option<CommitPosition>| commit_log::read_commit_log(&*read, after, 10).unwrap();
        assert!(at(None).snapshot_required);
        assert!(at(Some(positions[positions.len() - 2])).snapshot_required);
        let current = at(Some(last));
        assert!(!current.snapshot_required);
        assert!(current.records.is_empty());
        assert_eq!(current.oldest_retained, None);
        assert_eq!(current.newest, Some(last));
        assert!(at(Some(CommitPosition::new(last.sequence + 1, 0))).snapshot_required);
        assert!(at(Some(CommitPosition::new(0, 0))).snapshot_required);
        drop(read);
        // The next commit is logged after the trimmed point and reads on from it.
        let mut tx = kv.begin_write().unwrap();
        tx.put(b"after", b"1").unwrap();
        let next = tx.commit_position().unwrap();
        let page = commit_log::read_commit_log(&*kv.snapshot().unwrap(), Some(last), 10).unwrap();
        assert_eq!(
            page.records.iter().map(|r| r.position).collect::<Vec<_>>(),
            vec![next]
        );
    }
}

#[test]
fn explicit_transactions_log_their_statements_and_rollbacks_log_only_counters() {
    for concurrent in MODES {
        let dir = TempDir::new("log-txn");
        let (kv, store) = leader(&dir.path().join("r.redb"), concurrent, mu());
        let mut follower = Follower::copy_of(&*kv, &dir.path().join("f.redb"));
        // Commit: two statements, one savepoint rolled back with its request.
        let tx = store.begin_transaction(false).unwrap();
        tx.admit_write(&admission(&uuid(1), "notes/kept", None), None)
            .unwrap();
        let sp = tx.savepoint().unwrap();
        tx.admit_write(&admission(&uuid(2), "notes/dropped", None), None)
            .unwrap();
        tx.rollback_savepoint(sp).unwrap();
        tx.set_config("test.t", "v").unwrap();
        let at = tx.commit_transaction_at().unwrap();
        drop(tx);
        let page = store.read_commit_log(None, 1000).unwrap();
        let last = page.records.last().unwrap();
        assert_eq!(last.position, at);
        assert_eq!(last.write_ids, vec![uuid(1)]);
        assert_eq!(last.origin.writer_id, "local_cli:writer-1");
        follower.catch_up(&store);
        assert_eq!(follower.data(), data(&*kv));
        // Rollback after an admission (it took counters): the rollback commit writes them
        // forward, names no request and is logged.
        let tx = store.begin_transaction(false).unwrap();
        tx.submit_page_mutation(&mutation(&uuid(3), "notes/rolled", "x"), None)
            .unwrap();
        tx.rollback_transaction().unwrap();
        drop(tx);
        let page = store.read_commit_log(Some(at), 1000).unwrap();
        for record in &page.records {
            assert!(record.write_ids.is_empty(), "{record:?}");
        }
        follower.catch_up(&store);
        assert_eq!(follower.data(), data(&*kv));
        // A transaction opened read-only commits nothing: it reports the end of what it saw.
        let version = store.commit_version().unwrap();
        let tx = store.begin_transaction(true).unwrap();
        assert_eq!(
            tx.commit_transaction_at().unwrap(),
            CommitPosition::end_of(version)
        );
        drop(tx);
        // A dropped handle rolls back like a rollback.
        {
            let tx = store.begin_transaction(false).unwrap();
            tx.submit_page_mutation(&mutation(&uuid(4), "notes/dropped-handle", "x"), None)
                .unwrap();
        }
        follower.catch_up(&store);
        assert_eq!(follower.data(), data(&*kv));
    }
}

fn sorted_keys(v: &Value) -> Vec<String> {
    let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

/// Every file of a brain directory, byte for byte.
fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (
                e.file_name().to_string_lossy().into_owned(),
                std::fs::read(e.path()).unwrap(),
            )
        })
        .collect()
}

#[test]
fn a_log_brain_is_refused_for_writing_without_the_log_and_read_without_it() {
    for concurrent in MODES {
        let dir = TempDir::new("log-refuse");
        let brain = dir.path().join("brain");
        let store = Store::open_dir(&brain, options(concurrent, mu())).unwrap();
        store.set_config("test.a", "1").unwrap();
        let since = store.commit_log_since().unwrap();
        drop(store);
        let format: Value =
            serde_json::from_slice(&std::fs::read(brain.join("FORMAT")).unwrap()).unwrap();
        assert_eq!(format["format_version"], LOG_FORMAT_VERSION);
        assert_eq!(
            format["log"]["since"],
            json!({"sequence": since.sequence, "index": since.index})
        );
        let before = files(&brain);
        let err = Store::open_dir(&brain, options(concurrent, MultiUserWrites::default()))
            .err()
            .unwrap();
        assert_eq!(err.code, FORMAT_UNKNOWN);
        assert!(
            err.message.contains("GBRAIN_RUST_MULTIUSER=1"),
            "{}",
            err.message
        );
        assert_eq!(files(&brain), before, "the refused open changed a file");
        // Without FORMAT the format record refuses it, still before any record is written.
        std::fs::remove_file(brain.join("FORMAT")).unwrap();
        let before = files(&brain);
        let err = Store::open_dir(&brain, options(concurrent, MultiUserWrites::default()))
            .err()
            .unwrap();
        assert_eq!(err.code, FORMAT_UNKNOWN);
        assert_eq!(
            files(&brain),
            before,
            "the refused open changed a file without FORMAT"
        );
        // A read-only open reads it.
        let store = Store::open_dir(&brain, options(concurrent, mu())).unwrap();
        drop(store);
        let read = Store::open_dir_read_only(&brain).unwrap();
        assert_eq!(read.get_config("test.a").unwrap().as_deref(), Some("1"));
        assert!(!read.info().commit_log);
        drop(read);
        // With the log the brain opens and keeps its log from where it started.
        let store = Store::open_dir(&brain, options(concurrent, mu())).unwrap();
        assert_eq!(store.commit_log_since(), Some(since));
        assert_eq!(store.get_config("test.a").unwrap().as_deref(), Some("1"));
    }
}

#[test]
fn an_interrupted_switch_to_the_log_is_finished_with_the_log_and_refused_without_it() {
    let dir = TempDir::new("log-interrupted");
    let brain = dir.path().join("brain");
    let store = Store::open_dir(&brain, options(false, MultiUserWrites::default())).unwrap();
    store.set_config("test.a", "1").unwrap();
    drop(store);
    // The crash point: FORMAT stamped for the log, the records not yet.
    let mut format: Value =
        serde_json::from_slice(&std::fs::read(brain.join("FORMAT")).unwrap()).unwrap();
    let plain = format.clone();
    format["format_version"] = json!(LOG_FORMAT_VERSION);
    format["log"] = json!({"since": {"sequence": 99, "index": 0}});
    std::fs::write(
        brain.join("FORMAT"),
        serde_json::to_vec_pretty(&format).unwrap(),
    )
    .unwrap();
    let before = files(&brain);
    let err = Store::open_dir(&brain, options(false, MultiUserWrites::default()))
        .err()
        .unwrap();
    assert_eq!(err.code, FORMAT_UNKNOWN);
    assert_eq!(files(&brain), before);
    let store = Store::open_dir(&brain, options(false, mu())).unwrap();
    let since = store.commit_log_since().unwrap();
    assert_eq!(store.info().format_version, LOG_FORMAT_VERSION);
    drop(store);
    let after: Value =
        serde_json::from_slice(&std::fs::read(brain.join("FORMAT")).unwrap()).unwrap();
    assert_eq!(after["log"]["since"]["sequence"], since.sequence);
    assert_eq!(after["brain_id"], plain["brain_id"]);
}

#[test]
fn the_switch_off_leaves_format_and_records_without_any_log_field() {
    let dir = TempDir::new("log-off");
    let brain = dir.path().join("brain");
    let store = Store::open_dir(&brain, options(false, MultiUserWrites::default())).unwrap();
    store.set_config("test.a", "1").unwrap();
    let info = serde_json::to_value(store.info()).unwrap();
    assert_eq!(
        sorted_keys(&info),
        vec!["brain_id", "created", "format_version", "schema_version"],
        "the open result keeps its shape"
    );
    assert_eq!(store.commit_log_since(), None);
    drop(store);
    let format: Value =
        serde_json::from_slice(&std::fs::read(brain.join("FORMAT")).unwrap()).unwrap();
    assert_eq!(format["format_version"], gbrain_store::FORMAT_VERSION);
    assert!(format.get("log").is_none());
    let kv = RedbKv::open_path(&brain.join("records.redb")).unwrap();
    let stored: Value = serde_json::from_slice(
        &kv.snapshot()
            .unwrap()
            .get(&keys::meta("format"))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        sorted_keys(&stored),
        vec!["brain_id", "created_at_us", "format_version"]
    );
    assert!(data(&kv).keys().all(|k| !is_log_key(k)));
}

/// A log brain whose records are still at base format 7, built by hand as an older build with the
/// log would leave it: the shared-skill token secret back at `x 0x04`, the open-time markers gone
/// (so the reopen repeats the access-flag scan, the keyword index reset and the source-index
/// backfill), and the log re-pinned to start after these edits.
fn base_7_log_brain(path: &Path, concurrent: bool) -> Data {
    {
        let (_kv, store) = leader(path, concurrent, mu());
        store.set_config("test.a", "1").unwrap();
        store
            .submit_page_mutation(&mutation(&uuid(1), "notes/one", "one"), None)
            .unwrap();
    }
    let kv = RedbKv::open_path(path).unwrap();
    let mut tx = kv.begin_write().unwrap();
    let secret_new = vec![keys::ACCESS_MEMBERS, 0x0d];
    let secret_old = vec![keys::ACCESS_MEMBERS, 0x04];
    let secret = tx.get(&secret_new).unwrap().expect("a seeded token secret");
    tx.delete(&secret_new).unwrap();
    tx.put(&secret_old, &secret).unwrap();
    tx.delete(&keys::meta("access_flag_scan")).unwrap();
    tx.delete(&keys::meta("derivation_purge_source_index"))
        .unwrap();
    tx.delete(&keys::keyword_index_state()).unwrap();
    let mut format: Value =
        serde_json::from_slice(&tx.get(&keys::meta("format")).unwrap().unwrap()).unwrap();
    format["log"]["base_format"] = json!(7);
    tx.put(&keys::meta("format"), &serde_json::to_vec(&format).unwrap())
        .unwrap();
    let since = CommitPosition::new(kv.version().unwrap() + 1, 0);
    // Re-pin the log after the hand edits (they are the starting copy, not logged changes).
    let mut stale = Vec::new();
    tx.scan(
        &commit_log::record_key(CommitPosition::default()),
        b"3",
        false,
        &mut |k, _| {
            stale.push(k.to_vec());
            true
        },
    )
    .unwrap();
    for k in stale {
        tx.delete(&k).unwrap();
    }
    commit_log::write_activation(&mut *tx, since).unwrap();
    assert_eq!(tx.commit().unwrap(), since.sequence);
    let copy = data(&kv);
    assert!(copy.contains_key(&secret_old));
    copy
}

#[test]
fn a_log_brain_at_an_older_base_upgrades_inside_the_log() {
    for concurrent in MODES {
        let dir = TempDir::new("log-base");
        let path = dir.path().join("r.redb");
        let start = base_7_log_brain(&path, concurrent);
        let (kv, store) = leader(&path, concurrent, mu());
        assert_eq!(store.info().format_version, LOG_FORMAT_VERSION);
        let stored: Value = serde_json::from_slice(
            &kv.snapshot()
                .unwrap()
                .get(&keys::meta("format"))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(stored["format_version"], LOG_FORMAT_VERSION);
        assert_eq!(stored["log"]["base_format"], gbrain_store::FORMAT_VERSION);
        let page = store.read_commit_log(None, usize::MAX).unwrap();
        let changed: Vec<Vec<u8>> = page
            .records
            .iter()
            .flat_map(|r| r.ops.iter().map(|(k, _)| k.clone()))
            .collect();
        for key in [
            vec![keys::ACCESS_MEMBERS, 0x04],
            vec![keys::ACCESS_MEMBERS, 0x0d],
            keys::meta("access_flag_scan"),
            keys::meta("derivation_purge_source_index"),
            keys::keyword_index_state(),
            keys::meta("format"),
        ] {
            assert!(changed.contains(&key), "the reopen did not log {key:?}");
        }
        // Replaying the log onto the starting copy gives the upgraded brain.
        let follower_dir = TempDir::new("log-base-follower");
        let model = RedbKv::open_path(&follower_dir.path().join("m.redb")).unwrap();
        let mut tx = model.begin_write().unwrap();
        for (k, v) in &start {
            tx.put(k, v).unwrap();
        }
        tx.commit().unwrap();
        for record in &page.records {
            let mut tx = model.begin_write().unwrap();
            commit_log::apply_record(&mut *tx, record).unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(data(&model), data(&*kv));
        // A base newer than this build reads is refused.
        drop(store);
        drop(kv);
        let kv = RedbKv::open_path(&path).unwrap();
        let mut tx = kv.begin_write().unwrap();
        let mut format: Value =
            serde_json::from_slice(&tx.get(&keys::meta("format")).unwrap().unwrap()).unwrap();
        format["log"]["base_format"] = json!(gbrain_store::FORMAT_VERSION + 1);
        tx.put(&keys::meta("format"), &serde_json::to_vec(&format).unwrap())
            .unwrap();
        tx.commit().unwrap();
        drop(kv);
        let kv = records_kv(&path, concurrent);
        let err = Store::open_kv(kv, Arc::new(SystemEnv), options(concurrent, mu()))
            .err()
            .unwrap();
        assert_eq!(err.code, FORMAT_UNKNOWN);
    }
}

/// A clock that moves forward by one microsecond at every read, and random ids.
struct Ticking(std::sync::atomic::AtomicI64);

impl gbrain_store::Env for Ticking {
    fn now_micros(&self) -> i64 {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        gbrain_store::env::SystemEnv.new_uuid()
    }
}

#[test]
fn the_accept_hook_sees_every_commit_once_in_commit_order_with_its_time() {
    for concurrent in MODES {
        let dir = TempDir::new("accept-hook");
        let kv = records_kv(&dir.path().join("r.redb"), concurrent);
        let store = Store::open_kv(
            kv.clone(),
            Arc::new(Ticking(std::sync::atomic::AtomicI64::new(1_000))),
            OpenOptions {
                concurrent_writes: concurrent,
                keyword_index_builder: false,
                multiuser: true,
                ..OpenOptions::default()
            },
        )
        .unwrap();
        let seen: Arc<std::sync::Mutex<Vec<commit_log::Accepted>>> = Arc::default();
        let sink = seen.clone();
        store
            .set_accept_hook(Arc::new(move |a| sink.lock().unwrap().push(a)))
            .unwrap();
        let store = Arc::new(store);
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        store
                            .set_config(&format!("test.k{}", (t + i) % 3), &format!("{t}-{i}"))
                            .unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let seen = seen.lock().unwrap().clone();
        // Accepted transactions that lost nothing; a conflict is refused before the accept step.
        assert_eq!(seen.len(), 200, "concurrent {concurrent}");
        for pair in seen.windows(2) {
            assert!(
                pair[0].position < pair[1].position,
                "accept order is commit order: {pair:?}"
            );
            assert!(
                pair[0].commit_time < pair[1].commit_time,
                "times follow accept order: {pair:?}"
            );
        }
        assert_eq!(
            seen.last().unwrap().position.sequence,
            kv.version().unwrap()
        );
        if concurrent {
            // At least one group commit held several transactions, and their times still follow their places.
            assert!(
                seen.iter().any(|a| a.position.index > 0),
                "no group commit formed"
            );
        }
    }
}

/// A clock the test moves by hand (it may go backwards), with random ids.
struct HandClock(std::sync::atomic::AtomicI64);

impl gbrain_store::Env for HandClock {
    fn now_micros(&self) -> i64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        gbrain_store::env::SystemEnv.new_uuid()
    }
}

fn mu_only(concurrent: bool) -> OpenOptions {
    OpenOptions {
        concurrent_writes: concurrent,
        keyword_index_builder: false,
        multiuser: true,
        multiuser_writes: mu(),
        ..OpenOptions::default()
    }
}

/// Every commit record's time, in position order.
fn record_times(store: &Store) -> Vec<(CommitPosition, i64)> {
    store
        .read_commit_log(None, usize::MAX)
        .unwrap()
        .records
        .iter()
        .map(|r| (r.position, r.commit_time))
        .collect()
}

#[test]
fn commit_time_never_goes_back_when_the_store_clock_does() {
    for concurrent in MODES {
        let dir = TempDir::new("ctime-back");
        let kv = records_kv(&dir.path().join("r.redb"), concurrent);
        let clock = Arc::new(HandClock(std::sync::atomic::AtomicI64::new(5_000_000)));
        let store = Store::open_kv(kv.clone(), clock.clone(), mu_only(concurrent)).unwrap();
        store.set_config("test.a", "1").unwrap();
        let before = store.last_commit_time().unwrap().unwrap();
        // The clock jumps an hour back, then stands still.
        clock.0.store(
            5_000_000 - 3_600_000_000,
            std::sync::atomic::Ordering::SeqCst,
        );
        for i in 0..5 {
            store.set_config("test.a", &i.to_string()).unwrap();
        }
        let times = record_times(&store);
        for pair in times.windows(2) {
            assert!(pair[0].1 < pair[1].1, "concurrent {concurrent}: {pair:?}");
        }
        let last = store.last_commit_time().unwrap().unwrap();
        assert_eq!(
            last,
            before + 5,
            "each commit takes the previous time plus 1 us"
        );
        assert_eq!(
            times.last().unwrap().1,
            last,
            "the newest record's time is the durable time"
        );
    }
}

#[test]
fn commit_time_strictly_increases_inside_one_optimistic_batch() {
    let dir = TempDir::new("ctime-batch");
    let kv = Arc::new(OccKv::new(RedbKv::open_path(&dir.path().join("r.redb")).unwrap()).unwrap());
    let clock = Arc::new(HandClock(std::sync::atomic::AtomicI64::new(9_000_000)));
    kv.set_commit_clock(clock, None).unwrap();
    raw_logged(&*kv, commit_log::DEFAULT_RETENTION_BYTES);
    let exclusive = kv.begin_write_exclusive().unwrap();
    let threads: Vec<_> = (0..4u8)
        .map(|i| {
            let mut tx = kv.begin_write().unwrap();
            tx.put(&[b'k', i], b"v").unwrap();
            let t = std::thread::spawn(move || tx.commit_position());
            std::thread::sleep(std::time::Duration::from_millis(20));
            t
        })
        .collect();
    std::thread::sleep(std::time::Duration::from_millis(60));
    drop(exclusive);
    let mut positions: Vec<CommitPosition> = threads
        .into_iter()
        .map(|t| t.join().unwrap().unwrap())
        .collect();
    positions.sort();
    assert!(
        positions
            .iter()
            .all(|p| p.sequence == positions[0].sequence),
        "one batch: {positions:?}"
    );
    let page = commit_log::read_commit_log(&*kv.snapshot().unwrap(), None, 100).unwrap();
    let batch: Vec<i64> = page
        .records
        .iter()
        .filter(|r| r.position.sequence == positions[0].sequence)
        .map(|r| r.commit_time)
        .collect();
    assert_eq!(batch.len(), 4);
    // The clock stood still (the activation commit took 9_000_000): each transaction of the batch
    // takes the previous time plus 1 us.
    assert_eq!(batch, vec![9_000_001, 9_000_002, 9_000_003, 9_000_004]);
    assert_eq!(kv.last_commit_time().unwrap(), Some(9_000_004));
}

#[test]
fn commit_time_continues_above_the_durable_floor_after_a_restart_and_a_primary_move() {
    for concurrent in MODES {
        let dir = TempDir::new("ctime-move");
        let brain = dir.path().join("brain");
        let far = 4_000_000_000_000_000;
        let last = {
            std::fs::create_dir_all(&brain).unwrap();
            let kv = records_kv(&brain.join("records.redb"), concurrent);
            let clock = Arc::new(HandClock(std::sync::atomic::AtomicI64::new(far)));
            let store = Store::open_kv(kv, clock, mu_only(concurrent)).unwrap();
            store.set_config("test.a", "2").unwrap();
            store.last_commit_time().unwrap().unwrap()
        };
        // Reopen (a restart, or a new primary on another machine with a slower clock): the floor is
        // the newest durable time, and the next commit is above it.
        let store = Store::open_dir(&brain, mu_only(concurrent)).unwrap();
        assert_eq!(
            store.last_commit_time().unwrap(),
            Some(last),
            "the floor at open"
        );
        store.set_config("test.a", "3").unwrap();
        let next = store.last_commit_time().unwrap().unwrap();
        assert_eq!(
            next,
            last + 1,
            "concurrent {concurrent}: the next time is above the floor"
        );
        let times = record_times(&store);
        for pair in times.windows(2) {
            assert!(pair[0].1 < pair[1].1, "{pair:?}");
        }
        // A store rebuilt from the log alone (no adapter key) takes the same floor from its newest record.
        drop(store);
        let copy = TempDir::new("ctime-copy");
        let source = records_kv(&brain.join("records.redb"), false);
        let model = RedbKv::open_path(&copy.path().join("m.redb")).unwrap();
        let mut tx = model.begin_write().unwrap();
        source
            .snapshot()
            .unwrap()
            .scan(&[1], &[0xFF; 64], false, &mut |k, v| {
                tx.put(k, v).unwrap();
                true
            })
            .unwrap();
        tx.commit().unwrap();
        assert_eq!(
            model.last_commit_time().unwrap(),
            None,
            "the copy has no adapter key"
        );
        // A promoted follower's clock starts at its newest applied record's time.
        model.set_commit_clock(Arc::new(SystemEnv), None).unwrap();
        let mut tx = model.begin_write().unwrap();
        tx.put(b"after-promotion", b"1").unwrap();
        tx.commit().unwrap();
        assert_eq!(model.last_commit_time().unwrap(), Some(next + 1));
    }
}

#[test]
fn a_crash_after_commit_keeps_the_commit_time_and_the_next_one_is_above_it() {
    use gbrain_sim::{CrashMode, FaultPlan, SimDisk, SimFile};
    #[derive(Debug)]
    struct Backend(SimFile);
    impl gbrain_store::FileBackend for Backend {
        fn size(&self) -> std::io::Result<u64> {
            self.0.len()
        }
        fn read_at(&self, o: u64, b: &mut [u8]) -> std::io::Result<()> {
            self.0.read_at(o, b)
        }
        fn write_at(&self, o: u64, d: &[u8]) -> std::io::Result<()> {
            self.0.write_at(o, d)
        }
        fn set_len(&self, l: u64) -> std::io::Result<()> {
            self.0.set_len(l)
        }
        fn sync(&self) -> std::io::Result<()> {
            self.0.sync()
        }
    }
    let disk = SimDisk::new(7, FaultPlan::none());
    let open = |disk: &SimDisk| -> Arc<dyn Kv> {
        Arc::new(RedbKv::open_backend(Box::new(Backend(disk.open("r.redb")))).unwrap())
    };
    let far = 4_000_000_000_000_000;
    let last = {
        let store = Store::open_kv(
            open(&disk),
            Arc::new(HandClock(std::sync::atomic::AtomicI64::new(far))),
            mu_only(false),
        )
        .unwrap();
        store.set_config("test.a", "1").unwrap();
        let last = store.last_commit_time().unwrap().unwrap();
        // The crash: everything synced stays, nothing after it.
        disk.set_plan(FaultPlan {
            fsync_error_pm: 0,
            fsync_lie_pm: 0,
            crash_at_op: Some(disk.stats().io_ops + 1),
            crash_mode: CrashMode::DropUnsynced,
        });
        let _ = store.set_config("test.b", "lost");
        disk.crash_now();
        last
    };
    disk.reboot();
    disk.set_plan(FaultPlan::none());
    let store = Store::open_kv(open(&disk), Arc::new(SystemEnv), mu_only(false)).unwrap();
    assert_eq!(
        store.last_commit_time().unwrap(),
        Some(last),
        "the acknowledged commit's time survived"
    );
    assert_eq!(
        store.get_config("test.b").unwrap(),
        None,
        "the crashed commit left no data"
    );
    store.set_config("test.c", "1").unwrap();
    assert_eq!(
        store.last_commit_time().unwrap(),
        Some(last + 1),
        "and no time: the next is right above"
    );
    let times = record_times(&store);
    assert_eq!(times.last().unwrap().1, last + 1);
}

#[test]
fn a_brain_with_the_switch_off_never_holds_a_commit_time_or_log_key() {
    for concurrent in MODES {
        let dir = TempDir::new("ctime-off");
        // Sub-switches asked for, the switch itself off: nothing of this lane is written.
        let off = OpenOptions {
            concurrent_writes: concurrent,
            keyword_index_builder: false,
            multiuser: false,
            multiuser_writes: mu(),
            ..OpenOptions::default()
        };
        let kv = records_kv(&dir.path().join("r.redb"), concurrent);
        let store = Store::open_kv(kv.clone(), Arc::new(SystemEnv), off).unwrap();
        assert!(!store.info().multiuser && !store.info().commit_log);
        store.set_config("test.a", "1").unwrap();
        store
            .submit_page_mutation(&mutation(&uuid(1), "notes/a", "a"), None)
            .unwrap();
        assert_eq!(store.last_commit_time().unwrap(), None);
        assert!(
            store.set_accept_hook(Arc::new(|_| {})).is_err(),
            "the hook needs the mode"
        );
        assert!(data(&*kv).keys().all(|k| !is_log_key(k)));
        drop(store);
        drop(kv);
        let kv = RedbKv::open_path(&dir.path().join("r.redb")).unwrap();
        assert_eq!(
            gbrain_store::redb_kv::read_commit_time(&*kv.snapshot().unwrap()).unwrap(),
            None
        );
        let row = raw_request(&kv, &uuid(1));
        assert!(row.get("writer_id").is_none() && row.get("admitter_incarnation").is_none());
    }
}

#[test]
fn single_writer_commits_from_many_threads_hand_the_log_over_without_a_false_corruption() {
    let dir = TempDir::new("handoff");
    let kv = records_kv(&dir.path().join("r.redb"), false);
    raw_logged(&*kv, 2_000);
    let threads: Vec<_> = (0..8u8)
        .map(|t| {
            let kv = kv.clone();
            std::thread::spawn(move || {
                for i in 0..100u8 {
                    let mut tx = kv.begin_write().unwrap();
                    tx.put(&[b'k', t, i], &[i; 64]).unwrap();
                    tx.commit_position().unwrap();
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    let read = kv.snapshot().unwrap();
    let meta = commit_log::read_meta(&*read).unwrap().unwrap();
    assert_eq!(meta.newest.sequence, kv.version().unwrap());
}

#[test]
fn a_log_brain_snapshots_and_verifies_like_any_other() {
    let dir = TempDir::new("log-snapshot");
    let brain = dir.path().join("brain");
    let store = Store::open_dir(&brain, mu_only(false)).unwrap();
    store.set_config("test.a", "1").unwrap();
    let target = dir.path().join("copy");
    store
        .snapshot_to(&target, &gbrain_store::snapshot::SnapshotOp::new())
        .unwrap();
    drop(store);
    let report = gbrain_store::verify::verify_store_dir(&target, None).unwrap();
    assert_eq!(report.engine_format_version, Some(LOG_FORMAT_VERSION));
    let copy = Store::open_dir(&target, mu_only(false)).unwrap();
    assert_eq!(copy.get_config("test.a").unwrap().as_deref(), Some("1"));
}

/// Second-model review finding 1: a snapshot keeps the durable commit-time floor, so a copy opened
/// on a slower clock never times a commit below what the source already committed.
#[test]
fn a_snapshot_keeps_the_commit_time_floor() {
    let far = 4_000_000_000_000_000;
    for logged in [false, true] {
        let dir = TempDir::new("snapshot-floor");
        let brain = dir.path().join("brain");
        let writes = MultiUserWrites {
            commit_log: logged,
            ..mu()
        };
        std::fs::create_dir_all(&brain).unwrap();
        let kv = records_kv(&brain.join("records.redb"), false);
        let opts = OpenOptions {
            keyword_index_builder: false,
            multiuser: true,
            multiuser_writes: writes.clone(),
            ..OpenOptions::default()
        };
        let store = Store::open_kv(
            kv,
            Arc::new(HandClock(std::sync::atomic::AtomicI64::new(far))),
            opts.clone(),
        )
        .unwrap();
        store.set_config("test.a", "1").unwrap();
        let floor = store.last_commit_time().unwrap().unwrap();
        drop(store);
        let store = Store::open_dir(&brain, opts.clone()).unwrap();
        let target = dir.path().join("copy");
        store
            .snapshot_to(&target, &gbrain_store::snapshot::SnapshotOp::new())
            .unwrap();
        drop(store);
        let copy = Store::open_dir(&target, opts).unwrap();
        assert!(
            copy.last_commit_time().unwrap().unwrap() >= floor,
            "logged {logged}: the copy lost the floor"
        );
        copy.set_config("test.b", "2").unwrap();
        assert!(
            copy.last_commit_time().unwrap().unwrap() > floor,
            "logged {logged}"
        );
    }
}

/// Second-model review finding 2: an open refused on a shared adapter changes nothing for the store
/// already open on it.
#[test]
fn a_refused_open_on_a_shared_adapter_leaves_the_open_store_timing_its_commits() {
    for concurrent in MODES {
        let dir = TempDir::new("shared-refused");
        let (kv, store) = leader(&dir.path().join("r.redb"), concurrent, mu());
        store.set_config("test.a", "1").unwrap();
        let err = Store::open_kv(
            kv.clone(),
            Arc::new(SystemEnv),
            options(concurrent, MultiUserWrites::default()),
        )
        .err()
        .expect("a log brain without the log is refused");
        assert_eq!(err.code, FORMAT_UNKNOWN);
        store.set_config("test.a", "2").unwrap();
        let times = record_times(&store);
        for pair in times.windows(2) {
            assert!(pair[0].1 < pair[1].1, "concurrent {concurrent}: {pair:?}");
        }
    }
}

/// Lane L6 finding: a rolled-back (or dropped) explicit transaction leaves no data in the log. The
/// only record it may leave is the commit that writes its id sequences forward, and that record
/// holds counter ops and nothing else; a retry then logs its data exactly once.
#[test]
fn a_rolled_back_or_dropped_transaction_logs_no_data_and_a_retry_logs_it_once() {
    use gbrain_store::pages::{PageInput, PutPageOptions};
    let page = |body: &str| -> PageInput {
        serde_json::from_value(json!({"type": "note", "title": "t", "compiled_truth": body}))
            .unwrap()
    };
    let only_counters = |records: &[commit_log::CommitRecord], what: &str| {
        for r in records {
            for (k, op) in &r.ops {
                assert!(
                    matches!(op, LogOp::AddI64(_) | LogOp::RaiseCounter(_)),
                    "{what} left a data op on {}: {op:?}",
                    k.escape_ascii()
                );
            }
        }
    };
    for concurrent in MODES {
        let dir = TempDir::new("rollback-no-data");
        let (kv, store) = leader(&dir.path().join("r.redb"), concurrent, mu());
        let mut follower = Follower::copy_of(&*kv, &dir.path().join("f.redb"));
        let start = store.read_commit_log(None, usize::MAX).unwrap().newest;
        let before = data(&*kv);
        // Rolled back.
        let tx = store.begin_transaction(false).unwrap();
        tx.put_page(
            "rolled/back",
            &page("never committed"),
            &PutPageOptions::default(),
        )
        .unwrap();
        tx.submit_page_mutation(&mutation(&uuid(1), "rolled/mutation", "x"), None)
            .unwrap();
        tx.rollback_transaction().unwrap();
        drop(tx);
        // Dropped without a commit (an aborted attempt).
        {
            let tx = store.begin_transaction(false).unwrap();
            tx.put_page(
                "retried/page",
                &page("first attempt"),
                &PutPageOptions::default(),
            )
            .unwrap();
        }
        let page_after = store.read_commit_log(start, usize::MAX).unwrap();
        only_counters(
            &page_after.records,
            &format!("concurrent {concurrent}: a rollback"),
        );
        let after = data(&*kv);
        let changed: Vec<_> = after
            .iter()
            .filter(|(k, v)| before.get(*k) != Some(*v))
            .map(|(k, _)| k.escape_ascii().to_string())
            .collect();
        assert!(
            changed
                .iter()
                .all(|k| !k.contains("rolled") && !k.contains("retried")),
            "concurrent {concurrent}: {changed:?}"
        );
        follower.catch_up(&store);
        assert_eq!(follower.data(), after);
        // The retry: one record carries its data.
        let tx = store.begin_transaction(false).unwrap();
        tx.put_page(
            "retried/page",
            &page("second attempt"),
            &PutPageOptions::default(),
        )
        .unwrap();
        let at = tx.commit_transaction_at().unwrap();
        drop(tx);
        let records = store.read_commit_log(start, usize::MAX).unwrap().records;
        let with_data: Vec<_> = records
            .iter()
            .filter(|r| {
                r.ops
                    .iter()
                    .any(|(_, o)| matches!(o, LogOp::Put(_) | LogOp::Delete))
            })
            .collect();
        assert_eq!(with_data.len(), 1, "concurrent {concurrent}: {records:?}");
        assert_eq!(with_data[0].position, at);
        follower.catch_up(&store);
        assert_eq!(follower.data(), data(&*kv));
    }
}

/// Lane L1 twin of the rule above, on the optimistic transaction kinds (`Store::begin_with`,
/// `TxnMode::Optimistic`, multi-user mode): a rollback, a drop, and a run whose commit lost its
/// validation leave no data in the log (at most a record of counter ops), and the successful run
/// again logs its data exactly once. On the single-writer store an optimistic transaction runs
/// serialized, so both store modes are checked.
#[test]
fn an_optimistic_rollback_drop_or_lost_run_logs_no_data_and_the_rerun_logs_it_once() {
    use gbrain_store::pages::{PageInput, PutPageOptions};
    use gbrain_store::transactions::{TxnMode, TxnOptions};
    let page = |body: &str| -> PageInput {
        serde_json::from_value(json!({"type": "note", "title": "t", "compiled_truth": body}))
            .unwrap()
    };
    let optimistic = || TxnOptions {
        mode: TxnMode::Optimistic,
        ..TxnOptions::default()
    };
    let only_counters = |records: &[commit_log::CommitRecord], what: &str| {
        for r in records {
            for (k, op) in &r.ops {
                assert!(
                    matches!(op, LogOp::AddI64(_) | LogOp::RaiseCounter(_)),
                    "{what} left a data op on {}: {op:?}",
                    k.escape_ascii()
                );
            }
        }
    };
    for concurrent in MODES {
        let dir = TempDir::new("optimistic-no-data");
        let (kv, store) = leader(&dir.path().join("r.redb"), concurrent, mu());
        let mut follower = Follower::copy_of(&*kv, &dir.path().join("f.redb"));
        let start = store.read_commit_log(None, usize::MAX).unwrap().newest;
        // Rolled back.
        let tx = store.begin_with(optimistic()).unwrap();
        assert_eq!(tx.store().transaction_optimistic(), concurrent);
        tx.store()
            .put_page("opt/rolled", &page("never"), &PutPageOptions::default())
            .unwrap();
        tx.rollback().unwrap();
        // Dropped.
        {
            let tx = store.begin_with(optimistic()).unwrap();
            tx.store()
                .put_page("opt/dropped", &page("never"), &PutPageOptions::default())
                .unwrap();
        }
        // A run that loses its validation (concurrent store only: a single-writer one holds the
        // writer, so nothing can change what it read).
        let first = store.begin_with(optimistic()).unwrap();
        first
            .store()
            .put_page(
                "opt/retried",
                &page("first run"),
                &PutPageOptions::default(),
            )
            .unwrap();
        if concurrent {
            assert!(first.store().get_config("opt.gate").unwrap().is_none());
            store.set_config("opt.gate", "moved").unwrap();
            assert_eq!(first.commit().unwrap_err().code, WRITE_CONFLICT);
        } else {
            first.rollback().unwrap();
        }
        let gate_at = store.read_commit_log(start, usize::MAX).unwrap().records;
        let aborted: Vec<_> = gate_at
            .into_iter()
            .filter(|r| {
                !r.ops
                    .iter()
                    .any(|(k, _)| k.windows(8).any(|w| w == b"opt.gate"))
            })
            .collect();
        only_counters(
            &aborted,
            &format!("concurrent {concurrent}: an aborted optimistic run"),
        );
        // The run again: one record carries its data.
        let again = store.begin_with(optimistic()).unwrap();
        again
            .store()
            .put_page(
                "opt/retried",
                &page("second run"),
                &PutPageOptions::default(),
            )
            .unwrap();
        let at = again.store().commit_transaction_at().unwrap();
        drop(again);
        let with_data: Vec<_> = store
            .read_commit_log(start, usize::MAX)
            .unwrap()
            .records
            .into_iter()
            .filter(|r| {
                r.ops.iter().any(|(k, o)| {
                    matches!(o, LogOp::Put(_) | LogOp::Delete)
                        && !k.windows(8).any(|w| w == b"opt.gate")
                })
            })
            .collect();
        assert_eq!(with_data.len(), 1, "concurrent {concurrent}: {with_data:?}");
        assert_eq!(with_data[0].position, at);
        follower.catch_up(&store);
        assert_eq!(follower.data(), data(&*kv));
    }
}
