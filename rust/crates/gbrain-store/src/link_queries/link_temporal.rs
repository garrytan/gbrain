//! Link temporal state (temporal typed edges): the store's `link_transitions` and
//! `link_relationships` rows and the members that read and write them. PGLite and Postgres run
//! the SQL in `src/core/engine-sql/link-temporal.ts`; these answer the same members from the
//! store's records (rust/docs/store/link_temporal.md).
//!
//! Members: readLinkRelationshipEvidence, writeLinkRelationshipState,
//! linkRelationshipKeysForPages, staleLinkRelationshipKeys, linkRelationshipKeysForOrigin,
//! linkRelationshipKeysTouching, applyLinkTemporalRows, writeManualLinkTransitions,
//! removeManualLinkTransitions, listRelationshipNoteRows, readEntityInboundEdges, edgeValidityCounts,
//! listPageStatusByRef, listRecordMetadataRows, readReferrerGroupRows, readReferrerPageDetails, readReferrerTargetCounts,
//! countSearchVectorRows.
//!
//! The state itself (stints, status, evidence hash) is built by the pure TypeScript builder in
//! `src/core/link-relationships.ts` on every engine; the store only keeps rows.
//!
//! Keys: both record kinds sit under the link_queries tag, keyed by the source of the
//! relationship's from page, so a source delete through `link_queries::remove_source_rows`
//! removes them:
//!
//! ```text
//! q <source_id> \0 R <from BE8> <to BE8> <link_type> \0 <scope>      RelationshipRecord
//! q <source_id> \0 T <from BE8> <to BE8> <link_type> \0 <id BE8>     TransitionRecord
//! ```
//!
//! `M link_transition_id` is the transition id counter. A hard page delete removes the rows whose
//! from, to or origin page it is (`remove_page_rows`; Postgres declares those foreign keys
//! `ON DELETE CASCADE`). `valid_ranges` is kept in the canonical text form Postgres prints for a
//! `datemultirange`.

use super::site_reads::kept_inbound_links;
use super::{InboundCountInput, Pages, QUARANTINE_KEY, origin_links};
use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::{LinkRecord, in_links, out_links, put_link};
use crate::pages::{PageRecord, all_pages, next_id, read_page, read_page_by_id};
use crate::trust::valid_time::AmendmentsQuery;
use crate::trust::{TrustPolicy, TrustTier};
use crate::{Store, keys, put_json};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

/// The sub-tag after `q <source> \0` that marks a relationship state row.
const RELATIONSHIP: u8 = b'R';
/// The sub-tag after `q <source> \0` that marks a transition row.
const TRANSITION: u8 = b'T';
pub(crate) const TRANSITION_ID: &str = "link_transition_id";
const SCOPES: [&str; 2] = ["all", "world"];
const SEMANTICS: [&str; 2] = ["state", "event"];
const STATUSES: [&str; 6] = [
    "live",
    "ended",
    "ended_unknown_date",
    "not_started",
    "disputed",
    "event",
];
const KINDS: [&str; 2] = ["start", "end"];
const PRECISIONS: [&str; 3] = ["day", "month", "year"];
const PRODUCERS: [&str; 6] = [
    "timeline",
    "explicit",
    "frontmatter",
    "manual",
    "inline",
    "dream",
];

/// One `link_relationships` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct RelationshipRecord {
    pub from_page_id: u64,
    pub to_page_id: u64,
    pub link_type: String,
    pub scope: String,
    pub source_id: String,
    pub semantics: String,
    /// Canonical `datemultirange` text: `{[2021-04-01,2025-03-01),[2026-01-01,)}`, `{}` when empty.
    pub valid_ranges: String,
    pub status_now: String,
    pub first_start: Option<String>,
    pub last_start: Option<String>,
    pub last_end: Option<String>,
    pub undated_present: i64,
    pub undated_past: i64,
    pub disputed: bool,
    pub recorded_at_us: i64,
    pub retired_at_us: Option<i64>,
    pub evidence_hash: String,
    pub refreshed_at_us: i64,
}

/// One `link_transitions` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct TransitionRecord {
    pub id: u64,
    pub source_id: String,
    pub from_page_id: u64,
    pub to_page_id: u64,
    pub link_type: String,
    pub kind: String,
    pub occurred_on: String,
    pub date_precision: String,
    pub producer: String,
    pub origin_page_id: Option<u64>,
    pub line_hash: String,
    pub link_source: Option<String>,
    pub created_at_us: i64,
}

impl TransitionRecord {
    /// The unique identity `(origin, from, to, link_type, link_source, kind, occurred_on,
    /// producer) NULLS NOT DISTINCT`.
    fn same_identity(&self, other: &TransitionRecord) -> bool {
        self.origin_page_id == other.origin_page_id
            && self.from_page_id == other.from_page_id
            && self.to_page_id == other.to_page_id
            && self.link_type == other.link_type
            && self.link_source == other.link_source
            && self.kind == other.kind
            && self.occurred_on == other.occurred_on
            && self.producer == other.producer
    }

    fn key(&self) -> RelationshipKey {
        RelationshipKey::new(self.from_page_id, self.to_page_id, &self.link_type)
    }
}

/// `RelationshipKey` of `src/core/link-relationships.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(default)]
pub struct RelationshipKey {
    pub from_page_id: u64,
    pub to_page_id: u64,
    pub link_type: String,
}

impl RelationshipKey {
    pub(crate) fn new(from: u64, to: u64, link_type: &str) -> Self {
        RelationshipKey {
            from_page_id: from,
            to_page_id: to,
            link_type: link_type.to_string(),
        }
    }

    pub(crate) fn of_link(link: &LinkRecord) -> Self {
        RelationshipKey::new(link.from_page_id, link.to_page_id, &link.link_type)
    }
}

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/// `readLinkRelationshipEvidence`: the keys and the page policy of `privatePagesFilterFragment`
/// (no caller) that decides whether an origin is public.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EvidenceInput {
    pub keys: Vec<RelationshipKey>,
    /// Required.
    pub origin_policy: Option<PrivacyPolicy>,
}

/// One assertion row (`links` evidence).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssertionRow {
    pub from_page_id: u64,
    pub to_page_id: u64,
    pub link_type: String,
    pub origin_id: u64,
    pub tense: String,
    pub created_at: String,
    pub source_id: String,
    pub origin_public: bool,
}

/// One transition row (`link_transitions` evidence).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TransitionRow {
    pub from_page_id: u64,
    pub to_page_id: u64,
    pub link_type: String,
    pub origin_id: Option<u64>,
    pub kind: String,
    pub occurred_on: String,
    pub producer: String,
    pub created_at: String,
    pub source_id: String,
    pub origin_public: bool,
}

/// One existing state row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExistingRow {
    pub from_page_id: u64,
    pub to_page_id: u64,
    pub link_type: String,
    pub scope: String,
    pub recorded_at: String,
    pub retired_at: Option<String>,
    pub evidence_hash: String,
}

/// What `readLinkRelationshipEvidence` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RelationshipEvidence {
    pub assertions: Vec<AssertionRow>,
    pub transitions: Vec<TransitionRow>,
    pub existing: Vec<ExistingRow>,
}

/// One upsert row of `writeLinkRelationshipState`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RelationshipUpsert {
    pub from_page_id: u64,
    pub to_page_id: u64,
    pub link_type: String,
    pub scope: String,
    pub source_id: String,
    pub semantics: String,
    pub valid_ranges: String,
    pub status_now: String,
    pub first_start: Option<String>,
    pub last_start: Option<String>,
    pub last_end: Option<String>,
    pub undated_present: i64,
    pub undated_past: i64,
    pub disputed: bool,
    pub recorded_at: String,
    pub retired_at: Option<String>,
    pub evidence_hash: String,
}

/// One removal of `writeLinkRelationshipState`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct RelationshipRemoval {
    pub from_page_id: u64,
    pub to_page_id: u64,
    pub link_type: String,
    pub scope: String,
}

/// `writeLinkRelationshipState`: the rows to write and remove, and how many of the upserts the
/// builder counted as changed.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct StateWrite {
    pub upserts: Vec<RelationshipUpsert>,
    pub removals: Vec<RelationshipRemoval>,
    pub changed: u64,
}

/// `linkRelationshipKeysForPages`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeysForPagesInput {
    pub page_ids: Vec<u64>,
    pub link_types: Vec<String>,
}

/// `staleLinkRelationshipKeys`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StaleKeysInput {
    pub limit: u64,
    pub link_types: Vec<String>,
}

/// `linkRelationshipKeysForOrigin`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeysForOriginInput {
    pub page_id: u64,
    pub link_types: Vec<String>,
}

/// A page reference `{ slug, source_id }`.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(default)]
pub struct PageRef {
    pub slug: String,
    pub source_id: String,
}

/// One link endpoint pair of `linkRelationshipKeysTouching`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct EndpointPair {
    pub from_slug: String,
    pub from_source_id: String,
    pub to_slug: String,
    pub to_source_id: String,
}

/// `linkRelationshipKeysTouching`: the relationships a link delete can change, read before it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeysTouchingInput {
    pub pairs: Vec<EndpointPair>,
    pub from_pages: Vec<PageRef>,
    pub link_types: Vec<String>,
}

/// One tense row of `applyLinkTemporalRows`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TenseRow {
    pub from_slug: String,
    pub to_slug: String,
    pub link_type: String,
    pub link_source: String,
    pub from_source_id: String,
    pub to_source_id: String,
    pub tense: Option<String>,
}

/// One derived transition of `applyLinkTemporalRows`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DerivedTransitionRow {
    pub from_slug: String,
    pub to_slug: String,
    pub link_type: String,
    pub kind: String,
    pub occurred_on: String,
    pub date_precision: String,
    pub producer: String,
    pub line_hash: String,
}

/// `applyLinkTemporalRows`: one origin page's temporal evidence.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ApplyTemporalInput {
    pub page_id: u64,
    pub source_id: String,
    pub tense_rows: Vec<TenseRow>,
    pub transitions: Vec<DerivedTransitionRow>,
    pub explicit_targets: Vec<String>,
    pub producers: Vec<String>,
    pub link_types: Vec<String>,
}

/// What `applyLinkTemporalRows` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyTemporalResult {
    pub inserted: Vec<RelationshipKey>,
    pub live_targets: Vec<String>,
    pub keys_after: Vec<RelationshipKey>,
}

/// The relationship of a manual statement.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ManualRelationship {
    pub from: String,
    pub to: String,
    pub link_type: Option<String>,
    pub source_id: String,
    pub database_only: bool,
}

/// One manual statement row `{ kind, occurred_on }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ManualRow {
    pub kind: String,
    pub occurred_on: String,
}

/// `writeManualLinkTransitions`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ManualWriteInput {
    pub rel: ManualRelationship,
    pub rows: Vec<ManualRow>,
}

/// What `writeManualLinkTransitions` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ManualWriteResult {
    pub inserted: u64,
    pub key: Option<RelationshipKey>,
}

/// `listRelationshipNoteRows`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NoteRowsInput {
    pub subjects: Vec<PageRef>,
    /// The page policy of `privatePagesFilterForCaller`, or none for a trusted read.
    pub exclude_private: Option<PrivacyPolicy>,
}

/// One relationship note row, with the temporal columns of `TEMPORAL_LINK_SELECT_SQL`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NoteRow {
    pub from_slug: String,
    pub source_id: String,
    pub to_slug: String,
    pub to_title: String,
    pub link_type: String,
    pub last_end: Option<String>,
    pub end_upper_bound: bool,
    pub temporal_ranges: String,
    pub temporal_semantics: String,
    pub temporal_disputed: bool,
    pub temporal_undated_past: i64,
    pub temporal_first_start: Option<String>,
    pub temporal_recorded_at: String,
    pub temporal_retired_at: Option<String>,
}

/// One `readEntityInboundEdges` row: the referrer, the link, and the temporal columns of
/// `TEMPORAL_LINK_SELECT_SQL`, all null when the link has no relationship row in the scope.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InboundEdgeRow {
    pub from_slug: String,
    pub link_type: String,
    pub context: String,
    pub temporal_ranges: Option<String>,
    pub temporal_semantics: Option<String>,
    pub temporal_disputed: Option<bool>,
    pub temporal_undated_past: Option<i64>,
    pub temporal_first_start: Option<String>,
    pub temporal_recorded_at: Option<String>,
    pub temporal_retired_at: Option<String>,
}

/// `edgeValidityCounts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EdgeValidityInput {
    pub source_ids: Option<Vec<String>>,
    pub stale_limit: u64,
}

/// One status count.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatusCount {
    pub status: String,
    pub n: u64,
}

/// One page that still states a relationship its timeline ended.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StaleAssertion {
    pub slug: String,
    pub target: String,
    pub link_type: String,
    pub ended: Option<String>,
}

/// Contradiction proposal counts by status, from edge_proposals.rs.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProposalCounts {
    pub proposed: u64,
    pub undated: u64,
    pub applied: u64,
}

/// What `edgeValidityCounts` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeValidityCounts {
    pub by_status: Vec<StatusCount>,
    pub stale: Vec<StaleAssertion>,
    pub proposals: ProposalCounts,
}

/// `listPageStatusByRef`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PageStatusInput {
    pub refs: Vec<PageRef>,
    pub exclude_private: Option<PrivacyPolicy>,
    pub include_quarantined: bool,
}

/// One `{ source_id, slug, status }` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageStatusRow {
    pub source_id: String,
    pub slug: String,
    pub status: Value,
}

/// `listRecordMetadataRows`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RecordMetadataInput {
    pub page_ids: Vec<u64>,
    pub referrer_sources: Vec<String>,
    pub exclude_private: Option<PrivacyPolicy>,
    pub include_quarantined: bool,
    /// The relationship scope `since` is read from: `world` or `all`.
    pub scope: String,
}

/// One `{ id, status }` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IdStatusRow {
    pub id: u64,
    pub status: Value,
}

/// One `amends` or `supersedes` link of a referring page.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct RecordLinkRow {
    pub from_id: u64,
    pub slug: String,
    pub link_type: String,
    pub since: Option<String>,
}

/// What `listRecordMetadataRows` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecordMetadataRows {
    pub status: Vec<IdStatusRow>,
    pub links: Vec<RecordLinkRow>,
}

/// `readReferrerGroupRows`: the entity card's referrer groups.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReferrerGroupInput {
    /// The target pages, `(targetSources[i], targetSlugs[i])`.
    pub target_sources: Vec<String>,
    pub target_slugs: Vec<String>,
    pub referrer_sources: Vec<String>,
    /// Pack type aliases and the canonical type each maps to, index for index.
    pub stored_types: Vec<String>,
    pub canonical_types: Vec<String>,
    pub exclude_private: Option<PrivacyPolicy>,
    /// `pageEligibleSql`'s floor over the referrer's stamped tier.
    pub min_trust: Option<String>,
    /// Drop a referrer `activationSuppressedSql` flags.
    pub suppress_flagged: bool,
    pub include_quarantined: bool,
    pub per_group: u64,
}

/// One referring page of `readReferrerGroupRows`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReferrerGroupRow {
    pub id: u64,
    pub slug: String,
    pub source_id: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub canonical_type: String,
    /// `COALESCE(effective_date, updated_at)` as `to_char` UTC microsecond text.
    pub d: String,
    pub gtotal: u64,
}

/// `readReferrerTargetCounts`: the batched card counts per target index.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReferrerTargetCountInput {
    /// The target pages, `(targetSources[k], targetSlugs[k])`, each of index `targetIndexes[k]`.
    pub target_sources: Vec<String>,
    pub target_slugs: Vec<String>,
    pub target_indexes: Vec<i64>,
    pub referrer_sources: Vec<String>,
    /// Pack type aliases and the canonical type each maps to, index for index.
    pub stored_types: Vec<String>,
    pub canonical_types: Vec<String>,
    /// The canonical types counted on their own.
    pub record_types: Vec<String>,
    pub exclude_private: Option<PrivacyPolicy>,
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
    pub include_quarantined: bool,
}

/// One count of `readReferrerTargetCounts`: an index's total (`canonical_type` null) or its total for a record type.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReferrerTargetCountRow {
    pub i: i64,
    pub canonical_type: Option<String>,
    pub n: u64,
}

/// `listReferrerTargetSources`: the sources among `sources` holding a live page with this slug.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReferrerTargetSourcesInput {
    pub slug: String,
    pub sources: Vec<String>,
}

/// `countReferrerRows` and `readReferrerRows`: the referrer page (`get_backlinks` group `page`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReferrerRowInput {
    /// The target pages, `(targetSources[i], targetSlugs[i])`.
    pub target_sources: Vec<String>,
    pub target_slugs: Vec<String>,
    pub referrer_sources: Vec<String>,
    /// Pack type aliases and the canonical type each maps to, index for index.
    pub stored_types: Vec<String>,
    pub canonical_types: Vec<String>,
    pub exclude_private: Option<PrivacyPolicy>,
    /// A canonical or stored type the referrer has; none for every type.
    #[serde(rename = "type")]
    pub page_type: Option<String>,
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
    pub include_quarantined: bool,
    /// `readReferrerRows` only: the row the page continues after, `[d or null, source_id, slug]`.
    pub cursor: Option<(Option<String>, String, String)>,
    /// `readReferrerRows` only: the rows kept.
    pub limit: u64,
}

/// One referring page of `readReferrerRows`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReferrerRow {
    pub id: u64,
    pub slug: String,
    pub source_id: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub canonical_type: String,
    /// `COALESCE(effective_date, updated_at)` as `to_char` UTC microsecond text.
    pub d: String,
}

/// One distinct `(canonical_type, type)` pair of `readReferrerTypes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReferrerTypeRow {
    pub canonical_type: String,
    #[serde(rename = "type")]
    pub page_type: String,
}

/// `readReferrerRecordCandidates`: the newest referrers of the record types per target index.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReferrerRecordCandidateInput {
    /// The target pages, `(targetSources[k], targetSlugs[k])`, each of index `targetIndexes[k]`.
    pub target_sources: Vec<String>,
    pub target_slugs: Vec<String>,
    pub target_indexes: Vec<i64>,
    pub referrer_sources: Vec<String>,
    pub stored_types: Vec<String>,
    pub canonical_types: Vec<String>,
    /// The canonical types a candidate has.
    pub record_types: Vec<String>,
    pub exclude_private: Option<PrivacyPolicy>,
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
    pub include_quarantined: bool,
    /// The rows kept per index.
    pub per_target: u64,
}

/// One record candidate of `readReferrerRecordCandidates`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReferrerRecordCandidateRow {
    pub i: i64,
    pub id: u64,
    pub slug: String,
    pub source_id: String,
    pub canonical_type: String,
    pub d: String,
}

/// One record page of `readReferrerRecordPages`: its title and date source.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReferrerRecordPageRow {
    pub id: u64,
    pub title: String,
    pub date_source: String,
}

/// A referring page with its date (`COALESCE(effective_date, updated_at)`) and canonical type.
type DatedReferrer = (i64, Rc<PageRecord>, String);

/// Newest first by `(d DESC, source_id, slug)` bytewise.
fn newest_first(rows: &mut [DatedReferrer]) {
    rows.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.source_id.cmp(&b.1.source_id))
            .then_with(|| a.1.slug.cmp(&b.1.slug))
    });
}

/// `updated_at` with no effective date, else the effective date's source (`effective_date` when
/// none is recorded).
fn date_source(page: &PageRecord) -> String {
    if page.effective_date_us.is_none() {
        "updated_at".to_owned()
    } else {
        page.effective_date_source
            .clone()
            .unwrap_or_else(|| "effective_date".to_owned())
    }
}

/// The `typed` CTE's read scope, shared by the referrer reads.
struct ReferrerScope<'a> {
    referrer_sources: &'a [String],
    stored_types: &'a [String],
    canonical_types: &'a [String],
    exclude_private: Option<&'a PrivacyPolicy>,
    trust: TrustPolicy,
    include_quarantined: bool,
}

impl ReferrerScope<'_> {
    /// The referrers of the live, shown targets `(sources[i], slugs[i])`, dated, newest first.
    fn dated_referrers(
        &self,
        read: &dyn KvRead,
        target_sources: &[String],
        target_slugs: &[String],
    ) -> Result<Vec<DatedReferrer>> {
        let mut pages = Pages::new(read);
        let mut targets = BTreeSet::new();
        for (source_id, slug) in target_sources.iter().zip(target_slugs) {
            targets.extend(self.target(read, source_id, slug)?);
        }
        let mut rows: Vec<DatedReferrer> = self
            .referrers(read, &mut pages, &targets)?
            .into_iter()
            .map(|(page, canonical)| {
                (
                    page.effective_date_us.unwrap_or(page.updated_at_us),
                    page,
                    canonical,
                )
            })
            .collect();
        newest_first(&mut rows);
        Ok(rows)
    }

    /// `tgt`: the live target page's id, unless the policy hides it.
    fn target(&self, read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Option<u64>> {
        let Some(target) = live_page(read, source_id, slug)? else {
            return Ok(None);
        };
        if let Some(policy) = self.exclude_private
            && page_hidden(read, &target, policy)?
        {
            return Ok(None);
        }
        Ok(Some(target.id))
    }

    /// `refs` and `typed`: each live page in `referrer_sources` that links to one of `targets` and is
    /// not one of them, with its canonical type, in id order. A policy leaves out a link whose origin
    /// page it hides and a hidden referrer; the trust floor, the flagged filter and quarantine apply.
    fn referrers(
        &self,
        read: &dyn KvRead,
        pages: &mut Pages<'_>,
        targets: &BTreeSet<u64>,
    ) -> Result<Vec<(Rc<PageRecord>, String)>> {
        let mut refs = BTreeSet::new();
        for target in targets {
            for link in in_links(read, *target)? {
                if let Some(policy) = self.exclude_private
                    && !link_origin_shown(pages, &link, policy)?
                {
                    continue;
                }
                refs.insert(link.from_page_id);
            }
        }
        let mut out = Vec::new();
        for id in refs {
            if targets.contains(&id) {
                continue;
            }
            let Some(page) = pages.get(id)?.filter(|p| live(p)) else {
                continue;
            };
            if !self.referrer_sources.contains(&page.source_id) {
                continue;
            }
            if let Some(policy) = self.exclude_private
                && page_hidden(read, &page, policy)?
            {
                continue;
            }
            let tier = TrustTier::stored(page.trust_tier.as_deref());
            if !self.trust.admits(read, "pages", page.id, tier)? {
                continue;
            }
            if !self.include_quarantined && page.frontmatter.contains_key(QUARANTINE_KEY) {
                continue;
            }
            let canonical = self
                .stored_types
                .iter()
                .position(|t| *t == page.page_type)
                .and_then(|i| self.canonical_types.get(i).cloned())
                .unwrap_or_else(|| {
                    if page.page_type.is_empty() {
                        "untyped".to_string()
                    } else {
                        page.page_type.clone()
                    }
                });
            out.push((page, canonical));
        }
        Ok(out)
    }
}

/// `readReferrerPageDetails` input: the page ids to read.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReferrerPageDetailsInput {
    pub ids: Vec<u64>,
}

/// One referring page's card details (`readReferrerPageDetails`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReferrerPageDetailRow {
    pub id: u64,
    pub title: String,
    /// `left(left(coalesce(compiled_truth, truth_lead), BOUNDED_PREFIX_BYTES), 4000)`: the first
    /// 4000 code points of the body.
    pub body: Option<String>,
    /// `updated_at` with no effective date, else the effective date's source (`effective_date`
    /// when none is recorded).
    pub date_source: String,
    pub trust_tier: String,
    pub write_origin: Option<Value>,
    /// `activationSuppressedSql('pages', 'pages')`.
    pub flagged: bool,
    pub frontmatter: Value,
}

/// `left(text, n)`: the first `n` code points.
const REFERRER_BODY_CHARS: usize = 4000;

/// What `countSearchVectorRows` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchVectorCounts {
    pub pages: u64,
    pub chunks: u64,
}

// ---------------------------------------------------------------------------------------------
// Keys and scans
// ---------------------------------------------------------------------------------------------

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, message)
}

fn family_prefix(source_id: &str, tag: u8) -> Vec<u8> {
    let mut key = vec![keys::LINK_QUERIES];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key.push(tag);
    key
}

fn pair_prefix(source_id: &str, tag: u8, key: &RelationshipKey) -> Vec<u8> {
    let mut out = family_prefix(source_id, tag);
    out.extend_from_slice(&key.from_page_id.to_be_bytes());
    out.extend_from_slice(&key.to_page_id.to_be_bytes());
    out.extend_from_slice(key.link_type.as_bytes());
    out.push(0);
    out
}

fn decode_all<T: DeserializeOwned>(raw: Vec<(Vec<u8>, Vec<u8>)>) -> Result<Vec<(Vec<u8>, T)>> {
    raw.into_iter()
        .map(|(k, v)| Ok((k, serde_json::from_slice(&v)?)))
        .collect()
}

fn scan_under<T: DeserializeOwned>(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<(Vec<u8>, T)>> {
    let mut raw = Vec::new();
    scan_prefix(read, prefix, false, &mut |k, v| {
        raw.push((k.to_vec(), v.to_vec()));
        true
    })?;
    decode_all(raw)
}

/// Every record of the sub-tag, in every source.
fn scan_tag<T: DeserializeOwned>(read: &dyn KvRead, tag: u8) -> Result<Vec<(Vec<u8>, T)>> {
    let mut raw = Vec::new();
    scan_prefix(read, &[keys::LINK_QUERIES], false, &mut |k, v| {
        if let Some(nul) = k.iter().skip(1).position(|b| *b == 0)
            && k.get(nul + 2) == Some(&tag)
        {
            raw.push((k.to_vec(), v.to_vec()));
        }
        true
    })?;
    decode_all(raw)
}

/// Every transition whose origin is one of `pages`, or whose from page is one when it has no
/// origin, in id order (`OWNED_ROWS` of belief/state.ts over `link_transitions`).
pub(crate) fn transitions_owned_by(
    read: &dyn KvRead,
    pages: &BTreeSet<u64>,
) -> Result<Vec<TransitionRecord>> {
    let mut out: Vec<TransitionRecord> = scan_tag::<TransitionRecord>(read, TRANSITION)?
        .into_iter()
        .map(|(_, t)| t)
        .filter(|t| pages.contains(&t.origin_page_id.unwrap_or(t.from_page_id)))
        .collect();
    out.sort_by_key(|t| t.id);
    Ok(out)
}

/// The source the relationship's rows are keyed by: its from page's source.
fn key_source(read: &dyn KvRead, from_page_id: u64) -> Result<Option<String>> {
    Ok(read_page_by_id(read, from_page_id)?.map(|p| p.source_id))
}

fn relationships_of(
    read: &dyn KvRead,
    key: &RelationshipKey,
) -> Result<Vec<(Vec<u8>, RelationshipRecord)>> {
    match key_source(read, key.from_page_id)? {
        Some(source) => scan_under(read, &pair_prefix(&source, RELATIONSHIP, key)),
        None => Ok(Vec::new()),
    }
}

fn transitions_of(
    read: &dyn KvRead,
    key: &RelationshipKey,
) -> Result<Vec<(Vec<u8>, TransitionRecord)>> {
    match key_source(read, key.from_page_id)? {
        Some(source) => scan_under(read, &pair_prefix(&source, TRANSITION, key)),
        None => Ok(Vec::new()),
    }
}

pub(crate) fn relationship(
    read: &dyn KvRead,
    key: &RelationshipKey,
    scope: &str,
) -> Result<Option<RelationshipRecord>> {
    Ok(relationships_of(read, key)?
        .into_iter()
        .map(|(_, r)| r)
        .find(|r| r.scope == scope))
}

fn links_of(read: &dyn KvRead, key: &RelationshipKey) -> Result<Vec<LinkRecord>> {
    Ok(out_links(read, key.from_page_id)?
        .into_iter()
        .filter(|l| l.to_page_id == key.to_page_id && l.link_type == key.link_type)
        .collect())
}

/// Every `link_transitions` row, in every source.
pub(crate) fn all_transitions(read: &dyn KvRead) -> Result<Vec<TransitionRecord>> {
    Ok(scan_tag::<TransitionRecord>(read, TRANSITION)?
        .into_iter()
        .map(|(_, t)| t)
        .collect())
}

pub(crate) fn iso_ms(micros: i64) -> String {
    let full = iso(micros);
    format!("{}Z", &full[..full.len() - 4])
}

fn parse_time(field: &str, text: &str) -> Result<i64> {
    parse_iso(text).ok_or_else(|| invalid(format!("{field} must be an ISO timestamp")))
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// Whether `text` is a calendar date `YYYY-MM-DD`.
pub(crate) fn is_date(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |a: usize, z: usize| {
        text.get(a..z)
            .filter(|s| s.bytes().all(|c| c.is_ascii_digit()))
            .and_then(|s| s.parse::<i64>().ok())
    };
    match (num(0, 4), num(5, 7), num(8, 10)) {
        (Some(y), Some(m), Some(d)) => (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m),
        _ => false,
    }
}

fn check_date(field: &str, text: &str) -> Result<()> {
    if is_date(text) {
        Ok(())
    } else {
        Err(invalid(format!(
            "{field}: invalid input syntax for type date: \"{text}\""
        )))
    }
}

fn check_one_of(field: &str, value: &str, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            format!("{field} must be one of {}", allowed.join(", ")),
        ))
    }
}

fn check_no_nul(field: &str, value: &str) -> Result<()> {
    if value.contains('\0') {
        Err(invalid(format!("{field} must not contain a NUL byte")))
    } else {
        Ok(())
    }
}

pub(crate) fn today(now_us: i64) -> String {
    iso(now_us)[..10].to_string()
}

// ---------------------------------------------------------------------------------------------
// Multiranges
// ---------------------------------------------------------------------------------------------

pub(crate) type DateRange = (Option<String>, Option<String>);
/// One referrer of a group, before ordering: effective date (us), source id, slug, page id, page type.
type ReferrerGroupEntry = (i64, String, String, u64, String);

/// Parses a `datemultirange` literal of half-open ranges (`[a,b)`, `(,b)`, `[a,)`, `(,)`). A bound may also be the explicit
/// date `-infinity` (lower, `[-infinity,b)`) or `infinity` (upper, `[a,infinity)`), which Postgres keeps apart from an
/// omitted bound; the text order of a date puts both where they belong (`-infinity` before and `infinity` after every date).
pub(crate) fn parse_multirange(text: &str) -> Result<Vec<DateRange>> {
    let bad = || invalid(format!("malformed multirange literal: \"{text}\""));
    let inner = text
        .trim()
        .strip_prefix('{')
        .and_then(|t| t.strip_suffix('}'))
        .ok_or_else(bad)?;
    let mut out = Vec::new();
    let mut rest = inner.trim();
    while !rest.is_empty() {
        let close = rest.find(')').ok_or_else(bad)?;
        let range = &rest[..close];
        // An empty range (`{)}`) or one that opens with a multi-byte character has no one-byte bracket.
        let open = range.get(..1).ok_or_else(bad)?;
        let body = &range[1..];
        let (lower, upper) = body.split_once(',').ok_or_else(bad)?;
        let lower = match (open, lower) {
            ("(", "") | ("[", "") => None,
            ("[", d) if is_date(d) || d == "-infinity" => Some(d.to_string()),
            _ => return Err(bad()),
        };
        let upper = match upper {
            "" => None,
            d if is_date(d) || d == "infinity" => Some(d.to_string()),
            _ => return Err(bad()),
        };
        out.push((lower, upper));
        rest = rest[close + 1..].trim_start();
        if let Some(after) = rest.strip_prefix(',') {
            rest = after.trim_start();
            if rest.is_empty() {
                return Err(bad());
            }
        } else if !rest.is_empty() {
            return Err(bad());
        }
    }
    Ok(out)
}

/// Postgres's canonical form: empty ranges dropped, sorted by lower bound, overlapping and
/// adjacent ranges merged.
pub(crate) fn canonical_multirange(text: &str) -> Result<String> {
    let mut ranges: Vec<DateRange> = parse_multirange(text)?
        .into_iter()
        .filter(|(lo, hi)| !matches!((lo, hi), (Some(a), Some(b)) if a >= b))
        .collect();
    ranges.sort_by(|a, b| match (&a.0, &b.0) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, _) => std::cmp::Ordering::Less,
        (_, None) => std::cmp::Ordering::Greater,
        (Some(x), Some(y)) => x.cmp(y),
    });
    let mut merged: Vec<DateRange> = Vec::new();
    for (lo, hi) in ranges {
        if let Some(last) = merged.last_mut() {
            let touches = match (&last.1, &lo) {
                (None, _) => true,
                (_, None) => true,
                (Some(end), Some(start)) => start <= end,
            };
            if touches {
                last.1 = match (&last.1, &hi) {
                    (None, _) | (_, None) => None,
                    (Some(a), Some(b)) => Some(a.max(b).clone()),
                };
                continue;
            }
        }
        merged.push((lo, hi));
    }
    let parts: Vec<String> = merged
        .iter()
        .map(|(lo, hi)| match lo {
            None => format!("(,{})", hi.as_deref().unwrap_or("")),
            Some(d) => format!("[{d},{})", hi.as_deref().unwrap_or("")),
        })
        .collect();
    Ok(format!("{{{}}}", parts.join(",")))
}

/// `valid_ranges && daterange(from, until)`: some range overlaps `[from, until)`. An empty
/// multirange overlaps nothing.
pub(crate) fn multirange_overlaps(text: &str, from: &str, until: &str) -> bool {
    parse_multirange(text).is_ok_and(|ranges| {
        ranges.iter().any(|(lo, hi)| {
            lo.as_deref().is_none_or(|l| l < until) && hi.as_deref().is_none_or(|h| h > from)
        })
    })
}

/// `valid_ranges @> date`.
pub(crate) fn multirange_contains(text: &str, date: &str) -> bool {
    parse_multirange(text).is_ok_and(|ranges| {
        ranges.iter().any(|(lo, hi)| {
            lo.as_deref().is_none_or(|l| l <= date) && hi.as_deref().is_none_or(|h| date < h)
        })
    })
}

// ---------------------------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------------------------

/// Deletes the relationship and transition rows whose from, to or origin page is hard-deleted
/// (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    let id = page.id;
    let mut doomed = Vec::new();
    for (key, r) in scan_tag::<RelationshipRecord>(&*tx, RELATIONSHIP)? {
        if r.from_page_id == id || r.to_page_id == id {
            doomed.push(key);
        }
    }
    for (key, t) in scan_tag::<TransitionRecord>(&*tx, TRANSITION)? {
        if t.from_page_id == id || t.to_page_id == id || t.origin_page_id == Some(id) {
            doomed.push(key);
        }
    }
    for key in doomed {
        tx.delete(&key)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Helpers shared by the members
// ---------------------------------------------------------------------------------------------

fn live(page: &PageRecord) -> bool {
    page.deleted_at_us.is_none()
}

fn live_page(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Option<PageRecord>> {
    Ok(read_page(read, source_id, slug)?.filter(live))
}

fn sorted(keys: BTreeSet<RelationshipKey>) -> Vec<RelationshipKey> {
    keys.into_iter().collect()
}

/// `privateLinkOriginFilterForCaller(l)`: no origin, or an origin page that the policy shows.
fn link_origin_shown(
    pages: &mut Pages<'_>,
    link: &LinkRecord,
    policy: &PrivacyPolicy,
) -> Result<bool> {
    match link.origin_page_id {
        None => Ok(true),
        Some(id) => match pages.get(id)? {
            Some(origin) => Ok(!page_hidden(pages.read, &origin, policy)?),
            None => Ok(false),
        },
    }
}

/// Links of `link_types` that touch the page as from, to or origin.
fn links_touching_page(
    read: &dyn KvRead,
    page_id: u64,
    link_types: &[String],
    out: &mut BTreeSet<RelationshipKey>,
) -> Result<()> {
    let typed = |l: &LinkRecord| link_types.contains(&l.link_type);
    for link in out_links(read, page_id)?
        .into_iter()
        .chain(in_links(read, page_id)?)
        .chain(origin_links(read, page_id)?)
    {
        if typed(&link) {
            out.insert(RelationshipKey::of_link(&link));
        }
    }
    Ok(())
}

/// The keys `relationshipKeysForOrigin` reads, inside a read or a write.
fn keys_for_origin(
    read: &dyn KvRead,
    page_id: u64,
    link_types: &[String],
) -> Result<Vec<RelationshipKey>> {
    let mut keys = BTreeSet::new();
    let typed = |l: &LinkRecord| link_types.contains(&l.link_type);
    for link in out_links(read, page_id)? {
        if link.origin_page_id.is_none() && typed(&link) {
            keys.insert(RelationshipKey::of_link(&link));
        }
    }
    for link in origin_links(read, page_id)? {
        if typed(&link) {
            keys.insert(RelationshipKey::of_link(&link));
        }
    }
    for (_, t) in scan_tag::<TransitionRecord>(read, TRANSITION)? {
        if t.origin_page_id == Some(page_id) {
            keys.insert(t.key());
        }
    }
    if let Some(source) = key_source(read, page_id)? {
        let mut prefix = family_prefix(&source, RELATIONSHIP);
        prefix.extend_from_slice(&page_id.to_be_bytes());
        for (_, r) in scan_under::<RelationshipRecord>(read, &prefix)? {
            if r.scope == "all" {
                keys.insert(RelationshipKey::new(
                    r.from_page_id,
                    r.to_page_id,
                    &r.link_type,
                ));
            }
        }
    }
    Ok(sorted(keys))
}

/// Inserts a transition unless a row with the same identity exists (`ON CONFLICT DO NOTHING`).
/// Returns whether it was inserted.
pub(crate) fn insert_transition(tx: &mut dyn KvWrite, record: TransitionRecord) -> Result<bool> {
    let key = record.key();
    if transitions_of(&*tx, &key)?
        .iter()
        .any(|(_, t)| t.same_identity(&record))
    {
        return Ok(false);
    }
    let mut row_key = pair_prefix(&record.source_id, TRANSITION, &key);
    let id = next_id(tx, TRANSITION_ID)?;
    row_key.extend_from_slice(&id.to_be_bytes());
    put_json(tx, &row_key, &TransitionRecord { id, ..record })?;
    Ok(true)
}

/// The stored key of a transition row: its relationship prefix and its id.
fn transition_row_key(record: &TransitionRecord) -> Vec<u8> {
    let mut key = pair_prefix(&record.source_id, TRANSITION, &record.key());
    key.extend_from_slice(&record.id.to_be_bytes());
    key
}

/// Deletes a stored transition row (the twin merge's loser delete, and the first half of its move).
pub(crate) fn delete_transition(tx: &mut dyn KvWrite, record: &TransitionRecord) -> Result<()> {
    tx.delete(&transition_row_key(record))
}

/// Stores a transition row under its (moved) relationship, keeping its id. A row with the same identity
/// refuses, as the table's unique index does.
pub(crate) fn put_moved_transition(tx: &mut dyn KvWrite, record: &TransitionRecord) -> Result<()> {
    if transitions_of(&*tx, &record.key())?
        .iter()
        .any(|(_, t)| t.id != record.id && t.same_identity(record))
    {
        return Err(crate::links::unique_violation());
    }
    put_json(tx, &transition_row_key(record), record)
}

/// The shadow seed (`seed/state.rs`): stores a `link_relationships` row copied from another engine, with its own
/// `recorded_at` and `refreshed_at`, under the source of its from page (`from_source`), as `writeLinkRelationshipState` keys
/// it. The CHECK lists of the table apply and `valid_ranges` is kept in its canonical text. `false` when the row is held.
pub(crate) fn seed_relationship(
    tx: &mut dyn KvWrite,
    from_source: &str,
    record: &RelationshipRecord,
) -> Result<bool> {
    check_no_nul("link_type", &record.link_type)?;
    check_one_of("scope", &record.scope, &SCOPES)?;
    check_one_of("semantics", &record.semantics, &SEMANTICS)?;
    check_one_of("status_now", &record.status_now, &STATUSES)?;
    let key = RelationshipKey::new(record.from_page_id, record.to_page_id, &record.link_type);
    let mut row_key = pair_prefix(from_source, RELATIONSHIP, &key);
    row_key.extend_from_slice(record.scope.as_bytes());
    if tx.get(&row_key)?.is_some() {
        return Ok(false);
    }
    let record = RelationshipRecord {
        valid_ranges: canonical_multirange(&record.valid_ranges)?,
        ..record.clone()
    };
    put_json(tx, &row_key, &record)?;
    Ok(true)
}

/// The shadow follow (`seed/follow/remove_state.rs`): removes the state row of `(from, to, link_type, scope)`, found under
/// the source of its from page. `false` when there is none.
pub(crate) fn remove_relationship(
    tx: &mut dyn KvWrite,
    from_page_id: u64,
    to_page_id: u64,
    link_type: &str,
    scope: &str,
) -> Result<bool> {
    let Some(source) = key_source(&*tx, from_page_id)? else {
        return Ok(false);
    };
    let key = RelationshipKey::new(from_page_id, to_page_id, link_type);
    let mut row_key = pair_prefix(&source, RELATIONSHIP, &key);
    row_key.extend_from_slice(scope.as_bytes());
    if tx.get(&row_key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&row_key)?;
    Ok(true)
}

/// The shadow seed (`seed/state.rs`): stores a `link_transitions` row copied from another engine, with its own id and
/// `created_at`, and raises the id counter past the id. The row is keyed by the source of its from page, where the evidence
/// reads look (a row whose own `source_id` differs keeps that value in its record). `false` when the id, or a row of the
/// same identity (`origin, from, to, link_type, link_source, kind, occurred_on, producer`), is held.
pub(crate) fn seed_transition(tx: &mut dyn KvWrite, record: &TransitionRecord) -> Result<bool> {
    check_no_nul("link_type", &record.link_type)?;
    check_transition(
        &record.kind,
        &record.occurred_on,
        &record.date_precision,
        &record.producer,
    )?;
    let key = record.key();
    let keyed = key_source(&*tx, record.from_page_id)?.unwrap_or_else(|| record.source_id.clone());
    let prefix = pair_prefix(&keyed, TRANSITION, &key);
    let held = scan_under::<TransitionRecord>(&*tx, &prefix)?;
    if held
        .iter()
        .any(|(_, t)| t.id == record.id || t.same_identity(record))
    {
        return Ok(false);
    }
    let mut row_key = prefix;
    row_key.extend_from_slice(&record.id.to_be_bytes());
    put_json(tx, &row_key, record)?;
    crate::seed::raise_counter(tx, TRANSITION_ID, record.id)?;
    Ok(true)
}

/// The shadow follow (`seed/follow/remove_state.rs`): removes the transition `id` of the pair, found under the source of its
/// from page (`source_id`, the row's own, when that page is gone). `false` when there is none.
pub(crate) fn remove_transition(
    tx: &mut dyn KvWrite,
    source_id: &str,
    pair: (u64, u64, &str),
    id: u64,
) -> Result<bool> {
    let key = RelationshipKey::new(pair.0, pair.1, pair.2);
    let keyed = key_source(&*tx, pair.0)?.unwrap_or_else(|| source_id.to_owned());
    let mut row_key = pair_prefix(&keyed, TRANSITION, &key);
    row_key.extend_from_slice(&id.to_be_bytes());
    if tx.get(&row_key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&row_key)?;
    Ok(true)
}

fn check_transition(kind: &str, occurred_on: &str, precision: &str, producer: &str) -> Result<()> {
    check_one_of("kind", kind, &KINDS)?;
    check_date("occurred_on", occurred_on)?;
    check_one_of("date_precision", precision, &PRECISIONS)?;
    check_one_of("producer", producer, &PRODUCERS)
}

fn check_upsert(row: &RelationshipUpsert) -> Result<()> {
    check_no_nul("link_type", &row.link_type)?;
    check_one_of("scope", &row.scope, &SCOPES)?;
    check_one_of("semantics", &row.semantics, &SEMANTICS)?;
    check_one_of("status_now", &row.status_now, &STATUSES)?;
    for (field, value) in [
        ("first_start", &row.first_start),
        ("last_start", &row.last_start),
        ("last_end", &row.last_end),
    ] {
        if let Some(date) = value {
            check_date(field, date)?;
        }
    }
    Ok(())
}

fn status_value(page: &PageRecord) -> Value {
    page.frontmatter
        .get("status")
        .cloned()
        .unwrap_or(Value::Null)
}

impl Store {
    /// `readLinkRelationshipEvidence`: the assertions, transitions and state rows of the keys.
    pub fn read_link_relationship_evidence(
        &self,
        input: &EvidenceInput,
    ) -> Result<RelationshipEvidence> {
        let read = self.read()?;
        let read = &*read;
        let mut pages = Pages::new(read);
        let policy = input
            .origin_policy
            .as_ref()
            .ok_or_else(|| invalid("readLinkRelationshipEvidence needs originPolicy"))?;
        let mut evidence = RelationshipEvidence {
            assertions: Vec::new(),
            transitions: Vec::new(),
            existing: Vec::new(),
        };
        for key in &input.keys {
            let from = pages.get(key.from_page_id)?.filter(|p| live(p));
            let to = pages.get(key.to_page_id)?.filter(|p| live(p));
            if let (Some(from), Some(_)) = (&from, &to) {
                for link in links_of(read, key)? {
                    let origin_id = link.origin_page_id.unwrap_or(link.from_page_id);
                    let Some(origin) = pages.get(origin_id)? else {
                        continue;
                    };
                    if !live(&origin) || origin.source_id != from.source_id {
                        continue;
                    }
                    evidence.assertions.push(AssertionRow {
                        from_page_id: key.from_page_id,
                        to_page_id: key.to_page_id,
                        link_type: key.link_type.clone(),
                        origin_id,
                        tense: link
                            .assertion_tense
                            .clone()
                            .unwrap_or_else(|| "present".to_string()),
                        created_at: iso_ms(link.created_at_us),
                        source_id: from.source_id.clone(),
                        origin_public: !page_hidden(read, &origin, policy)?,
                    });
                }
                for (_, t) in transitions_of(read, key)? {
                    let origin_public = match t.origin_page_id {
                        None => true,
                        Some(id) => match pages.get(id)? {
                            Some(o) if live(&o) && o.source_id == from.source_id => {
                                !page_hidden(read, &o, policy)?
                            }
                            _ => continue,
                        },
                    };
                    evidence.transitions.push(TransitionRow {
                        from_page_id: key.from_page_id,
                        to_page_id: key.to_page_id,
                        link_type: key.link_type.clone(),
                        origin_id: t.origin_page_id,
                        kind: t.kind,
                        occurred_on: t.occurred_on,
                        producer: t.producer,
                        created_at: iso_ms(t.created_at_us),
                        source_id: from.source_id.clone(),
                        origin_public,
                    });
                }
            }
            for (_, r) in relationships_of(read, key)? {
                evidence.existing.push(ExistingRow {
                    from_page_id: r.from_page_id,
                    to_page_id: r.to_page_id,
                    link_type: r.link_type,
                    scope: r.scope,
                    recorded_at: iso_ms(r.recorded_at_us),
                    retired_at: r.retired_at_us.map(iso_ms),
                    evidence_hash: r.evidence_hash,
                });
            }
        }
        Ok(evidence)
    }

    /// `writeLinkRelationshipState`: upserts and removes state rows. Returns `changed` plus the
    /// number of rows removed.
    pub fn write_link_relationship_state(&self, input: &StateWrite) -> Result<u64> {
        for row in &input.upserts {
            check_upsert(row)?;
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            for row in &input.upserts {
                let key = RelationshipKey::new(row.from_page_id, row.to_page_id, &row.link_type);
                let source = key_source(&*tx, key.from_page_id)?.ok_or_else(|| {
                    StoreError::new(
                        CONSTRAINT_VIOLATION,
                        "link_relationships_from_page_id_fkey: the from page does not exist",
                    )
                })?;
                if read_page_by_id(&*tx, key.to_page_id)?.is_none() {
                    return Err(StoreError::new(
                        CONSTRAINT_VIOLATION,
                        "link_relationships_to_page_id_fkey: the to page does not exist",
                    ));
                }
                let mut row_key = pair_prefix(&source, RELATIONSHIP, &key);
                row_key.extend_from_slice(row.scope.as_bytes());
                let recorded = parse_time("recorded_at", &row.recorded_at)?;
                let prior: Option<RelationshipRecord> = crate::get_json(&*tx, &row_key)?;
                let record = RelationshipRecord {
                    from_page_id: row.from_page_id,
                    to_page_id: row.to_page_id,
                    link_type: row.link_type.clone(),
                    scope: row.scope.clone(),
                    source_id: row.source_id.clone(),
                    semantics: row.semantics.clone(),
                    valid_ranges: canonical_multirange(&row.valid_ranges)?,
                    status_now: row.status_now.clone(),
                    first_start: row.first_start.clone(),
                    last_start: row.last_start.clone(),
                    last_end: row.last_end.clone(),
                    undated_present: row.undated_present,
                    undated_past: row.undated_past,
                    disputed: row.disputed,
                    recorded_at_us: prior
                        .as_ref()
                        .map_or(recorded, |p| p.recorded_at_us.min(recorded)),
                    retired_at_us: row
                        .retired_at
                        .as_deref()
                        .map(|t| parse_time("retired_at", t))
                        .transpose()?,
                    evidence_hash: row.evidence_hash.clone(),
                    refreshed_at_us: now,
                };
                put_json(tx, &row_key, &record)?;
            }
            let mut removed = 0;
            for row in &input.removals {
                let key = RelationshipKey::new(row.from_page_id, row.to_page_id, &row.link_type);
                let Some(source) = key_source(&*tx, key.from_page_id)? else {
                    continue;
                };
                let mut row_key = pair_prefix(&source, RELATIONSHIP, &key);
                row_key.extend_from_slice(row.scope.as_bytes());
                if tx.get(&row_key)?.is_some() {
                    tx.delete(&row_key)?;
                    removed += 1;
                }
            }
            Ok(input.changed + removed)
        })
    }

    /// `linkRelationshipKeysForPages`: keys with any evidence touching the pages.
    pub fn link_relationship_keys_for_pages(
        &self,
        input: &KeysForPagesInput,
    ) -> Result<Vec<RelationshipKey>> {
        let read = self.read()?;
        let read = &*read;
        let ids: BTreeSet<u64> = input.page_ids.iter().copied().collect();
        let mut keys = BTreeSet::new();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        for id in &ids {
            links_touching_page(read, *id, &input.link_types, &mut keys)?;
        }
        for (_, t) in scan_tag::<TransitionRecord>(read, TRANSITION)? {
            if ids.contains(&t.from_page_id)
                || ids.contains(&t.to_page_id)
                || t.origin_page_id.is_some_and(|o| ids.contains(&o))
            {
                keys.insert(t.key());
            }
        }
        for (_, r) in scan_tag::<RelationshipRecord>(read, RELATIONSHIP)? {
            if ids.contains(&r.from_page_id) || ids.contains(&r.to_page_id) {
                keys.insert(RelationshipKey::new(
                    r.from_page_id,
                    r.to_page_id,
                    &r.link_type,
                ));
            }
        }
        Ok(sorted(keys))
    }

    /// `staleLinkRelationshipKeys`: keys whose state is missing, older than their newest
    /// evidence, older than an origin page's change, or orphaned. Ties in age are ordered by key.
    pub fn stale_link_relationship_keys(
        &self,
        input: &StaleKeysInput,
    ) -> Result<Vec<RelationshipKey>> {
        let read = self.read()?;
        let read = &*read;
        let limit = input.limit as usize;
        let links = super::all_links(read)?;
        let transitions: Vec<TransitionRecord> = scan_tag::<TransitionRecord>(read, TRANSITION)?
            .into_iter()
            .map(|(_, t)| t)
            .collect();
        let states: BTreeMap<RelationshipKey, RelationshipRecord> =
            scan_tag::<RelationshipRecord>(read, RELATIONSHIP)?
                .into_iter()
                .filter(|(_, r)| r.scope == "all")
                .map(|(_, r)| {
                    (
                        RelationshipKey::new(r.from_page_id, r.to_page_id, &r.link_type),
                        r,
                    )
                })
                .collect();
        let mut link_newest: BTreeMap<RelationshipKey, i64> = BTreeMap::new();
        for link in links
            .iter()
            .filter(|l| input.link_types.contains(&l.link_type))
        {
            let e = link_newest
                .entry(RelationshipKey::of_link(link))
                .or_insert(i64::MIN);
            *e = (*e).max(link.created_at_us);
        }
        let mut transition_newest: BTreeMap<RelationshipKey, i64> = BTreeMap::new();
        for t in &transitions {
            let e = transition_newest.entry(t.key()).or_insert(i64::MIN);
            *e = (*e).max(t.created_at_us);
        }
        let fresh = |key: &RelationshipKey, newest: i64| {
            states.get(key).is_some_and(|r| r.refreshed_at_us >= newest)
        };
        let mut oldest: BTreeMap<RelationshipKey, i64> = BTreeMap::new();
        for (key, newest) in link_newest.iter().chain(transition_newest.iter()) {
            if !fresh(key, *newest) {
                let e = oldest.entry(key.clone()).or_insert(i64::MAX);
                *e = (*e).min(*newest);
            }
        }
        let mut stale: Vec<(i64, RelationshipKey)> =
            oldest.into_iter().map(|(k, at)| (at, k)).collect();
        stale.sort();
        let mut rows: Vec<RelationshipKey> =
            stale.into_iter().take(limit).map(|(_, k)| k).collect();
        if rows.len() < limit {
            let mut pages = Pages::new(read);
            let mut changed = BTreeSet::new();
            for link in &links {
                let key = RelationshipKey::of_link(link);
                let Some(state) = states.get(&key) else {
                    continue;
                };
                let origin = link.origin_page_id.unwrap_or(link.from_page_id);
                if let Some(o) = pages.get(origin)? {
                    let touched = o
                        .updated_at_us
                        .max(o.deleted_at_us.unwrap_or(o.updated_at_us));
                    if touched > state.refreshed_at_us {
                        changed.insert(key);
                    }
                }
            }
            let room = limit - rows.len();
            let picked: Vec<RelationshipKey> = changed.into_iter().take(room).collect();
            for key in picked {
                if !rows.contains(&key) {
                    rows.push(key);
                }
            }
        }
        if rows.len() < limit {
            let room = limit - rows.len();
            let linked: BTreeSet<RelationshipKey> =
                links.iter().map(RelationshipKey::of_link).collect();
            let orphans: Vec<RelationshipKey> = states
                .keys()
                .filter(|k| !linked.contains(*k) && !transition_newest.contains_key(*k))
                .take(room)
                .cloned()
                .collect();
            rows.extend(orphans);
        }
        Ok(rows)
    }

    /// `linkRelationshipKeysForOrigin`: keys whose evidence the origin page owns.
    pub fn link_relationship_keys_for_origin(
        &self,
        input: &KeysForOriginInput,
    ) -> Result<Vec<RelationshipKey>> {
        let read = self.read()?;
        keys_for_origin(&*read, input.page_id, &input.link_types)
    }

    /// `linkRelationshipKeysTouching`: the keys a link delete can change, read before it. Pages
    /// are resolved in any deletion state; a pair yields its links of `link_types`, and its
    /// transition and state rows; a from page yields every key it starts.
    pub fn link_relationship_keys_touching(
        &self,
        input: &KeysTouchingInput,
    ) -> Result<Vec<RelationshipKey>> {
        let read = self.read()?;
        let read = &*read;
        let mut keys = BTreeSet::new();
        let typed = |l: &LinkRecord| input.link_types.contains(&l.link_type);
        for pair in &input.pairs {
            let (Some(from), Some(to)) = (
                read_page(read, &pair.from_source_id, &pair.from_slug)?,
                read_page(read, &pair.to_source_id, &pair.to_slug)?,
            ) else {
                continue;
            };
            for link in out_links(read, from.id)? {
                if link.to_page_id == to.id && typed(&link) {
                    keys.insert(RelationshipKey::of_link(&link));
                }
            }
            let mut prefix_t = family_prefix(&from.source_id, TRANSITION);
            prefix_t.extend_from_slice(&from.id.to_be_bytes());
            prefix_t.extend_from_slice(&to.id.to_be_bytes());
            for (_, t) in scan_under::<TransitionRecord>(read, &prefix_t)? {
                keys.insert(t.key());
            }
            let mut prefix_r = family_prefix(&from.source_id, RELATIONSHIP);
            prefix_r.extend_from_slice(&from.id.to_be_bytes());
            prefix_r.extend_from_slice(&to.id.to_be_bytes());
            for (_, r) in scan_under::<RelationshipRecord>(read, &prefix_r)? {
                keys.insert(RelationshipKey::new(
                    r.from_page_id,
                    r.to_page_id,
                    &r.link_type,
                ));
            }
        }
        for page in &input.from_pages {
            let Some(from) = read_page(read, &page.source_id, &page.slug)? else {
                continue;
            };
            for link in out_links(read, from.id)? {
                if typed(&link) {
                    keys.insert(RelationshipKey::of_link(&link));
                }
            }
            for tag in [TRANSITION, RELATIONSHIP] {
                let mut prefix = family_prefix(&from.source_id, tag);
                prefix.extend_from_slice(&from.id.to_be_bytes());
                let mut raw = Vec::new();
                scan_prefix(read, &prefix, false, &mut |k, _| {
                    raw.push(k.to_vec());
                    true
                })?;
                for k in raw {
                    let rest = &k[prefix.len()..];
                    if rest.len() < 9 {
                        continue;
                    }
                    let to = keys::be8(&rest[..8]).unwrap_or_default();
                    let tail = &rest[8..];
                    let nul = tail.iter().position(|b| *b == 0).unwrap_or(tail.len());
                    keys.insert(RelationshipKey::new(
                        from.id,
                        to,
                        &String::from_utf8_lossy(&tail[..nul]),
                    ));
                }
            }
        }
        Ok(sorted(keys))
    }

    /// `applyLinkTemporalRows`: stamps assertion tense on the links the page owns, replaces its
    /// derived transitions, checks explicit targets and reads the keys it owns afterwards, in one
    /// write.
    pub fn apply_link_temporal_rows(
        &self,
        input: &ApplyTemporalInput,
    ) -> Result<ApplyTemporalResult> {
        for t in &input.transitions {
            check_no_nul("link_type", &t.link_type)?;
            check_transition(&t.kind, &t.occurred_on, &t.date_precision, &t.producer)?;
        }
        let now = self.env.now_micros();
        let page_id = input.page_id;
        self.write(|tx| {
            for row in &input.tense_rows {
                let (Some(from), Some(to)) = (
                    read_page(&*tx, &row.from_source_id, &row.from_slug)?,
                    read_page(&*tx, &row.to_source_id, &row.to_slug)?,
                ) else {
                    continue;
                };
                for mut link in out_links(&*tx, from.id)? {
                    let owned = link.origin_page_id == Some(page_id)
                        || (link.origin_page_id.is_none() && link.from_page_id == page_id);
                    if link.to_page_id == to.id
                        && link.link_type == row.link_type
                        && link.link_source.as_deref() == Some(row.link_source.as_str())
                        && owned
                        && link.assertion_tense != row.tense
                    {
                        link.assertion_tense = row.tense.clone();
                        put_link(tx, &link)?;
                    }
                }
            }
            let mut doomed = Vec::new();
            for (key, t) in scan_tag::<TransitionRecord>(&*tx, TRANSITION)? {
                if t.origin_page_id == Some(page_id) && input.producers.contains(&t.producer) {
                    doomed.push(key);
                }
            }
            for key in doomed {
                tx.delete(&key)?;
            }
            let mut inserted = Vec::new();
            // `origin_page_id REFERENCES pages(id)`: an inserted row needs its origin page to exist (in any deletion
            // state), read once, when the first row reaches the insert.
            let mut origin_exists = None;
            for t in &input.transitions {
                let (Some(from), Some(to)) = (
                    live_page(&*tx, &input.source_id, &t.from_slug)?,
                    live_page(&*tx, &input.source_id, &t.to_slug)?,
                ) else {
                    continue;
                };
                let exists = match origin_exists {
                    Some(known) => known,
                    None => *origin_exists.insert(read_page_by_id(&*tx, page_id)?.is_some()),
                };
                if !exists {
                    return Err(crate::takes::fk_failed(
                        "link_transitions",
                        "link_transitions_origin_page_id_fkey",
                    ));
                }
                let record = TransitionRecord {
                    id: 0,
                    source_id: input.source_id.clone(),
                    from_page_id: from.id,
                    to_page_id: to.id,
                    link_type: t.link_type.clone(),
                    kind: t.kind.clone(),
                    occurred_on: t.occurred_on.clone(),
                    date_precision: t.date_precision.clone(),
                    producer: t.producer.clone(),
                    origin_page_id: Some(page_id),
                    line_hash: t.line_hash.clone(),
                    link_source: None,
                    created_at_us: now,
                };
                let key = record.key();
                if insert_transition(tx, record)? {
                    inserted.push(key);
                }
            }
            let mut live_targets = Vec::new();
            for slug in input.explicit_targets.iter().collect::<BTreeSet<_>>() {
                if live_page(&*tx, &input.source_id, slug)?.is_some() {
                    live_targets.push(slug.clone());
                }
            }
            let keys_after = keys_for_origin(&*tx, page_id, &input.link_types)?;
            Ok(ApplyTemporalResult {
                inserted,
                live_targets,
                keys_after,
            })
        })
    }

    /// `writeManualLinkTransitions`: manual dated statements for one relationship. Returns the
    /// rows written and the relationship's key (pages in any deletion state).
    pub fn write_manual_link_transitions(
        &self,
        input: &ManualWriteInput,
    ) -> Result<ManualWriteResult> {
        let link_type = input.rel.link_type.clone().unwrap_or_default();
        check_no_nul("link_type", &link_type)?;
        for row in &input.rows {
            check_transition(&row.kind, &row.occurred_on, "day", "manual")?;
        }
        let now = self.env.now_micros();
        let rel = &input.rel;
        self.write(|tx| {
            let mut inserted = 0;
            if let (Some(from), Some(to)) = (
                live_page(&*tx, &rel.source_id, &rel.from)?,
                live_page(&*tx, &rel.source_id, &rel.to)?,
            ) {
                for row in &input.rows {
                    let record = TransitionRecord {
                        id: 0,
                        source_id: rel.source_id.clone(),
                        from_page_id: from.id,
                        to_page_id: to.id,
                        link_type: link_type.clone(),
                        kind: row.kind.clone(),
                        occurred_on: row.occurred_on.clone(),
                        date_precision: "day".to_string(),
                        producer: "manual".to_string(),
                        origin_page_id: None,
                        line_hash: String::new(),
                        link_source: None,
                        created_at_us: now,
                    };
                    if insert_transition(tx, record)? {
                        inserted += 1;
                    }
                }
            }
            let key = match (
                read_page(&*tx, &rel.source_id, &rel.from)?,
                read_page(&*tx, &rel.source_id, &rel.to)?,
            ) {
                (Some(f), Some(t)) => Some(RelationshipKey::new(f.id, t.id, &link_type)),
                _ => None,
            };
            Ok(ManualWriteResult { inserted, key })
        })
    }

    /// `removeManualLinkTransitions`: drops the manual statements of the relationship(s), one key
    /// per row removed.
    pub fn remove_manual_link_transitions(
        &self,
        rel: &ManualRelationship,
    ) -> Result<Vec<RelationshipKey>> {
        self.write(|tx| {
            let (Some(from), Some(to)) = (
                read_page(&*tx, &rel.source_id, &rel.from)?,
                read_page(&*tx, &rel.source_id, &rel.to)?,
            ) else {
                return Ok(Vec::new());
            };
            let mut prefix = family_prefix(&from.source_id, TRANSITION);
            prefix.extend_from_slice(&from.id.to_be_bytes());
            prefix.extend_from_slice(&to.id.to_be_bytes());
            let mut keys = Vec::new();
            for (key, t) in scan_under::<TransitionRecord>(&*tx, &prefix)? {
                if t.producer == "manual"
                    && rel.link_type.as_ref().is_none_or(|lt| *lt == t.link_type)
                    && (!rel.database_only || t.origin_page_id.is_none())
                {
                    tx.delete(&key)?;
                    keys.push(t.key());
                }
            }
            Ok(keys)
        })
    }

    /// `listRelationshipNoteRows`: the state relationships the subjects start, with their
    /// temporal columns, for the relationship note.
    pub fn list_relationship_note_rows(&self, input: &NoteRowsInput) -> Result<Vec<NoteRow>> {
        let read = self.read()?;
        let read = &*read;
        let mut pages = Pages::new(read);
        let scope = if input.exclude_private.is_some() {
            "world"
        } else {
            "all"
        };
        let subjects: BTreeSet<&PageRef> = input.subjects.iter().collect();
        let mut out = Vec::new();
        for subject in subjects {
            let Some(from) = read_page(read, &subject.source_id, &subject.slug)? else {
                continue;
            };
            for link in out_links(read, from.id)? {
                let Some(to) = pages.get(link.to_page_id)?.filter(|p| live(p)) else {
                    continue;
                };
                let key = RelationshipKey::of_link(&link);
                let Some(state) = relationship(read, &key, scope)? else {
                    continue;
                };
                if state.semantics != "state" {
                    continue;
                }
                if let Some(policy) = &input.exclude_private
                    && (page_hidden(read, &to, policy)?
                        || !link_origin_shown(&mut pages, &link, policy)?)
                {
                    continue;
                }
                let mut dream = false;
                let mut other = false;
                if let Some(last_end) = &state.last_end {
                    for (_, t) in transitions_of(read, &key)? {
                        if t.kind != "end" || t.occurred_on != *last_end {
                            continue;
                        }
                        let counts = match t.origin_page_id {
                            None => true,
                            Some(id) => match pages.get(id)? {
                                Some(o) if live(&o) && o.source_id == from.source_id => {
                                    match &input.exclude_private {
                                        Some(policy) => !page_hidden(read, &o, policy)?,
                                        None => true,
                                    }
                                }
                                _ => false,
                            },
                        };
                        if counts {
                            if t.producer == "dream" {
                                dream = true;
                            } else {
                                other = true;
                            }
                        }
                    }
                }
                out.push(NoteRow {
                    from_slug: from.slug.clone(),
                    source_id: from.source_id.clone(),
                    to_slug: to.slug.clone(),
                    to_title: to.title.clone(),
                    link_type: link.link_type.clone(),
                    last_end: state.last_end.clone(),
                    end_upper_bound: dream && !other,
                    temporal_ranges: state.valid_ranges.clone(),
                    temporal_semantics: state.semantics.clone(),
                    temporal_disputed: state.disputed,
                    temporal_undated_past: state.undated_past,
                    temporal_first_start: state.first_start.clone(),
                    temporal_recorded_at: iso_ms(state.recorded_at_us),
                    temporal_retired_at: state.retired_at_us.map(iso_ms),
                });
            }
        }
        Ok(out)
    }

    /// `readEntityInboundEdges`: the links `countInboundLinks` counts, in link id order, each with
    /// its referrer's slug and the temporal columns of its relationship in the `world` scope under
    /// the policy, else `all` (`temporalLinkJoinSql`).
    pub fn read_entity_inbound_edges(
        &self,
        input: &InboundCountInput,
    ) -> Result<Vec<InboundEdgeRow>> {
        let read = self.read()?;
        let read = &*read;
        let scope = if input.exclude_private.is_some() {
            "world"
        } else {
            "all"
        };
        let mut out = Vec::new();
        for (link, from_slug) in kept_inbound_links(read, input)? {
            let state = relationship(read, &RelationshipKey::of_link(&link), scope)?;
            out.push(InboundEdgeRow {
                from_slug,
                link_type: link.link_type.clone(),
                context: link.context.clone(),
                temporal_ranges: state.as_ref().map(|r| r.valid_ranges.clone()),
                temporal_semantics: state.as_ref().map(|r| r.semantics.clone()),
                temporal_disputed: state.as_ref().map(|r| r.disputed),
                temporal_undated_past: state.as_ref().map(|r| r.undated_past),
                temporal_first_start: state.as_ref().and_then(|r| r.first_start.clone()),
                temporal_recorded_at: state.as_ref().map(|r| iso_ms(r.recorded_at_us)),
                temporal_retired_at: state.as_ref().and_then(|r| r.retired_at_us.map(iso_ms)),
            });
        }
        Ok(out)
    }

    /// `edgeValidityCounts`: relationship counts by status, the pages that still state an ended
    /// relationship, newest end first, and the contradiction proposals by status.
    pub fn edge_validity_counts(&self, input: &EdgeValidityInput) -> Result<EdgeValidityCounts> {
        let read = self.read()?;
        let read = &*read;
        let in_scope = |source: &str| {
            input
                .source_ids
                .as_ref()
                .is_none_or(|ids| ids.iter().any(|id| id == source))
        };
        let today = today(self.env.now_micros());
        let states: Vec<RelationshipRecord> = scan_tag::<RelationshipRecord>(read, RELATIONSHIP)?
            .into_iter()
            .map(|(_, r)| r)
            .filter(|r| r.scope == "all" && in_scope(&r.source_id))
            .collect();
        let mut counts: BTreeMap<String, u64> = BTreeMap::new();
        for r in &states {
            let status = if r.semantics == "event" {
                "event".to_string()
            } else if r.disputed {
                "disputed".to_string()
            } else {
                r.status_now.clone()
            };
            *counts.entry(status).or_default() += 1;
        }
        let mut stale: Vec<(String, RelationshipKey, StaleAssertion)> = Vec::new();
        for r in &states {
            let Some(last_end) = &r.last_end else {
                continue;
            };
            if r.semantics != "state"
                || r.undated_present <= 0
                || multirange_contains(&r.valid_ranges, &today)
            {
                continue;
            }
            let key = RelationshipKey::new(r.from_page_id, r.to_page_id, &r.link_type);
            let asserted = links_of(read, &key)?.iter().any(|l| {
                l.origin_page_id.unwrap_or(l.from_page_id) == r.from_page_id
                    && l.assertion_tense.as_deref().unwrap_or("present") == "present"
            });
            if !asserted {
                continue;
            }
            let (Some(f), Some(t)) = (
                read_page_by_id(read, r.from_page_id)?,
                read_page_by_id(read, r.to_page_id)?,
            ) else {
                continue;
            };
            stale.push((
                last_end.clone(),
                key,
                StaleAssertion {
                    slug: f.slug,
                    target: t.slug,
                    link_type: r.link_type.clone(),
                    ended: Some(last_end.clone()),
                },
            ));
        }
        stale.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let proposals = crate::edge_proposals::proposal_counts(read, in_scope)?;
        Ok(EdgeValidityCounts {
            by_status: counts
                .into_iter()
                .map(|(status, n)| StatusCount { status, n })
                .collect(),
            stale: stale
                .into_iter()
                .take(input.stale_limit as usize)
                .map(|(_, _, s)| s)
                .collect(),
            proposals,
        })
    }

    /// `listPageStatusByRef`: the frontmatter `status` of live pages by reference.
    pub fn list_page_status_by_ref(&self, input: &PageStatusInput) -> Result<Vec<PageStatusRow>> {
        let read = self.read()?;
        let read = &*read;
        let mut out = Vec::new();
        for r in input.refs.iter().collect::<BTreeSet<_>>() {
            let Some(page) = live_page(read, &r.source_id, &r.slug)? else {
                continue;
            };
            let Some(status) = page.frontmatter.get("status") else {
                continue;
            };
            if let Some(policy) = &input.exclude_private
                && page_hidden(read, &page, policy)?
            {
                continue;
            }
            if !input.include_quarantined && page.frontmatter.contains_key(QUARANTINE_KEY) {
                continue;
            }
            out.push(PageStatusRow {
                source_id: page.source_id.clone(),
                slug: page.slug.clone(),
                status: status.clone(),
            });
        }
        Ok(out)
    }

    /// `listRecordMetadataRows`: the status of each page and its `amends` and `supersedes` links
    /// to pages the caller can see, with an amends link's `since` from the relationship state.
    pub fn list_record_metadata_rows(
        &self,
        input: &RecordMetadataInput,
    ) -> Result<RecordMetadataRows> {
        let read = self.read()?;
        let read = &*read;
        let mut pages = Pages::new(read);
        let ids: BTreeSet<u64> = input.page_ids.iter().copied().collect();
        let mut status = Vec::new();
        let mut links = BTreeSet::new();
        for id in &ids {
            let Some(page) = pages.get(*id)? else {
                continue;
            };
            status.push(IdStatusRow {
                id: *id,
                status: status_value(&page),
            });
            for link in out_links(read, *id)? {
                if link.link_type != "amends" && link.link_type != "supersedes" {
                    continue;
                }
                let Some(target) = pages.get(link.to_page_id)?.filter(|p| live(p)) else {
                    continue;
                };
                if !input.referrer_sources.contains(&target.source_id) {
                    continue;
                }
                if let Some(policy) = &input.exclude_private
                    && (page_hidden(read, &target, policy)?
                        || !link_origin_shown(&mut pages, &link, policy)?)
                {
                    continue;
                }
                if !input.include_quarantined && target.frontmatter.contains_key(QUARANTINE_KEY) {
                    continue;
                }
                let since = if link.link_type == "amends" {
                    relationship(read, &RelationshipKey::of_link(&link), &input.scope)?
                        .and_then(|r| r.first_start)
                } else {
                    None
                };
                links.insert(RecordLinkRow {
                    from_id: *id,
                    slug: target.slug.clone(),
                    link_type: link.link_type.clone(),
                    since,
                });
            }
        }
        Ok(RecordMetadataRows {
            status,
            links: links.into_iter().collect(),
        })
    }

    /// `readPageReferenceDate(sourceId, slug)`: the live page's `COALESCE(effective_date,
    /// updated_at)` as `to_char(.. AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` prints it, or
    /// `None` for a missing or soft-deleted page.
    pub fn read_page_reference_date(&self, source_id: &str, slug: &str) -> Result<Option<String>> {
        crate::links::no_nul(
            "readPageReferenceDate",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        Ok(read_page(&*read, source_id, slug)?
            .filter(|page| page.deleted_at_us.is_none())
            .map(|page| iso(page.effective_date_us.unwrap_or(page.updated_at_us))))
    }

    /// `readReferrerPageDetails`: the title, bounded body, date source, trust fields, flag and
    /// frontmatter of each page id that exists (soft-deleted pages too, as `id = ANY($1)` reads
    /// them), once per id, in id order.
    pub fn read_referrer_page_details(
        &self,
        input: &ReferrerPageDetailsInput,
    ) -> Result<Vec<ReferrerPageDetailRow>> {
        let read = self.read()?;
        let read = &*read;
        let ids: BTreeSet<u64> = input.ids.iter().copied().collect();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let Some(page) = read_page_by_id(read, id)? else {
                continue;
            };
            let body = match page.compiled_truth.as_deref() {
                Some(text) => Some(text.to_string()),
                None => crate::page_body::truth_lead(read, page.id)?,
            };
            let tier = TrustTier::stored(page.trust_tier.as_deref());
            out.push(ReferrerPageDetailRow {
                id: page.id,
                body: body.map(|b| {
                    b.char_indices()
                        .nth(REFERRER_BODY_CHARS)
                        .map_or(b.clone(), |(at, _)| b[..at].to_string())
                }),
                date_source: date_source(&page),
                trust_tier: tier.as_str().to_owned(),
                write_origin: page.write_origin.clone(),
                flagged: crate::trust::activation_suppressed(read, "pages", page.id, tier)?,
                frontmatter: Value::Object(page.frontmatter.clone()),
                title: page.title,
            });
        }
        Ok(out)
    }

    /// `readReferrerGroupRows`: the live pages in `referrerSources` that link to a live target (other
    /// than the targets), by canonical type, the newest `perGroup` of each by `(d DESC, source_id,
    /// slug)` bytewise, each with its group's total; groups by canonical type bytewise. A policy
    /// leaves out a hidden target, a link whose origin page it hides and a hidden referrer; the trust
    /// floor, the flagged filter and quarantine apply before the cap.
    pub fn read_referrer_group_rows(
        &self,
        input: &ReferrerGroupInput,
    ) -> Result<Vec<ReferrerGroupRow>> {
        let read = self.read()?;
        let read = &*read;
        let scope = ReferrerScope {
            referrer_sources: &input.referrer_sources,
            stored_types: &input.stored_types,
            canonical_types: &input.canonical_types,
            exclude_private: input.exclude_private.as_ref(),
            trust: TrustPolicy::parse(input.min_trust.as_deref(), input.suppress_flagged)?,
            include_quarantined: input.include_quarantined,
        };
        let mut pages = Pages::new(read);
        let mut targets = BTreeSet::new();
        for (source_id, slug) in input.target_sources.iter().zip(&input.target_slugs) {
            targets.extend(scope.target(read, source_id, slug)?);
        }
        let mut groups: BTreeMap<String, Vec<ReferrerGroupEntry>> = BTreeMap::new();
        for (page, canonical) in scope.referrers(read, &mut pages, &targets)? {
            let d = page.effective_date_us.unwrap_or(page.updated_at_us);
            groups.entry(canonical).or_default().push((
                d,
                page.source_id.clone(),
                page.slug.clone(),
                page.id,
                page.page_type.clone(),
            ));
        }
        let mut out = Vec::new();
        for (canonical, mut rows) in groups {
            rows.sort_by(|a, b| {
                b.0.cmp(&a.0)
                    .then_with(|| a.1.cmp(&b.1))
                    .then_with(|| a.2.cmp(&b.2))
            });
            let gtotal = rows.len() as u64;
            for (d, source_id, slug, id, page_type) in
                rows.into_iter().take(input.per_group as usize)
            {
                out.push(ReferrerGroupRow {
                    id,
                    slug,
                    source_id,
                    page_type,
                    canonical_type: canonical.clone(),
                    d: iso(d),
                    gtotal,
                });
            }
        }
        Ok(out)
    }

    /// `readReferrerTargetCounts`: per target index (in ascending order), the referrers of its live
    /// pages other than its own pages, as `readReferrerGroupRows` reads them: the total (no canonical
    /// type), then the total of each canonical type in `recordTypes` that has any, bytewise. An index
    /// with no referrer has no row.
    pub fn read_referrer_target_counts(
        &self,
        input: &ReferrerTargetCountInput,
    ) -> Result<Vec<ReferrerTargetCountRow>> {
        let read = self.read()?;
        let read = &*read;
        let scope = ReferrerScope {
            referrer_sources: &input.referrer_sources,
            stored_types: &input.stored_types,
            canonical_types: &input.canonical_types,
            exclude_private: input.exclude_private.as_ref(),
            trust: TrustPolicy::parse(input.min_trust.as_deref(), input.suppress_flagged)?,
            include_quarantined: input.include_quarantined,
        };
        let mut pages = Pages::new(read);
        let mut targets: BTreeMap<i64, BTreeSet<u64>> = BTreeMap::new();
        for ((source_id, slug), i) in input
            .target_sources
            .iter()
            .zip(&input.target_slugs)
            .zip(&input.target_indexes)
        {
            if let Some(id) = scope.target(read, source_id, slug)? {
                targets.entry(*i).or_default().insert(id);
            }
        }
        let mut out = Vec::new();
        for (i, ids) in &targets {
            let referrers = scope.referrers(read, &mut pages, ids)?;
            if referrers.is_empty() {
                continue;
            }
            let mut by_type: BTreeMap<&str, u64> = BTreeMap::new();
            for (_, canonical) in &referrers {
                if input.record_types.contains(canonical) {
                    *by_type.entry(canonical.as_str()).or_default() += 1;
                }
            }
            out.push(ReferrerTargetCountRow {
                i: *i,
                canonical_type: None,
                n: referrers.len() as u64,
            });
            out.extend(by_type.into_iter().map(|(t, n)| ReferrerTargetCountRow {
                i: *i,
                canonical_type: Some(t.to_string()),
                n,
            }));
        }
        Ok(out)
    }

    /// `listReferrerTargetSources`: each source in `sources` holding a live page with this slug,
    /// once, in input order.
    pub fn list_referrer_target_sources(
        &self,
        input: &ReferrerTargetSourcesInput,
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let read = &*read;
        let mut out: Vec<String> = Vec::new();
        for source_id in &input.sources {
            if !out.contains(source_id) && live_page(read, source_id, &input.slug)?.is_some() {
                out.push(source_id.clone());
            }
        }
        Ok(out)
    }

    /// The referrer page's scope and its type-filtered referrers, newest first.
    fn referrer_page_rows(&self, input: &ReferrerRowInput) -> Result<Vec<DatedReferrer>> {
        let mut rows = self.referrer_scope_rows(input)?;
        if let Some(t) = &input.page_type {
            rows.retain(|(_, page, canonical)| canonical == t || page.page_type == *t);
        }
        Ok(rows)
    }

    /// Every referrer in the referrer page's scope, with no type filter, newest first.
    fn referrer_scope_rows(&self, input: &ReferrerRowInput) -> Result<Vec<DatedReferrer>> {
        let read = self.read()?;
        let read = &*read;
        let scope = ReferrerScope {
            referrer_sources: &input.referrer_sources,
            stored_types: &input.stored_types,
            canonical_types: &input.canonical_types,
            exclude_private: input.exclude_private.as_ref(),
            trust: TrustPolicy::parse(input.min_trust.as_deref(), input.suppress_flagged)?,
            include_quarantined: input.include_quarantined,
        };
        scope.dated_referrers(read, &input.target_sources, &input.target_slugs)
    }

    /// `readReferrerTypes`: the distinct `(canonical_type, type)` pairs among the referrers of
    /// `countReferrerRows` with no type filter (`type`, `cursor` and `limit` are ignored), by
    /// canonical type then stored type bytewise. An untyped referrer's stored type is `""`.
    pub fn read_referrer_types(&self, input: &ReferrerRowInput) -> Result<Vec<ReferrerTypeRow>> {
        let pairs: BTreeSet<(String, String)> = self
            .referrer_scope_rows(input)?
            .into_iter()
            .map(|(_, page, canonical)| (canonical, page.page_type.clone()))
            .collect();
        Ok(pairs
            .into_iter()
            .map(|(canonical_type, page_type)| ReferrerTypeRow {
                canonical_type,
                page_type,
            })
            .collect())
    }

    /// `countReferrerRows`: how many referrers `readReferrerRows` pages through, of `type` when set.
    pub fn count_referrer_rows(&self, input: &ReferrerRowInput) -> Result<u64> {
        Ok(self.referrer_page_rows(input)?.len() as u64)
    }

    /// `readReferrerRows`: the referrers of `readReferrerGroupRows` (of `type`, its canonical or stored
    /// type, when set), newest first by `(d DESC, source_id, slug)` bytewise, after the cursor when
    /// one is given (a row of the cursor's date and a greater `(source_id, slug)`, or an older row; a
    /// cursor with no date continues with nothing), at most `limit`. A cursor date that is not
    /// `to_char` UTC text is refused, as `::timestamptz` refuses it.
    pub fn read_referrer_rows(&self, input: &ReferrerRowInput) -> Result<Vec<ReferrerRow>> {
        let after = match &input.cursor {
            None => None,
            Some((None, _, _)) => return Ok(Vec::new()),
            Some((Some(d), source_id, slug)) => {
                let us = parse_iso(d).ok_or_else(|| {
                    StoreError::invalid(format!(
                        "readReferrerRows: the cursor date is not a timestamp: {d:?}"
                    ))
                })?;
                Some((us, source_id.as_str(), slug.as_str()))
            }
        };
        let rows = self.referrer_page_rows(input)?;
        Ok(rows
            .into_iter()
            .filter(|(d, page, _)| match after {
                None => true,
                Some((at, source_id, slug)) => {
                    *d < at
                        || (*d == at
                            && (page.source_id.as_str(), page.slug.as_str()) > (source_id, slug))
                }
            })
            .take(input.limit as usize)
            .map(|(d, page, canonical)| ReferrerRow {
                id: page.id,
                slug: page.slug.clone(),
                source_id: page.source_id.clone(),
                page_type: page.page_type.clone(),
                canonical_type: canonical,
                d: iso(d),
            })
            .collect())
    }

    /// `readReferrerRecordCandidates`: per target index with a live, shown target (ascending), the
    /// newest `perTarget` of its referrers (as `readReferrerTargetCounts` reads them) whose canonical
    /// type is in `recordTypes`, by `(d DESC, source_id, slug)` bytewise.
    pub fn read_referrer_record_candidates(
        &self,
        input: &ReferrerRecordCandidateInput,
    ) -> Result<Vec<ReferrerRecordCandidateRow>> {
        let read = self.read()?;
        let read = &*read;
        let scope = ReferrerScope {
            referrer_sources: &input.referrer_sources,
            stored_types: &input.stored_types,
            canonical_types: &input.canonical_types,
            exclude_private: input.exclude_private.as_ref(),
            trust: TrustPolicy::parse(input.min_trust.as_deref(), input.suppress_flagged)?,
            include_quarantined: input.include_quarantined,
        };
        let mut pages = Pages::new(read);
        let mut targets: BTreeMap<i64, BTreeSet<u64>> = BTreeMap::new();
        for ((source_id, slug), i) in input
            .target_sources
            .iter()
            .zip(&input.target_slugs)
            .zip(&input.target_indexes)
        {
            if let Some(id) = scope.target(read, source_id, slug)? {
                targets.entry(*i).or_default().insert(id);
            }
        }
        let mut out = Vec::new();
        for (i, ids) in &targets {
            let mut rows: Vec<DatedReferrer> = scope
                .referrers(read, &mut pages, ids)?
                .into_iter()
                .filter(|(_, canonical)| input.record_types.contains(canonical))
                .map(|(page, canonical)| {
                    (
                        page.effective_date_us.unwrap_or(page.updated_at_us),
                        page,
                        canonical,
                    )
                })
                .collect();
            newest_first(&mut rows);
            out.extend(rows.into_iter().take(input.per_target as usize).map(
                |(d, page, canonical)| ReferrerRecordCandidateRow {
                    i: *i,
                    id: page.id,
                    slug: page.slug.clone(),
                    source_id: page.source_id.clone(),
                    canonical_type: canonical,
                    d: iso(d),
                },
            ));
        }
        Ok(out)
    }

    /// `readReferrerRecordPages`: the title and date source of each page id that exists (soft-deleted
    /// pages too, as `id = ANY($1)` reads them), once per id, in id order.
    pub fn read_referrer_record_pages(
        &self,
        input: &ReferrerPageDetailsInput,
    ) -> Result<Vec<ReferrerRecordPageRow>> {
        let read = self.read()?;
        let read = &*read;
        let ids: BTreeSet<u64> = input.ids.iter().copied().collect();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(page) = read_page_by_id(read, id)? {
                out.push(ReferrerRecordPageRow {
                    id: page.id,
                    date_source: date_source(&page),
                    title: page.title,
                });
            }
        }
        Ok(out)
    }

    /// `listAmendmentsNotApplied`: the live pages with an `amends` link to the page whose relationship
    /// (scope `world` under a policy, else `all`) starts after the edition took effect and on or before the date,
    /// or has no start; each once, with the earliest start, by slug then source bytewise, at most `limit`.
    pub fn list_amendments_not_applied(&self, q: &AmendmentsQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let read = &*read;
        let Ok(page_id) = u64::try_from(q.page_id) else {
            return Ok(Vec::new());
        };
        let scope = if q.exclude_private.is_some() {
            "world"
        } else {
            "all"
        };
        let mut pages = Pages::new(read);
        let mut found: BTreeMap<(String, String), Option<String>> = BTreeMap::new();
        for link in in_links(read, page_id)? {
            if link.link_type != "amends" {
                continue;
            }
            let Some(from) = pages.get(link.from_page_id)?.filter(|p| live(p)) else {
                continue;
            };
            if q.source_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&from.source_id))
            {
                continue;
            }
            if let Some(policy) = &q.exclude_private
                && (page_hidden(read, &from, policy)?
                    || !link_origin_shown(&mut pages, &link, policy)?)
            {
                continue;
            }
            let start = relationship(read, &RelationshipKey::of_link(&link), scope)?
                .and_then(|r| r.first_start);
            if let Some(start) = &start
                && !(start.as_str() > q.edition_from.as_str() && start.as_str() <= q.as_of.as_str())
            {
                continue;
            }
            let since = found
                .entry((from.slug.clone(), from.source_id.clone()))
                .or_insert(None);
            if let Some(start) = start
                && since.as_ref().is_none_or(|s| start < *s)
            {
                *since = Some(start);
            }
        }
        Ok(found
            .into_iter()
            .take(usize::try_from(q.limit).unwrap_or(usize::MAX))
            .map(|((slug, source_id), since)| serde_json::json!({ "slug": slug, "source_id": source_id, "since": since }))
            .collect())
    }

    /// `countSearchVectorRows`: the pages and chunks a keyword reindex would touch.
    pub fn count_search_vector_rows(&self) -> Result<SearchVectorCounts> {
        let read = self.read()?;
        let read = &*read;
        Ok(SearchVectorCounts {
            pages: all_pages(read)?.len() as u64,
            chunks: crate::chunks::read_stats(read)?.chunks,
        })
    }

    /// `listManualLinkTransitions`: the manual dated statements of the relationships the page
    /// (in any deletion state) starts, with each target's slug and source, by target source, target
    /// slug, link type, kind and day (bytewise). The engine copier carries them with the page.
    pub fn list_manual_link_transitions(&self, source_id: &str, slug: &str) -> Result<Value> {
        let read = self.read()?;
        let Some(from) = read_page(&*read, source_id, slug)? else {
            return Ok(Value::Array(Vec::new()));
        };
        let mut prefix = family_prefix(&from.source_id, TRANSITION);
        prefix.extend_from_slice(&from.id.to_be_bytes());
        let mut rows = Vec::new();
        for (_, t) in scan_under::<TransitionRecord>(&*read, &prefix)? {
            if t.producer != "manual" {
                continue;
            }
            let Some(to) = read_page_by_id(&*read, t.to_page_id)? else {
                continue;
            };
            rows.push((to.source_id, to.slug, t.link_type, t.kind, t.occurred_on));
        }
        rows.sort();
        Ok(Value::Array(
            rows.into_iter()
                .map(|(to_source_id, to_slug, link_type, kind, occurred_on)| {
                    serde_json::json!({
                        "to_slug": to_slug, "to_source_id": to_source_id, "link_type": link_type,
                        "kind": kind, "occurred_on": occurred_on,
                    })
                })
                .collect(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiranges_are_canonical() {
        let c = |t: &str| canonical_multirange(t).unwrap();
        assert_eq!(c("{}"), "{}");
        assert_eq!(c("{[2021-04-01,2025-03-01)}"), "{[2021-04-01,2025-03-01)}");
        assert_eq!(
            c("{[2026-01-01,),[2021-04-01,2025-03-01)}"),
            "{[2021-04-01,2025-03-01),[2026-01-01,)}"
        );
        assert_eq!(
            c("{[2021-01-01,2022-01-01),[2022-01-01,2023-01-01)}"),
            "{[2021-01-01,2023-01-01)}"
        );
        assert_eq!(c("{[2021-01-01,2021-01-01)}"), "{}");
        assert_eq!(c("{(,2022-01-01),[2021-01-01,)}"), "{(,)}");
        assert_eq!(
            c("{[2021-01-01,2024-01-01),[2022-01-01,2023-01-01)}"),
            "{[2021-01-01,2024-01-01)}"
        );
        // An explicit infinite bound is kept apart from an omitted one, as Postgres prints it, and merges as it does.
        assert_eq!(c("{[2020-01-01,infinity)}"), "{[2020-01-01,infinity)}");
        assert_eq!(c("{[-infinity,2020-01-01)}"), "{[-infinity,2020-01-01)}");
        assert_eq!(
            c("{[2021-01-01,infinity),[2019-01-01,2019-06-01)}"),
            "{[2019-01-01,2019-06-01),[2021-01-01,infinity)}"
        );
        assert_eq!(
            c("{[2020-01-01,infinity),[2021-01-01,)}"),
            "{[2020-01-01,)}"
        );
        assert!(multirange_contains("{[2020-01-01,infinity)}", "9999-12-31"));
        assert!(!multirange_contains(
            "{[2020-01-01,infinity)}",
            "2019-12-31"
        ));
        assert!(multirange_contains(
            "{[-infinity,2020-01-01)}",
            "1900-01-01"
        ));
        assert!(canonical_multirange("{[2021-01-01,2022-01-01]}").is_err());
        assert!(canonical_multirange("{[infinity,2022-01-01)}").is_err());
        assert!(canonical_multirange("{[2021-01-01,-infinity)}").is_err());
        assert!(canonical_multirange("[2021-01-01,)").is_err());
        assert!(canonical_multirange("{[2021-13-01,)}").is_err());
    }

    #[test]
    fn a_malformed_multirange_is_refused_never_a_panic() {
        // Postgres refuses each of these with `malformed multirange literal: "<text>"`.
        for text in ["{)}", "{ )}", "{é)}", "{[)}", "{()}", "{,)}"] {
            let err = canonical_multirange(text).unwrap_err();
            assert_eq!(
                err.message,
                format!("malformed multirange literal: \"{text}\"")
            );
            assert!(!multirange_overlaps(text, "2020-01-01", "2021-01-01"));
            assert!(!multirange_contains(text, "2020-01-01"));
        }
    }

    #[test]
    fn containment_is_half_open() {
        let r = "{[2021-01-01,2022-01-01),[2026-01-01,)}";
        assert!(multirange_contains(r, "2021-01-01"));
        assert!(!multirange_contains(r, "2022-01-01"));
        assert!(multirange_contains(r, "2030-05-05"));
        assert!(!multirange_contains("{}", "2030-05-05"));
        assert!(multirange_contains("{(,2022-01-01)}", "1999-01-01"));
    }

    #[test]
    fn dates_are_checked() {
        assert!(is_date("2024-02-29"));
        assert!(!is_date("2023-02-29"));
        assert!(!is_date("2023-2-01"));
        assert!(!is_date("not-a-date"));
    }
}
