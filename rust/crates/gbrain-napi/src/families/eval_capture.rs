//! Captured eval candidates and capture failures. No methods yet.
//!
//! Store methods for: logEvalCandidate, listEvalCandidates, deleteEvalCandidatesBefore,
//! logEvalCaptureFailure, listEvalCaptureFailures.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::eval_capture` module (see `pages.rs` in this
//! directory for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
