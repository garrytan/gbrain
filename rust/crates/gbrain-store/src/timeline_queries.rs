//! Timeline reads by date and event projections. Nothing is built yet: every member below still
//! refuses with `engine_capability_missing` in the TypeScript engine.
//!
//! Members: getTimelineForDate, getSince, getOnThisDay, getLastSeen, upsertEventProjection.
//!
//! Keys: every record of this family starts with `keys::TIMELINE_QUERIES` (`u`). The bytes after
//! the tag are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
