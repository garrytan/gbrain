//! Keyword search members the keyword_search capability still refuses, and title trigrams. Nothing
//! is built yet: every member below still refuses with `engine_capability_missing` in the
//! TypeScript engine.
//!
//! Members: countKeywordPages, searchKeywordPages, searchTitles, searchKeywordChunks,
//! findByTitleFuzzy.
//!
//! This family also writes the `ts_rank` compatibility ranker (design D5) over the core keyword
//! postings (`keys::POSTING`, `T`); the facts keyword arm reuses it.
//!
//! Keys: every record of this family starts with `keys::TRIGRAM` (`R`). The bytes after the tag are
//! this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.

/// The page index hook (`page_index::reindex_page`): keeps this family's index of page fields in
/// step with a page write. Empty until this family indexes a page field.
pub(crate) fn reindex_page(
    _tx: &mut dyn crate::kv::KvWrite,
    _before: Option<&crate::pages::PageRecord>,
    _after: Option<&crate::pages::PageRecord>,
) -> crate::Result<()> {
    Ok(())
}
