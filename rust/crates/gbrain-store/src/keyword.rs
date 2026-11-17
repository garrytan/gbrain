//! Keyword search members the keyword_search capability still refuses, and title trigrams. The
//! members are not built yet: each still refuses with `engine_capability_missing` in the
//! TypeScript engine.
//!
//! Members: countKeywordPages, searchKeywordPages, searchTitles, searchKeywordChunks,
//! findByTitleFuzzy.
//!
//! Built: the pg_trgm scorer (`keyword/trgm.rs`), for findByTitleFuzzy here and for other
//! families (searchTakes). Its signatures and thresholds are stable:
//! `trgm_similarity`, `trgm_word_similarity`, `trgm_strict_word_similarity`, `trigrams` and
//! `TRGM_SIMILARITY_THRESHOLD` (0.3), `TRGM_WORD_SIMILARITY_THRESHOLD` (0.6),
//! `TRGM_STRICT_WORD_SIMILARITY_THRESHOLD` (0.5).
//!
//! Keys: every record of this family starts with `keys::TRIGRAM` (`R`). The bytes after the tag are
//! this file's to define; document them here. None are written yet.
//!
//! See docs/designs/RUST_ENGINE_INTERFACES.md.

mod trgm;

#[allow(unused_imports)]
pub(crate) use trgm::{
    TRGM_SIMILARITY_THRESHOLD, TRGM_STRICT_WORD_SIMILARITY_THRESHOLD,
    TRGM_WORD_SIMILARITY_THRESHOLD, trgm_similarity, trgm_strict_word_similarity,
    trgm_word_similarity, trigrams,
};
