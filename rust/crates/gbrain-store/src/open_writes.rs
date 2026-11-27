//! The start times of the writes open on one brain in multi-user mode, so the per-source cycle's
//! listing instant (`cycle_window.rs`, `readCycleListingInstant`) can be held back before the
//! oldest of them, as the SQL engines hold it back before the oldest open transaction
//! (`pg_stat_activity.xact_start`, `src/core/engine-sql/cycle-reads.ts`).
//!
//! A page is stamped with its write's start time (an explicit transaction's clock,
//! `transactions::TransactionClock`, as Postgres `now()`). With explicit transactions running
//! optimistically, a write that started before a cycle read its instant can commit after it; a
//! cursor at that instant would leave its page behind every later window. While a write is open
//! its start is registered here; the instant is never later than just before the oldest one.
//!
//! The registry lives with the brain (every store of an open brain shares it). A start is read
//! from the brain's clock under the registry's lock, and the instant reads the clock under the
//! same lock, so a write either is in the registry when the instant is read or starts at or after
//! it. With multi-user mode off nothing registers: the instant is the clock, as before.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::env::Env;

/// How far back the instant may be held (the SQL engines' bound): ten minutes, in microseconds.
pub const MAX_HOLD_BACK_US: i64 = 10 * 60 * 1_000_000;

/// The open writes of one brain: registration id to start time (microseconds).
#[derive(Debug, Default)]
pub struct OpenWrites {
    inner: Mutex<Registry>,
}

#[derive(Debug, Default)]
struct Registry {
    next: u64,
    starts: BTreeMap<u64, i64>,
}

impl OpenWrites {
    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a write starting now on `clock`: returns the start time it read and the guard that
    /// keeps it registered until dropped.
    pub fn open(self: &Arc<Self>, clock: &dyn Env) -> (i64, OpenWrite) {
        let mut registry = self.lock();
        let start = clock.now_micros();
        let id = registry.next;
        registry.next += 1;
        registry.starts.insert(id, start);
        (
            start,
            OpenWrite {
                writes: Some((self.clone(), id)),
            },
        )
    }

    /// The listing instant on `clock`: now, held back to one millisecond before the oldest open
    /// write's start, and never more than [`MAX_HOLD_BACK_US`] before now.
    pub fn listing_instant(&self, clock: &dyn Env) -> i64 {
        let registry = self.lock();
        let now = clock.now_micros();
        let oldest = registry.starts.values().min().copied();
        match oldest {
            Some(start) => now.min(start - 1_000).max(now - MAX_HOLD_BACK_US),
            None => now,
        }
    }

    /// The number of writes registered now (tests).
    pub fn open_count(&self) -> usize {
        self.lock().starts.len()
    }
}

/// One registered write; dropping it (or [`OpenWrite::release`]) removes the registration.
#[derive(Debug)]
pub struct OpenWrite {
    writes: Option<(Arc<OpenWrites>, u64)>,
}

impl OpenWrite {
    /// A guard that registers nothing (multi-user mode off).
    pub fn none() -> Self {
        OpenWrite { writes: None }
    }

    /// Removes the registration now.
    pub fn release(&mut self) {
        if let Some((writes, id)) = self.writes.take() {
            writes.lock().starts.remove(&id);
        }
    }
}

impl Drop for OpenWrite {
    fn drop(&mut self) {
        self.release();
    }
}

/// An explicit transaction's registration (multi-user mode): the start its clock uses and the
/// guard that keeps it registered until the transaction commits, rolls back or is dropped.
#[derive(Debug)]
pub(crate) struct Registration {
    start: Option<i64>,
    guard: Mutex<OpenWrite>,
}

impl Registration {
    /// Registers a transaction starting now on `clock` (multi-user mode).
    pub(crate) fn open(writes: &Arc<OpenWrites>, clock: &dyn Env) -> Self {
        let (start, guard) = writes.open(clock);
        Registration {
            start: Some(start),
            guard: Mutex::new(guard),
        }
    }

    /// No registration (multi-user mode off): the transaction's clock starts as before.
    pub(crate) fn none() -> Self {
        Registration {
            start: None,
            guard: Mutex::new(OpenWrite::none()),
        }
    }

    /// The start the transaction's clock uses, when registered.
    pub(crate) fn start(&self) -> Option<i64> {
        self.start
    }

    /// Removes the registration (the transaction ended).
    pub(crate) fn release(&self) {
        self.guard
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .release();
    }

    /// A guard that removes the registration when the enclosing call returns, on every path.
    pub(crate) fn release_at_exit(&self) -> ReleaseAtExit<'_> {
        ReleaseAtExit(self)
    }
}

/// Releases a [`Registration`] when dropped ([`Registration::release_at_exit`]).
pub(crate) struct ReleaseAtExit<'a>(&'a Registration);

impl Drop for ReleaseAtExit<'_> {
    fn drop(&mut self) {
        self.0.release();
    }
}

impl crate::Store {
    /// The writes registered as open on this brain now (multi-user mode; always 0 with it off).
    /// A diagnostic for tests of the listing instant (`cycle_window.rs`).
    pub fn open_write_count(&self) -> usize {
        self.open_writes.open_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Env;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct Clock(AtomicI64);
    impl Env for Clock {
        fn now_micros(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
        fn new_uuid(&self) -> String {
            String::new()
        }
    }

    #[test]
    fn the_instant_is_held_before_the_oldest_open_write_within_ten_minutes() {
        let clock = Clock(AtomicI64::new(100_000_000));
        let writes = Arc::new(OpenWrites::default());
        assert_eq!(writes.listing_instant(&clock), 100_000_000);
        let (start, mut first) = writes.open(&clock);
        assert_eq!(start, 100_000_000);
        clock.0.store(100_500_000, Ordering::SeqCst);
        let (_, second) = writes.open(&clock);
        clock.0.store(101_000_000, Ordering::SeqCst);
        assert_eq!(
            writes.listing_instant(&clock),
            99_999_000,
            "one millisecond before the oldest start"
        );
        first.release();
        assert_eq!(writes.listing_instant(&clock), 100_499_000);
        drop(second);
        assert_eq!(writes.listing_instant(&clock), 101_000_000);
        assert_eq!(writes.open_count(), 0);
        let (_, _stuck) = writes.open(&clock);
        clock
            .0
            .store(101_000_000 + MAX_HOLD_BACK_US + 7, Ordering::SeqCst);
        assert_eq!(
            writes.listing_instant(&clock),
            101_000_007,
            "never more than ten minutes back"
        );
    }
}
