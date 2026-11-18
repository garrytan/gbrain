//! Batch page reads and writes the pages capability still refuses. No methods yet.
//!
//! Store methods for: readPageSnapshotsBatch, findDuplicatePage, findDuplicatePages, deletePages,
//! resolveSlugsByPaths, softDeletePages, purgeDeletedPages, findPages, countPagesBy, getAllSlugs,
//! listAllPageRefs, listPrefixSampledPages, listCorpusSample, getContentFlagsByPageIds,
//! getUnverifiedExtractionPageIds, getPageTimestamps, getEffectiveDates, revertToVersion.
//!
//! Add them here as one `#[napi] impl Brain { ... }` block, each method a thin `self.run(env, move
//! |s| s.<method>(...))` over the `gbrain_store::page_ops` module (see `pages.rs` in this directory
//! for the pattern).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
