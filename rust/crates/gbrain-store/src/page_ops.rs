//! Batch page reads and writes the pages capability still refuses. Nothing is built yet: every
//! member below still refuses with `engine_capability_missing` in the TypeScript engine.
//!
//! Members: readPageSnapshotsBatch, findDuplicatePage, findDuplicatePages, deletePages,
//! resolveSlugsByPaths, softDeletePages, purgeDeletedPages, findPages, countPagesBy, getAllSlugs,
//! listAllPageRefs, listPrefixSampledPages, listCorpusSample, getContentFlagsByPageIds,
//! getUnverifiedExtractionPageIds, getPageTimestamps, getEffectiveDates, revertToVersion.
//!
//! Keys: every record of this family starts with `keys::PAGE_OPS` (`p`). The bytes after the tag
//! are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
