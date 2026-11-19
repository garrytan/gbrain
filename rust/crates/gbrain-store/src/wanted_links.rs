//! Wanted links: the `wanted_links` table reads and writes that `listWantedPages` needs (authored
//! links whose target page does not exist; `src/core/wanted-links-store.ts`). Nothing is built yet:
//! TypeScript reaches the table through `executeRaw`, which the Rust engine refuses.
//!
//! Members: the `wanted_links` reads and writes of `listWantedPages`, `replaceWantedLinks`,
//! `possibleWantedRows` and `wantedReadAt`.
//!
//! Keys: records live under `keys::LINK_QUERIES` (`q`), which this family shares with
//! link_queries, as `q <origin source_id> 0x00 W <origin page id BE8> ...`. The bytes after `W`
//! are this file's to define; document them here. `link_queries::remove_source_rows` deletes
//! everything under `q <source> 0x00`, so it owns the source-delete cascade for these records too.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`;
/// Postgres `wanted_links.origin_page_id` is `ON DELETE CASCADE`). Nothing to delete yet. Full paths
/// keep this stub clear of the imports this file will add.
pub(crate) fn remove_page_rows(
    _tx: &mut dyn crate::kv::KvWrite,
    _page: &crate::pages::PageRecord,
) -> crate::Result<()> {
    Ok(())
}
