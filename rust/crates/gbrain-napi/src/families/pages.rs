//! Pages: snapshots, writes, lists, slug resolution, soft delete, restore and delete.
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
    /// `readPageSnapshot(slug, { sourceId?, sourceIds?, includeDeleted? }?)`: `{ page, tags,
    /// revision, sourceIncarnation, withdrawals }` or `null`. Dates are ISO strings.
    #[napi]
    pub fn read_page_snapshot<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_snapshot(&slug, &arg(options, "readPageSnapshot options")?)
        })
    }

    /// `putPage(slug, page, { sourceId?, allowEmptyOverwrite?, expectedRevision?, force? }?)`: the
    /// stored `Page`. `expectedRevision` is absent, `null` or a revision UUID.
    #[napi]
    pub fn put_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        page: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.put_page(
                &slug,
                &required(page, "putPage page")?,
                &arg(options, "putPage options")?,
            )
        })
    }

    /// `listPages(filters?)`: `Page[]`.
    #[napi]
    pub fn list_pages<'env>(
        &self,
        env: &'env Env,
        filters: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_pages(&arg(filters, "listPages filters")?)
        })
    }

    /// `countPages({ sourceId? }?)`: the number of live pages.
    #[napi]
    pub fn count_pages<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "countPages options")?;
            s.count_pages(scope.source_id.as_deref())
        })
    }

    /// `lockPageKeys([{ sourceId, slug }])`: resolves `null`.
    #[napi]
    pub fn lock_page_keys<'env>(&self, env: &'env Env, keys: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.lock_page_keys(&required::<Vec<gbrain_store::pages::PageKey>>(
                keys,
                "lockPageKeys keys",
            )?)
        })
    }

    /// `resolveSlugs(partial, { sourceId?, sourceIds? }?)`: up to 5 slugs.
    #[napi]
    pub fn resolve_slugs<'env>(
        &self,
        env: &'env Env,
        partial: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.resolve_slugs(&partial, &arg(options, "resolveSlugs options")?)
        })
    }

    /// `softDeletePage(slug, { sourceId? }?)`: `{ slug }` or `null` when no live page matches.
    #[napi]
    pub fn soft_delete_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "softDeletePage options")?;
            Ok(s.soft_delete_page(&slug, scope.source_id.as_deref())?
                .map(|slug| serde_json::json!({ "slug": slug })))
        })
    }

    /// `restorePage(slug, { sourceId? }?)`: whether a deleted page came back.
    #[napi]
    pub fn restore_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "restorePage options")?;
            s.restore_page(&slug, scope.source_id.as_deref())
        })
    }

    /// `deletePage(slug, { sourceId? }?)`: removes the page for good. Resolves `null`.
    #[napi]
    pub fn delete_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "deletePage options")?;
            s.delete_page(&slug, scope.source_id.as_deref())
        })
    }
}
