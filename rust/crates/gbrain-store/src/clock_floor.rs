//! The clock rule of multi-user mode (I-4.v2.1; design note "M3", "Clocks"): only the store's process clock writes
//! times; a row's `created_at` is its transaction's clock time, never below the clock floor at open; the commit
//! record's `commit_time` is the strictly rising time; order is the commit position.
//!
//! The floor is the newest durable commit time, `M\0ctime` (`Store::last_commit_time`, lane L2): every commit in
//! multi-user mode writes it atomically with its data, so a snapshot, a copy, a takeover or a rebuild from the log
//! carries it with the data. A promoted follower's floor is max(its own `M\0ctime`, the last applied record's
//! `commit_time`), which is the same value once the record is applied. On a store opened in multi-user mode the
//! store's [`Env`] is wrapped in [`ClockFloor`]: `now_micros` is the larger of the system time and the floor, and
//! every reading raises the floor in memory, so a wall clock that steps back never moves stored times back.
//!
//! The key `~L 0x04` (`leases::CLOCK_HIGH_WATER`) held this floor before the commit time existed. It was never written
//! by a shipped build; a store that has it opens normally and the key is ignored.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use crate::env::Env;
use crate::error::Result;
use crate::keys;
use crate::kv::KvRead;
use crate::leases::CLOCK_HIGH_WATER;

/// The retired key `~L 0x04` (the floor before the commit time existed); a store that holds it ignores it.
pub fn retired_high_water_key() -> Vec<u8> {
    let mut key = keys::LEASES.to_vec();
    key.push(CLOCK_HIGH_WATER);
    key
}

/// The floor a multi-user open starts its clock at: the newest durable commit time (microseconds; 0 when none).
pub fn read_high_water(read: &dyn KvRead) -> Result<i64> {
    Ok(crate::redb_kv::read_commit_time(read)?.unwrap_or(0))
}

impl crate::Store {
    /// The clock floor: the newest durable commit time (`M\0ctime`; 0 when none). It is brain state: a snapshot, a
    /// copy, a takeover or a rebuild from the log carries it with the data.
    pub fn clock_high_water(&self) -> Result<i64> {
        read_high_water(&*self.read()?)
    }
}

/// A clock that never goes below its floor and never hands out a time below one it handed out before.
pub struct ClockFloor {
    inner: Arc<dyn Env>,
    floor: AtomicI64,
}

impl ClockFloor {
    pub fn new(inner: Arc<dyn Env>, floor: i64) -> Self {
        ClockFloor {
            inner,
            floor: AtomicI64::new(floor),
        }
    }

    fn floored(&self, t: i64) -> i64 {
        let prev = self.floor.fetch_max(t, Ordering::SeqCst);
        prev.max(t)
    }
}

impl Env for ClockFloor {
    fn now_micros(&self) -> i64 {
        self.floored(self.inner.now_micros())
    }

    fn clock_micros(&self) -> i64 {
        self.floored(self.inner.clock_micros())
    }

    fn new_uuid(&self) -> String {
        self.inner.new_uuid()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{mem_kv, occ_kv};
    use crate::write_origin::WriteOrigin;
    use crate::{OpenOptions, Store};

    struct Wall(AtomicI64);
    impl Env for Wall {
        fn now_micros(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
        fn new_uuid(&self) -> String {
            "00000000-0000-4000-8000-000000000001".into()
        }
    }

    fn origin() -> WriteOrigin {
        WriteOrigin {
            host_id: "h".into(),
            incarnation: "i".into(),
            writer_id: "local_cli:t".into(),
        }
    }

    fn open(kv: Arc<dyn crate::kv::Kv>, wall: &Arc<Wall>, multiuser: bool) -> Store {
        let options = OpenOptions {
            multiuser,
            keyword_index_builder: false,
            ..OpenOptions::default()
        };
        Store::open_kv(kv, wall.clone(), options).unwrap()
    }

    fn acquired_at(store: &Store, name: &str) -> i64 {
        store
            .acquire_lease(name, &origin(), 60_000)
            .unwrap()
            .unwrap();
        store.read_lease(name).unwrap().unwrap().acquired_at_us
    }

    /// A wall clock that steps back, and a reopen on a machine whose clock is behind: stored times never go backwards.
    #[test]
    fn a_backwards_wall_clock_or_a_reopen_behind_never_moves_stored_times_back() {
        for (mode, kv) in [
            ("single", mem_kv()),
            ("concurrent", Arc::new(occ_kv()) as Arc<dyn crate::kv::Kv>),
        ] {
            let wall = Arc::new(Wall(AtomicI64::new(2_000_000_000_000_000)));
            let store = open(kv.clone(), &wall, true);
            let first = acquired_at(&store, "a");
            wall.0.fetch_sub(10_000_000, Ordering::SeqCst);
            let second = acquired_at(&store, "b");
            assert!(second >= first, "{mode}: {second} < {first}");
            assert!(
                read_high_water(&*store.read().unwrap()).unwrap() >= first,
                "{mode}"
            );
            drop(store);
            // Reopen with the wall clock an hour behind: the floor comes back from the stored high-water mark.
            wall.0.fetch_sub(3_600_000_000, Ordering::SeqCst);
            let store = open(kv.clone(), &wall, true);
            let third = acquired_at(&store, "c");
            assert!(third >= second, "{mode}: {third} < {second}");
        }
    }

    /// G15: a lease taken inside an explicit transaction carries the live clock (after the transaction began); the
    /// high-water mark that transaction commits is at or above that time, so a reopen never goes below it.
    #[test]
    fn a_write_inside_an_explicit_transaction_raises_the_floor_to_the_time_it_stored() {
        for (mode, kv) in [
            ("single", mem_kv()),
            ("concurrent", Arc::new(occ_kv()) as Arc<dyn crate::kv::Kv>),
        ] {
            let wall = Arc::new(Wall(AtomicI64::new(2_000_000_000_000_000)));
            let store = open(kv.clone(), &wall, true);
            let tx = store.begin_transaction(false).unwrap();
            wall.0.fetch_add(10_000_000, Ordering::SeqCst);
            tx.acquire_lease("in-tx", &origin(), 60_000)
                .unwrap()
                .unwrap();
            tx.commit_transaction().unwrap();
            let stored = store.read_lease("in-tx").unwrap().unwrap().acquired_at_us;
            let floor = read_high_water(&*store.read().unwrap()).unwrap();
            assert!(
                floor >= stored,
                "{mode}: floor {floor} below the stored time {stored}"
            );
        }
    }

    /// G15: a brain opened in multi-user mode records a high-water mark at once, so the records it was created
    /// (or seeded) with stay below the floor of a later open behind the wall clock.
    #[test]
    fn a_multi_user_open_records_a_floor_before_any_write() {
        let wall = Arc::new(Wall(AtomicI64::new(2_000_000_000_000_000)));
        let kv = mem_kv();
        let store = open(kv.clone(), &wall, true);
        assert!(read_high_water(&*store.read().unwrap()).unwrap() >= 2_000_000_000_000_000);
    }

    /// Off: the store keeps the wall clock as it is and writes no high-water mark.
    #[test]
    fn with_multi_user_mode_off_the_clock_and_the_records_are_untouched() {
        let wall = Arc::new(Wall(AtomicI64::new(2_000_000_000_000_000)));
        let store = open(mem_kv(), &wall, false);
        let first = acquired_at(&store, "a");
        wall.0.fetch_sub(10_000_000, Ordering::SeqCst);
        let second = acquired_at(&store, "b");
        assert_eq!(second, first - 10_000_000);
        assert_eq!(
            store
                .read()
                .unwrap()
                .get(&retired_high_water_key())
                .unwrap(),
            None
        );
        assert_eq!(
            store.last_commit_time().unwrap(),
            None,
            "no commit time is written with the switch off"
        );
    }

    /// Stays ignored by ruling (I-4.v2.1, Ember A1, Nov 25: created_at is transaction time, order is commit
    /// position): two independent commits that read the clock in one order and commit in the other keep their own
    /// transaction times, as Postgres `now()` does. The commit record's commit_time is the strictly rising time.
    #[test]
    #[ignore = "I-4.v2.1 (Ember A1, Nov 25): created_at is transaction time, order is commit position"]
    fn reverse_preparation_order_commits_get_increasing_times() {
        unimplemented!("not built by ruling A1");
    }

    /// A new primary (another process, its own clock an hour behind) opens the same store and writes: every time it
    /// stores is at or above the floor the store carried at open, which is at or above every time written before.
    #[test]
    fn after_a_promotion_created_at_is_never_below_the_floor_at_open() {
        for (mode, kv) in [
            ("single", mem_kv()),
            ("concurrent", Arc::new(occ_kv()) as Arc<dyn crate::kv::Kv>),
        ] {
            let old_primary = Arc::new(Wall(AtomicI64::new(2_000_000_000_000_000)));
            let store = open(kv.clone(), &old_primary, true);
            let mut last = 0;
            for i in 0..5 {
                last = last.max(acquired_at(&store, &format!("old-{i}")));
                old_primary.0.fetch_add(1_000, Ordering::SeqCst);
            }
            drop(store);
            let new_primary = Arc::new(Wall(AtomicI64::new(2_000_000_000_000_000 - 3_600_000_000)));
            let store = open(kv.clone(), &new_primary, true);
            let floor = read_high_water(&*store.read().unwrap()).unwrap();
            assert!(
                floor >= last,
                "{mode}: floor {floor} below the last stored time {last}"
            );
            for i in 0..5 {
                let t = acquired_at(&store, &format!("new-{i}"));
                assert!(t >= floor, "{mode}: {t} below the floor {floor}");
            }
        }
    }
}

#[cfg(test)]
mod commit_time_floor {
    use super::*;
    use crate::test_support::{mem_kv, occ_kv};
    use crate::write_origin::WriteOrigin;
    use crate::{OpenOptions, Store};

    struct Frozen(i64);
    impl Env for Frozen {
        fn now_micros(&self) -> i64 {
            self.0
        }
        fn new_uuid(&self) -> String {
            "00000000-0000-4000-8000-000000000001".into()
        }
    }

    /// L6's finding, I-4.v2.1: with a wall clock that does not move, each commit time is the previous one plus 1 µs,
    /// so the durable commit time runs ahead of the wall clock. After a reopen, a row written by the next transaction
    /// must not be below the commit time the store held at open (the floor).
    #[test]
    fn a_row_written_after_reopen_is_never_below_the_commit_time_at_open() {
        for (mode, kv) in [
            ("single", mem_kv()),
            ("concurrent", Arc::new(occ_kv()) as Arc<dyn crate::kv::Kv>),
        ] {
            let env: Arc<dyn Env> = Arc::new(Frozen(2_000_000_000_000_000));
            let options = || OpenOptions {
                multiuser: true,
                keyword_index_builder: false,
                ..OpenOptions::default()
            };
            let origin = WriteOrigin {
                host_id: "h".into(),
                incarnation: "i".into(),
                writer_id: "local_cli:t".into(),
            };
            let store = Store::open_kv(kv.clone(), env.clone(), options()).unwrap();
            for i in 0..20 {
                store.set_config(&format!("k{i}"), "v").unwrap();
            }
            drop(store);
            let store = Store::open_kv(kv.clone(), env.clone(), options()).unwrap();
            let floor = store.last_commit_time().unwrap().expect("a commit time");
            store
                .acquire_lease("after-reopen", &origin, 60_000)
                .unwrap()
                .unwrap();
            let stored = store
                .read_lease("after-reopen")
                .unwrap()
                .unwrap()
                .acquired_at_us;
            assert!(
                stored >= floor,
                "{mode}: row time {stored} below the floor at open {floor}"
            );
        }
    }

    /// Acceptance check from L6's commit-log proof (c22, first step): a brain with the commit log on, its commits made
    /// through explicit transactions, reopened on a clock 5 s below the persisted floor: the floor read at open is the
    /// persisted commit time, and every row time written after open is at or above it.
    #[test]
    fn c22_a_reopen_on_a_clock_below_the_floor_writes_no_row_time_below_it_with_the_commit_log_on()
    {
        for (mode, kv) in [
            ("single", mem_kv()),
            ("concurrent", Arc::new(occ_kv()) as Arc<dyn crate::kv::Kv>),
        ] {
            let options = || OpenOptions {
                multiuser: true,
                keyword_index_builder: false,
                multiuser_writes: crate::MultiUserWrites {
                    commit_log: true,
                    host_id: Some("h".into()),
                    ..Default::default()
                },
                ..OpenOptions::default()
            };
            let origin = WriteOrigin {
                host_id: "h".into(),
                incarnation: "i".into(),
                writer_id: "local_cli:t".into(),
            };
            let t0 = 1_800_000_000_000_000;
            let store = Store::open_kv(kv.clone(), Arc::new(Frozen(t0)), options()).unwrap();
            for i in 0..8 {
                let tx = store.begin_transaction(false).unwrap();
                tx.set_config(&format!("c22/{i}"), "primary commit")
                    .unwrap();
                tx.commit_transaction().unwrap();
            }
            let floor = store.last_commit_time().unwrap().expect("a commit time");
            drop(store);
            let reopened =
                Store::open_kv(kv.clone(), Arc::new(Frozen(floor - 5_000_000)), options()).unwrap();
            assert_eq!(
                reopened.last_commit_time().unwrap(),
                Some(floor),
                "{mode}: the floor at open"
            );
            for n in 0..4 {
                reopened
                    .acquire_lease(&format!("rows/{n}"), &origin, 60_000)
                    .unwrap()
                    .unwrap();
                let t = reopened
                    .read_lease(&format!("rows/{n}"))
                    .unwrap()
                    .unwrap()
                    .acquired_at_us;
                assert!(
                    t >= floor,
                    "{mode}: a row time {t} is below the clock floor {floor} read at open"
                );
            }
        }
    }
}

#[cfg(test)]
mod retired_key {
    use super::*;
    use crate::test_support::mem_kv;
    use crate::{OpenOptions, Store, SystemEnv};

    /// Ruling (1b): a store that still holds the retired `~L 0x04` key opens cleanly and ignores it: a huge stale value
    /// never becomes the floor.
    #[test]
    fn a_store_with_the_retired_floor_key_opens_and_ignores_it() {
        let kv = mem_kv();
        let store =
            Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
        drop(store);
        let mut tx = kv.begin_write().unwrap();
        tx.put(
            &retired_high_water_key(),
            &(i64::MAX as u64 / 2).to_be_bytes(),
        )
        .unwrap();
        tx.commit().unwrap();
        let options = OpenOptions {
            multiuser: true,
            keyword_index_builder: false,
            ..OpenOptions::default()
        };
        let store = Store::open_kv(kv.clone(), Arc::new(SystemEnv), options).unwrap();
        let floor = store.clock_high_water().unwrap();
        assert!(
            floor > 0 && floor < i64::MAX / 4,
            "the floor comes from the commit time, not the retired key: {floor}"
        );
    }
}
