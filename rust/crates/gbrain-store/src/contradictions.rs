//! Contradiction runs and the contradiction cache. Nothing is built yet: every member below still
//! refuses with `engine_capability_missing` in the TypeScript engine.
//!
//! Members: writeContradictionsRun, loadContradictionsTrend, getContradictionCacheEntry,
//! putContradictionCacheEntry, sweepContradictionCache.
//!
//! Keys: every record of this family starts with `keys::CONTRADICTIONS` (`Q`). The bytes after the
//! tag are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
