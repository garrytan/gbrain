//! The commit log as a storage-layer rule, and a primary move between two hosts.
//!
//! New rule for every lane: "the commit log lives at the storage layer, so open-time upkeep, upgrades and rollbacks are logged too.
//! No lane adds a write path that skips it." Each `every_write_path_is_logged_*` test snapshots every key and value of the record file
//! before a scenario and after it, replays the scenario's log records onto the before-image, and requires byte equality with the
//! after-image (`common::logged::log_explains_change`): a key that changed with no record fails, and so does a record whose change is
//! not in the store. They are `#[ignore = "multi_writer"]`, pending on `L2 commit log` (the open that turns the log on); the check
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
#[ignore = "multi_writer"]
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
#[ignore = "multi_writer"]
fn every_write_path_is_logged_open_time_upkeep_multi_writer() {
    opened_brain_is_explained_by_its_log(UpkeepKind::UpkeepOnly);
}

/// A format upgrade at open: a logged brain whose records are at an older base format is upgraded, and every change it makes is in the
/// log. (The C16 fixture, a format-1 brain with no log, is upgraded before the log exists: `commit-log.md` leaves that upgrade and the
/// activation commit outside the log by design, so a replay from the log's start cannot cover it. That is a question for the log
/// lane, not something this check skips: see the answer that came with this test.)
#[test]
#[ignore = "multi_writer"]
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
            closed.image.get(&scan).is_none() && after.get(&scan).is_some(),
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
                    && closed.image.get(&secret_new).is_none()
                    && after.get(&secret_new).is_some(),
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
#[ignore = "multi_writer"]
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
#[ignore = "multi_writer"]
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

/// An optimistic commit that was aborted (its transaction dropped) and then retried: the abort leaves no record, the retry exactly one.
#[test]
#[ignore = "multi_writer"]
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
