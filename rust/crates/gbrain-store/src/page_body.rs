//! Segmented page bodies: segment texts, manifests, staging and derivations. Nothing is built yet:
//! every member below still refuses with `engine_capability_missing` in the TypeScript engine.
//!
//! Members: allocateBodyOccurrenceIds, stageSegmentTexts, readSegmentTexts, stageManifestRows,
//! readManifest, stageSegmentChunks, createSegmentedPageShell, flipBodyGeneration, openBodyStaging,
//! setBodyStagingState, sweepSegments, readSegmentDerivations, upsertSegmentDerivations,
//! retireSegmentDerivations, refreshPageBody.
//!
//! Keys: every record of this family starts with `keys::PAGE_BODY` (`b`). The bytes after the tag
//! are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.

use crate::Result;
use crate::kv::{KvRead, KvWrite};
use crate::page_columns::PageColumns;
use crate::pages::PageRecord;

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`).
/// Nothing to delete yet.
pub(crate) fn remove_page_rows(_tx: &mut dyn KvWrite, _page: &PageRecord) -> Result<()> {
    Ok(())
}

/// Adds this family's `getPage` columns to a page (`page_columns::add_page_columns`). Adds none
/// yet: a segmented page's `body_storage` and `body_bytes` belong here.
pub(crate) fn page_columns(
    _read: &dyn KvRead,
    _page: &PageRecord,
    _columns: &mut PageColumns,
) -> Result<()> {
    Ok(())
}
