//! Keyword search members the keyword_search capability still refuses, and title trigrams. Nothing
//! is built yet: every member below still refuses with `engine_capability_missing` in the
//! TypeScript engine.
//!
//! Members: countKeywordPages, searchKeywordPages, searchTitles, searchKeywordChunks,
//! findByTitleFuzzy.
//!
//! Keys: every record of this family starts with `keys::TRIGRAM` (`R`). The bytes after the tag are
//! this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
