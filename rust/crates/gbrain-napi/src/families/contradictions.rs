//! Contradiction runs and the contradiction cache. No methods yet.
//!
//! Store methods for: writeContradictionsRun, loadContradictionsTrend, getContradictionCacheEntry,
//! putContradictionCacheEntry, sweepContradictionCache.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::contradictions` module (see `pages.rs` in this
//! directory for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
