//! Test-only seed writes for the Rust arm of the parity suite. This file is compiled only with the
//! `test-seeds` feature, which the shipped addon build does not enable, so the default addon has
//! no `seedPageUpdatedAt` and no `seedPageOrigin` method (rust/docs/store/test-seeds.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `seedPageUpdatedAt(sourceId, slug, updatedAtUs)`: the page's `updated_at`, in microseconds.
    #[napi]
    pub fn seed_page_updated_at<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        updated_at_us: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.seed_page_updated_at(&source_id, &slug, updated_at_us)
        })
    }

    /// `seedPageOrigin(sourceId, slug, sourcePath, deletedAtUs)`: `null` clears a column.
    #[napi]
    pub fn seed_page_origin<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        source_path: Option<String>,
        deleted_at_us: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.seed_page_origin(&source_id, &slug, source_path.as_deref(), deleted_at_us)
        })
    }

    /// `seedBeliefPageLifetimes(sourceId, slugs)`: one open lifetime for each of the source's pages
    /// named, as `enableBeliefLedger` mints them; resolves the slugs it minted for.
    #[napi]
    pub fn seed_belief_page_lifetimes<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.seed_belief_page_lifetimes(&source_id, &slugs)
        })
    }
}
