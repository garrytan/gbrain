//! The belief ledger's orphan lifetime read (rust/docs/store/collate-belief-reads.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listOrphanLifetimes(sourceId, limit, deep)`: `{ total, rows: [{ slug, page_lifetime, reason }] }`
    /// by slug and lifetime bytes; `reason` is `no_page`, or `no_lifetime` for the events a `deep` read finds.
    #[napi]
    pub fn list_orphan_lifetimes<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        limit: u32,
        deep: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_orphan_lifetimes(&source_id, limit as usize, deep)
        })
    }
}
