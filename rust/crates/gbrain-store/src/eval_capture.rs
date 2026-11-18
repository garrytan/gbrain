//! Captured eval candidates and capture failures. Nothing is built yet: every member below still
//! refuses with `engine_capability_missing` in the TypeScript engine.
//!
//! Members: logEvalCandidate, listEvalCandidates, deleteEvalCandidatesBefore,
//! logEvalCaptureFailure, listEvalCaptureFailures.
//!
//! Keys: every record of this family starts with `keys::EVAL_CAPTURE` (`Z`). The bytes after the
//! tag are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
