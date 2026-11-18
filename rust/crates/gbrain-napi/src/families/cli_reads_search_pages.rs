//! The page reads of hybrid search's ranking stage (gbrain-store `cli_reads::search_reads_pages`):
//! the bare-slug suffix lookup, the generated pages among ids and the live page ids at refs.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `slugsEndingIn(sourceId, word)`: up to two live slugs equal to `word` or ending in `/word`.
    #[napi]
    pub fn slugs_ending_in<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        word: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.slugs_ending_in(&source_id, &word))
    }

    /// `generatedPagesIn(ids)`: `{ id, frontmatter, compiled_truth }` of the generated pages among `ids`.
    #[napi]
    pub fn generated_pages_in<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.generated_pages_in(&required::<Vec<i64>>(ids, "generatedPagesIn ids")?)
        })
    }

    /// `livePageIdsAt(refs)`: the ids of the live pages at `{ slug, source_id }` refs.
    #[napi]
    pub fn live_page_ids_at<'env>(
        &self,
        env: &'env Env,
        refs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.live_page_ids_at(&required::<Vec<_>>(refs, "livePageIdsAt refs")?)
        })
    }
}
