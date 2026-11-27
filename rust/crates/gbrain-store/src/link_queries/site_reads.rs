//! The link reads of `src/core/engine-sql/link-reads.ts`: the graph counts and endpoint reads
//! that doctor, orphans, graph-query, the entity card, automatic link preparation and two search
//! stages ran through `engine.executeRaw`.
//!
//! Members: inboundLinkCoverage, listJunkEntityHubs, countEntityPages, entityGraphCoverage,
//! entityFeatureCoverage, countDatedMeetingPages,
//! countForeignEdges, listLivePageSummaries, countInboundLinks, listLinkEndpointPages,
//! listPagesTitledIn, wordLexemes, readLinkContextMatches, readLinkContextOriginPages, and the
//! search type-filter probe probePageTypes and the long-page size preflight readLongPageSizes
//! (src/core/engine-sql/cli-reads-ops.ts).
//! readEntityInboundEdges reads the links countInboundLinks counts (`kept_inbound_links`), with
//! their temporal columns, in link_temporal.rs.
//!
//! Each method reads what its statement reads and keeps the statement's tests: a "live" page here
//! is `deleted_at IS NULL` alone unless the statement also asks for `pageReadFilter(.., live)`.
//! Where the SQL leaves the row order to the plan, the order is named on the method.

use super::{GraphScope, Pages, QUARANTINE_KEY, all_links, not_mentions, touching};
use crate::Store;
use crate::chunk_queries::safe_chunks;
use crate::chunks::read_chunks;
use crate::cli_reads::pg_text::is_pg_space;
use crate::error::{Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::links::{LinkRecord, in_links, out_links};
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::sources::{SourceRecord, all_sources};
use crate::stats::EntityTypeFilter;
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

/// The slug prefix of gbrain's own test fixtures (`entityGraphCoverage`).
const TEST_FIXTURE_PREFIX: &str = "tools/gbrain/test/";
/// The person template page (`entityGraphCoverage`).
const PERSON_TEMPLATE: &str = "templates/new-person";

/// `inboundLinkCoverage({ sourceIds? })`. `sourceIds` present (even empty) filters by it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InboundCoverageInput {
    pub source_ids: Option<Vec<String>>,
}

/// `listJunkEntityHubs({ edgeThreshold, maxChunks, limit })` plus `CONNECTOR_SOURCE_KINDS`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct JunkHubsInput {
    pub edge_threshold: i64,
    pub max_chunks: i64,
    pub limit: u64,
    pub connector_kinds: Vec<String>,
}

/// `countEntityPages(filter, { sourceId?, excludeQuarantined? })` and `entityGraphCoverage(filter)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EntityPagesInput {
    pub filter: EntityTypeFilter,
    pub source_id: Option<String>,
    pub exclude_quarantined: bool,
}

/// `entityFeatureCoverage(filter, feature)`: `feature` is `links` (an inbound link) or `timeline`
/// (a timeline entry). The store has no TABLESAMPLE; the TypeScript member refuses a sample.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FeatureCoverageInput {
    pub filter: EntityTypeFilter,
    pub feature: String,
}

/// `countForeignEdges(slug, sourceId, direction)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ForeignEdgesInput {
    pub slug: String,
    pub source_id: String,
    pub direction: String,
}

/// `countInboundLinks(slug, sourceId, { excludePrivate, originSameSource })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InboundCountInput {
    pub slug: String,
    pub source_id: String,
    pub exclude_private: Option<PrivacyPolicy>,
    pub origin_same_source: bool,
}

/// `listLinkEndpointPages(sourceId, slugs, crossSourceSlugs)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EndpointsInput {
    pub source_id: String,
    pub slugs: Vec<String>,
    pub cross_source_slugs: Vec<String>,
}

/// `listPagesTitledIn(queryLower, scope)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TitledInput {
    pub query_lower: String,
    pub scope: GraphScope,
}

/// `probePageTypes(sets, scope)`: one type set per requested type.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TypeProbeInput {
    pub sets: Vec<Vec<String>>,
    pub scope: GraphScope,
}

/// The input of `readLongPageSizes(ids, scope, { includeTimeline })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LongPageSizeInput {
    pub ids: Vec<i64>,
    pub scope: GraphScope,
    /// `requiresSafeChunks(scope)`: the page must pass `safeChunksFilter`.
    pub safe_chunks: bool,
    /// The timeline counts (every detail but `low`).
    pub include_timeline: bool,
}

/// `TIMELINE_SEPARATOR.length` of `src/core/page-window/document.ts` (ASCII, so also its bytes).
const TIMELINE_SEPARATOR_LEN: usize = "\n\n<!-- timeline -->\n\n".len();
/// `ACTIVATION_SERVED_REVISION` of `src/core/search/safe-chunks.ts`.
const ACTIVATION_SERVED_REVISION: &str = "00000000-0000-0000-0000-000000000153";

/// `servedTextProjectionFilter`: the current projection, or the pre-activation marker.
fn served(page: &PageRecord) -> bool {
    page.text_projection_revision
        .as_deref()
        .is_some_and(|rev| rev == page.knowledge_revision || rev == ACTIVATION_SERVED_REVISION)
}

/// The most distinct types the probe lists (`LIMIT 500`).
const PROBE_TYPE_LIMIT: usize = 500;

/// One ask of `readLinkContextMatches(asks)`: a returned link context, its row index and the
/// stored edge it came from.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LinkContextAsk {
    pub i: i64,
    pub from_source_id: String,
    pub from_slug: String,
    pub to_source_id: String,
    pub to_slug: String,
    pub link_type: String,
    pub context: String,
}

/// The ellipsis a read appends to a truncated link context.
const ELLIPSIS: char = '\u{2026}';

/// The context test of `readLinkContextMatches`: `l.context = ctx`, or, for a `ctx` that ends in
/// the ellipsis, `left(l.context, n - 1) = left(ctx, n - 1)` with `n` the length of `ctx` in
/// characters.
fn context_matches(stored: &str, ctx: &str) -> bool {
    if stored == ctx {
        return true;
    }
    if !ctx.ends_with(ELLIPSIS) {
        return false;
    }
    let n = ctx.chars().count() - 1;
    stored.chars().take(n).eq(ctx.chars().take(n))
}

/// `->>` of a frontmatter key.
fn field_text(page: &PageRecord, key: &str) -> Option<String> {
    page.frontmatter.get(key).and_then(jsonb_field_text)
}

/// `s.config ->> 'kind'`.
fn source_kind(source: Option<&SourceRecord>) -> Option<String> {
    source
        .and_then(|s| s.config.get("kind"))
        .and_then(jsonb_field_text)
}

/// `entityTypePredicateSql(alias, filter)`: the source's own list when it has one, else `types`.
fn is_entity(filter: &EntityTypeFilter, page: &PageRecord) -> bool {
    filter
        .per_source
        .iter()
        .find(|b| b.source_id == page.source_id)
        .map_or(&filter.types, |b| &b.types)
        .contains(&page.page_type)
}

/// The inbound links `countInboundLinks` counts and `readEntityInboundEdges` reads, each with its
/// referrer's slug, in link id order.
pub(super) fn kept_inbound_links(
    read: &dyn KvRead,
    input: &InboundCountInput,
) -> Result<Vec<(LinkRecord, String)>> {
    let Some(target) = read_page(read, &input.source_id, &input.slug)? else {
        return Ok(Vec::new());
    };
    let mut pages = Pages::new(read);
    let mut kept = Vec::new();
    for link in in_links(read, target.id)? {
        if !not_mentions(&link) {
            continue;
        }
        let Some(from) = pages.get(link.from_page_id)? else {
            continue;
        };
        if from.source_id != input.source_id || !live(&from) {
            continue;
        }
        let origin = match link.origin_page_id {
            Some(id) => match pages.get(id)? {
                Some(origin) => Some(origin),
                None => continue,
            },
            None => None,
        };
        if let Some(policy) = &input.exclude_private {
            if page_hidden(read, &from, policy)? {
                continue;
            }
            if let Some(origin) = &origin
                && page_hidden(read, origin, policy)?
            {
                continue;
            }
        }
        if let Some(origin) = &origin
            && (!live(origin) || (input.origin_same_source && origin.source_id != input.source_id))
        {
            continue;
        }
        kept.push((link, from.slug.clone()));
    }
    kept.sort_by_key(|(link, _)| link.id);
    Ok(kept)
}

fn live(page: &PageRecord) -> bool {
    page.deleted_at_us.is_none()
}

fn has_timeline(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    let mut found = false;
    scan_prefix(read, &keys::timeline_prefix(page_id), false, &mut |_, _| {
        found = true;
        false
    })?;
    Ok(found)
}

impl Store {
    /// `inboundLinkCoverage`: `{ livePages, linkedPages }`, live meaning not soft-deleted. A
    /// linked page is the target of any link.
    pub fn inbound_link_coverage(&self, input: &InboundCoverageInput) -> Result<Value> {
        let read = self.read()?;
        let in_scope = |p: &PageRecord| {
            input
                .source_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&p.source_id))
        };
        let pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| live(p) && in_scope(p))
            .collect();
        let mut linked = 0u64;
        if !pages.is_empty() {
            for page in &pages {
                if !in_links(&*read, page.id)?.is_empty() {
                    linked += 1;
                }
            }
        }
        Ok(json!({"livePages": pages.len(), "linkedPages": linked}))
    }

    /// `listJunkEntityHubs`: live pages with more than `edgeThreshold` link ends (a self-link has
    /// two), at most `maxChunks` chunks and no `junk_hub_exempt: true`, most edges first. The SQL
    /// leaves equal edge counts to the plan; the store breaks them by page id.
    pub fn list_junk_entity_hubs(&self, input: &JunkHubsInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut edges: HashMap<u64, i64> = HashMap::new();
        for link in all_links(&*read)? {
            *edges.entry(link.from_page_id).or_default() += 1;
            *edges.entry(link.to_page_id).or_default() += 1;
        }
        let mut hubs: Vec<(i64, u64)> = edges
            .into_iter()
            .filter(|&(_, n)| n > input.edge_threshold)
            .map(|(id, n)| (n, id))
            .collect();
        hubs.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let sources: HashMap<String, SourceRecord> = all_sources(&*read)?
            .into_iter()
            .map(|s| (s.id.clone(), s))
            .collect();
        let mut source_order: Vec<&str> = sources.keys().map(String::as_str).collect();
        // `ORDER BY (t.source_id = 'default') DESC, t.source_id`.
        source_order.sort_by(|a, b| (*b == "default").cmp(&(*a == "default")).then(a.cmp(b)));
        let mut pages = Pages::new(&*read);
        let mut out = Vec::new();
        for (n, id) in hubs {
            if out.len() as u64 >= input.limit {
                break;
            }
            let Some(page) = pages.get(id)? else {
                continue;
            };
            if !live(&page) {
                continue;
            }
            let chunks = read_chunks(&*read, id)?.len() as i64;
            if chunks > input.max_chunks
                || field_text(&page, "junk_hub_exempt").as_deref() == Some("true")
            {
                continue;
            }
            let mut twin = None;
            for &sid in &source_order {
                if sid == page.source_id {
                    continue;
                }
                let Some(t) = read_page(&*read, sid, &page.slug)? else {
                    continue;
                };
                let kind = source_kind(sources.get(sid)).unwrap_or_default();
                if live(&t)
                    && field_text(&t, "google_contact_id").is_none()
                    && !input.connector_kinds.contains(&kind)
                {
                    twin = Some(sid.to_string());
                    break;
                }
            }
            out.push(json!({
                "slug": page.slug,
                "source_id": page.source_id,
                "edges": n,
                "chunks": chunks,
                "connector_page": field_text(&page, "google_contact_id").is_some(),
                "source_kind": source_kind(sources.get(&page.source_id)),
                "canonical_twin_source": twin,
            }));
        }
        Ok(out)
    }

    /// `countEntityPages`: live entity pages; unquarantined ones (no source filter) with
    /// `excludeQuarantined`, else those in `sourceId` when it is not empty.
    pub fn count_entity_pages(&self, input: &EntityPagesInput) -> Result<u64> {
        let read = self.read()?;
        let source = input.source_id.as_deref().filter(|s| !s.is_empty());
        Ok(all_pages(&*read)?
            .iter()
            .filter(|p| live(p) && is_entity(&input.filter, p))
            .filter(|p| {
                if input.exclude_quarantined {
                    !p.frontmatter.contains_key(QUARANTINE_KEY)
                } else {
                    source.is_none_or(|s| s == p.source_id)
                }
            })
            .count() as u64)
    }

    /// `entityGraphCoverage`: `{ entities, connected, withTimeline }` over the live unquarantined
    /// entity pages that are not test fixtures or the person template.
    pub fn entity_graph_coverage(&self, input: &EntityPagesInput) -> Result<Value> {
        let read = self.read()?;
        let (mut entities, mut connected, mut timeline) = (0u64, 0u64, 0u64);
        for page in all_pages(&*read)? {
            if !live(&page)
                || !is_entity(&input.filter, &page)
                || page.frontmatter.contains_key(QUARANTINE_KEY)
                || page.slug.starts_with(TEST_FIXTURE_PREFIX)
                || page.slug == PERSON_TEMPLATE
            {
                continue;
            }
            entities += 1;
            if !touching(&*read, page.id)?.is_empty() {
                connected += 1;
            }
            if has_timeline(&*read, page.id)? {
                timeline += 1;
            }
        }
        Ok(json!({"entities": entities, "connected": connected, "withTimeline": timeline}))
    }

    /// `entityFeatureCoverage`: `{ sampleSize, matched }` over the live unquarantined entity
    /// pages: how many there are and how many are the target of a link (`links`) or have a
    /// timeline entry (`timeline`). Any other feature is invalid.
    pub fn entity_feature_coverage(&self, input: &FeatureCoverageInput) -> Result<Value> {
        let links = match input.feature.as_str() {
            "links" => true,
            "timeline" => false,
            other => {
                return Err(StoreError::invalid(format!(
                    "entityFeatureCoverage: unknown feature {other:?}"
                )));
            }
        };
        let read = self.read()?;
        let (mut sample_size, mut matched) = (0u64, 0u64);
        for page in all_pages(&*read)? {
            if !live(&page)
                || !is_entity(&input.filter, &page)
                || page.frontmatter.contains_key(QUARANTINE_KEY)
            {
                continue;
            }
            sample_size += 1;
            let has = if links {
                !in_links(&*read, page.id)?.is_empty()
            } else {
                has_timeline(&*read, page.id)?
            };
            if has {
                matched += 1;
            }
        }
        Ok(json!({"sampleSize": sample_size, "matched": matched}))
    }

    /// `countDatedMeetingPages`: live pages of type `meeting` with an effective date.
    pub fn count_dated_meeting_pages(&self) -> Result<u64> {
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .iter()
            .filter(|p| live(p) && p.page_type == "meeting" && p.effective_date_us.is_some())
            .count() as u64)
    }

    /// `countForeignEdges`: the links of the page (`sourceId`, `slug`), soft-deleted or not,
    /// whose other end is in another source; `in`, `out` or `both` (each link once).
    pub fn count_foreign_edges(&self, input: &ForeignEdgesInput) -> Result<u64> {
        let read = self.read()?;
        let Some(root) = read_page(&*read, &input.source_id, &input.slug)? else {
            return Ok(0);
        };
        let mut pages = Pages::new(&*read);
        let mut n = 0u64;
        for link in touching(&*read, root.id)? {
            let wanted = match input.direction.as_str() {
                "in" => link.to_page_id == root.id,
                "both" => true,
                _ => link.from_page_id == root.id,
            };
            if !wanted {
                continue;
            }
            let (Some(from), Some(to)) =
                (pages.get(link.from_page_id)?, pages.get(link.to_page_id)?)
            else {
                continue;
            };
            if from.source_id != to.source_id {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `listLivePageSummaries(scope)`: `[{ slug, type, quarantined }]` for every page that is not
    /// soft-deleted and passes `pageReadFilter(.., scope)` (not live), in page id order.
    pub fn list_live_page_summaries(&self, scope: &GraphScope) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = Pages::new(&*read);
        let mut rows: Vec<PageRecord> = Vec::new();
        for page in all_pages(&*read)? {
            if live(&page) && pages.passes(&page, scope, false)? {
                rows.push(page);
            }
        }
        rows.sort_by_key(|p| p.id);
        Ok(rows
            .into_iter()
            .map(|p| {
                json!({
                    "slug": p.slug,
                    "type": p.page_type,
                    "quarantined": p.frontmatter.contains_key(QUARANTINE_KEY),
                })
            })
            .collect())
    }

    /// `countInboundLinks`: inbound links of the page (`sourceId`, `slug`), soft-deleted or not,
    /// from live pages of the same source, mentions left out. Under the policy the referrer and
    /// the origin must be readable; an origin must be live, in `sourceId` with `originSameSource`.
    pub fn count_inbound_links(&self, input: &InboundCountInput) -> Result<u64> {
        let read = self.read()?;
        Ok(kept_inbound_links(&*read, input)?.len() as u64)
    }

    /// `listLinkEndpointPages`: `[{ slug, source_id, type, knowledge_revision }]`, the live pages of
    /// `sourceId` named in `slugs` first (by slug), then, for the slugs that are in
    /// `crossSourceSlugs` or have no row there, the live pages of every other source (source order,
    /// then slug). The SQL leaves the row order to the plan.
    pub fn list_link_endpoint_pages(&self, input: &EndpointsInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let row = |p: &PageRecord| {
            json!({
                "slug": p.slug,
                "source_id": p.source_id,
                "type": p.page_type,
                "knowledge_revision": p.knowledge_revision,
            })
        };
        let slugs: BTreeSet<&str> = input.slugs.iter().map(String::as_str).collect();
        let cross: HashSet<&str> = input
            .cross_source_slugs
            .iter()
            .map(String::as_str)
            .collect();
        let mut out = Vec::new();
        let mut own: HashSet<&str> = HashSet::new();
        for &slug in &slugs {
            if let Some(page) = read_page(&*read, &input.source_id, slug)?
                && live(&page)
            {
                own.insert(slug);
                out.push(row(&page));
            }
        }
        let refs: Vec<&str> = slugs
            .iter()
            .copied()
            .filter(|k| cross.contains(k) || !own.contains(k))
            .collect();
        if refs.is_empty() {
            return Ok(out);
        }
        for source in all_sources(&*read)? {
            if source.id == input.source_id {
                continue;
            }
            for &slug in &refs {
                if let Some(page) = read_page(&*read, &source.id, slug)?
                    && live(&page)
                {
                    out.push(row(&page));
                }
            }
        }
        Ok(out)
    }

    /// `listPagesTitledIn`: `[{ id, slug, title, type, source_id }]` for the pages whose title
    /// (three characters or more), lowercased, is in `queryLower` and that pass
    /// `pageReadFilter(.., scope, live)`; by source id, then slug (byte order), at most 50.
    pub fn list_pages_titled_in(&self, input: &TitledInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = Pages::new(&*read);
        let mut rows: Vec<PageRecord> = Vec::new();
        for page in all_pages(&*read)? {
            if page.title.chars().count() < 3
                || !input
                    .query_lower
                    .contains(&crate::keyword::pg_lower(&page.title))
            {
                continue;
            }
            if pages.passes(&page, &input.scope, true)? {
                rows.push(page);
            }
        }
        rows.sort_by(|a, b| {
            a.source_id
                .as_bytes()
                .cmp(b.source_id.as_bytes())
                .then(a.slug.as_bytes().cmp(b.slug.as_bytes()))
        });
        rows.truncate(50);
        Ok(rows
            .into_iter()
            .map(|p| {
                json!({
                    "id": p.id,
                    "slug": p.slug,
                    "title": p.title,
                    "type": p.page_type,
                    "source_id": p.source_id,
                })
            })
            .collect())
    }

    /// `probePageTypes(sets, scope)`: `{ present, available }`. `present[i]` is whether a page that
    /// passes `pageReadFilter(.., scope, live)` has a type in `sets[i]` (false for an empty set).
    /// `available` is null when no set is empty-handed, else the distinct types of such pages, at
    /// most 500; the SQL leaves which 500 and their order to the plan, here they are the first 500
    /// in byte order.
    pub fn probe_page_types(&self, input: &TypeProbeInput) -> Result<Value> {
        let read = self.read()?;
        let mut pages = Pages::new(&*read);
        let mut types: BTreeSet<String> = BTreeSet::new();
        for page in all_pages(&*read)? {
            if pages.passes(&page, &input.scope, true)? {
                types.insert(page.page_type.clone());
            }
        }
        let present: Vec<bool> = input
            .sets
            .iter()
            .map(|set| set.iter().any(|t| types.contains(t)))
            .collect();
        let probed = input.sets.iter().any(|set| !set.is_empty());
        let all_found = input
            .sets
            .iter()
            .zip(&present)
            .all(|(set, found)| set.is_empty() || *found);
        let available = if !probed || all_found {
            Value::Null
        } else {
            json!(types.into_iter().take(PROBE_TYPE_LIMIT).collect::<Vec<_>>())
        };
        Ok(json!({ "present": present, "available": available }))
    }

    /// `readLongPageSizes(ids, scope, { includeTimeline })`: `[{ id, chars, bytes }]`, one row per page in
    /// `ids` that passes `pageReadFilter(.., scope, live)` and `servedTextProjectionFilter` (and
    /// `safeChunksFilter` with `safe_chunks`). `chars` is `char_length` (code points) and `bytes`
    /// `octet_length` of the compiled truth (NULL counts 0); with `timeline`, a timeline holding a
    /// character outside `[[:space:]]` adds the separator and its own length. The SQL leaves the
    /// row order to the plan; here it is the order of `ids`, each page once.
    pub fn read_long_page_sizes(&self, input: &LongPageSizeInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = Pages::new(&*read);
        let mut seen = HashSet::new();
        let mut rows = Vec::new();
        for &id in &input.ids {
            let Ok(id) = u64::try_from(id) else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            let Some(page) = pages.readable(id, &input.scope, true)? else {
                continue;
            };
            if !served(&page) || (input.safe_chunks && !safe_chunks(&page)) {
                continue;
            }
            let body = page.compiled_truth.as_deref().unwrap_or("");
            let (mut chars, mut bytes) = (body.chars().count(), body.len());
            if input.include_timeline
                && let Some(timeline) = page.timeline.as_deref()
                && timeline.chars().any(|c| !is_pg_space(c))
            {
                chars += TIMELINE_SEPARATOR_LEN + timeline.chars().count();
                bytes += TIMELINE_SEPARATOR_LEN + timeline.len();
            }
            rows.push(json!({ "id": id, "chars": chars, "bytes": bytes }));
        }
        Ok(rows)
    }

    /// `readLinkContextMatches(asks)`: `[{ i, link_source, context, page_id }]`, for each ask the
    /// links of its edge (from page, to page and link type; the pages deleted or not) whose context
    /// passes [`context_matches`], with `page_id` the link's origin page (its from page when it has
    /// none) when that page is live, else null. In ask order, then link id order; the SQL leaves
    /// the row order to the plan.
    pub fn read_link_context_matches(&self, asks: &[LinkContextAsk]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for ask in asks {
            let (Some(from), Some(to)) = (
                read_page(&*read, &ask.from_source_id, &ask.from_slug)?,
                read_page(&*read, &ask.to_source_id, &ask.to_slug)?,
            ) else {
                continue;
            };
            for link in out_links(&*read, from.id)? {
                if link.to_page_id != to.id
                    || link.link_type != ask.link_type
                    || !context_matches(&link.context, &ask.context)
                {
                    continue;
                }
                let origin = link.origin_page_id.unwrap_or(link.from_page_id);
                let page_id = read_page_by_id(&*read, origin)?.filter(live).map(|p| p.id);
                out.push(json!({
                    "i": ask.i,
                    "link_source": link.link_source,
                    "context": link.context,
                    "page_id": page_id,
                }));
            }
        }
        Ok(out)
    }

    /// `readLinkContextOriginPages(ids)`: `[{ id, source_id, slug, compiled_truth, timeline }]`
    /// for the pages in `ids` (deleted or not) that are not segmented shells, by id. The SQL leaves
    /// the row order to the plan.
    pub fn read_link_context_origin_pages(&self, ids: &[u64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let wanted: BTreeSet<u64> = ids.iter().copied().collect();
        let mut out = Vec::new();
        for id in wanted {
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            if page.compiled_truth.is_null() {
                continue;
            }
            out.push(json!({
                "id": page.id,
                "source_id": page.source_id,
                "slug": page.slug,
                "compiled_truth": page.compiled_truth.as_deref(),
                "timeline": page.timeline.as_deref(),
            }));
        }
        Ok(out)
    }

    /// `wordLexemes(words)` under the text search configuration `config` (absent: `english`):
    /// `[{ w, lexemes }]`, each word's `tsvector_to_array(to_tsvector(config, w))` (sorted as the
    /// tsvector holds them).
    pub fn word_lexemes(&self, words: &[String], config: Option<&str>) -> Result<Vec<Value>> {
        let config = crate::keyword::FtsConfig::parse(config)?;
        words
            .iter()
            .map(|w| {
                let vector = crate::keyword::to_tsvector_in(config, w)?;
                let lexemes: Vec<&str> = vector.entries.iter().map(|e| e.lexeme.as_str()).collect();
                Ok(json!({"w": w, "lexemes": lexemes}))
            })
            .collect()
    }
}
