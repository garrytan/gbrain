//! Brain statistics, health and the ingest log. Nothing is built yet: every member below still
//! refuses with `engine_capability_missing` in the TypeScript engine.
//!
//! Members: getStats, getHealth, logIngest, getIngestLog, listEnrichCandidates, findAnomalies.
//!
//! Keys: every record of this family starts with `keys::INGEST_LOG` (`n`). The bytes after the tag
//! are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
