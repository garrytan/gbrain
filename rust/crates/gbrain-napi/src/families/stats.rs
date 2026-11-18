//! Brain statistics, health and the ingest log. No methods yet.
//!
//! Store methods for: getStats, getHealth, logIngest, getIngestLog, listEnrichCandidates,
//! findAnomalies.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::stats` module (see `pages.rs` in this directory
//! for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
