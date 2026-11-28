//! Keyword search members of the keyword_search capability, and title trigrams.
//!
//! Served: findByTitleFuzzy (`keyword/title_fuzzy.rs`), searchKeyword (`keyword/arm.rs`: the
//! arm's statement and the rare-word read its OR retry ranks with), searchKeywordChunks
//! (`keyword/chunk_search.rs`), countKeywordPages and searchKeywordPages (`keyword/page_search.rs`),
//! and searchTitles (`keyword/titles.rs`: the title arm's statements, over page vectors rebuilt
//! from the page, its timeline entries and the sealed search timeline), with the page and chunk
//! filters they share in `keyword/filters.rs`. A CJK query takes the substring path in
//! `keyword/cjk.rs` (searchKeyword, searchKeywordChunks) and `keyword/page_search.rs` (the paging
//! members); it scans the text chunks and reads no vector or posting. The rebuilt chunk and page
//! vectors are cached in
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
//! this file's to define; document them here. `R 0x00` is the keyword index state
//! (`keys::keyword_index_state`): while it exists, every `Store::write` handle tracks the chunks
//! and pages a write touches (`keyword/index_writer.rs`) and rebuilds their postings when the
//! statement ends. `R 0x01 len term page_id index` is a chunk posting and `R 0x02 len term
//! page_id` a page posting, each valued with the lexeme's positions and weights; `R 0x03 len
//! trigram page_id` holds one raw title trigram (`findByTitleFuzzy`); `R 0x04 len
//! basename page_id` maps a slug basename to its page; `R 0x05 page_id index` and `R 0x06
//! page_id` are the forward records that list a document's postings (`keyword/index.rs`). The
//! members read them through `keyword/walk.rs` once the state is complete.
//!
//! See docs/designs/RUST_ENGINE_INTERFACES.md.

mod arm;
mod chunk_search;
mod cjk;
mod entity_fuzzy;
mod filters;
mod frontmatter_ids;
mod index;
mod index_build;
mod index_health;
mod index_writer;
mod page_search;
pub(crate) mod parser;
mod rank;
mod stem;
pub(crate) mod stem_german;
mod title_fuzzy;
mod titles;
mod trgm;
mod tsearch;
mod vector_cache;
mod walk;

pub use cjk::{CjkBound, CjkKeywordResult, CjkRun, CjkTerm};
pub use filters::{AfterKey, DateBound, KeywordOptions};
pub(crate) use filters::{DateWindow, frontmatter_holds, parse_trust_floor};
pub(crate) use index::{
    StateRecord, read_state as read_index_state, read_state_record as read_index_state_record,
};
pub(crate) use index_build::{
    Builder, build_batch, open_index, reset as reset_index, seed_complete as seed_complete_index,
    verify as verify_index,
};
pub use index_build::{KeywordIndexReport, KeywordIndexState};
pub use index_health::{KeywordIndexHealth, KeywordIndexRebuild};
pub(crate) use index_health::{check as check_index_health, rebuild as rebuild_index};
pub(crate) use index_writer::IndexingWriter;
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
pub(crate) use stem::pg_lower;
#[allow(unused_imports)]
pub(crate) use tsearch::{
    FtsConfig, TsQuery, TsVector, Weight, concat, fts_input, or_of_lexemes, phraseto_tsquery,
    plainto_tsquery, plainto_tsquery_in, plainto_tsquery_simple, setweight, to_tsvector,
    to_tsvector_in, to_tsvector_simple, ts_matches, websearch_to_tsquery, with_query_stack,
};
#[cfg(test)]
pub(crate) use tsearch::{deep_spawns, reset_deep_spawns};

pub(crate) use title_fuzzy::{real_to_js, sql_ilike, sql_like};

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
