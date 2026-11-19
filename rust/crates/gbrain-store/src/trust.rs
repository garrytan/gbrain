//! Trust: trust tiers and write provenance of pages, the write gate, trust review, fact withdrawal
//! and the belief ledger. Nothing is built yet: TypeScript reaches these tables through
//! `executeRaw`, which the Rust engine refuses.
//!
//! Keys: every record of this family starts with `keys::TRUST` (`t`). The bytes after the tag are
//! this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md ("trust").

/// Adds this family's `getPage` columns to a page (`page_columns::add_page_columns`), such as the
/// page's `trust_tier`. Adds none yet, so a page read is unchanged. Full paths keep this stub clear
/// of the imports this file will add.
pub(crate) fn page_columns(
    _read: &dyn crate::kv::KvRead,
    _page: &crate::pages::PageRecord,
    _columns: &mut crate::page_columns::PageColumns,
) -> crate::Result<()> {
    Ok(())
}
