//! A fake clock. Simulated code reads it instead of the wall clock; the scheduler advances it.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Debug, Default)]
pub struct SimClock(Arc<AtomicU64>);

impl SimClock {
    pub fn new() -> Self {
        Self::default()
    }
    /// Simulated nanoseconds since the start of the run.
    pub fn now_ns(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    pub fn advance_ns(&self, ns: u64) {
        self.0.fetch_add(ns, Ordering::SeqCst);
    }
}
