//! Tags on a page.
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

    /// `addTag(slug, tag, { sourceId?, tagSource? }?)`: resolves `null`; `page_not_found` for a
    /// missing page.
    #[napi]
    pub fn add_tag<'env>(
        &self,
        env: &'env Env,
        slug: String,
        tag: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: gbrain_store::pages::TagOptions = arg(options, "addTag options")?;
            s.add_tag_claimed(&slug, &tag, opts.source_id.as_deref(), opts.frontmatter()?)
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

    /// `pruneFrontmatterTags(slug, keep, { sourceId? }?)`: resolves `null`.
    #[napi]
    pub fn prune_frontmatter_tags<'env>(
        &self,
        env: &'env Env,
        slug: String,
        keep: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let keep: Vec<String> = required(keep, "pruneFrontmatterTags keep")?;
            let scope: gbrain_store::pages::ReadScope =
                arg(options, "pruneFrontmatterTags options")?;
            s.prune_frontmatter_tags(&slug, &keep, scope.source_id.as_deref())
        })
    }

    /// `addPageTagsById(pageId, tags, { tagSource? }?)`: resolves `null`; `page_not_found` when no
    /// page has the id.
    #[napi]
    pub fn add_page_tags_by_id<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        tags: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "addPageTagsById pageId")?;
            let tags: Vec<String> = required(tags, "addPageTagsById tags")?;
            let opts: gbrain_store::pages::TagOptions = arg(options, "addPageTagsById options")?;
            s.add_page_tags_by_id(page_id, &tags, opts.frontmatter()?)
        })
    }
}
