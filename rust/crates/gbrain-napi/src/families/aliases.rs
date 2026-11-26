//! Slug renames, slug aliases, page aliases and the contextual retrieval state of pages.
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
    /// `updateSlug(oldSlug, newSlug, sourceId?)`: resolves the number of pages moved (0 or 1).
    #[napi]
    pub fn update_slug<'env>(
        &self,
        env: &'env Env,
        old_slug: String,
        new_slug: String,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.update_slug(&old_slug, &new_slug, source_id.as_deref())
        })
    }

    /// `resolveSlugWithAliasDetailed(slug, sources)`: resolves `{ canonical_slug, source_id,
    /// matches }` for the first source in order that has the alias, or `null`.
    #[napi]
    pub fn resolve_slug_with_alias_detailed<'env>(
        &self,
        env: &'env Env,
        slug: String,
        sources: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let sources: Vec<String> = required(sources, "resolveSlugWithAliasDetailed sources")?;
            s.resolve_slug_with_alias_detailed(&slug, &sources)
        })
    }

    /// `listSlugAliases(sourceId)`: resolves every `{ alias_slug, canonical_slug }` row of the
    /// source, in alias byte order.
    #[napi]
    pub fn list_slug_aliases<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_slug_aliases(&source_id))
    }

    /// `resolveAliases(aliasNorms, { sourceId?, sourceIds?, excludePrivate?, minTrust?,
    /// suppressFlagged? }?)` (`AliasScope`): resolves `[aliasNorm, [{ slug, source_id }]]` pairs,
    /// aliases in order.
    #[napi]
    pub fn resolve_aliases<'env>(
        &self,
        env: &'env Env,
        alias_norms: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let alias_norms: Vec<String> = required(alias_norms, "resolveAliases aliasNorms")?;
            s.resolve_aliases(&alias_norms, &arg(options, "resolveAliases options")?)
        })
    }

    /// `aliasCanonicalRefs(refs, policy)`: resolves the `{ source_id, canonical_slug }` refs a
    /// `slug_aliases` row names (`AliasCanonicalQuery`).
    #[napi]
    pub fn alias_canonical_refs<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::aliases::AliasCanonicalQuery =
                required(query, "aliasCanonicalRefs query")?;
            s.alias_canonical_refs(&q)
        })
    }

    /// `setPageAliases(slug, sourceId, aliasNorms)`: replaces the page's frontmatter aliases.
    #[napi]
    pub fn set_page_aliases<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
        alias_norms: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let alias_norms: Vec<String> = required(alias_norms, "setPageAliases aliasNorms")?;
            s.set_page_aliases(&slug, &source_id, &alias_norms)
        })
    }

    /// `updatePageContextualRetrievalState(slug, sourceId, mode, corpusGeneration)`: stamps a live
    /// page's contextual retrieval state.
    #[napi]
    pub fn update_page_contextual_retrieval_state<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
        mode: String,
        corpus_generation: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.update_page_contextual_retrieval_state(
                &slug,
                &source_id,
                &mode,
                corpus_generation.as_deref(),
            )
        })
    }

    /// `replaceDerivedAliases(slug, sourceId, aliases)`: replaces the page's declared and subject
    /// alias rows with `aliases` (`[{ alias_norm, origin, case_sensitive, alias_text }]`).
    #[napi]
    pub fn replace_derived_aliases<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: String,
        aliases: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let aliases: Vec<gbrain_store::aliases::DerivedAliasRow> =
                required(aliases, "replaceDerivedAliases aliases")?;
            s.replace_derived_aliases(&slug, &source_id, &aliases)
        })
    }

    /// `listAliasTargets(sourceIds?)`: resolves `{ source_id, slug, page, page_aliases,
    /// slug_redirects }` for every alias target whose page is missing or soft-deleted, by source
    /// then slug in byte order; every source when `sourceIds` is null.
    #[napi]
    pub fn list_alias_targets<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let source_ids: Option<Vec<String>> = arg(source_ids, "listAliasTargets sourceIds")?;
            s.list_alias_targets(source_ids.as_deref())
        })
    }

    /// `deleteOrphanedAliases(sourceId, slug)`: resolves how many alias rows of both tables went;
    /// 0 when the slug has a page row, live or soft-deleted.
    #[napi]
    pub fn delete_orphaned_aliases<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_orphaned_aliases(&source_id, &slug))
    }
}
