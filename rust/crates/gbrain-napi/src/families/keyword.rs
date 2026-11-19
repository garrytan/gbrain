//! Keyword search members and title trigrams.
//!
//! Store methods for: findByTitleFuzzy, searchKeyword (`searchKeywordArm` and
//! `keywordRareTermPages`), searchKeywordChunks, the CJK fallback of both (`searchKeywordCjk`), countKeywordPages, searchKeywordPages and
//! searchTitles (`searchTitlesAttempts`).
//!
//! One `#[napi] impl Brain` block per family file; each method decodes its arguments, runs one
//! `Store` call on the pool through `Brain::run`, and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `findByTitleFuzzy(name, dirPrefix?, minSimilarity?, sourceId?)`: `{ slug, similarity }` or
    /// `null`. `minSimilarity` absent means the default 0.55; the TypeScript member answers a
    /// `null` one itself.
    #[napi]
    pub fn find_by_title_fuzzy<'env>(
        &self,
        env: &'env Env,
        name: String,
        dir_prefix: Option<String>,
        min_similarity: Option<f64>,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_by_title_fuzzy(
                &name,
                dir_prefix.as_deref(),
                min_similarity,
                source_id.as_deref(),
            )
        })
    }

    /// `searchKeywordChunks(query, options?)`: `SearchResult[]` rows, one per matching chunk. The
    /// TypeScript member resolves every option first (`KeywordOptions`).
    #[napi]
    pub fn search_keyword_chunks<'env>(
        &self,
        env: &'env Env,
        query: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.search_keyword_chunks(&query, &arg(options, "searchKeywordChunks options")?)
        })
    }

    /// `searchKeywordCjk(query, options, run)`: the CJK fallback of searchKeyword (`run.dedup`)
    /// and searchKeywordChunks, `{ rows, capped, capHit }`. `run` carries the match terms, the OR
    /// fallback and the bounded arm's work bound (`CjkRun`).
    #[napi]
    pub fn search_keyword_cjk<'env>(
        &self,
        env: &'env Env,
        query: String,
        options: Option<Value>,
        run: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.search_keyword_cjk(
                &query,
                &arg(options, "searchKeywordCjk options")?,
                &required(run, "searchKeywordCjk run")?,
            )
        })
    }

    /// `countKeywordPages(query, options?)`: the pages the strict keyword match finds, at most
    /// 10001.
    #[napi]
    pub fn count_keyword_pages<'env>(
        &self,
        env: &'env Env,
        query: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_keyword_pages(&query, &arg(options, "countKeywordPages options")?)
        })
    }

    /// `searchKeywordPages(query, options?)`: one `SearchResult` row per page, best chunk. The
    /// window (`limit`, `offset`, `after`) travels in the options.
    #[napi]
    pub fn search_keyword_pages<'env>(
        &self,
        env: &'env Env,
        query: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.search_keyword_pages(&query, &arg(options, "searchKeywordPages options")?)
        })
    }

    /// `searchKeywordArm(matchQuery, rankQuery, options?)`: the keyword arm's statement, one
    /// `SearchResult` row per page. The TypeScript member runs it for the strict match and for
    /// each retry of `searchKeyword`.
    #[napi]
    pub fn search_keyword_arm<'env>(
        &self,
        env: &'env Env,
        match_query: String,
        rank_query: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.search_keyword_arm(
                &match_query,
                &rank_query,
                &arg(options, "searchKeywordArm options")?,
            )
        })
    }

    /// `keywordRareTermPages(terms, cap)`: per word, `{ term, chunks, page_ids }`
    /// (`rareTermPagesSql`).
    #[napi]
    pub fn keyword_rare_term_pages<'env>(
        &self,
        env: &'env Env,
        terms: Vec<String>,
        cap: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.keyword_rare_term_pages(&terms, cap))
    }

    /// `searchTitlesAttempts(attempts, exactKey, candidatesCap, options?)`: the title arm's
    /// statements over one read, per attempt `{ rows, cut }`. The TypeScript member runs the
    /// strict attempt and the OR fallback of `engine-sql/titles.ts` through it.
    #[napi]
    pub fn search_titles_attempts<'env>(
        &self,
        env: &'env Env,
        attempts: Value,
        exact_key: String,
        candidates_cap: f64,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let attempts: Vec<gbrain_store::keyword::TitleAttempt> =
                arg(Some(attempts), "searchTitlesAttempts attempts")?;
            s.search_titles_attempts(
                &attempts,
                &exact_key,
                candidates_cap,
                &arg(options, "searchTitlesAttempts options")?,
            )
        })
    }
}
