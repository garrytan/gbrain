//! Slug renames and page aliases. Nothing is built yet: every member below still refuses with
//! `engine_capability_missing` in the TypeScript engine.
//!
//! Members: updateSlug, resolveSlugWithAlias, resolveSlugWithAliasDetailed, resolveAliases,
//! setPageAliases, updatePageContextualRetrievalState.
//!
//! Keys: every record of this family starts with `keys::ALIAS` (`k`). The bytes after the tag are
//! this file's to define; document them here.
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
/// yet: `contextual_retrieval_mode` reads as its `PAGE_ROW_DEFAULTS` value (`store-codec.ts`).
pub(crate) fn page_columns(
    _read: &dyn KvRead,
    _page: &PageRecord,
    _columns: &mut PageColumns,
) -> Result<()> {
    Ok(())
}

/// Deletes this family's records keyed by a source that is deleted (`cascade::remove_source_rows`).
/// Nothing to delete yet.
pub(crate) fn remove_source_rows(_tx: &mut dyn KvWrite, _source_id: &str) -> Result<()> {
    Ok(())
}
