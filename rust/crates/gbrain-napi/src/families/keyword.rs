//! Keyword search members and title trigrams.
//!
//! Store methods for: findByTitleFuzzy. Still to come: countKeywordPages, searchKeywordPages,
//! searchTitles, searchKeywordChunks.
//!
//! One `#[napi] impl Brain` block per family file; each method decodes its arguments, runs one
//! `Store` call on the pool through `Brain::run`, and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

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
}
