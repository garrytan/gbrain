//! Keyword search: `searchKeyword`, the keyword arm with the query as match and rank query.
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
    /// `searchKeyword(query, opts?)`: what `searchKeywordArm(query, query, opts?)` answers, the
    /// keyword arm over the live keyword index (`gbrain_store::search`).
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
