//! Keyword search members and title trigrams.
//!
//! Store methods for: findByTitleFuzzy, searchKeywordChunks, countKeywordPages and
//! searchKeywordPages. Still to come: searchTitles.
//!
//! One `#[napi] impl Brain` block per family file; each method decodes its arguments, runs one
//! `Store` call on the pool through `Brain::run`, and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};

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
}
