//! Facts and their supersession chains. No methods yet.
//!
//! Store methods for: insertFact, insertFacts, deleteFactsForPage, expireFact, listFactsByEntity,
//! listFactsSince, listFactsKeyset, listFactsBySession, listSupersessions,
//! countUnconsolidatedFacts, findCandidateDuplicates, consolidateFact, findTrajectory,
//! getFactsHealth, migrateFactsToCanonical.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::facts` module (see `pages.rs` in this directory
//! for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
