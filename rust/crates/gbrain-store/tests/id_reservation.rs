//! Durable id reservation in multi-user mode (`occ_kv.rs`, "Id sequences"): an id the concurrent store handed out is
//! never handed out again, also when the process stops before the transaction that took it commits or writes its
//! counters forward (a crash, a kill, a lost forward write). A clean close gives back the unused part of the reserved
//! range, so a brain that is closed and opened again numbers on with no gap.
//!
//! Every store here is opened with multi-user mode on in the run (`common::mu::logged_options`, asserted), never from the
//! environment, except the mode-off case, which asserts the mode is off.

mod common;

use gbrain_sim::{CrashMode, FaultPlan, SimDisk, SimFile};
use gbrain_store::occ_kv::OccKv;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::transactions::{TxnMode, TxnOptions};
use gbrain_store::{Env, FileBackend, Kv, OpenOptions, Store, StoreError, keys};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

const FILE: &str = "brain.redb";

#[derive(Debug)]
struct SimBackend(SimFile);

impl FileBackend for SimBackend {
    fn size(&self) -> std::io::Result<u64> {
        self.0.len()
    }
    fn read_at(&self, offset: u64, out: &mut [u8]) -> std::io::Result<()> {
        self.0.read_at(offset, out)
    }
    fn write_at(&self, offset: u64, data: &[u8]) -> std::io::Result<()> {
        self.0.write_at(offset, data)
    }
    fn set_len(&self, len: u64) -> std::io::Result<()> {
        self.0.set_len(len)
    }
    fn sync(&self) -> std::io::Result<()> {
        self.0.sync()
    }
}

/// A clock that moves 1 ms per read and uuids from a counter. Each open starts it at the same time: the commit clock
/// floors every commit time at the durable one, so a reopen never moves time back.
struct TickEnv {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Env for TickEnv {
    fn now_micros(&self) -> i64 {
        self.now.fetch_add(1_000, Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        gbrain_store::env::uuid_from_bytes(bytes)
    }
}

fn env(first_uuid: u64) -> Arc<TickEnv> {
    Arc::new(TickEnv {
        now: AtomicI64::new(1_800_000_000_000_000),
        ids: AtomicU64::new(first_uuid),
    })
}

/// The brain on `disk`, opened with multi-user mode on (asserted), and its concurrent record file.
fn open_mu(disk: &SimDisk, first_uuid: u64) -> Result<(Store, Arc<OccKv>), StoreError> {
    let kv = Arc::new(OccKv::new(RedbKv::open_backend(Box::new(SimBackend(
        disk.open(FILE),
    )))?)?);
    let store = Store::open_kv(
        kv.clone(),
        env(first_uuid),
        common::mu::logged_options(true, common::mu::TEST_HOST),
    )?;
    common::mu::assert_logged(&store);
    Ok((store, kv))
}

/// The brain on `disk` with multi-user mode off (asserted) and concurrent writes on.
fn open_off(disk: &SimDisk) -> Result<(Store, Arc<OccKv>), StoreError> {
    let kv = Arc::new(OccKv::new(RedbKv::open_backend(Box::new(SimBackend(
        disk.open(FILE),
    )))?)?);
    let store = Store::open_kv(
        kv.clone(),
        env(1),
        OpenOptions {
            concurrent_writes: true,
            keyword_index_builder: false,
            multiuser: false,
            ..OpenOptions::default()
        },
    )?;
    assert!(!store.multiuser(), "the store resolved multi-user mode on");
    Ok((store, kv))
}

fn input(title: &str) -> PageInput {
    serde_json::from_value(json!({"type": "note", "title": title, "compiled_truth": title}))
        .unwrap()
}

fn put(store: &Store, slug: &str) -> u64 {
    store
        .put_page(slug, &input(slug), &PutPageOptions::default())
        .unwrap_or_else(|e| panic!("put {slug}: {e}"))["id"]
        .as_u64()
        .unwrap()
}

fn optimistic() -> TxnOptions {
    TxnOptions {
        mode: TxnMode::Optimistic,
        ..TxnOptions::default()
    }
}

/// A sequence key of the store's own kind (`M` + `next_...`), used by no store code.
fn test_sequence() -> Vec<u8> {
    keys::meta("next_test_reservation_id")
}

/// Crashes `disk` with `mode`, drops what was open on it and powers it back on.
fn crash(disk: &SimDisk, mode: CrashMode, open: impl FnOnce()) {
    disk.crash_now_with(mode);
    open();
    disk.reboot();
    disk.set_plan(FaultPlan::none());
}

const CRASH_MODES: [CrashMode; 2] = [CrashMode::DropUnsynced, CrashMode::TearLast];

/// The record-file level: ranges handed out to write transactions that never commit (one still open, one dropped) are
/// not handed out again after a crash and a reopen.
#[test]
fn ids_handed_out_before_a_crash_are_not_handed_out_after_the_reopen() {
    for (n, mode) in CRASH_MODES.into_iter().enumerate() {
        for seed in 0..8u64 {
            let disk = SimDisk::new(seed * 10 + n as u64, FaultPlan::none());
            let (store, kv) = open_mu(&disk, 1).unwrap();
            let key = test_sequence();
            let mut taken = Vec::new();
            let mut held = kv.begin_write().unwrap();
            taken.push((held.allocate(&key, 3).unwrap(), 3));
            {
                let mut dropped = kv.begin_write().unwrap();
                taken.push((dropped.allocate(&key, 5).unwrap(), 5));
            }
            taken.push((held.allocate(&key, 1).unwrap(), 1));
            let high = taken
                .iter()
                .map(|(first, count)| first + count)
                .max()
                .unwrap();
            crash(&disk, mode, || {
                drop(held);
                drop(store);
                drop(kv);
            });
            let (_store, kv) = open_mu(&disk, 100).unwrap();
            let mut after = kv.begin_write().unwrap();
            let first = after.allocate(&key, 4).unwrap();
            assert!(
                first >= high,
                "seed {seed} {mode:?}: id {first} was handed out again after the crash (ids before it: {taken:?}, so the next is at least {high})"
            );
        }
    }
}

/// The store level: an optimistic transaction creates a page (it takes the page id) and the brain crashes before the
/// transaction ends. The next page after the reopen gets a new id.
#[test]
fn a_page_id_taken_by_an_open_optimistic_transaction_is_new_after_a_crash() {
    for (n, mode) in CRASH_MODES.into_iter().enumerate() {
        let disk = SimDisk::new(900 + n as u64, FaultPlan::none());
        let (store, kv) = open_mu(&disk, 1).unwrap();
        let committed = put(&store, "notes/before");
        let txn = store.begin_with(optimistic()).unwrap();
        let open_id = put(txn.store(), "notes/in-flight");
        assert!(open_id > committed);
        crash(&disk, mode, || {
            drop(txn);
            drop(store);
            drop(kv);
        });
        let (store, _kv) = open_mu(&disk, 100).unwrap();
        let next = put(&store, "notes/after");
        assert!(
            next > open_id,
            "{mode:?}: page id {next} was handed out again after the crash (the open transaction held {open_id})"
        );
    }
}

/// A clean close gives back the unused part of the reserved range: after a close and a reopen the next id follows the
/// last one handed out, as before the reservation existed (ids of a rolled-back transaction stay used).
#[test]
fn a_clean_close_and_reopen_number_on_with_no_gap() {
    let disk = SimDisk::new(7, FaultPlan::none());
    let (store, kv) = open_mu(&disk, 1).unwrap();
    let a = put(&store, "notes/a");
    let b = put(&store, "notes/b");
    assert_eq!(b, a + 1);
    let txn = store.begin_with(optimistic()).unwrap();
    let rolled_back = put(txn.store(), "notes/rolled-back");
    assert_eq!(rolled_back, b + 1);
    txn.rollback().unwrap();
    let key = test_sequence();
    let first = {
        let mut w = kv.begin_write().unwrap();
        let first = w.allocate(&key, 2).unwrap();
        w.commit().unwrap();
        first
    };
    drop(store);
    drop(kv);
    let (store, kv) = open_mu(&disk, 100).unwrap();
    assert_eq!(
        put(&store, "notes/c"),
        rolled_back + 1,
        "the page ids skipped after a clean reopen"
    );
    let mut w = kv.begin_write().unwrap();
    assert_eq!(
        w.allocate(&key, 1).unwrap(),
        first + 2,
        "the test sequence skipped after a clean reopen"
    );
}

/// Ids a transaction took and that a still-open transaction holds when the brain closes cleanly are not handed out
/// again after the reopen either: the close keeps the reservation up to the newest id handed out.
#[test]
fn a_clean_close_keeps_ids_an_open_transaction_still_holds() {
    let disk = SimDisk::new(8, FaultPlan::none());
    let (store, kv) = open_mu(&disk, 1).unwrap();
    let key = test_sequence();
    let mut held = kv.begin_write().unwrap();
    let first = held.allocate(&key, 6).unwrap();
    drop(store);
    drop(kv);
    // The open transaction outlives the brain's handles; the record file closes when it goes.
    drop(held);
    let (_store, kv) = open_mu(&disk, 100).unwrap();
    let mut w = kv.begin_write().unwrap();
    assert_eq!(w.allocate(&key, 1).unwrap(), first + 6);
}

/// Mode off is unchanged: the record file gets no reservation and a crash still hands the ids of a transaction that never
/// committed out again (as before, and as in Postgres for a sequence whose `nextval` was never flushed).
#[test]
fn mode_off_keeps_the_old_numbering() {
    let disk = SimDisk::new(11, FaultPlan::none());
    let (store, kv) = open_off(&disk).unwrap();
    let key = test_sequence();
    let mut held = kv.begin_write().unwrap();
    let first = held.allocate(&key, 3).unwrap();
    crash(&disk, CrashMode::DropUnsynced, || {
        drop(held);
        drop(store);
        drop(kv);
    });
    let (_store, kv) = open_off(&disk).unwrap();
    let mut w = kv.begin_write().unwrap();
    assert_eq!(w.allocate(&key, 1).unwrap(), first);
}

/// A reservation write is not a commit: the commit sequence and the commit log do not move when an allocation reserves.
/// An allocation past the reserved range reserves again, and a crash after it still starts above every id handed out.
#[test]
fn a_reservation_is_no_commit_and_a_range_past_it_reserves_again() {
    let disk = SimDisk::new(12, FaultPlan::none());
    let (store, kv) = open_mu(&disk, 1).unwrap();
    let key = test_sequence();
    let version = kv.version().unwrap();
    let log = store
        .read_commit_log(None, usize::MAX)
        .unwrap()
        .records
        .len();
    let mut held = kv.begin_write().unwrap();
    let first = held.allocate(&key, 1000).unwrap();
    let second = held.allocate(&key, 2000).unwrap();
    assert_eq!(second, first + 1000);
    assert_eq!(
        kv.version().unwrap(),
        version,
        "a reservation moved the commit sequence"
    );
    assert_eq!(
        store
            .read_commit_log(None, usize::MAX)
            .unwrap()
            .records
            .len(),
        log,
        "a reservation wrote a commit record"
    );
    crash(&disk, CrashMode::DropUnsynced, || {
        drop(held);
        drop(store);
        drop(kv);
    });
    let (_store, kv) = open_mu(&disk, 100).unwrap();
    let mut w = kv.begin_write().unwrap();
    let after = w.allocate(&key, 1).unwrap();
    assert!(
        after >= second + 2000,
        "id {after} was handed out again (the range ended at {})",
        second + 2000
    );
}

/// A commit refused for a conflict gives its page id back (`occ_kv.rs`, "Id sequences"), in memory only: the next page
/// takes it, and a crash before or after that never hands out an id a committed page holds. The commit log explains
/// every change the scenario made, the reopen included.
#[test]
fn a_conflict_give_back_never_hands_out_a_committed_id_after_a_crash() {
    for (n, mode) in CRASH_MODES.into_iter().enumerate() {
        for retake in [false, true] {
            let disk = SimDisk::new(950 + 2 * n as u64 + retake as u64, FaultPlan::none());
            let (store, kv) = open_mu(&disk, 1).unwrap();
            let start = store.read_commit_log(None, usize::MAX).unwrap().newest;
            let before = common::mu::image_of(&*kv);
            let mut committed = vec![put(&store, "notes/hot")];
            let txn = store.begin_with(optimistic()).unwrap();
            let refused = put(txn.store(), "notes/in-flight");
            put(txn.store(), "notes/hot");
            put(&store, "notes/hot");
            assert_eq!(
                txn.commit().unwrap_err().code,
                gbrain_store::error::WRITE_CONFLICT
            );
            if retake {
                let again = put(&store, "notes/in-flight");
                assert_eq!(
                    again, refused,
                    "{mode:?}: the refused commit's page id did not go back"
                );
                committed.push(again);
            }
            crash(&disk, mode, || {
                drop(store);
                drop(kv);
            });
            let (store, kv) = open_mu(&disk, 100).unwrap();
            let next = put(&store, "notes/after");
            assert!(
                committed.iter().all(|&id| next > id),
                "{mode:?} retake={retake}: page id {next} was handed out again (committed: {committed:?})"
            );
            let records = store.read_commit_log(start, usize::MAX).unwrap();
            assert!(!records.snapshot_required, "the log asked for a snapshot");
            common::logged::log_explains_change(
                &before,
                &common::mu::image_of(&*kv),
                &records.records,
            )
            .unwrap_or_else(|e| panic!("{mode:?} retake={retake}: {e}"));
        }
    }
}
