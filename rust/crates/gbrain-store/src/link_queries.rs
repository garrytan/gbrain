//! Link and graph members beyond the core links family: derived-link replacement
//! (`replaceDerivedLinks`, `replaceDerivedLinksBatch`), provenance-scoped deletes
//! (`removeLinksByPagesAndSource`), provenance counts (`listLinkSources`), the ranking signals
//! (`getBacklinkCounts`, `getAdjacencyBoosts`), the relational walks (`relationalFanout`,
//! `relationalChainHop`) and orphan detection (`findOrphanPages`). `rewriteLinks` is a no-op in
//! the SQL engines and in the TypeScript member, so the store has nothing for it.
//!
//! It also serves the three link reads of hybrid search's ranking stage
//! (src/core/engine-sql/search-reads.ts): `hasSupersedeEdges`, `supersedingPageSlugs` and
//! `pagesLinkingTo`, and in `site_reads` the link reads of src/core/engine-sql/link-reads.ts.
//!
//! Members: replaceDerivedLinks, replaceDerivedLinksBatch, removeLinksByPagesAndSource,
//! listLinkSources, getBacklinkCounts, rewriteLinks, relationalFanout, relationalChainHop,
//! getAdjacencyBoosts, findOrphanPages, hasSupersedeEdges, supersedingPageSlugs, pagesLinkingTo;
//! site_reads: inboundLinkCoverage, listJunkEntityHubs, countEntityPages, entityGraphCoverage,
//! countForeignEdges, listLivePageSummaries, countInboundLinks, listLinkEndpointPages,
//! listPagesTitledIn, wordLexemes.
//!
//! Reads and writes go through the core links helpers (`put_link`, `delete_link`, `out_links`,
//! `in_links`) and the page and source readers.
//!
//! Keys: the `q` tag (`keys::LINK_QUERIES`) is shared with wanted_links (`wanted_links.rs`).
//! The bytes after `q <source> \0 W` are wanted_links' bytes; this family keeps the `W` sub-tag
//! free. The link temporal records (relationship state under `R`, transitions under `T`) live in
//! `link_temporal.rs`. `remove_source_rows` deletes everything under `q <source> \0`, so a source
//! delete removes the records of all three.
//!
//! The read policy of `src/core/search/read-policy-sql.ts` (`pageReadFilter`) is modelled for the
//! source filter and the live test (not soft-deleted, not quarantined, source not archived).
//! `requireSafeChunks` is modelled on the relational walks (the canonical chunk's safe fence and the
//! chain's evidence `textGate`). The privacy and trust filters ride in `GraphScope`
//! (`exclude_private`, `min_trust`, `suppress_flagged`). A page's canonical chunk is its lowest
//! `chunk_index` chunk among the chunks of its live body. See rust/docs/store/link_queries.md.

use crate::Store;
use crate::chunks::{in_live_body, read_chunks, read_segment_view, segmented};
use crate::error::{INVALID_ARGUMENT, INVALID_STATE, REVISION_CONFLICT, Result, StoreError};
use crate::facts::{OwnerOnlyCache, PrivacyPolicy, page_hidden};
use crate::keys;
use crate::kv::{KvRead, KvWrite, collect_prefix, scan_prefix};
use crate::links::{LinkBatchInput, LinkRecord, delete_link, in_links, out_links, put_link};
use crate::pages::{
    PageRecord, all_pages, clean, find_in_scope, next_id, read_page, read_page_by_id,
};
use crate::sources::read_source;
use crate::timeline_queries::jsonb_field_text;
use crate::trust::{TrustPolicy, TrustTier};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;

pub(crate) mod link_temporal;
pub use link_temporal::{
    ApplyTemporalInput, ApplyTemporalResult, EdgeValidityCounts, EdgeValidityInput, EvidenceInput,
    InboundEdgeRow, KeysForOriginInput, KeysForPagesInput, KeysTouchingInput, ManualRelationship,
    ManualWriteInput, ManualWriteResult, NoteRow, NoteRowsInput, PageStatusInput, PageStatusRow,
    RecordMetadataInput, RecordMetadataRows, RelationshipEvidence, RelationshipKey,
    SearchVectorCounts, StaleKeysInput, StateWrite,
};
mod retrieval_coverage;
pub use retrieval_coverage::{
    CoverageRelevance, CoverageScope, PendingCount, PendingCountInput, ReadinessRow,
    RebuildProgress,
};
mod site_reads;
pub use site_reads::{
    EndpointsInput, EntityPagesInput, ForeignEdgesInput, InboundCountInput, InboundCoverageInput,
    JunkHubsInput, LinkContextAsk, TitledInput,
};

/// The frontmatter key that hides a page (`quarantineFilterFragment`).
const QUARANTINE_KEY: &str = "quarantine";
/// `NON_RANKING_LINK_TYPES` of `src/core/link-ranking-policy.ts`.
const NON_RANKING_LINK_TYPES: &[&str] = &["amends"];
/// The `link_type` of a supersede edge (`A supersedes B`: from A, the canon, to B, the stale page).
const SUPERSEDES: &str = "supersedes";
/// `CHAIN_DEGREE_SATURATION` of `src/core/search/read-enrichment.ts`.
const CHAIN_DEGREE_SATURATION: usize = 300;
/// The meta counter the core links family allocates link ids from.
const NEXT_LINK_ID: &str = "next_link_id";
/// The producers whose rows with no origin belong to their from page.
const BODY_PRODUCERS: &[&str] = &["markdown", "wikilink-resolved"];

/// Deletes this family's records keyed by a source that is deleted (`cascade::remove_source_rows`):
/// every key under `q source \0`.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut prefix = vec![keys::LINK_QUERIES];
    prefix.extend_from_slice(source_id.as_bytes());
    prefix.push(0);
    for (key, _) in collect_prefix(&*tx, &prefix, false, usize::MAX)? {
        tx.delete(&key)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

/// A `{ sourceId?, sourceIds? }` scope plus whether a read policy applies at all. `scoped` is
/// `hasReadPolicy(opts)` for relationalFanout and `opts !== undefined` for getBacklinkCounts and
/// getAdjacencyBoosts; relationalChainHop always applies the policy.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GraphScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub scoped: bool,
    /// `excludePrivate`: the page policy `privatePagesFilterForCaller` (`facts/privacy.rs`).
    pub exclude_private: Option<PrivacyPolicy>,
    /// `minTrust`: `pageEligibleSql`'s floor over the page's stamped tier (`trust::TrustPolicy`).
    pub min_trust: Option<String>,
    /// `suppressFlagged`: drop a page `activationSuppressedSql('pages')` flags.
    pub suppress_flagged: bool,
}

impl GraphScope {
    /// `pageReadFilter`'s `pageEligibleSql` clause: the trust floor and the flagged-page filter.
    fn trust(&self) -> Result<TrustPolicy> {
        TrustPolicy::parse(self.min_trust.as_deref(), self.suppress_flagged)
    }

    /// `pageReadFilter`'s source clause: `sourceIds` when not empty, else a non-empty `sourceId`.
    fn source_ok(&self, source_id: &str) -> bool {
        match (&self.source_ids, &self.source_id) {
            (Some(ids), _) if !ids.is_empty() => ids.iter().any(|id| id == source_id),
            (_, Some(id)) if !id.is_empty() => id == source_id,
            _ => true,
        }
    }

    fn has_sources(&self) -> bool {
        self.source_ids.as_ref().is_some_and(|ids| !ids.is_empty())
            || self.source_id.as_ref().is_some_and(|id| !id.is_empty())
    }
}

/// `listLinkSources({ sourceId?, sourceIds? })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LinkSourcesOptions {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
}

/// `findOrphanPages({ sourceId?, sourceIds?, mode?, scopeInbound? })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OrphanOptions {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    /// `excludePrivate`: the page policy on the candidate, its link ends and their origins.
    pub exclude_private: Option<PrivacyPolicy>,
    pub mode: Option<String>,
    pub scope_inbound: bool,
}

/// One `{ slug, source_id }` page of `removeLinksByPagesAndSource`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PageRef {
    pub slug: String,
    pub source_id: String,
}

/// One kept typed-NER pair of `removeLinksByPagesAndSource`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct KeepPair {
    pub from_slug: String,
    pub from_source_id: String,
    pub to_slug: String,
    pub to_source_id: String,
}

/// `{ linkSource, keepTypedNerPairs? }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoveBySourceOptions {
    pub link_source: Option<String>,
    pub keep_typed_ner_pairs: Vec<KeepPair>,
}

/// `RelationalFanoutOpts`, the part the store reads. `depth` and `limit` arrive clamped.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FanoutOptions {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    /// `hasReadPolicy(opts)`.
    pub scoped: bool,
    /// `excludePrivate`: the page policy on the seed, step and origin pages.
    pub exclude_private: Option<PrivacyPolicy>,
    /// `minTrust` and `suppressFlagged`: the trust policy on the same pages ([`GraphScope`]).
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
    pub seed_refs: Option<Vec<PageRef>>,
    pub link_types: Option<Vec<String>>,
    pub direction: Option<String>,
    pub depth: u32,
    pub include_mentions: bool,
    pub limit: usize,
    /// `requiresSafeChunks(opts)`: a node's canonical chunk is read only from a page sealed at the safe fence.
    pub require_safe_chunks: bool,
}

/// `ChainHopOpts`, the part the store reads. `neighborCap` arrives clamped to 1..=1000.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChainHopOptions {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    /// `excludePrivate`: the page policy on every endpoint, origin, neighbor and evidence page.
    pub exclude_private: Option<PrivacyPolicy>,
    /// `minTrust` and `suppressFlagged`: the trust policy on the same pages ([`GraphScope`]).
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
    pub link_types: Vec<String>,
    pub toward: String,
    pub subject_types: Vec<String>,
    pub object_types: Vec<String>,
    pub degree_link_types: Vec<String>,
    pub neighbor_cap: usize,
    /// `requiresSafeChunks(opts)`: the next page's canonical chunk is read only from a page sealed at the safe fence.
    pub require_safe_chunks: bool,
    /// `textGate` of readChainHop, decided by the TypeScript member (it knows the caller): `body` returns an edge's
    /// context only when the evidence page is sealed and holds no facts / takes fence, `takes` only when it is sealed
    /// and holds no takes fence, and absent returns it whenever the evidence page is readable.
    pub text_gate: Option<String>,
}

/// `DerivedLinkOrigin` without the refused `snapshot`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DerivedOrigin {
    pub slug: String,
    pub source_id: String,
    pub expected_revision: Option<String>,
    pub source_incarnation: String,
}

/// One `{ slug, sourceId, revision }` of `expectedEndpoints`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExpectedEndpoint {
    pub slug: String,
    pub source_id: String,
    pub revision: String,
}

/// One origin of a derived-link replacement, already normalized by the TypeScript member
/// (`derivedLinkRows`): the producers it may replace and the deduplicated candidate rows, each
/// with its source ids filled in.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedItem {
    pub origin: DerivedOrigin,
    pub producers: Vec<String>,
    pub rows: Vec<LinkBatchInput>,
    #[serde(default = "yes")]
    pub include_frontmatter: bool,
    #[serde(default)]
    pub preserve_existing: bool,
    #[serde(default = "yes")]
    pub include_legacy_null_producer: bool,
    #[serde(default)]
    pub expected_endpoints: Vec<ExpectedEndpoint>,
}

fn yes() -> bool {
    true
}

// ---------------------------------------------------------------------------------------------
// Read policy
// ---------------------------------------------------------------------------------------------

/// Pages and sources read once per call.
struct Pages<'a> {
    read: &'a dyn KvRead,
    pages: HashMap<u64, Option<Rc<PageRecord>>>,
    sources: HashMap<String, bool>,
    owner_only: OwnerOnlyCache,
}

impl<'a> Pages<'a> {
    fn new(read: &'a dyn KvRead) -> Self {
        Pages {
            read,
            pages: HashMap::new(),
            sources: HashMap::new(),
            owner_only: OwnerOnlyCache::default(),
        }
    }

    fn get(&mut self, id: u64) -> Result<Option<Rc<PageRecord>>> {
        if let Some(page) = self.pages.get(&id) {
            return Ok(page.clone());
        }
        let page = read_page_by_id(self.read, id)?.map(Rc::new);
        self.pages.insert(id, page.clone());
        Ok(page)
    }

    /// The `EXISTS (SELECT 1 FROM sources ... AND NOT archived)` clause.
    fn source_live(&mut self, source_id: &str) -> Result<bool> {
        if let Some(live) = self.sources.get(source_id) {
            return Ok(*live);
        }
        let live = read_source(self.read, source_id)?.is_some_and(|s| !s.archived);
        self.sources.insert(source_id.to_string(), live);
        Ok(live)
    }

    /// `pageReadFilter(alias, scope, params, live)`.
    fn passes(&mut self, page: &PageRecord, scope: &GraphScope, live: bool) -> Result<bool> {
        if !scope.source_ok(&page.source_id) {
            return Ok(false);
        }
        if let Some(policy) = &scope.exclude_private
            && self.owner_only.page_hidden(self.read, page, policy)?
        {
            return Ok(false);
        }
        let tier = TrustTier::stored(page.trust_tier.as_deref());
        if !scope.trust()?.admits(self.read, "pages", page.id, tier)? {
            return Ok(false);
        }
        if !live {
            return Ok(true);
        }
        Ok(page.deleted_at_us.is_none()
            && !page.frontmatter.contains_key(QUARANTINE_KEY)
            && self.source_live(&page.source_id)?)
    }

    /// The page with this id when it passes `pageReadFilter(.., live)`.
    fn readable(
        &mut self,
        id: u64,
        scope: &GraphScope,
        live: bool,
    ) -> Result<Option<Rc<PageRecord>>> {
        match self.get(id)? {
            Some(page) if self.passes(&page, scope, live)? => Ok(Some(page)),
            _ => Ok(None),
        }
    }

    /// `(l.origin_page_id IS NULL OR EXISTS (... origin passes the live filter))`.
    fn origin_ok(&mut self, link: &LinkRecord, scope: &GraphScope) -> Result<bool> {
        match link.origin_page_id {
            None => Ok(true),
            Some(id) => Ok(self.readable(id, scope, true)?.is_some()),
        }
    }

    /// The page's lowest-ordinal chunk id among the chunks of its live body (`chunkGenerationProbe`: an inline chunk of
    /// a page that is not segmented, or a segmented chunk at or below the page's generation whose occurrence has a live
    /// manifest row). A staged chunk, one whose occurrence a deferred retire closed and an inline chunk left on a
    /// segmented page are never named. With `require_safe` (`requiresSafeChunks`), only a page sealed at the safe
    /// fence has one (`EXISTS (... safeChunksFilter('cp'))`).
    fn canonical_chunk(&mut self, page_id: u64, require_safe: bool) -> Result<Option<u64>> {
        let Some(page) = self.get(page_id)? else {
            return Ok(None);
        };
        if require_safe && !sealed_safe(&page) {
            return Ok(None);
        }
        let segmented_page = segmented(&page);
        let view = read_segment_view(self.read, page_id)?;
        Ok(read_chunks(self.read, page_id)?
            .into_iter()
            .filter(|c| in_live_body(c, segmented_page, &view))
            .min_by_key(|c| c.chunk_index)
            .map(|c| c.id))
    }
}

/// `safeChunksFilter`: `chunker_version >= 4`; a page that records no version is not safe (the comparison is NULL).
fn sealed_safe(page: &PageRecord) -> bool {
    page.chunker_version
        .is_some_and(|v| v >= crate::chunks::SAFE_FENCE_CHUNKER_VERSION)
}

/// `PROTECTED_MARKER` of src/core/search/safe-chunks.ts: `<!--- gbrain:(facts|takes):(begin|end) -->`.
fn has_marker(text: Option<&str>, kinds: &[&str]) -> bool {
    let Some(text) = text else { return false };
    kinds.iter().any(|kind| {
        ["begin", "end"]
            .iter()
            .any(|edge| text.contains(&format!("<!--- gbrain:{kind}:{edge} -->")))
    })
}

/// `protectedBodyFilter` (kinds facts and takes) or `protectedTakesFilter` (takes only). A segmented page has no body
/// columns: its `body_flags.has_protected` decides, and a page without the flag counts as protected (fail closed:
/// `body_flags->>'has_protected' IS DISTINCT FROM 'false'`).
fn protected_body(read: &dyn KvRead, page: &PageRecord, kinds: &[&str]) -> Result<bool> {
    if let Some(flags) = crate::page_body::segmented_body_flags(read, page.id)? {
        let unprotected = match flags.as_ref().and_then(|f| f.get("has_protected")) {
            Some(Value::Bool(false)) => true,
            Some(Value::String(s)) => s == "false",
            _ => false,
        };
        return Ok(!unprotected);
    }
    Ok(has_marker(page.compiled_truth.as_deref(), kinds)
        || has_marker(page.timeline.as_deref(), kinds))
}

/// `rankingLinkSql`: the link may feed a ranking signal.
fn ranks(link: &LinkRecord) -> bool {
    !NON_RANKING_LINK_TYPES.contains(&link.link_type.as_str())
}

/// `link_source IS DISTINCT FROM 'mentions'`.
fn not_mentions(link: &LinkRecord) -> bool {
    link.link_source.as_deref() != Some("mentions")
}

/// Every link that leaves or arrives at the page, in id order, each once.
fn touching(read: &dyn KvRead, page_id: u64) -> Result<Vec<LinkRecord>> {
    let mut links = out_links(read, page_id)?;
    links.extend(
        in_links(read, page_id)?
            .into_iter()
            .filter(|l| l.from_page_id != page_id),
    );
    links.sort_by_key(|l| l.id);
    Ok(links)
}

/// Every link in the store.
fn all_links(read: &dyn KvRead) -> Result<Vec<LinkRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &[keys::LINK], false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

/// The links a page authored (`origin_page_id = id`), in id order.
fn origin_links(read: &dyn KvRead, origin_id: u64) -> Result<Vec<LinkRecord>> {
    let mut refs = Vec::new();
    scan_prefix(
        read,
        &keys::link_origin_prefix(origin_id),
        false,
        &mut |k, v| {
            if let (Some(id), Some(from)) =
                (keys::be8(&k[k.len().saturating_sub(8)..]), keys::be8(v))
            {
                refs.push((from, id));
            }
            true
        },
    )?;
    let mut out = Vec::with_capacity(refs.len());
    for (from, id) in refs {
        if let Some(link) = crate::get_json::<LinkRecord>(read, &keys::link(from, id))? {
            out.push(link);
        }
    }
    Ok(out)
}

fn invalid_state(prefix: &str, text: &str) -> StoreError {
    StoreError::new(INVALID_STATE, format!("{prefix}: {text}"))
}

// ---------------------------------------------------------------------------------------------
// Derived-link writes
// ---------------------------------------------------------------------------------------------

/// The CHECK constraints of the links table (`check_link` of links.rs).
fn valid_link_source(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && !text.contains("--")
        && !text.ends_with('-')
}

fn check_violation(constraint: &str) -> StoreError {
    StoreError::new(
        crate::error::CONSTRAINT_VIOLATION,
        format!("new row for relation \"links\" violates check constraint \"{constraint}\""),
    )
}

fn check_link(record: &LinkRecord) -> Result<()> {
    if record
        .link_source
        .as_deref()
        .is_some_and(|s| !valid_link_source(s))
    {
        return Err(check_violation("links_link_source_check"));
    }
    if record
        .link_kind
        .as_deref()
        .is_some_and(|k| k != "plain" && k != "typed_ner")
    {
        return Err(check_violation("links_link_kind_check"));
    }
    if record
        .resolution_type
        .as_deref()
        .is_some_and(|r| r != "qualified" && r != "unqualified")
    {
        return Err(check_violation("links_resolution_type_check"));
    }
    Ok(())
}

/// One `addLinksBatch` row inside the caller's transaction: true when it inserted a link. Mirrors
/// `Store::add_links_batch` (endpoints and origin resolved in any deletion state, a row whose
/// endpoint is missing or whose unique key exists is skipped).
fn insert_row(tx: &mut dyn KvWrite, link: &LinkBatchInput, now: i64) -> Result<bool> {
    let text = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
    let source =
        |v: &Option<String>| text(v).unwrap_or_else(|| crate::sources::DEFAULT_SOURCE.into());
    let (Some(from), Some(to)) = (&link.from_slug, &link.to_slug) else {
        return Ok(false);
    };
    let Some(from_page) = read_page(&*tx, &source(&link.from_source_id), from)? else {
        return Ok(false);
    };
    let Some(to_page) = read_page(&*tx, &source(&link.to_source_id), to)? else {
        return Ok(false);
    };
    let origin = match text(&link.origin_slug) {
        Some(slug) => read_page(&*tx, &source(&link.origin_source_id), &slug)?.map(|p| p.id),
        None => None,
    };
    let mut record = LinkRecord {
        id: 0,
        from_page_id: from_page.id,
        to_page_id: to_page.id,
        link_type: link.link_type.clone().unwrap_or_default(),
        context: clean(link.context.as_deref().unwrap_or("")),
        link_source: Some(text(&link.link_source).unwrap_or_else(|| "markdown".into())),
        link_kind: link.link_kind.clone(),
        origin_page_id: origin,
        origin_field: text(&link.origin_field),
        resolution_type: link.resolution_type.clone(),
        created_at_us: now,
        assertion_tense: None,
    };
    check_link(&record)?;
    if tx.get(&record.unique_key())?.is_some() {
        return Ok(false);
    }
    record.id = next_id(tx, NEXT_LINK_ID)?;
    put_link(tx, &record)?;
    Ok(true)
}

/// A live page by exact `(source_id, slug)`.
fn live_page(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Option<PageRecord>> {
    Ok(read_page(read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none()))
}

/// `assertPageRevision`'s `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn opt(v: &Option<String>) -> &str {
    v.as_deref().unwrap_or("")
}

/// The `preserveExisting` identity of a link: `[from_src, from_slug, to_src, to_slug, link_type,
/// link_source ?? 'markdown', origin_slug ?? null]`.
type Identity = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
);

fn row_identity(row: &LinkBatchInput) -> Identity {
    (
        opt(&row.from_source_id).to_string(),
        opt(&row.from_slug).to_string(),
        opt(&row.to_source_id).to_string(),
        opt(&row.to_slug).to_string(),
        opt(&row.link_type).to_string(),
        row.link_source.clone().unwrap_or_else(|| "markdown".into()),
        row.origin_slug.clone(),
    )
}

/// `publishDerivedLinks` for one origin, inside the caller's write transaction.
fn publish(tx: &mut dyn KvWrite, index: usize, item: &DerivedItem, now: i64) -> Result<Value> {
    let origin = &item.origin;
    if origin
        .expected_revision
        .as_deref()
        .is_some_and(|r| !is_uuid(r))
    {
        return Err(invalid_state(
            "bad_revision",
            "expectedRevision must be a UUID revision",
        ));
    }
    // assertPageRevision over a live-rows snapshot of the origin.
    let snapshot = find_in_scope(
        &*tx,
        &origin.slug.to_lowercase(),
        &Some(origin.source_id.clone()),
        &None,
        false,
    )?;
    let current = snapshot.as_ref().map(|p| p.knowledge_revision.clone());
    let expected = origin.expected_revision.as_ref().map(|r| r.to_lowercase());
    if current != expected {
        return Err(StoreError::new(
            REVISION_CONFLICT,
            format!(
                "derived link origin revision conflict: item={index} current={}",
                current.as_deref().unwrap_or("null")
            ),
        ));
    }
    let Some(page) = snapshot else {
        return Err(invalid_state(
            "origin_changed",
            "Derived link origin changed or was deleted",
        ));
    };
    let incarnation = read_source(&*tx, &page.source_id)?
        .map(|s| s.incarnation)
        .unwrap_or_default();
    if incarnation != origin.source_incarnation || page.deleted_at_us.is_some() {
        return Err(invalid_state(
            "origin_changed",
            "Derived link origin changed or was deleted",
        ));
    }
    let id = page.id;
    if item.include_frontmatter && !item.preserve_existing {
        let ambiguous = touching(&*tx, id)?
            .iter()
            .any(|l| l.link_source.as_deref() == Some("frontmatter") && l.origin_page_id.is_none());
        if ambiguous {
            return Err(invalid_state(
                "provenance_required",
                "Derived frontmatter edges have no origin. Repair their provenance before reconciliation.",
            ));
        }
    }
    for row in &item.rows {
        if live_page(&*tx, opt(&row.from_source_id), opt(&row.from_slug))?.is_none()
            || live_page(&*tx, opt(&row.to_source_id), opt(&row.to_slug))?.is_none()
        {
            return Err(invalid_state(
                "endpoint_missing",
                "A derived link endpoint changed or was deleted",
            ));
        }
    }
    for endpoint in &item.expected_endpoints {
        let ok = live_page(&*tx, &endpoint.source_id, &endpoint.slug)?
            .is_some_and(|p| p.knowledge_revision == endpoint.revision);
        if !ok {
            return Err(invalid_state(
                "endpoint_changed",
                "A derived link endpoint changed after type resolution",
            ));
        }
    }
    let reversed: Vec<&LinkBatchInput> = item
        .rows
        .iter()
        .filter(|row| {
            opt(&row.link_type) == "attended"
                && !opt(&row.origin_slug).is_empty()
                && opt(&row.to_slug) == origin.slug
                && opt(&row.to_source_id) == origin.source_id
                && (opt(&row.from_slug) != origin.slug
                    || opt(&row.from_source_id) != origin.source_id)
        })
        .collect();
    if !reversed.is_empty() {
        let unbound = reversed.iter().any(|row| {
            opt(&row.link_source) != "frontmatter"
                && !item.expected_endpoints.iter().any(|e| {
                    e.slug == opt(&row.from_slug) && e.source_id == opt(&row.from_source_id)
                })
        });
        if page.page_type != "meeting" || unbound {
            return Err(invalid_state(
                "attendance_origin",
                "Canonical attendance requires a meeting origin and revision-bound person endpoints",
            ));
        }
        for row in &reversed {
            if read_page(&*tx, opt(&row.from_source_id), opt(&row.from_slug))?
                .is_some_and(|p| p.page_type != "person")
            {
                return Err(invalid_state(
                    "attendance_person",
                    "Canonical attendance requires person endpoints",
                ));
            }
        }
    }
    let producer = |l: &LinkRecord| {
        l.link_source
            .as_deref()
            .is_some_and(|s| item.producers.iter().any(|p| p == s))
    };
    let body_producer = |l: &LinkRecord| {
        l.link_source
            .as_deref()
            .is_some_and(|s| BODY_PRODUCERS.contains(&s))
    };
    // Links this origin owns: authored by it, or body links with no origin that leave it.
    let mut owned: BTreeMap<u64, LinkRecord> = BTreeMap::new();
    for link in origin_links(&*tx, id)? {
        owned.insert(link.id, link);
    }
    for link in out_links(&*tx, id)? {
        if link.origin_page_id.is_none() {
            owned.insert(link.id, link);
        }
    }
    let not_persisted = || {
        invalid_state(
            "not_persisted",
            "Derived link replacement did not persist every candidate",
        )
    };
    if item.preserve_existing {
        let existing: Vec<LinkRecord> = owned
            .into_values()
            .filter(|l| {
                (producer(l) || (item.include_legacy_null_producer && l.link_source.is_none()))
                    && (l.origin_page_id == Some(id)
                        || (body_producer(l) || l.link_source.is_none()))
            })
            .collect();
        let mut pages = Pages::new(&*tx);
        let mut identities = Vec::with_capacity(existing.len());
        for link in &existing {
            let (Some(f), Some(t)) = (pages.get(link.from_page_id)?, pages.get(link.to_page_id)?)
            else {
                identities.push(None);
                continue;
            };
            let origin_slug = match link.origin_page_id {
                Some(o) => pages.get(o)?.map(|p| p.slug.clone()),
                None => None,
            };
            identities.push(Some((
                f.source_id.clone(),
                f.slug.clone(),
                t.source_id.clone(),
                t.slug.clone(),
                link.link_type.clone(),
                link.link_source
                    .clone()
                    .unwrap_or_else(|| "markdown".into()),
                origin_slug,
            )));
        }
        drop(pages);
        let mut wanted: HashMap<Identity, &LinkBatchInput> = HashMap::new();
        for row in &item.rows {
            wanted.insert(row_identity(row), row);
        }
        let retained: HashSet<&Identity> = identities.iter().flatten().collect();
        let mut removed = 0u64;
        let mut updates = Vec::new();
        for (link, identity) in existing.iter().zip(&identities) {
            let Some(identity) = identity else { continue };
            match wanted.get(identity) {
                None => {
                    delete_link(tx, link)?;
                    removed += 1;
                }
                Some(desired) => {
                    let context = clean(opt(&desired.context));
                    let origin_field = desired.origin_field.clone().filter(|f| !f.is_empty());
                    if link.context != context || link.origin_field != origin_field {
                        updates.push(LinkRecord {
                            context,
                            origin_field,
                            ..link.clone()
                        });
                    }
                }
            }
        }
        for record in &updates {
            put_link(tx, record)?;
        }
        let additions: Vec<&LinkBatchInput> = item
            .rows
            .iter()
            .filter(|row| !retained.contains(&row_identity(row)))
            .collect();
        let mut created = 0u64;
        for row in &additions {
            if insert_row(tx, row, now)? {
                created += 1;
            }
        }
        if created as usize != additions.len() {
            return Err(not_persisted());
        }
        return Ok(json!({"created": created, "removed": removed}));
    }
    let mut removed = 0u64;
    for link in owned.values() {
        if producer(link) && (link.origin_page_id == Some(id) || body_producer(link)) {
            delete_link(tx, link)?;
            removed += 1;
        }
    }
    let mut created = 0u64;
    for row in &item.rows {
        if insert_row(tx, row, now)? {
            created += 1;
        }
    }
    if created as usize != item.rows.len() {
        return Err(not_persisted());
    }
    Ok(json!({"created": created, "removed": removed}))
}

// ---------------------------------------------------------------------------------------------
// Fan-out walk
// ---------------------------------------------------------------------------------------------

/// One row of the recursive `walk` CTE.
struct WalkRow {
    id: u64,
    depth: u32,
    visited: Vec<u64>,
    path: Vec<String>,
    seed_source: String,
    last_link_type: Option<String>,
    edges: Vec<String>,
}

/// The rows of one page, grouped.
struct FanoutNode {
    source_id: String,
    slug: String,
    hop: u32,
    types: BTreeSet<String>,
    best: Option<((u32, usize, String), String)>,
}

impl Store {
    /// `replaceDerivedLinks` and `replaceDerivedLinksBatch`: every origin in order, in one write
    /// transaction; any failure rolls every origin back. Returns `[{ created, removed }]`.
    pub fn replace_derived_links(&self, items: &[DerivedItem]) -> Result<Vec<Value>> {
        for item in items {
            for row in &item.rows {
                crate::links::no_nul(
                    "replaceDerivedLinks",
                    &[
                        ("from_slug", opt(&row.from_slug)),
                        ("to_slug", opt(&row.to_slug)),
                        ("link_type", opt(&row.link_type)),
                        ("link_source", opt(&row.link_source)),
                        ("origin_slug", opt(&row.origin_slug)),
                        ("origin_field", opt(&row.origin_field)),
                        ("from_source_id", opt(&row.from_source_id)),
                        ("to_source_id", opt(&row.to_source_id)),
                        ("origin_source_id", opt(&row.origin_source_id)),
                        ("link_kind", opt(&row.link_kind)),
                        ("resolution_type", opt(&row.resolution_type)),
                    ],
                )?;
            }
        }
        if items.is_empty() {
            return Ok(Vec::new());
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                out.push(publish(tx, i, item, now)?);
            }
            Ok(out)
        })
    }

    /// `removeLinksByPagesAndSource(pages, { linkSource, keepTypedNerPairs })`: the number of
    /// links deleted.
    pub fn remove_links_by_pages_and_source(
        &self,
        pages: &[PageRef],
        options: &RemoveBySourceOptions,
    ) -> Result<u64> {
        if pages.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            let mut scope = BTreeSet::new();
            for p in pages {
                if let Some(page) = read_page(&*tx, &p.source_id, &p.slug)? {
                    scope.insert(page.id);
                }
            }
            let mut keep = HashSet::new();
            for k in &options.keep_typed_ner_pairs {
                if let (Some(f), Some(t)) = (
                    read_page(&*tx, &k.from_source_id, &k.from_slug)?,
                    read_page(&*tx, &k.to_source_id, &k.to_slug)?,
                ) {
                    keep.insert((f.id, t.id));
                }
            }
            let Some(link_source) = options.link_source.as_deref() else {
                return Ok(0);
            };
            let mut removed = 0u64;
            for from in scope {
                for link in out_links(&*tx, from)? {
                    if link.link_source.as_deref() != Some(link_source) {
                        continue;
                    }
                    if link.link_kind.as_deref() == Some("typed_ner")
                        && keep.contains(&(link.from_page_id, link.to_page_id))
                    {
                        continue;
                    }
                    delete_link(tx, &link)?;
                    removed += 1;
                }
            }
            Ok(removed)
        })
    }

    /// `listLinkSources(opts)`: `[{ link_source, count }]`, count descending, then link source
    /// ascending with no source last.
    pub fn list_link_sources(&self, options: &LinkSourcesOptions) -> Result<Vec<Value>> {
        let read = self.read()?;
        let scope = GraphScope {
            source_id: options.source_id.clone(),
            source_ids: options.source_ids.clone(),
            scoped: true,
            ..GraphScope::default()
        };
        let scoped = scope.has_sources();
        let mut pages = Pages::new(&*read);
        let mut counts: HashMap<Option<String>, u64> = HashMap::new();
        for link in all_links(&*read)? {
            let (Some(f), Some(t)) = (pages.get(link.from_page_id)?, pages.get(link.to_page_id)?)
            else {
                continue;
            };
            if scoped {
                if !scope.source_ok(&f.source_id) || !scope.source_ok(&t.source_id) {
                    continue;
                }
                if let Some(o) = link.origin_page_id {
                    let ok = pages.get(o)?.is_some_and(|p| {
                        p.deleted_at_us.is_none() && scope.source_ok(&p.source_id)
                    });
                    if !ok {
                        continue;
                    }
                }
            }
            *counts.entry(link.link_source.clone()).or_default() += 1;
        }
        let mut rows: Vec<(Option<String>, u64)> = counts.into_iter().collect();
        rows.sort_by(|(a, ca), (b, cb)| {
            cb.cmp(ca).then_with(|| match (a, b) {
                (Some(a), Some(b)) => a.cmp(b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
        });
        Ok(rows
            .into_iter()
            .map(|(link_source, count)| json!({"link_source": link_source, "count": count}))
            .collect())
    }

    /// `findOrphanPages(opts)`: live pages with no live inbound link (and, islanded, no outbound
    /// link to a live page), ordered by slug.
    pub fn find_orphan_pages(&self, options: &OrphanOptions) -> Result<Vec<Value>> {
        let read = self.read()?;
        let scope = GraphScope {
            source_id: options.source_id.clone(),
            source_ids: options.source_ids.clone(),
            scoped: true,
            ..GraphScope::default()
        };
        let islanded = options.mode.as_deref().unwrap_or("islanded") == "islanded";
        let mut pages = Pages::new(&*read);
        let mut out = Vec::new();
        // An endpoint counts when it is live and, with scopeInbound, in scope; its link's origin
        // must then be absent or a live in-scope page (`liveOriginFilter`).
        let counts = |pages: &mut Pages, link: &LinkRecord, other: u64| -> Result<bool> {
            let Some(end) = pages.get(other)? else {
                return Ok(false);
            };
            if end.deleted_at_us.is_some() {
                return Ok(false);
            }
            // `privatePagesFilterForCaller(end)` and `privateLinkOriginFilterForCaller(l)`: the
            // origin passes the page policy alone, live or not.
            if let Some(policy) = &options.exclude_private {
                if page_hidden(pages.read, &end, policy)? {
                    return Ok(false);
                }
                if let Some(o) = link.origin_page_id {
                    match pages.get(o)? {
                        Some(origin) if !page_hidden(pages.read, &origin, policy)? => {}
                        _ => return Ok(false),
                    }
                }
            }
            if !options.scope_inbound {
                return Ok(true);
            }
            if !scope.source_ok(&end.source_id) {
                return Ok(false);
            }
            Ok(match link.origin_page_id {
                None => true,
                Some(o) => pages
                    .get(o)?
                    .is_some_and(|p| p.deleted_at_us.is_none() && scope.source_ok(&p.source_id)),
            })
        };
        let mut candidates = Vec::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || !scope.source_ok(&page.source_id) {
                continue;
            }
            if let Some(policy) = &options.exclude_private
                && page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            candidates.push(page);
        }
        candidates.sort_by(|a, b| {
            a.slug
                .cmp(&b.slug)
                .then_with(|| a.source_id.cmp(&b.source_id))
        });
        'pages: for page in candidates {
            for link in in_links(&*read, page.id)? {
                if counts(&mut pages, &link, link.from_page_id)? {
                    continue 'pages;
                }
            }
            if islanded {
                for link in out_links(&*read, page.id)? {
                    if counts(&mut pages, &link, link.to_page_id)? {
                        continue 'pages;
                    }
                }
            }
            out.push(json!({
                "slug": page.slug,
                "title": page.title,
                "domain": page.frontmatter.get("domain").and_then(jsonb_field_text),
                "type": page.page_type,
                "quarantined": page.frontmatter.contains_key(QUARANTINE_KEY),
                "source_id": page.source_id,
            }));
        }
        Ok(out)
    }

    /// `getBacklinkCounts(ids, scope?)`: `[{ page_id, cnt }]` for each listed page that passes
    /// the target filter. The TypeScript member maps every other id to 0.
    pub fn get_backlink_counts(&self, ids: &[u64], scope: &GraphScope) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = Pages::new(&*read);
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for &id in ids {
            if !seen.insert(id) {
                continue;
            }
            let Some(page) = pages.readable(id, scope, scope.scoped)? else {
                continue;
            };
            let mut from = HashSet::new();
            for link in in_links(&*read, page.id)? {
                if link.from_page_id == page.id || !not_mentions(&link) || !ranks(&link) {
                    continue;
                }
                if scope.scoped
                    && (pages.readable(link.from_page_id, scope, true)?.is_none()
                        || !pages.origin_ok(&link, scope)?)
                {
                    continue;
                }
                from.insert(link.from_page_id);
            }
            out.push(json!({"page_id": page.id, "cnt": from.len()}));
        }
        Ok(out)
    }

    /// `hasSupersedeEdges()`: whether any link has `link_type = 'supersedes'`, on any page in
    /// any source (the SQL probe reads `links` alone).
    pub fn has_supersede_edges(&self) -> Result<bool> {
        let read = self.read()?;
        let mut found = false;
        let mut failed = None;
        scan_prefix(&*read, &[keys::LINK], false, &mut |_, v| {
            match serde_json::from_slice::<LinkRecord>(v) {
                Ok(link) => found = link.link_type == SUPERSEDES,
                Err(e) => failed = Some(StoreError::from(e)),
            }
            !found && failed.is_none()
        })?;
        match failed {
            Some(e) => Err(e),
            None => Ok(found),
        }
    }

    /// `supersedingPageSlugs(ids, policy?)`: the distinct `[{ to_page_id, by_slug }]` rows of
    /// the SQL, ordered by page id, then slug in byte order (PGLite's `Unique` over a sort, under
    /// the C collation). A row is a `supersedes` link to a listed page from a page that is not
    /// soft-deleted and is in the same source. With a policy (`scope.scoped`), both pages pass the
    /// live read filter and the link's origin page, when it has one, passes it too. The
    /// TypeScript member keeps the first row per page.
    pub fn superseding_page_slugs(&self, ids: &[u64], scope: &GraphScope) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = Pages::new(&*read);
        let mut rows: BTreeSet<(u64, String)> = BTreeSet::new();
        let targets: BTreeSet<u64> = ids.iter().copied().collect();
        for &to_id in &targets {
            let Some(to) = pages.readable(to_id, scope, scope.scoped)? else {
                continue;
            };
            for link in in_links(&*read, to.id)? {
                if link.link_type != SUPERSEDES {
                    continue;
                }
                let Some(from) = pages.readable(link.from_page_id, scope, scope.scoped)? else {
                    continue;
                };
                if from.deleted_at_us.is_some() || from.source_id != to.source_id {
                    continue;
                }
                if scope.scoped && !pages.origin_ok(&link, scope)? {
                    continue;
                }
                rows.insert((to.id, from.slug.clone()));
            }
        }
        Ok(rows
            .into_iter()
            .map(|(to, slug)| json!({"to_page_id": to, "by_slug": slug}))
            .collect())
    }

    /// `pagesLinkingTo(fromIds, toIds)`: the distinct ids among `fromIds` with a ranking link
    /// (`rankingLinkSql`) to a page in `toIds`, ascending (PGLite's `Unique` over the
    /// `(from_page_id, to_page_id, ..)` index). The SQL reads `links` alone: no page filter.
    pub fn pages_linking_to(&self, from_ids: &[u64], to_ids: &[u64]) -> Result<Vec<u64>> {
        let read = self.read()?;
        let targets: HashSet<u64> = to_ids.iter().copied().collect();
        let sources: BTreeSet<u64> = from_ids.iter().copied().collect();
        let mut out = Vec::new();
        if targets.is_empty() {
            return Ok(out);
        }
        for from_id in sources {
            if out_links(&*read, from_id)?
                .iter()
                .any(|link| targets.contains(&link.to_page_id) && ranks(link))
            {
                out.push(from_id);
            }
        }
        Ok(out)
    }

    /// `getAdjacencyBoosts(ids, scope?)`: `[{ to_page_id, hits, cross_source_hits }]` over the
    /// subgraph the ids induce, ordered by page id.
    pub fn get_adjacency_boosts(&self, ids: &[u64], scope: &GraphScope) -> Result<Vec<Value>> {
        let read = self.read()?;
        let set: BTreeSet<u64> = ids.iter().copied().collect();
        let mut pages = Pages::new(&*read);
        let mut groups: BTreeMap<u64, (HashSet<u64>, HashSet<String>)> = BTreeMap::new();
        for &from_id in &set {
            let Some(from) = pages.get(from_id)? else {
                continue;
            };
            if from.deleted_at_us.is_some() || !pages.passes(&from, scope, scope.scoped)? {
                continue;
            }
            for link in out_links(&*read, from_id)? {
                if !set.contains(&link.to_page_id) || !ranks(&link) {
                    continue;
                }
                let Some(to) = pages.get(link.to_page_id)? else {
                    continue;
                };
                if to.deleted_at_us.is_some() || !pages.passes(&to, scope, scope.scoped)? {
                    continue;
                }
                if scope.scoped && !pages.origin_ok(&link, scope)? {
                    continue;
                }
                let entry = groups.entry(to.id).or_default();
                entry.0.insert(from.id);
                if from.source_id != to.source_id {
                    entry.1.insert(from.source_id.clone());
                }
            }
        }
        Ok(groups
            .into_iter()
            .map(|(to, (hits, cross))| {
                json!({"to_page_id": to, "hits": hits.len(), "cross_source_hits": cross.len()})
            })
            .collect())
    }

    /// `relationalFanout(seeds, opts)`: every simple path from the seeds up to `depth` hops,
    /// grouped per reached page.
    pub fn relational_fanout(
        &self,
        seeds: &[String],
        options: &FanoutOptions,
    ) -> Result<Vec<Value>> {
        if seeds.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let scope = GraphScope {
            source_id: options.source_id.clone(),
            source_ids: options.source_ids.clone(),
            scoped: options.scoped,
            exclude_private: options.exclude_private.clone(),
            min_trust: options.min_trust.clone(),
            suppress_flagged: options.suppress_flagged,
        };
        let policy = scope.scoped;
        // Without a read policy pageReadFilter renders TRUE, source clause included.
        let filter = if policy {
            scope.clone()
        } else {
            GraphScope::default()
        };
        let direction = options.direction.as_deref().unwrap_or("both");
        let seed_set: HashSet<&str> = seeds.iter().map(String::as_str).collect();
        let link_types: Option<HashSet<&str>> = options
            .link_types
            .as_ref()
            .filter(|t| !t.is_empty())
            .map(|t| t.iter().map(String::as_str).collect());
        let mut pages = Pages::new(&*read);
        let mut stack: Vec<WalkRow> = Vec::new();
        for page in all_pages(&*read)? {
            if !seed_set.contains(page.slug.as_str())
                || page.deleted_at_us.is_some()
                || !pages.passes(&page, &filter, policy)?
            {
                continue;
            }
            if let Some(refs) = &options.seed_refs
                && !refs
                    .iter()
                    .any(|r| r.source_id == page.source_id && r.slug == page.slug)
            {
                continue;
            }
            stack.push(WalkRow {
                id: page.id,
                depth: 0,
                visited: vec![page.id],
                path: vec![page.slug.clone()],
                seed_source: page.source_id.clone(),
                last_link_type: None,
                edges: Vec::new(),
            });
        }
        let mut nodes: HashMap<u64, FanoutNode> = HashMap::new();
        let mut incident: HashMap<u64, Vec<LinkRecord>> = HashMap::new();
        while let Some(row) = stack.pop() {
            if row.depth > 0 {
                let page = pages.get(row.id)?.expect("walked page exists");
                let node = nodes.entry(row.id).or_insert_with(|| FanoutNode {
                    source_id: page.source_id.clone(),
                    slug: page.slug.clone(),
                    hop: row.depth,
                    types: BTreeSet::new(),
                    best: None,
                });
                node.hop = node.hop.min(row.depth);
                if let Some(t) = &row.last_link_type {
                    node.types.insert(t.clone());
                }
                let key = (row.depth, row.path.len(), row.path.join("\t"));
                let edges = row.edges.join("\t");
                let better = match &node.best {
                    None => true,
                    Some((k, e)) => (&key, &edges) < (k, e),
                };
                if better {
                    node.best = Some((key, edges));
                }
            }
            if row.depth >= options.depth {
                continue;
            }
            let w = pages.get(row.id)?.expect("walked page exists");
            let links = match incident.get(&row.id) {
                Some(links) => links.clone(),
                None => {
                    let links = match direction {
                        "out" => out_links(&*read, row.id)?,
                        "in" => in_links(&*read, row.id)?,
                        _ => touching(&*read, row.id)?,
                    };
                    incident.insert(row.id, links.clone());
                    links
                }
            };
            for link in links {
                let next = match direction {
                    "out" => link.to_page_id,
                    "in" => link.from_page_id,
                    _ if link.from_page_id == row.id => link.to_page_id,
                    _ => link.from_page_id,
                };
                if row.visited.contains(&next)
                    || !ranks(&link)
                    || (!options.include_mentions && !not_mentions(&link))
                    || link_types
                        .as_ref()
                        .is_some_and(|t| !t.contains(link.link_type.as_str()))
                {
                    continue;
                }
                let Some(p2) = pages.get(next)? else { continue };
                if p2.source_id != row.seed_source
                    || p2.deleted_at_us.is_some()
                    || !pages.passes(&p2, &filter, policy)?
                    || (policy && !pages.origin_ok(&link, &filter)?)
                {
                    continue;
                }
                let edge = match direction {
                    "out" => format!("{}|{}|{}", w.slug, link.link_type, p2.slug),
                    "in" => format!("{}|{}|{}", p2.slug, link.link_type, w.slug),
                    _ if link.from_page_id == row.id => {
                        format!("{}|{}|{}", w.slug, link.link_type, p2.slug)
                    }
                    _ => format!("{}|{}|{}", p2.slug, link.link_type, w.slug),
                };
                let mut visited = row.visited.clone();
                visited.push(p2.id);
                let mut path = row.path.clone();
                path.push(p2.slug.clone());
                let mut edges = row.edges.clone();
                edges.push(edge);
                stack.push(WalkRow {
                    id: p2.id,
                    depth: row.depth + 1,
                    visited,
                    path,
                    seed_source: row.seed_source.clone(),
                    last_link_type: Some(link.link_type.clone()),
                    edges,
                });
            }
        }
        let mut grouped: Vec<(u64, FanoutNode)> = nodes.into_iter().collect();
        grouped.sort_by(|(_, a), (_, b)| {
            a.hop
                .cmp(&b.hop)
                .then_with(|| b.types.len().cmp(&a.types.len()))
                .then_with(|| a.source_id.cmp(&b.source_id))
                .then_with(|| a.slug.cmp(&b.slug))
        });
        grouped.truncate(options.limit);
        let mut out = Vec::with_capacity(grouped.len());
        for (id, node) in grouped {
            let (path, edges) = node.best.map(|((_, _, p), e)| (p, e)).unwrap_or_default();
            let split = |s: &str| -> Vec<String> {
                if s.is_empty() {
                    Vec::new()
                } else {
                    s.split('\t').map(str::to_string).collect()
                }
            };
            out.push(json!({
                "source_id": node.source_id,
                "slug": node.slug,
                "hop": node.hop,
                "edge_count": node.types.len(),
                "via_link_types": node.types.into_iter().collect::<Vec<_>>(),
                "path": split(&path),
                "path_edges": split(&edges),
                "canonical_chunk_id": pages.canonical_chunk(id, options.require_safe_chunks)?,
            }));
        }
        Ok(out)
    }

    /// `relationalChainHop(frontier, opts)`: one oriented, authorized expansion step, ordered by
    /// frontier id and lowest link id.
    pub fn relational_chain_hop(
        &self,
        frontier: &[u64],
        options: &ChainHopOptions,
    ) -> Result<Vec<Value>> {
        if frontier.is_empty() || options.link_types.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let scope = GraphScope {
            source_id: options.source_id.clone(),
            source_ids: options.source_ids.clone(),
            scoped: true,
            exclude_private: options.exclude_private.clone(),
            min_trust: options.min_trust.clone(),
            suppress_flagged: options.suppress_flagged,
        };
        let cap = options.neighbor_cap.clamp(1, 1000);
        let has = |list: &[String], v: &str| list.iter().any(|x| x == v);
        let frontier: BTreeSet<u64> = frontier.iter().copied().collect();
        let toward_object = options.toward == "object";
        let mut pages = Pages::new(&*read);
        let mut out = Vec::new();
        for &f in &frontier {
            // (next, link id, orientation rank, orientation, source)
            let mut stepped: Vec<(u64, u64, u8, &'static str, String)> = Vec::new();
            let mut links_by_id: HashMap<u64, LinkRecord> = HashMap::new();
            for link in touching(&*read, f)? {
                if !has(&options.link_types, &link.link_type)
                    || link.from_page_id == link.to_page_id
                    || !not_mentions(&link)
                    || !ranks(&link)
                {
                    continue;
                }
                let (Some(lf), Some(lt)) = (
                    pages.readable(link.from_page_id, &scope, true)?,
                    pages.readable(link.to_page_id, &scope, true)?,
                ) else {
                    continue;
                };
                if lf.source_id != lt.source_id || !pages.origin_ok(&link, &scope)? {
                    continue;
                }
                let forward = has(&options.subject_types, &lf.page_type)
                    && has(&options.object_types, &lt.page_type);
                let reverse = has(&options.subject_types, &lt.page_type)
                    && has(&options.object_types, &lf.page_type);
                let canonical_row =
                    matches!(link.link_source.as_deref(), Some("frontmatter" | "manual"))
                        || (link.link_type == "attended" && link.origin_page_id.is_some());
                let orientation = if canonical_row {
                    forward.then_some("canonical")
                } else if forward && reverse {
                    Some("uncertain")
                } else if forward {
                    Some("stored")
                } else if reverse {
                    Some("flipped")
                } else {
                    None
                };
                let Some(orientation) = orientation else {
                    continue;
                };
                let (subject, object) = if orientation == "flipped" {
                    (link.to_page_id, link.from_page_id)
                } else {
                    (link.from_page_id, link.to_page_id)
                };
                let (next, near) = if toward_object {
                    (object, subject)
                } else {
                    (subject, object)
                };
                if near != f {
                    continue;
                }
                let rank = match orientation {
                    "canonical" => 0,
                    "stored" => 1,
                    "flipped" => 2,
                    _ => 3,
                };
                stepped.push((next, link.id, rank, orientation, lf.source_id.clone()));
                links_by_id.insert(link.id, link);
            }
            // logical: group by next.
            struct Logical {
                next: u64,
                source_id: String,
                min_lid: u64,
                link_ids: Vec<u64>,
                evidence: (u8, u64),
                orientation: &'static str,
            }
            let mut logical: BTreeMap<u64, Logical> = BTreeMap::new();
            for (next, lid, rank, orientation, source) in stepped {
                let g = logical.entry(next).or_insert_with(|| Logical {
                    next,
                    source_id: source.clone(),
                    min_lid: lid,
                    link_ids: Vec::new(),
                    evidence: (rank, lid),
                    orientation,
                });
                if source < g.source_id {
                    g.source_id = source;
                }
                g.min_lid = g.min_lid.min(lid);
                g.link_ids.push(lid);
                if (rank, lid) < g.evidence {
                    g.evidence = (rank, lid);
                    g.orientation = orientation;
                }
            }
            let mut groups: Vec<Logical> = logical.into_values().collect();
            if groups.is_empty() {
                continue;
            }
            groups.sort_by_key(|g| g.min_lid);
            let per_frontier = groups.len();
            groups.truncate(cap);
            // Degree over the readable typed neighbors.
            let mut deg_rows = Vec::new();
            for link in touching(&*read, f)? {
                if deg_rows.len() >= CHAIN_DEGREE_SATURATION {
                    break;
                }
                if link.from_page_id == link.to_page_id
                    || !has(&options.degree_link_types, &link.link_type)
                    || !not_mentions(&link)
                    || !ranks(&link)
                {
                    continue;
                }
                let nb = if link.from_page_id == f {
                    link.to_page_id
                } else {
                    link.from_page_id
                };
                if pages.readable(nb, &scope, true)?.is_none() || !pages.origin_ok(&link, &scope)? {
                    continue;
                }
                deg_rows.push(nb);
            }
            let degree = if deg_rows.len() >= CHAIN_DEGREE_SATURATION {
                CHAIN_DEGREE_SATURATION
            } else {
                deg_rows.iter().collect::<HashSet<_>>().len()
            };
            for mut g in groups {
                let Some(np) = pages.get(g.next)? else {
                    continue;
                };
                let el = links_by_id[&g.evidence.1].clone();
                let (Some(sf), Some(st)) = (pages.get(el.from_page_id)?, pages.get(el.to_page_id)?)
                else {
                    continue;
                };
                let origin_slug = match el.origin_page_id {
                    Some(o) => pages.get(o)?.map(|p| p.slug.clone()),
                    None => None,
                };
                let evidence_page = el.origin_page_id.unwrap_or(el.from_page_id);
                let context = match pages.readable(evidence_page, &scope, true)? {
                    None => None,
                    Some(ev) => {
                        let kinds: &[&str] = match options.text_gate.as_deref() {
                            None => &[],
                            Some("takes") => &["takes"],
                            Some("body") => &["facts", "takes"],
                            Some(other) => {
                                return Err(StoreError::new(
                                    INVALID_ARGUMENT,
                                    format!("relationalChainHop: unknown textGate {other:?}"),
                                ));
                            }
                        };
                        let gated = !kinds.is_empty()
                            && (!sealed_safe(&ev) || protected_body(&*read, &ev, kinds)?);
                        (!gated).then(|| el.context.clone())
                    }
                };
                g.link_ids.sort_unstable();
                out.push(json!({
                    "from_page_id": f,
                    "to_page_id": g.next,
                    "to_slug": np.slug,
                    "to_type": np.page_type,
                    "source_id": g.source_id,
                    "link_type": el.link_type,
                    "orientation": g.orientation,
                    "link_ids": g.link_ids,
                    "stored_from_slug": sf.slug,
                    "stored_to_slug": st.slug,
                    "context": context,
                    "origin_page_id": el.origin_page_id,
                    "origin_slug": origin_slug,
                    "canonical_chunk_id": pages.canonical_chunk(g.next, options.require_safe_chunks)?,
                    "from_degree": degree,
                    "neighbor_cap_hit": per_frontier > cap,
                }));
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_source_rows_deletes_only_that_source() {
        let store = crate::test_support::store();
        let key = |source: &str, rest: &str| {
            let mut k = vec![keys::LINK_QUERIES];
            k.extend_from_slice(source.as_bytes());
            k.push(0);
            k.extend_from_slice(rest.as_bytes());
            k
        };
        store
            .write(|tx| {
                tx.put(&key("gone", "a"), b"1")?;
                tx.put(&key("gone", "b"), b"1")?;
                tx.put(&key("gone-too", "a"), b"1")?;
                tx.put(&key("kept", "a"), b"1")?;
                Ok(())
            })
            .unwrap();
        store.write(|tx| remove_source_rows(tx, "gone")).unwrap();
        let read = store.read().unwrap();
        assert!(read.get(&key("gone", "a")).unwrap().is_none());
        assert!(read.get(&key("gone", "b")).unwrap().is_none());
        assert!(read.get(&key("gone-too", "a")).unwrap().is_some());
        assert!(read.get(&key("kept", "a")).unwrap().is_some());
    }

    #[test]
    fn scope_follows_page_read_filter() {
        let none = GraphScope::default();
        assert!(none.source_ok("x") && !none.has_sources());
        let empty_ids = GraphScope {
            source_ids: Some(vec![]),
            source_id: Some("a".into()),
            scoped: true,
            ..GraphScope::default()
        };
        assert!(empty_ids.source_ok("a") && !empty_ids.source_ok("b"));
        let blank = GraphScope {
            source_id: Some(String::new()),
            ..GraphScope::default()
        };
        assert!(blank.source_ok("anything") && !blank.has_sources());
        let ids = GraphScope {
            source_ids: Some(vec!["b".into()]),
            source_id: Some("a".into()),
            scoped: true,
            ..GraphScope::default()
        };
        assert!(ids.source_ok("b") && !ids.source_ok("a"));
    }
}
