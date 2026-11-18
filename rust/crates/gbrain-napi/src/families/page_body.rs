//! Segmented page bodies: segment texts, manifests, staging and derivations. No methods yet.
//!
//! Store methods for: allocateBodyOccurrenceIds, stageSegmentTexts, readSegmentTexts,
//! stageManifestRows, readManifest, stageSegmentChunks, createSegmentedPageShell,
//! flipBodyGeneration, openBodyStaging, setBodyStagingState, sweepSegments, readSegmentDerivations,
//! upsertSegmentDerivations, retireSegmentDerivations, refreshPageBody.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::page_body` module (see `pages.rs` in this
//! directory for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
