//! Emotional weight and salience of pages. No methods yet.
//!
//! Store methods for: batchLoadEmotionalInputs, setEmotionalWeightBatch, getRecentSalience,
//! getSalienceScores.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::salience` module (see `pages.rs` in this directory
//! for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
