//! Link and graph reads and writes beyond the core links family.
//!
//! Store methods for replaceDerivedLinks, replaceDerivedLinksBatch, removeLinksByPagesAndSource,
//! listLinkSources, getBacklinkCounts, getAdjacencyBoosts, relationalFanout, relationalChainHop
//! and findOrphanPages, and the search-reads link reads hasSupersedeEdges, supersedingPageSlugs
//! and pagesLinkingTo. rewriteLinks needs no store call. The link reads of
//! src/core/engine-sql/link-reads.ts: inboundLinkCoverage, listJunkEntityHubs, countEntityPages,
//! entityGraphCoverage, entityFeatureCoverage, countDatedMeetingPages, countForeignEdges, listLivePageSummaries, countInboundLinks, readEntityInboundEdges,
//! listLinkEndpointPages, listPagesTitledIn and wordLexemes, each with one JSON input.
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

    /// `inboundLinkCoverage(input)`: `{ livePages, linkedPages }`.
    #[napi]
    pub fn inbound_link_coverage<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::InboundCoverageInput =
                arg(input, "inboundLinkCoverage input")?;
            s.inbound_link_coverage(&input)
        })
    }

    /// `listJunkEntityHubs(input)`: the hub rows, most edges first.
    #[napi]
    pub fn list_junk_entity_hubs<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::JunkHubsInput =
                arg(input, "listJunkEntityHubs input")?;
            s.list_junk_entity_hubs(&input)
        })
    }

    /// `countEntityPages(input)`: a count.
    #[napi]
    pub fn count_entity_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::EntityPagesInput =
                arg(input, "countEntityPages input")?;
            s.count_entity_pages(&input)
        })
    }

    /// `entityGraphCoverage(input)`: `{ entities, connected, timeline }`.
    #[napi]
    pub fn entity_graph_coverage<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::EntityPagesInput =
                arg(input, "entityGraphCoverage input")?;
            s.entity_graph_coverage(&input)
        })
    }

    /// `entityFeatureCoverage(input)`: `{ sampleSize, matched }`.
    #[napi]
    pub fn entity_feature_coverage<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::FeatureCoverageInput =
                arg(input, "entityFeatureCoverage input")?;
            s.entity_feature_coverage(&input)
        })
    }

    /// `countDatedMeetingPages()`: a count.
    #[napi]
    pub fn count_dated_meeting_pages<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_dated_meeting_pages())
    }

    /// `countForeignEdges(input)`: a count.
    #[napi]
    pub fn count_foreign_edges<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ForeignEdgesInput =
                arg(input, "countForeignEdges input")?;
            s.count_foreign_edges(&input)
        })
    }

    /// `listLivePageSummaries(input)`: `[{ slug, type, quarantined }]`.
    #[napi]
    pub fn list_live_page_summaries<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::GraphScope =
                arg(input, "listLivePageSummaries input")?;
            s.list_live_page_summaries(&input)
        })
    }

    /// `countInboundLinks(input)`: a count.
    #[napi]
    pub fn count_inbound_links<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::InboundCountInput =
                arg(input, "countInboundLinks input")?;
            s.count_inbound_links(&input)
        })
    }

    /// `readEntityInboundEdges(input)`: the entity card's inbound edge rows.
    #[napi]
    pub fn read_entity_inbound_edges<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::InboundCountInput =
                arg(input, "readEntityInboundEdges input")?;
            s.read_entity_inbound_edges(&input)
        })
    }

    /// `listLinkEndpointPages(input)`: the endpoint page rows.
    #[napi]
    pub fn list_link_endpoint_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::EndpointsInput =
                arg(input, "listLinkEndpointPages input")?;
            s.list_link_endpoint_pages(&input)
        })
    }

    /// `listPagesTitledIn(input)`: `[{ id, slug, title, type, source_id }]`.
    #[napi]
    pub fn list_pages_titled_in<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::TitledInput =
                arg(input, "listPagesTitledIn input")?;
            s.list_pages_titled_in(&input)
        })
    }

    /// `probePageTypes(input)`: `{ present, available }`.
    #[napi]
    pub fn probe_page_types<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::TypeProbeInput =
                arg(input, "probePageTypes input")?;
            s.probe_page_types(&input)
        })
    }

    /// `readLongPageSizes(input)`: `[{ id, chars, bytes }]`.
    #[napi]
    pub fn read_long_page_sizes<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::LongPageSizeInput =
                arg(input, "readLongPageSizes input")?;
            s.read_long_page_sizes(&input)
        })
    }

    /// `wordLexemes(words)`: `[{ w, lexemes }]`.
    #[napi]
    pub fn word_lexemes<'env>(
        &self,
        env: &'env Env,
        words: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let words: Vec<String> = arg(words, "wordLexemes words")?;
            s.word_lexemes(&words)
        })
    }

    /// `readLinkContextMatches(asks)`: `[{ i, link_source, context, page_id }]`.
    #[napi]
    pub fn read_link_context_matches<'env>(
        &self,
        env: &'env Env,
        asks: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let asks: Vec<gbrain_store::link_queries::LinkContextAsk> =
                arg(asks, "readLinkContextMatches asks")?;
            s.read_link_context_matches(&asks)
        })
    }

    /// `readLinkContextOriginPages(ids)`: `[{ id, source_id, slug, compiled_truth, timeline }]`.
    #[napi]
    pub fn read_link_context_origin_pages<'env>(
        &self,
        env: &'env Env,
        ids: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<u64> = arg(ids, "readLinkContextOriginPages ids")?;
            s.read_link_context_origin_pages(&ids)
        })
    }
}
