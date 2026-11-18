//! Keyword search members of the keyword_search capability, and title trigrams.
//!
//! Served: findByTitleFuzzy (`keyword/title_fuzzy.rs`), searchKeyword (`keyword/arm.rs`: the
//! arm's statement and the rare-word read its OR retry ranks with), searchKeywordChunks
//! (`keyword/chunk_search.rs`), countKeywordPages and searchKeywordPages (`keyword/page_search.rs`),
//! and searchTitles (`keyword/titles.rs`: the title arm's statements, over page vectors rebuilt
//! from the page, its timeline entries and the sealed search timeline), with the page and chunk
//! filters they share in `keyword/filters.rs`. The rebuilt chunk and page vectors are cached in
//! `keyword/vector_cache.rs` (bounded, keyed by the exact input text). rust/docs/store/keyword.md
//! lists what each member reads, refuses and leaves as a follow-up.
//!
//! This family also writes the `ts_rank` compatibility ranker (design D5) over the core keyword
//! postings (`keys::POSTING`, `T`); the facts keyword arm reuses it.
//!
//! Built: the pg_trgm scorer (`keyword/trgm.rs`), for findByTitleFuzzy here and for other
//! families (searchTakes). Its signatures and thresholds are stable:
//! `trgm_similarity`, `trgm_word_similarity`, `trgm_strict_word_similarity`, `trigrams` and
//! `TRGM_SIMILARITY_THRESHOLD` (0.3), `TRGM_WORD_SIMILARITY_THRESHOLD` (0.6),
//! `TRGM_STRICT_WORD_SIMILARITY_THRESHOLD` (0.5).
//!
//! Built: PostgreSQL full-text search for the `english` configuration (`keyword/tsearch.rs`) and
//! the `ts_rank` / `ts_rank_cd` rankers (`keyword/rank.rs`, design D5), ported from the PG 18 C
//! sources and checked against PGLite. The facts keyword arm (findCandidateDuplicates) and the
//! members here use them. Stable signatures:
//! `to_tsvector(&str) -> Result<TsVector>`, `setweight(TsVector, Weight) -> TsVector`,
//! `concat(&TsVector, &TsVector) -> Result<TsVector>`, `fts_input(&str) -> String`
//! (`gbrain_fts_input`), `plainto_tsquery` / `phraseto_tsquery` / `websearch_to_tsquery`
//! `(&str) -> Result<TsQuery>`, `or_of_lexemes(&TsQuery) -> Option<TsQuery>` (the facts
//! `replace(plainto::text, ' & ', ' | ')` query), `ts_matches(&TsVector, &TsQuery) -> bool` (`@@`),
//! `ts_rank(&TsVector, &TsQuery) -> f32`, `ts_rank_cd(&TsVector, &TsQuery) -> f32`, and
//! `to_text()` on both types. The core keyword postings (`keys::POSTING`, `T`) are unstemmed and
//! carry no positions or weights, so they can only narrow candidates; scores come from a
//! `TsVector` built from the row's text.
//!
//! Keys: every record of this family starts with `keys::TRIGRAM` (`R`). The bytes after the tag are
//! this file's to define; document them here. None are written yet.
//!
//! See docs/designs/RUST_ENGINE_INTERFACES.md.

mod arm;
mod chunk_search;
mod filters;
mod page_search;
mod parser;
mod rank;
mod stem;
mod title_fuzzy;
mod titles;
mod trgm;
mod tsearch;
mod vector_cache;

pub use filters::{AfterKey, DateBound, KeywordOptions};
pub use titles::{TitleAttempt, TitleAttemptKind};
pub(crate) use titles::{check_page_vector, check_sealed_page_vector};

#[allow(unused_imports)]
pub(crate) use rank::{ts_rank, ts_rank_cd};

/// The write-time half of `update_chunk_search_vector`: builds the chunk's `search_vector` and returns the error the
/// trigger would raise ("string is too long for tsvector") when it cannot be stored. The built vector is cached for the
/// searches that read the chunk next.
pub(crate) fn check_chunk_vector(chunk: &crate::chunks::ChunkRecord) -> crate::error::Result<()> {
    filters::chunk_vector(chunk).map(|_| ())
}
#[allow(unused_imports)]
pub(crate) use tsearch::{
    TsQuery, TsVector, Weight, concat, fts_input, or_of_lexemes, phraseto_tsquery, plainto_tsquery,
    setweight, to_tsvector, ts_matches, websearch_to_tsquery,
};

#[allow(unused_imports)]
pub(crate) use trgm::{
    TRGM_SIMILARITY_THRESHOLD, TRGM_STRICT_WORD_SIMILARITY_THRESHOLD,
    TRGM_WORD_SIMILARITY_THRESHOLD, trgm_similarity, trgm_strict_word_similarity,
    trgm_word_similarity, trigrams,
};

/// The page index hook (`page_index::reindex_page`): keeps this family's index of page fields in
/// step with a page write. Empty until this family indexes a page field.
pub(crate) fn reindex_page(
    _tx: &mut dyn crate::kv::KvWrite,
    _before: Option<&crate::pages::PageRecord>,
    _after: Option<&crate::pages::PageRecord>,
) -> crate::Result<()> {
    Ok(())
}
