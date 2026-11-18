//! Links between pages.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `addLink(from, to, { context?, linkType?, linkSource?, originSlug?, originField?,
    /// fromSourceId?, toSourceId?, originSourceId? }?)`: the positional arguments of the engine
    /// method as one object. Resolves `null`; `page_not_found` names the missing endpoint.
    #[napi]
    pub fn add_link<'env>(
        &self,
        env: &'env Env,
        from: String,
        to: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.add_link(&from, &to, &arg(options, "addLink options")?)
        })
    }

    /// `addLinksBatch(links)`: resolves the number of links inserted.
    #[napi]
    pub fn add_links_batch<'env>(
        &self,
        env: &'env Env,
        links: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let links: Vec<gbrain_store::links::LinkBatchInput> =
                required(links, "addLinksBatch links")?;
            s.add_links_batch(&links)
        })
    }

    /// `removeLink(from, to, { linkType?, linkSource?, fromSourceId?, toSourceId? }?)`: resolves
    /// the number of links deleted. A key set to `null` is a `null` filter, not a missing one.
    #[napi]
    pub fn remove_link<'env>(
        &self,
        env: &'env Env,
        from: String,
        to: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.remove_link(&from, &to, &arg(options, "removeLink options")?)
        })
    }

    /// `getLinks(slug, { sourceId?, sourceIds? }?)`: `Link[]` in link id order.
    #[napi]
    pub fn get_links<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_links(&slug, &arg(options, "getLinks options")?)
        })
    }

    /// `getBacklinks(slug, { sourceId?, sourceIds? }?)`: `Link[]` in link id order.
    #[napi]
    pub fn get_backlinks<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_backlinks(&slug, &arg(options, "getBacklinks options")?)
        })
    }
}
