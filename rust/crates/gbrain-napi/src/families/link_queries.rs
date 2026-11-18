//! Link and graph reads and writes beyond the core links family.
//!
//! Store methods for replaceDerivedLinks, replaceDerivedLinksBatch, removeLinksByPagesAndSource,
//! listLinkSources, getBacklinkCounts, getAdjacencyBoosts, relationalFanout, relationalChainHop
//! and findOrphanPages, and the search-reads link reads hasSupersedeEdges, supersedingPageSlugs
//! and pagesLinkingTo. rewriteLinks needs no store call.
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
    /// `replaceDerivedLinks` / `replaceDerivedLinksBatch(items)`: the normalized origins, all in
    /// one transaction; `[{ created, removed }]`.
    #[napi]
    pub fn replace_derived_links<'env>(
        &self,
        env: &'env Env,
        items: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let items: Vec<gbrain_store::link_queries::DerivedItem> =
                arg(items, "replaceDerivedLinks items")?;
            s.replace_derived_links(&items)
        })
    }

    /// `removeLinksByPagesAndSource(pages, { linkSource, keepTypedNerPairs })`: a count.
    #[napi]
    pub fn remove_links_by_pages_and_source<'env>(
        &self,
        env: &'env Env,
        pages: Option<Value>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let pages: Vec<gbrain_store::link_queries::PageRef> =
                arg(pages, "removeLinksByPagesAndSource pages")?;
            s.remove_links_by_pages_and_source(
                &pages,
                &arg(options, "removeLinksByPagesAndSource options")?,
            )
        })
    }

    /// `listLinkSources({ sourceId?, sourceIds? })`: `[{ link_source, count }]`.
    #[napi]
    pub fn list_link_sources<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_link_sources(&arg(options, "listLinkSources options")?)
        })
    }

    /// `getBacklinkCounts(ids, { sourceId?, sourceIds?, scoped })`: `[{ page_id, cnt }]`.
    #[napi]
    pub fn get_backlink_counts<'env>(
        &self,
        env: &'env Env,
        ids: Option<Value>,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<u64> = arg(ids, "getBacklinkCounts ids")?;
            s.get_backlink_counts(&ids, &arg(scope, "getBacklinkCounts scope")?)
        })
    }

    /// `getAdjacencyBoosts(ids, { sourceId?, sourceIds?, scoped })`: `[{ to_page_id, hits,
    /// cross_source_hits }]`.
    #[napi]
    pub fn get_adjacency_boosts<'env>(
        &self,
        env: &'env Env,
        ids: Option<Value>,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<u64> = arg(ids, "getAdjacencyBoosts ids")?;
            s.get_adjacency_boosts(&ids, &arg(scope, "getAdjacencyBoosts scope")?)
        })
    }

    /// `relationalFanout(seeds, opts)`: `RelationalFanoutRow[]`.
    #[napi]
    pub fn relational_fanout<'env>(
        &self,
        env: &'env Env,
        seeds: Option<Value>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let seeds: Vec<String> = arg(seeds, "relationalFanout seeds")?;
            s.relational_fanout(&seeds, &arg(options, "relationalFanout options")?)
        })
    }

    /// `relationalChainHop(frontier, opts)`: `ChainHopEdge[]`.
    #[napi]
    pub fn relational_chain_hop<'env>(
        &self,
        env: &'env Env,
        frontier: Option<Value>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let frontier: Vec<u64> = arg(frontier, "relationalChainHop frontier")?;
            s.relational_chain_hop(&frontier, &arg(options, "relationalChainHop options")?)
        })
    }

    /// `findOrphanPages(opts)`: the orphan rows, ordered by slug.
    #[napi]
    pub fn find_orphan_pages<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_orphan_pages(&arg(options, "findOrphanPages options")?)
        })
    }

    /// `hasSupersedeEdges()`: whether any `supersedes` link exists.
    #[napi]
    pub fn has_supersede_edges<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_supersede_edges())
    }

    /// `supersedingPageSlugs(ids, { sourceId?, sourceIds?, scoped })`: `[{ to_page_id, by_slug }]`.
    #[napi]
    pub fn superseding_page_slugs<'env>(
        &self,
        env: &'env Env,
        ids: Option<Value>,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<u64> = arg(ids, "supersedingPageSlugs ids")?;
            s.superseding_page_slugs(&ids, &arg(scope, "supersedingPageSlugs scope")?)
        })
    }

    /// `pagesLinkingTo(fromIds, toIds)`: the linking page ids, ascending.
    #[napi]
    pub fn pages_linking_to<'env>(
        &self,
        env: &'env Env,
        from_ids: Option<Value>,
        to_ids: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let from_ids: Vec<u64> = arg(from_ids, "pagesLinkingTo fromIds")?;
            let to_ids: Vec<u64> = arg(to_ids, "pagesLinkingTo toIds")?;
            s.pages_linking_to(&from_ids, &to_ids)
        })
    }
}
