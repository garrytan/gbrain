//! The `page_purges` ledger (`gbrain-store` `facts::page_purges`, rust/docs/store/facts.md): the request ids of
//! recent purges for `listRecentPurgeRequests`, and the writer a purge will call.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listRecentPurgeRequests(days, cap)`: resolves the distinct request ids of the page purges of the last `days`.
    #[napi]
    pub fn list_recent_purge_requests<'env>(
        &self,
        env: &'env Env,
        days: i32,
        cap: i32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_recent_purge_requests(i64::from(days), i64::from(cap))
        })
    }

    /// `recordPagePurge(sourceId, contentHashes, slug, requestId)`: records the purge of a page; resolves null.
    #[napi]
    pub fn record_page_purge<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        content_hashes: Vec<String>,
        slug: String,
        request_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.record_page_purge(&source_id, &content_hashes, &slug, request_id.as_deref())
        })
    }
}
