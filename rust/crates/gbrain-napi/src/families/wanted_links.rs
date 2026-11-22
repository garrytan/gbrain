//! Wanted links (gbrain-store `wanted_links`): the registered-source check, the per-origin row
//! replace and the store read of `listWantedPages`.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use gbrain_store::wanted_links::WantedLinkOrigin;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `lockRegisteredSourceIds(sourceIds)`: the registered ids among `sourceIds`, sorted.
    #[napi]
    pub fn lock_registered_source_ids<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.lock_registered_source_ids(&required::<Vec<String>>(
                source_ids,
                "lockRegisteredSourceIds sourceIds",
            )?)
        })
    }

    /// `replaceWantedLinkRows({ pageId, sourceId }, { rows, producers, readAt? })`: the number of
    /// rows written.
    #[napi]
    pub fn replace_wanted_link_rows<'env>(
        &self,
        env: &'env Env,
        origin: Value,
        replacement: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let origin: WantedLinkOrigin = required(origin, "replaceWantedLinkRows origin")?;
            s.replace_wanted_link_rows(
                origin.page_id,
                &origin.source_id,
                &required(replacement, "replaceWantedLinkRows replacement")?,
            )
        })
    }

    /// `listWantedPages({ sourceId?, sourceIds?, excludePrivate?, limit, offset })`:
    /// `{ total, rows }` with every row in its final `WantedPageRow` shape.
    #[napi]
    pub fn list_wanted_pages<'env>(
        &self,
        env: &'env Env,
        query: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_wanted_pages(&arg(query, "listWantedPages options")?)
        })
    }
}
