//! Takes and synthesis evidence. No methods yet.
//!
//! Store methods for: addTakesBatch, listTakes, searchTakes, updateTake, supersedeTake,
//! resolveTake, getScorecard, getCalibrationCurve, addSynthesisEvidence, listActiveTakesForPages.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::takes` module (see `pages.rs` in this directory
//! for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
