//! The facts-home scan's reads (rust/docs/store/facts_home_reads.md).
//!
//! One `#[napi] impl Brain` block over `gbrain_store::facts::home_reads`; each method runs one `Store` call on the pool
//! through `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `scanUnfencedFactRows(sourceId)`: resolves the unfenced rows with their page flags.
    #[napi]
    pub fn scan_unfenced_fact_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.scan_unfenced_fact_rows(&source_id))
    }

    /// `listHeldFactRows(sourceId, days)`: resolves the held fence rows with their age.
    #[napi]
    pub fn list_held_fact_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        days: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_held_fact_rows(&source_id, &days))
    }

    /// `listFencedFactsOfMissingPages(sourceId)`: resolves `{ id, slug }` rows.
    #[napi]
    pub fn list_fenced_facts_of_missing_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_fenced_facts_of_missing_pages(&source_id)
        })
    }

    /// `readPageFileOrigin(sourceId, slug)`: resolves `{ source_path, source_uri }` or null.
    #[napi]
    pub fn read_page_file_origin<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_file_origin(&source_id, &slug))
    }
}
