//! Keyword search (BM25; design D5).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `searchKeyword(query, opts?)`: `SearchResult[]`, one per page, best chunk first. Ranking is
    /// BM25, not the Postgres full-text rank; see the README.
    #[napi]
    pub fn search_keyword<'env>(
        &self,
        env: &'env Env,
        query: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.search_keyword(&query, &arg(options, "searchKeyword options")?)
        })
    }
}
