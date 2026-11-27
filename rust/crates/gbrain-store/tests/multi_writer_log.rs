//! The commit log as a storage-layer rule, and a primary move between two hosts.
//!
//! New rule for every lane: "the commit log lives at the storage layer, so open-time upkeep, upgrades and rollbacks are logged too.
//! No lane adds a write path that skips it." Each `every_write_path_is_logged_*` test snapshots every key and value of the record file
//! before a scenario and after it, replays the scenario's log records onto the before-image, and requires byte equality with the
//! after-image (`common::logged::log_explains_change`): a key that changed with no record fails, and so does a record whose change is
//! not in the store. They run against the commit-log lane's real code, with multi-user mode and the log on in the run (`mu::open_logged`, which asserts the resolved state); the check
//! itself runs today against hand-built images, and `the_write_path_check_passes_an_exact_replay_and_fails_each_unlogged_change` shows
//! it fails a write that bypasses the log, a doctored after-image, and a rollback that left a change.
//!
//! `second_host_promotion_keeps_clock_floor_and_positions_multi_writer` moves the primary from host A to host B through the log.
//! The log applies in process; reasons: `L2 commit log` (apply and promote), `L5 hosts` (fencing the old primary), `L3 server` (the
//! handover over the wire).

mod common;
mod memory_env;

use common::mu::{
    self, CommitPosition, CommitRecord, Image, L3_SERVER, L5_HOSTS, LogOp, LostReason, MuStore,
    MuTxn, TxnMode, TxnOptions, UpkeepKind, WriteOrigin,
};
use common::{TempDir, clock, logged};
use gbrain_store::Store;
use gbrain_store::StoreError;
use gbrain_store::journal::{PageMutation, Principal};
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use memory_env::{Clock, T0};
use serde_json::json;
use std::sync::Arc;
use std::thread;

const HOST_A: &str = "a0000000-0000-4000-8000-0000000000a1";
const HOST_B: &str = "b0000000-0000-4000-8000-0000000000b1";
const MODES: [bool; 2] = [false, true];

fn page(body: &str) -> PageInput {
    serde_json::from_value(json!({"type": "note", "title": "t", "compiled_truth": body})).unwrap()
}

fn put(s: &Store, slug: &str, body: &str) {
    s.put_page(slug, &page(body), &PutPageOptions::default())
        .unwrap();
}

fn origin(i: usize) -> WriteOrigin {
    WriteOrigin {
        host_id: format!("host-{i}"),
        incarnation: format!("incarnation-{i}"),
        writer_id: format!("writer-{i}"),
    }
}

fn begin_host(s: &Store, i: usize) -> MuTxn {
    s.begin_with(TxnOptions {
        mode: TxnMode::Optimistic,
        deadline: None,
        origin: Some(origin(i)),
        ..TxnOptions::default()
    })
    .unwrap_or_else(|e| panic!("{e}"))
}

fn commit_host(s: &Store, tx: MuTxn) -> CommitPosition {
    s.commit_position(tx).unwrap_or_else(|e| panic!("{e}"))
}

fn page_created_us(s: &Store, slug: &str) -> i64 {
    let snap = s
        .read_page_snapshot(slug, &ReadScope::default())
        .unwrap()
        .unwrap();
    gbrain_store::env::parse_iso(snap["page"]["created_at"].as_str().unwrap()).unwrap()
}

fn op(key: &str, op: LogOp) -> (Vec<u8>, LogOp) {
    (key.as_bytes().to_vec(), op)
}

fn record(sequence: u64, time: i64, ops: Vec<(Vec<u8>, LogOp)>) -> CommitRecord {
    CommitRecord {
        ops,
        ..clock::record(sequence, 0, time)
    }
}

fn image(pairs: &[(&str, &[u8])]) -> Image {
    pairs
        .iter()
        .map(|(k, v)| (k.as_bytes().to_vec(), v.to_vec()))
        .collect()
}

/// The check fails what it claims to. Runs today.
#[test]
fn the_write_path_check_passes_an_exact_replay_and_fails_each_unlogged_change() {
    let counter = |n: i64| n.to_le_bytes().to_vec();
    let before = image(&[
        ("a", b"1"),
        ("gone", b"x"),
        ("n", &counter(3)),
        ("seq", &5u64.to_be_bytes()),
    ]);
    let records = vec![
        record(
            1,
            10,
            vec![
                op("a", LogOp::Put(b"2".to_vec())),
                op("new", LogOp::Put(b"y".to_vec())),
            ],
        ),
        record(
            2,
            11,
            vec![
                op("gone", LogOp::Delete),
                op("n", LogOp::AddI64(4)),
                op("seq", LogOp::RaiseCounter(9)),
            ],
        ),
    ];
    let after = image(&[
        ("a", b"2"),
        ("new", b"y"),
        ("n", &counter(7)),
        ("seq", &9u64.to_be_bytes()),
    ]);
    logged::log_explains_change(&before, &after, &records).unwrap();
    // raise_counter never lowers a counter.
    let lower = vec![record(1, 10, vec![op("seq", LogOp::RaiseCounter(2))])];
    logged::log_explains_change(&before, &before, &lower).unwrap();

    // A write that bypasses the log: a key in the store with no record.
    let mut bypass = after.clone();
    bypass.insert(b"bypass".to_vec(), b"z".to_vec());
    let e = logged::log_explains_change(&before, &bypass, &records).unwrap_err();
    assert!(e.contains("changed with no record"), "{e}");
    // A doctored value: the record says `2`, the store holds `3`.
    let mut doctored = after.clone();
    doctored.insert(b"a".to_vec(), b"3".to_vec());
    assert!(
        logged::log_explains_change(&before, &doctored, &records)
            .unwrap_err()
            .contains("changed with no record")
    );
    // A delete the store did not make (a bypass that put the key back).
    let mut resurrected = after.clone();
    resurrected.insert(b"gone".to_vec(), b"x".to_vec());
    assert!(logged::log_explains_change(&before, &resurrected, &records).is_err());
    // A record whose change is not in the store.
    let mut missing = after.clone();
    missing.remove(b"new".as_slice());
    let e = logged::log_explains_change(&before, &missing, &records).unwrap_err();
    assert!(e.contains("did not change it"), "{e}");
    // A rollback leaves no record and no change; one that left a change fails.
    logged::log_explains_change(&before, &before, &[]).unwrap();
    let mut leaked = before.clone();
    leaked.insert(b"p/rolled-back".to_vec(), b"page".to_vec());
    assert!(logged::log_explains_change(&before, &leaked, &[]).is_err());
    // A record no replay can apply fails rather than passing: a counter delta onto a key that is not a counter.
    let broken = vec![record(1, 10, vec![op("a", LogOp::AddI64(1))])];
    assert!(logged::log_explains_change(&before, &before, &broken).is_err());
}

/// The records after `after` (all of them for `None`) and the position they end at.
fn log_since(
    s: &Store,
    after: Option<CommitPosition>,
) -> (Vec<CommitRecord>, Option<CommitPosition>) {
    let page = s
        .read_commit_log(after, usize::MAX)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(!page.snapshot_required, "the log asked for a snapshot");
    (page.records, page.newest)
}

fn clock_env() -> Arc<Clock> {
    Clock::at(T0)
}

/// Ordinary writes on both stores: pages, config, journal admissions, tags, and writers from four threads.
#[test]
fn every_write_path_is_logged_ordinary_writes_multi_writer() {
    for optimistic in MODES {
        let dir = TempDir::new("log-ordinary");
        let path = dir.path().join("records.redb");
        let brain = mu::open_logged(&path, optimistic, clock_env(), HOST_A)
            .unwrap_or_else(|e| panic!("{e}"));
        let store = &brain.store;
        let (_, start) = log_since(store, None);
        let before = mu::image_of(&*brain.kv);
        for n in 0..6 {
            put(store, &format!("w/{n}"), "an ordinary write");
        }
        store.set_config("test.key", "1").unwrap();
        store.add_tag("w/0", "tagged", None).unwrap();
        thread::scope(|s| {
            for t in 0..4 {
                s.spawn(move || {
                    for n in 0..3 {
                        put(store, &format!("t/{t}-{n}"), "from a thread");
                    }
                });
            }
        });
        let (records, _) = log_since(store, start);
        assert!(
            records.len() >= 18,
            "{} records for 20 commits",
            records.len()
        );
        let after = mu::image_of(&*brain.kv);
        logged::log_explains_change(&before, &after, &records)
            .unwrap_or_else(|e| panic!("optimistic={optimistic}: {e}"));
        // The control: the same after-image with one write that skipped the log fails.
        let mut bypass = after.clone();
        bypass.insert(b"bypass".to_vec(), b"x".to_vec());
        assert!(logged::log_explains_change(&before, &bypass, &records).is_err());
    }
}

/// An open that writes by itself: the access-flag scan, the keyword index reset and the source-index backfill run at open of a
/// brain whose markers are gone, and each write is in the log.
#[test]
fn every_write_path_is_logged_open_time_upkeep_multi_writer() {
    opened_brain_is_explained_by_its_log(UpkeepKind::UpkeepOnly);
}

/// A format upgrade at open: a logged brain whose records are at an older base format is upgraded, and every change it makes is in the
/// log. (The C16 fixture, a format-1 brain with no log, is upgraded before the log exists: `commit-log.md` leaves that upgrade and the
/// activation commit outside the log by design, so a replay from the log's start cannot cover it. That is a question for the log
/// lane, not something this check skips: see the answer that came with this test.)
#[test]
fn every_write_path_is_logged_format_upgrade_multi_writer() {
    opened_brain_is_explained_by_its_log(UpkeepKind::OlderBase);
}

fn opened_brain_is_explained_by_its_log(kind: UpkeepKind) {
    for optimistic in MODES {
        let dir = TempDir::new("log-upkeep");
        let path = dir.path().join("records.redb");
        let closed = mu::logged_brain_needing_upkeep(&path, optimistic, kind)
            .unwrap_or_else(|e| panic!("{e}"));
        let brain = mu::open_logged(&path, optimistic, clock_env(), HOST_A)
            .unwrap_or_else(|e| panic!("{e}"));
        // Only the records AFTER the cursor taken before the open are the open's: an old idempotent put cannot satisfy this.
        let (records, _) = log_since(&brain.store, closed.cursor);
        assert!(
            records.iter().any(|r| !r.ops.is_empty()),
            "{kind:?}, optimistic={optimistic}: the open wrote nothing"
        );
        let after = mu::image_of(&*brain.kv);
        logged::log_explains_change(&closed.image, &after, &records)
            .unwrap_or_else(|e| panic!("{kind:?}, optimistic={optimistic}: {e}"));
        // The expected marker or format transition happened, and it is in the open's records.
        let logged_key = |key: &[u8]| {
            records.iter().any(|r| {
                r.ops
                    .iter()
                    .any(|(k, op)| k == key && !matches!(op, LogOp::Delete))
            })
        };
        let (scan, backfill) = (
            gbrain_store::keys::meta("access_flag_scan"),
            gbrain_store::keys::meta("derivation_purge_source_index"),
        );
        assert!(
            logged_key(&scan) || logged_key(&backfill),
            "{kind:?}, optimistic={optimistic}: no open-time upkeep marker was logged by the open"
        );
        assert!(
            !closed.image.contains_key(&scan) && after.contains_key(&scan),
            "the access-flag scan marker did not appear at open"
        );
        if kind == UpkeepKind::OlderBase {
            let format_key = gbrain_store::keys::meta("format");
            let secret_new = vec![gbrain_store::keys::ACCESS_MEMBERS, 0x0d];
            assert!(
                logged_key(&format_key),
                "the upgrade did not log the format record"
            );
            assert!(
                logged_key(&secret_new)
                    && !closed.image.contains_key(&secret_new)
                    && after.contains_key(&secret_new),
                "the format upgrade did not move the token secret"
            );
        }
        let mut bypass = after.clone();
        bypass.insert(b"bypass".to_vec(), b"x".to_vec());
        assert!(logged::log_explains_change(&closed.image, &bypass, &records).is_err());
    }
}

/// The open's own records must be those after the pre-open cursor: with the records read from the start, an old idempotent put
/// would satisfy a "the open wrote something" check and replay onto an unchanged image. The control feeds exactly that history.
#[test]
fn the_open_time_check_needs_the_records_after_the_cursor_not_any_record() {
    let before = image(&[("a", b"1")]);
    let old_put = record(1, 10, vec![op("a", LogOp::Put(b"1".to_vec()))]);
    // The open wrote nothing: the image is unchanged, and the only record is an old idempotent put from before the cursor.
    let all_records = vec![old_put];
    assert!(
        all_records.iter().any(|r| !r.ops.is_empty()),
        "the from-the-start read finds a record"
    );
    logged::log_explains_change(&before, &before, &all_records).unwrap();
    let after_cursor: Vec<CommitRecord> = all_records
        .into_iter()
        .filter(|r| r.position > CommitPosition::new(1, 0))
        .collect();
    assert!(
        after_cursor.iter().all(|r| r.ops.is_empty()),
        "the records after the cursor must hold the open's writes, and here there are none"
    );
}

/// Commit times are exactly `max(store clock, previous commit time + 1 µs)` (I-4.v2): the injected clock is held for several
/// commits, advanced, then moved back. An increasing counter would rise and equal `last_commit_time()`; this fails it.
#[test]
fn commit_times_are_the_max_of_the_clock_and_the_previous_time_plus_one_multi_writer() {
    for optimistic in MODES {
        let dir = TempDir::new("log-clock-exact");
        let path = dir.path().join("records.redb");
        let clock = Clock::at(T0);
        let brain = mu::open_logged(&path, optimistic, clock.clone(), HOST_A)
            .unwrap_or_else(|e| panic!("{e}"));
        let (_, start) = log_since(&brain.store, None);
        let prev = brain
            .store
            .last_commit_time()
            .unwrap_or_else(|e| panic!("{e}"));
        let mut clocks = Vec::new();
        let mut commit = |slug: &str| {
            clocks.push(clock.now());
            put(&brain.store, slug, "a commit");
        };
        for n in 0..3 {
            commit(&format!("held/{n}")); // the clock holds: each time is previous + 1
        }
        clock.advance(1_000_000);
        commit("advanced"); // the clock is ahead of previous + 1: the time is the clock
        clock.advance(-5_000_000);
        commit("behind"); // the clock went back: previous + 1 again
        let (records, _) = log_since(&brain.store, start);
        clock::commit_times_are_exact(&records, prev, &clocks)
            .unwrap_or_else(|e| panic!("optimistic={optimistic}: {e}"));
    }
}

/// A rolled-back explicit transaction leaves no change and no record of its data. A rollback that writes id sequences forward commits
/// counters only (`commit-log.md`): any record it leaves holds counter ops and nothing else.
#[test]
fn every_write_path_is_logged_rolled_back_transaction_multi_writer() {
    for optimistic in MODES {
        let dir = TempDir::new("log-rollback");
        let path = dir.path().join("records.redb");
        let brain = mu::open_logged(&path, optimistic, clock_env(), HOST_A)
            .unwrap_or_else(|e| panic!("{e}"));
        let store = &brain.store;
        let (_, start) = log_since(store, None);
        let before = mu::image_of(&*brain.kv);
        let tx = store.begin_transaction(false).unwrap();
        put(&tx, "rolled/back", "never committed");
        tx.rollback_transaction().unwrap();
        let (records, _) = log_since(store, start);
        let after = mu::image_of(&*brain.kv);
        logged::log_explains_change(&before, &after, &records)
            .unwrap_or_else(|e| panic!("optimistic={optimistic}: {e}"));
        assert!(
            records
                .iter()
                .flat_map(|r| &r.ops)
                .all(|(_, o)| matches!(o, LogOp::AddI64(_) | LogOp::RaiseCounter(_))),
            "a rolled-back transaction left a data record: {records:?}"
        );
        assert!(
            store
                .read_page_snapshot("rolled/back", &ReadScope::default())
                .unwrap()
                .is_none()
        );
    }
}

/// An optimistic commit that was aborted (its explicit optimistic transaction dropped) and then retried: the abort leaves no data
/// record, the retry exactly one.
#[test]
fn every_write_path_is_logged_aborted_then_retried_optimistic_commit_multi_writer() {
    let dir = TempDir::new("log-retry");
    let path = dir.path().join("records.redb");
    let brain = mu::open_logged(&path, true, clock_env(), HOST_A).unwrap_or_else(|e| panic!("{e}"));
    let store = &brain.store;
    let (_, start) = log_since(store, None);
    let before = mu::image_of(&*brain.kv);
    let aborted = begin_host(store, 1);
    put(&aborted, "retried/page", "first attempt");
    drop(aborted);
    let (records, _) = log_since(store, start);
    assert!(
        records
            .iter()
            .flat_map(|r| &r.ops)
            .all(|(_, o)| matches!(o, LogOp::AddI64(_) | LogOp::RaiseCounter(_))),
        "an aborted transaction left a data record: {records:?}"
    );
    logged::log_explains_change(&before, &mu::image_of(&*brain.kv), &records)
        .unwrap_or_else(|e| panic!("after the abort: {e}"));
    let retry = begin_host(store, 1);
    put(&retry, "retried/page", "second attempt");
    let position = commit_host(store, retry);
    let (records, _) = log_since(store, start);
    let data_records: Vec<&CommitRecord> = records
        .iter()
        .filter(|r| r.ops.iter().any(|(_, o)| matches!(o, LogOp::Put(_))))
        .collect();
    assert_eq!(
        data_records.len(),
        1,
        "the retry is one commit: {records:?}"
    );
    assert_eq!(data_records[0].position, position);
    clock::commit_times_rise(&records).unwrap_or_else(|e| panic!("{e}"));
    logged::log_explains_change(&before, &mu::image_of(&*brain.kv), &records)
        .unwrap_or_else(|e| panic!("after the retry: {e}"));
}

// ---- explicit optimistic transactions, with the log on ---------------------------------------------------------------------

fn request_id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn principal_of(n: usize) -> Principal {
    serde_json::from_value(json!({"kind": "local_cli", "id": format!("w{}", n % 8)})).unwrap()
}

fn mutation(n: usize, slug: &str, body: &str) -> PageMutation {
    serde_json::from_value(json!({
        "principal": {"kind": "local_cli", "id": format!("w{}", n % 8)}, "requestId": request_id(n),
        "slug": slug, "page": {"type": "note", "title": slug, "compiled_truth": body}, "options": {},
    }))
    .unwrap()
}

/// Runs request `n` (a page write) inside the explicit transaction `tx`; the receipt it gives inside is `committed`.
fn submit_in(tx: &MuTxn, n: usize, slug: &str, body: &str) {
    let receipt = tx
        .submit_page_mutation(&mutation(n, slug, body), None)
        .unwrap();
    assert_eq!(receipt["state"], "committed", "{receipt}");
}

/// A record that carries data (a put or a delete), as opposed to one that only moves a counter.
fn has_data(record: &CommitRecord) -> bool {
    record
        .ops
        .iter()
        .any(|(_, o)| matches!(o, LogOp::Put(_) | LogOp::Delete))
}

/// Nothing of a transaction that never committed is in the log: no record with data, no record naming one of its request ids, and
/// the log replays onto the before-image to the after-image exactly (any change that has no record fails; counters it advanced are
/// logged as counter operations only).
fn leaves_no_trace(
    before: &Image,
    after: &Image,
    records: &[CommitRecord],
    request_ids: &[String],
) -> Result<(), String> {
    if let Some(r) = records.iter().find(|r| has_data(r)) {
        return Err(format!("a record with data at {:?}", r.position));
    }
    for id in request_ids {
        if records.iter().any(|r| r.write_ids.contains(id)) {
            return Err(format!("a record names request {id}"));
        }
    }
    logged::log_explains_change(before, after, records)
}

fn data_records_of(records: &[CommitRecord]) -> Vec<CommitRecord> {
    records.iter().filter(|r| has_data(r)).cloned().collect()
}

/// What one writer saw: the commits it was acknowledged (position and request id) and the request ids of its refused runs.
type WriterOutcome = (Vec<(CommitPosition, String)>, Vec<String>);

/// How an explicit optimistic transaction ends without committing.
#[derive(Clone, Copy, Debug)]
enum Ending {
    Rollback,
    Drop,
}

fn an_abandoned_optimistic_transaction_leaves_nothing(ending: Ending) {
    let dir = TempDir::new("log-abandoned");
    let path = dir.path().join("records.redb");
    let brain = mu::open_logged(&path, true, clock_env(), HOST_A).unwrap_or_else(|e| panic!("{e}"));
    let store = &brain.store;
    put(store, "kept/page", "committed before");
    let (_, start) = log_since(store, None);
    let before = mu::image_of(&*brain.kv);
    let tx = begin_host(store, 1);
    submit_in(&tx, 1, "never/committed", "written in the transaction");
    put(&tx, "also/never", "a second write");
    assert!(
        tx.read_page_snapshot("never/committed", &ReadScope::default())
            .unwrap()
            .is_some(),
        "the transaction cannot read its own write"
    );
    match ending {
        Ending::Rollback => tx.rollback().unwrap_or_else(|e| panic!("{e}")),
        Ending::Drop => drop(tx),
    }
    let (records, _) = log_since(store, start);
    let after = mu::image_of(&*brain.kv);
    let ids = [request_id(1)];
    leaves_no_trace(&before, &after, &records, &ids).unwrap_or_else(|e| panic!("{ending:?}: {e}"));
    // What an abandoned transaction does leave is the counters it advanced, raised in one separate write so an id it handed out is
    // never handed out again (`transactions.rs`): at most one record, and only counter operations.
    assert!(
        records.len() <= 1,
        "{ending:?}: more than one record: {records:?}"
    );
    for slug in ["never/committed", "also/never"] {
        assert!(
            store
                .read_page_snapshot(slug, &ReadScope::default())
                .unwrap()
                .is_none(),
            "{ending:?}: {slug} is visible"
        );
    }
    assert!(
        store
            .get_write_receipt(&principal_of(1), &ids[0])
            .unwrap()
            .is_none(),
        "{ending:?}: the abandoned request left a receipt"
    );
    // The control: each way a trace could be left makes the check fail.
    let mut leaked = after.clone();
    leaked.insert(b"p/leaked".to_vec(), b"page".to_vec());
    assert!(leaves_no_trace(&before, &leaked, &records, &ids).is_err());
    let with_data = CommitRecord {
        ops: vec![(b"p/never".to_vec(), LogOp::Put(b"page".to_vec()))],
        write_ids: vec![ids[0].clone()],
        ..clock::record(99, 0, 1)
    };
    let mut doctored = records.clone();
    doctored.push(with_data);
    assert!(leaves_no_trace(&before, &after, &doctored, &ids).is_err());
    // The brain is still usable: the same request runs again and is logged.
    let again = begin_host(store, 1);
    submit_in(&again, 1, "never/committed", "written in the transaction");
    let position = commit_host(store, again);
    let (records, _) = log_since(store, start);
    clock::positions_match_records(&[position], &data_records_of(&records), 0)
        .unwrap_or_else(|e| panic!("{e}"));
    clock::request_ids_match_records(&ids, &records).unwrap_or_else(|e| panic!("{e}"));
}

/// Log on, optimistic store, explicit `begin_with(Optimistic)` transaction: a rolled-back transaction leaves no record and no
/// change (only the counters it advanced are logged, as counter operations), and its request leaves no receipt.
#[test]
fn an_optimistic_transaction_rolled_back_leaves_no_record_and_no_change_multi_writer() {
    an_abandoned_optimistic_transaction_leaves_nothing(Ending::Rollback);
}

/// The same for a transaction dropped without a commit.
#[test]
fn an_optimistic_transaction_dropped_without_a_commit_leaves_no_record_and_no_change_multi_writer()
{
    an_abandoned_optimistic_transaction_leaves_nothing(Ending::Drop);
}

/// A lost run, then the same request rerun: two explicit optimistic transactions read the same page; the second to commit is refused
/// with a typed `write_conflict` and leaves nothing (no record, no receipt); the same request id run again commits and is in the
/// write ids of exactly one record. The positions the two commits returned are exactly the two data records.
#[test]
fn a_lost_run_and_its_rerun_are_logged_exactly_once_multi_writer() {
    let dir = TempDir::new("log-lost-run");
    let path = dir.path().join("records.redb");
    let brain = mu::open_logged(&path, true, clock_env(), HOST_A).unwrap_or_else(|e| panic!("{e}"));
    let store = &brain.store;
    put(store, "doc", "seed");
    let (_, start) = log_since(store, None);
    let (first, second) = (begin_host(store, 1), begin_host(store, 2));
    submit_in(&first, 1, "doc", "from the first");
    submit_in(&second, 2, "doc", "from the second");
    let p1 = commit_host(store, first);
    let lost = store
        .commit_position(second)
        .expect_err("the second writer's stale commit was acknowledged");
    assert_eq!(lost.code, gbrain_store::error::WRITE_CONFLICT, "{lost}");
    let (records, _) = log_since(store, start);
    assert!(
        records
            .iter()
            .all(|r| !r.write_ids.contains(&request_id(2))),
        "the lost run is in the log: {records:?}"
    );
    assert!(
        store
            .get_write_receipt(&principal_of(2), &request_id(2))
            .unwrap()
            .is_none(),
        "the lost run left a receipt"
    );
    // The rerun: the same request id, from a fresh read.
    let rerun = begin_host(store, 2);
    submit_in(&rerun, 2, "doc", "from the second");
    let p2 = commit_host(store, rerun);
    assert!(
        p2 > p1,
        "the rerun's position is not after the first commit"
    );
    let (records, _) = log_since(store, start);
    let ids = [request_id(1), request_id(2)];
    clock::request_ids_match_records(&ids, &records).unwrap_or_else(|e| panic!("{e}"));
    clock::positions_match_records(&[p1, p2], &data_records_of(&records), 0)
        .unwrap_or_else(|e| panic!("{e}"));
    clock::commit_times_rise(&records).unwrap_or_else(|e| panic!("{e}"));
    // The controls: a rerun logged twice, and a lost run that reached the log, each fail the check.
    let named = |id: &str, n: u64| CommitRecord {
        write_ids: vec![id.to_string()],
        ..clock::record(n, 0, n as i64)
    };
    assert!(
        clock::request_ids_match_records(
            &ids,
            &[named(&ids[0], 1), named(&ids[1], 2), named(&ids[1], 3)]
        )
        .is_err(),
        "a rerun logged twice passed"
    );
    assert!(
        clock::request_ids_match_records(&ids, &[named(&ids[0], 1)]).is_err(),
        "an acknowledged rerun missing from the log passed"
    );
    // The page holds the rerun's write, and the first writer's write is in its history (nothing was lost).
    assert_eq!(
        store
            .read_page_snapshot("doc", &ReadScope::default())
            .unwrap()
            .unwrap()["page"]["compiled_truth"],
        "from the second"
    );
}

/// Positions are in commit order and each returned position is exactly one record. Six transactions are open at once and commit in
/// a fixed, shuffled order: the positions rise in that order and the log's records follow it. Then eight writers on one page, each
/// retrying a refused commit under a new request id: every acknowledged position is one data record that carries its request id,
/// no refused attempt is in the log, and the records rise in position and commit time.
#[test]
fn positions_are_in_commit_order_and_each_is_exactly_one_record_multi_writer() {
    let dir = TempDir::new("log-positions");
    let path = dir.path().join("records.redb");
    let brain = mu::open_logged(&path, true, clock_env(), HOST_A).unwrap_or_else(|e| panic!("{e}"));
    let store = &brain.store;
    let (_, start) = log_since(store, None);

    // Six at once, committed in an order that is not the order they began in.
    let order = [3usize, 0, 5, 1, 4, 2];
    let mut open: Vec<Option<MuTxn>> = (0..6)
        .map(|i| {
            let tx = begin_host(store, i);
            submit_in(
                &tx,
                100 + i,
                &format!("open/{i}"),
                "written while others are open",
            );
            Some(tx)
        })
        .collect();
    let committed: Vec<(CommitPosition, usize)> = order
        .iter()
        .map(|&i| (commit_host(store, open[i].take().unwrap()), i))
        .collect();
    assert!(
        committed.windows(2).all(|w| w[0].0 < w[1].0),
        "positions did not rise in commit order: {committed:?}"
    );
    let (records, _) = log_since(store, start);
    let data = data_records_of(&records);
    let returned: Vec<CommitPosition> = committed.iter().map(|(p, _)| *p).collect();
    clock::positions_match_records(&returned, &data, 0).unwrap_or_else(|e| panic!("{e}"));
    let logged_order: Vec<String> = data.iter().flat_map(|r| r.write_ids.clone()).collect();
    let commit_order: Vec<String> = order.iter().map(|&i| request_id(100 + i)).collect();
    assert_eq!(logged_order, commit_order, "the log is not in commit order");

    // Eight writers on one page: conflicts, reruns, one record per acknowledged commit.
    let attempts = std::sync::atomic::AtomicUsize::new(1_000);
    let outcomes: Vec<WriterOutcome> = thread::scope(|scope| {
        let handles: Vec<_> = (0..8usize)
            .map(|w| {
                let attempts = &attempts;
                scope.spawn(move || {
                    let (mut acked, mut refused) = (Vec::new(), Vec::new());
                    for round in 0..3 {
                        loop {
                            let n = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            let tx = begin_host(store, w);
                            submit_in(&tx, n, "hot/page", &format!("writer {w} round {round}"));
                            match store.commit_position(tx) {
                                Ok(p) => {
                                    acked.push((p, request_id(n)));
                                    break;
                                }
                                Err(e) => {
                                    assert_eq!(e.code, gbrain_store::error::WRITE_CONFLICT, "{e}");
                                    refused.push(request_id(n));
                                }
                            }
                        }
                    }
                    (acked, refused)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let acked: Vec<(CommitPosition, String)> =
        outcomes.iter().flat_map(|(a, _)| a.clone()).collect();
    let refused: Vec<String> = outcomes.iter().flat_map(|(_, r)| r.clone()).collect();
    assert_eq!(acked.len(), 24, "a writer gave up");
    let (records, _) = log_since(store, None);
    let writers: Vec<CommitRecord> = records
        .iter()
        .filter(|r| {
            r.write_ids
                .iter()
                .any(|id| acked.iter().any(|(_, a)| a == id))
        })
        .cloned()
        .collect();
    let returned: Vec<CommitPosition> = acked.iter().map(|(p, _)| *p).collect();
    clock::positions_match_records(&returned, &writers, 0).unwrap_or_else(|e| panic!("{e}"));
    for (position, id) in &acked {
        let record = writers.iter().find(|r| r.position == *position).unwrap();
        assert_eq!(
            record.write_ids.iter().filter(|w| *w == id).count(),
            1,
            "the record at {position:?} does not carry request {id} exactly once"
        );
    }
    for id in &refused {
        assert!(
            records.iter().all(|r| !r.write_ids.contains(id)),
            "a refused attempt, {id}, is in the log"
        );
    }
    assert!(
        records.windows(2).all(|w| w[0].position < w[1].position),
        "the log is not in position order"
    );
    clock::commit_times_rise(&records).unwrap_or_else(|e| panic!("{e}"));
}

fn assert_lost(e: &StoreError, reason: LostReason, what: &str) {
    assert_eq!(e.code, mu::LEASE_LOST, "{what}: {e}");
    assert_eq!(
        mu::lost_reason(e).as_deref(),
        Some(reason.as_str()),
        "{what}: {e}"
    );
}

/// The primary moves from host A to host B through the log. A commits N transactions; B, a store of its own with its own clock set below
/// A's last commit time, applies A's records in order and is promoted; B then commits more. Every new position is above A's last, the
/// commit times keep strictly rising across the move, B's floor is `max(its own M\0ctime, A's last commit_time)`, every row time after
/// the promotion is at or above it, every key A's records touched holds A's value on B, and A's write after the move is refused.
/// PENDING: `apply_log` and `promote_from_log` have no `Store` member in the commit-log lane (L2: `commit_log::apply_record` takes a raw
/// write handle), the old primary's fence is L5 hosts, and the wire handover is L3 server.
#[test]
#[ignore = "multi_writer"]
fn second_host_promotion_keeps_clock_floor_and_positions_multi_writer() {
    for optimistic in MODES {
        let (a_dir, b_dir) = (TempDir::new("promo-a"), TempDir::new("promo-b"));
        let (a_path, b_path) = (
            a_dir.path().join("records.redb"),
            b_dir.path().join("records.redb"),
        );
        let a = mu::open_logged(&a_path, optimistic, Clock::at(T0), HOST_A)
            .unwrap_or_else(|e| panic!("{e}"));
        for i in 0..6 {
            let tx = begin_host(&a.store, i);
            put(&tx, &format!("hand/{i}"), "committed on host A");
            commit_host(&a.store, tx);
        }
        let (a_records, a_last) = log_since(&a.store, None);
        let a_last = a_last.expect("A's log has a newest position");
        let a_time = a_records.last().expect("A committed").commit_time;
        clock::replay_clock_checks(
            &a_records,
            a.store.last_commit_time().unwrap_or_else(|e| panic!("{e}")),
            None,
            &[],
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let a_image = mu::image_of(&*a.kv);

        // Host B: its own store and its own clock, 10 s below A's last commit time.
        let b = mu::open_logged(&b_path, optimistic, Clock::at(a_time - 10_000_000), HOST_B)
            .unwrap_or_else(|e| panic!("{e}"));
        let applied = b
            .store
            .apply_log(&a_records)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(applied, Some(a_last), "B did not apply A's whole log");
        let own = b.store.last_commit_time().unwrap_or_else(|e| panic!("{e}"));
        let floor = b
            .store
            .promote_from_log(applied)
            .unwrap_or_else(|e| panic!("{e}"))
            .expect("a floor after the promotion");
        assert_eq!(
            Some(floor),
            clock::floor_of(own, a_records.last()),
            "the floor is not max(own M\\0ctime, last applied commit_time)"
        );
        assert!(floor >= a_time);
        // Every key A's records touched holds A's value on B at the handover position.
        let b_image = mu::image_of(&*b.kv);
        for key in a_records.iter().flat_map(|r| r.ops.iter().map(|(k, _)| k)) {
            assert_eq!(
                b_image.get(key),
                a_image.get(key),
                "key {key:?} differs at the handover"
            );
        }

        // B commits more: positions above A's last, commit times rising across the move, row times at or above the floor.
        let mut positions = Vec::new();
        for i in 0..4 {
            let tx = begin_host(&b.store, 10 + i);
            put(&tx, &format!("after/{i}"), "committed on host B");
            positions.push(commit_host(&b.store, tx));
        }
        assert!(
            positions.iter().all(|p| *p > a_last) && positions.windows(2).all(|w| w[0] < w[1]),
            "a position did not rise above A's last {a_last:?}: {positions:?}"
        );
        let (b_records, _) = log_since(&b.store, Some(a_last));
        assert_eq!(b_records.len(), positions.len());
        let mut across = a_records.clone();
        across.extend(b_records.clone());
        clock::commit_times_rise(&across).unwrap_or_else(|e| panic!("across the move: {e}"));
        assert!(
            b_records[0].commit_time >= floor,
            "the first commit after the move is below the floor"
        );
        let times: Vec<i64> = (0..4)
            .map(|i| page_created_us(&b.store, &format!("after/{i}")))
            .collect();
        clock::row_times_at_or_above_floor(floor, &times).unwrap_or_else(|e| panic!("{e}"));

        // The old primary is fenced: its write after the move is refused.
        mu::pending_member::<()>(
            L5_HOSTS,
            "the old primary is fenced after the promotion (its lease epoch moved)",
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let late = begin_host(&a.store, 1);
        put(&late, "late/write", "from the old primary");
        let refused = a.store.commit_position(late).unwrap_err();
        assert_lost(
            &refused,
            LostReason::EpochMoved,
            "the old primary's write after the move",
        );

        // The same handover through the server's wire frame, not in process.
        mu::pending_member::<()>(
            L3_SERVER,
            "the log records reach the follower in a wire frame",
        )
        .unwrap_or_else(|e| panic!("{e}"));
    }
}
