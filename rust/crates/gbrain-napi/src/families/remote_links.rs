//! The remote links effect's edge reads and writes and its batch re-arm
//! (`src/core/engine-sql/remote-links.ts`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::persistence::LinksRearm;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readOwnedLinks(linkSource, originPageId)`: the edges the producer owns from the page, with each target's slug.
    #[napi]
    pub fn read_owned_links<'env>(
        &self,
        env: &'env Env,
        link_source: String,
        origin_page_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_owned_links(&link_source, &origin_page_id)
        })
    }

    /// `deleteOwnedLinks(originPageId, linkSource, ids)`: removes the owned edges among `ids`; returns how many.
    #[napi]
    pub fn delete_owned_links<'env>(
        &self,
        env: &'env Env,
        origin_page_id: String,
        link_source: String,
        ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_owned_links(&origin_page_id, &link_source, &ids)
        })
    }

    /// `readLinkTargetPages(sourceId, slugs, policy, honorAliases)`: the live pages among `slugs`, readable under
    /// `policy` (null: every page) and shown by the privacy part.
    #[napi]
    pub fn read_link_target_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        policy: Option<Value>,
        honor_aliases: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy: Option<PrivacyPolicy> = match policy {
                None | Some(Value::Null) => None,
                Some(v) => Some(required(v, "readLinkTargetPages policy")?),
            };
            s.read_link_target_pages(&source_id, &slugs, policy.as_ref(), honor_aliases)
        })
    }

    /// `rearmLinksEffects(spec)`: re-arms, once each, the `links` effects of requests published together.
    #[napi]
    pub fn rearm_links_effects<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.rearm_links_effects(&required::<LinksRearm>(spec, "rearmLinksEffects spec")?)
        })
    }
}
