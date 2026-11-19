//! Doctor reads over the `sources` table (store side: `gbrain_store::cli_reads::doctor_sources`, docs in
//! `rust/docs/store/cli-reads-doctor-src.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listDoctorSources()`: every source with the columns the doctor statements read, by id.
    #[napi]
    pub fn list_doctor_sources<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_doctor_sources())
    }

    /// `listSourceIdsWithLivePages()`: the ids of the sources that hold a live page, by id.
    #[napi]
    pub fn list_source_ids_with_live_pages<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_source_ids_with_live_pages())
    }

    /// `countDefaultSourceFiles()`: `{ live, file_backed }` for the `default` source's pages.
    #[napi]
    pub fn count_default_source_files<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_default_source_files())
    }
}
