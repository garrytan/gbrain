//! The clock rule of multi-user mode (design note "M3", "Clocks"; lane L5 plan step 7, rule 2 as decided A1):
//! only the store's process clock writes times, and a time the store hands out is never below the last committed time
//! it has seen, nor below a time it handed out before, on one server. So a wall clock that steps backwards, or a
//! restart on a machine whose clock is behind, never makes `created_at` run backwards.
//!
//! How: on a store opened in multi-user mode the store's [`Env`] is wrapped in [`ClockFloor`]: `now_micros` is the
//! larger of the system time and the floor, and every reading raises the floor. Every committed write raises the
//! durable high-water mark `~L 0x04` (`leases::CLOCK_HIGH_WATER`) to the time it ran at, with `raise_counter`, which
//! never conflicts on the concurrent store; an open reads it back as the floor's start.
//!
//! Not covered yet (pending on lane L2's accept-hook commit time): two independent transactions that commit in the
//! reverse of the order they read the clock in still store their own times, as Postgres `now()` does; commit order is
//! the order (the commit position), not `created_at`.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use crate::env::Env;
use crate::error::Result;
use crate::keys;
use crate::kv::{KvRead, KvWrite};
use crate::leases::CLOCK_HIGH_WATER;

/// The key of the durable high-water mark: `~L 0x04`.
pub fn high_water_key() -> Vec<u8> {
    let mut key = keys::LEASES.to_vec();
    key.push(CLOCK_HIGH_WATER);
    key
}

/// The stored high-water mark (microseconds), 0 when none.
pub fn read_high_water(read: &dyn KvRead) -> Result<i64> {
    Ok(read
        .get(&high_water_key())?
        .and_then(|b| keys::be8(&b))
        .map_or(0, |v| i64::try_from(v).unwrap_or(i64::MAX)))
}

/// Raises the stored high-water mark to `at` (never lowers it, never conflicts).
pub fn raise_high_water(tx: &mut dyn KvWrite, at: i64) -> Result<()> {
    tx.raise_counter(&high_water_key(), at.max(0) as u64)
}

impl crate::Store {
    /// The stored clock high-water mark (microseconds; 0 when none): the floor a multi-user open starts its clock at.
    /// It is brain state: a snapshot, a copy or a takeover of the store carries it with the data.
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
        assert_eq!(store.read().unwrap().get(&high_water_key()).unwrap(), None);
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
