//! Tags on a page.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `getTags(slug, { sourceId?, sourceIds? }?)`: sorted tags.
    #[napi]
    pub fn get_tags<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_tags(&slug, &arg(options, "getTags options")?)
        })
    }

    /// `addTag(slug, tag, { sourceId? }?)`: resolves `null`; `page_not_found` for a missing page.
    #[napi]
    pub fn add_tag<'env>(
        &self,
        env: &'env Env,
        slug: String,
        tag: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "addTag options")?;
            s.add_tag(&slug, &tag, scope.source_id.as_deref())
        })
    }

    /// `removeTag(slug, tag, { sourceId? }?)`: resolves `null`.
    #[napi]
    pub fn remove_tag<'env>(
        &self,
        env: &'env Env,
        slug: String,
        tag: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "removeTag options")?;
            s.remove_tag(&slug, &tag, scope.source_id.as_deref())
        })
    }
}
