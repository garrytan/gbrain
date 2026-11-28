//! Group 5 facts members, the conversation publication and relink reads
//! (src/core/engine-sql/facts-conversation.ts). Every member only reads.
//!
//! Write journal (`persistence_requests`, `persistence_counters`). A request's `compacted` flag is
//! the record's `compacted` field; a request the store admitted natively has none, which is false.
//! - `findSpentConversationRequest(principalKind, principalId, requestId, digest)`: the writer's
//!   request `requestId` when its digest is not `digest`, or it was compacted and did not commit,
//!   `{ request_id }`; null otherwise. A `requestId` that is not a UUID is an error (`::uuid`).
//! - `listConversationBatchRequests(principalKind, principalId, sourceId, anchorSlug)`: the
//!   writer's `submit_job` requests on the anchor page that did not commit and are not compacted,
//!   in journal order, each `{ id, request_id, state, error_code, members }`; `members` lists
//!   `{ generation, attempt }` of each `intent.pages` entry, null for no entries.
//! - `readStoredConversationEntry(id, generation)`: the first `intent.pages` entry of request `id`
//!   (not compacted) whose `generation` text is `generation`, null otherwise.
//! - `readPrincipalCounters(key)`: `{ outstanding_count, terminal_bytes, lifetime_ids }`, null when
//!   the key has no counter row.
//!
//! Pages and aliases.
//! - `countConversationPagesToExtract(sourceId, pageTypes, force)`: the live pages of the source
//!   whose type is in `pageTypes` that have, unless `force`, no unexpired terminal or
//!   non-extractable (v2) outcome row.
//! - `listMergedEntityAliases(sourceId, slugs)`: for each distinct slug that is an alias with no
//!   live page of its own and a live canonical page, `{ alias_slug, canonical_slug }`.
//! - `listEntityHintPages(sourceId, slugs)`: the live pages among `slugs`, in page id order, each
//!   `{ slug, type, frontmatter, retired, folder_restricted }`. `folder_restricted` is
//!   `folderRestrictedSql`: the page carries a stamped folder rule or sits under a pending prefix.
//! - `readRelinkSource(sourceId)`: `{ incarnation, archived, local_path, kind }` (`config->>'kind'`),
//!   null for an unknown source.
//! - `readReextractOutcomeRow(sourceId, slug)`: on a live page, its newest unexpired terminal (v2)
//!   outcome row, `{ id, hash }` with the page's content hash (empty when it has none).
//!
//! Fact rows.
//! - `readConversationSlotValueHash(sourceId, entitySlug, dimension, validFrom)`: the value hash of
//!   the slot's newest live, unsuperseded conversation row valid at or before `validFrom` (ties:
//!   the larger id), `{ value_hash }`; null for none.
//! - `listPurgeTombstoneMatches(sourceId, claims)`: the 1-based positions of the claims (the four
//!   arrays read side by side, a shorter one padded with NULL) that a `fact_purges` tombstone of
//!   the claim's visibility and fingerprint covers, under `*`, under the claim's entity, or under
//!   any subject for an unbacked name key; an outcome marker of an audit (or NULL) source never
//!   matches.
//! - `findSameClaimFenceRow(sourceId, slug, fact, source)`: the oldest unexpired fence row of the
//!   page with the claim `fact` and the source `source`, `{ id, visibility }`.
//! - `findOntologyTwin(sourceId, slug, factId)`: a row of the page on entity `slug` with fact
//!   `factId`'s dimension, value hash and valid-from (not that row), an unexpired one first, then
//!   by id, `{ id }`.
//! - `listUnbackedConversationRows` / `listUnlinkedConversationRows(sourceId, slugs)`: the live
//!   derived conversation rows of the pages on an unbacked name key / with no entity, by page then
//!   id.
//! - `listClearedRelinkedFacts(sourceId, slug)`: the page's expired conversation rows, newest
//!   first, `{ fact, entity_slug, context, carried }` (#10443); `carried` is true for a relinked
//!   row whose entity page is live.
//! - `countEmbeddedFactsAmong(sourceId, ids)`: how many of the distinct `ids` are rows of the
//!   source with an embedding.

use super::conversation::{ConversationPageArgs, derived_row, relinked};
use super::purge::unbacked;
use super::purge_ledger::purge_hash_under;
use super::{
    AUDIT_ROW_SOURCES, FactRecord, fact_by_number, fact_fingerprint, page_rows, read_fact,
};
use crate::Store;
use crate::aliases::read_slug_alias;
use crate::cli_reads::reads::retired;
use crate::env::{is_uuid, parse_iso};
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::jsonb::order as jsonb_order;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::read_page;
use crate::persistence::read_counter;
use crate::sources::read_source;
use crate::timeline_queries::jsonb_field_text;
use crate::{get_json, keys};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// `TERMINAL_AUDIT_SOURCE`.
const TERMINAL_SOURCE: &str = "cli:extract-conversation-facts:terminal:v2";
/// `NON_EXTRACTABLE_AUDIT_SOURCE`.
const NON_EXTRACTABLE_SOURCE: &str = "cli:extract-conversation-facts:non-extractable:v2";
/// `OUTCOME_MARKER_FACTS`.
const OUTCOME_MARKERS: [&str; 2] = ["EXTRACTION_COMPLETE", "EXTRACTION_NOT_APPLICABLE"];

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SpentRequestArgs {
    pub principal_kind: String,
    pub principal_id: String,
    pub request_id: String,
    pub digest: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchRequestArgs {
    pub principal_kind: String,
    pub principal_id: String,
    pub source_id: String,
    pub anchor_slug: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredEntryArgs {
    pub id: String,
    pub generation: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CounterArgs {
    pub key: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PagesToExtractArgs {
    pub source_id: String,
    pub page_types: Vec<String>,
    pub force: bool,
}

/// A source and a list of slugs.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSlugsArgs {
    pub source_id: String,
    pub slugs: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SlotValueArgs {
    pub source_id: String,
    pub entity_slug: String,
    pub dimension: String,
    pub valid_from: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TombstoneClaims {
    pub facts: Vec<Option<String>>,
    pub visibilities: Vec<Option<String>>,
    pub entity_slugs: Vec<Option<String>>,
    pub sources: Vec<Option<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TombstoneMatchArgs {
    pub source_id: String,
    pub claims: TombstoneClaims,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SameClaimArgs {
    pub source_id: String,
    pub slug: String,
    pub fact: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct OntologyTwinArgs {
    pub source_id: String,
    pub slug: String,
    pub fact_id: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceArgs {
    pub source_id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EmbeddedAmongArgs {
    pub source_id: String,
    pub ids: Vec<f64>,
}

/// The fields of a page record a page scan needs.
#[derive(Deserialize)]
struct PageHead {
    slug: String,
    #[serde(rename = "type")]
    page_type: String,
    #[serde(default)]
    deleted_at_us: Option<i64>,
}

/// The pages of a source, decoded as [`PageHead`].
fn source_pages(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageHead>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(
        read,
        &keys::text(keys::PAGE, &[source_id, ""]),
        false,
        &mut |_, v| match serde_json::from_slice::<PageHead>(v) {
            Ok(page) => {
                out.push(page);
                true
            }
            Err(e) => {
                failure = Some(StoreError::from(e));
                false
            }
        },
    )?;
    failure.map_or(Ok(out), Err)
}

/// Whether the source has a live page `slug`.
fn live_page(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<bool> {
    if slug.contains('\0') {
        return Ok(false);
    }
    Ok(read_page(read, source_id, slug)?.is_some_and(|p| p.deleted_at_us.is_none()))
}

/// A `::uuid` argument in lower case.
fn uuid_arg(op: &str, name: &str, text: &str) -> Result<String> {
    if is_uuid(text) {
        Ok(text.to_lowercase())
    } else {
        Err(StoreError::invalid(format!(
            "{op}: invalid input syntax for type uuid: \"{text}\" ({name})"
        )))
    }
}

/// Every request row, in key order.
fn all_requests(read: &dyn KvRead) -> Result<Vec<RequestRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::REQUEST], false, &mut |_, v| {
        match serde_json::from_slice::<RequestRecord>(v) {
            Ok(r) => out.push(r),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// The request's `compacted` column (a natively admitted request has none: false).
fn compacted(r: &RequestRecord) -> bool {
    r.extra
        .get("compacted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// `jsonb_array_elements(intent->'pages')`: none for a missing or null `pages`, an error for a
/// value that is not an array.
fn intent_pages<'a>(op: &str, r: &'a RequestRecord) -> Result<&'a [Value]> {
    match r.intent.as_object().and_then(|o| o.get("pages")) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(pages)) => Ok(pages),
        Some(_) => Err(StoreError::invalid(format!(
            "{op}: cannot extract elements from a scalar or object (intent pages)"
        ))),
    }
}

/// `p->>name` of a pages entry.
fn entry_text(entry: &Value, name: &str) -> Option<String> {
    entry
        .as_object()
        .and_then(|o| o.get(name))
        .and_then(jsonb_field_text)
}

/// `(text)::int`: Postgres's `int4` input (blanks around an optional sign and digits).
fn int4_text(op: &str, text: &str) -> Result<i64> {
    let trimmed = text.trim_matches(|c: char| c.is_ascii_whitespace());
    trimmed.parse::<i32>().map(i64::from).map_err(|_| {
        StoreError::invalid(format!(
            "{op}: invalid input syntax for type integer: \"{text}\""
        ))
    })
}

impl Store {
    /// `findSpentConversationRequest(principalKind, principalId, requestId, digest)`.
    pub fn find_spent_conversation_request(&self, a: &SpentRequestArgs) -> Result<Value> {
        const OP: &str = "findSpentConversationRequest";
        let request_id = uuid_arg(OP, "requestId", &a.request_id)?;
        let read = self.read()?;
        let spent = all_requests(&*read)?.into_iter().find(|r| {
            r.principal_kind == a.principal_kind
                && r.principal_id == a.principal_id
                && r.request_id.to_lowercase() == request_id
                && (r.digest != a.digest || (compacted(r) && r.state != "committed"))
        });
        Ok(spent.map_or(Value::Null, |r| json!({ "request_id": r.request_id })))
    }

    /// `listConversationBatchRequests(principalKind, principalId, sourceId, anchorSlug)`.
    pub fn list_conversation_batch_requests(&self, a: &BatchRequestArgs) -> Result<Vec<Value>> {
        const OP: &str = "listConversationBatchRequests";
        let read = self.read()?;
        let mut rows: Vec<RequestRecord> = all_requests(&*read)?
            .into_iter()
            .filter(|r| {
                r.principal_kind == a.principal_kind
                    && r.principal_id == a.principal_id
                    && r.source_id == a.source_id
                    && r.slug == a.anchor_slug
                    && r.operation == "submit_job"
                    && r.state != "committed"
                    && !compacted(r)
            })
            .collect();
        rows.sort_by_key(|r| r.sequence);
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let mut members = Vec::new();
            for p in intent_pages(OP, &r)? {
                let attempt = match entry_text(p, "attempt") {
                    Some(t) => json!(int4_text(OP, &t)?),
                    None => Value::Null,
                };
                members
                    .push(json!({ "attempt": attempt, "generation": entry_text(p, "generation") }));
            }
            out.push(json!({
                "id": r.id,
                "request_id": r.request_id,
                "state": r.state,
                "error_code": r.error_code,
                "members": if members.is_empty() { Value::Null } else { Value::Array(members) },
            }));
        }
        Ok(out)
    }

    /// `readStoredConversationEntry(id, generation)`.
    pub fn read_stored_conversation_entry(&self, a: &StoredEntryArgs) -> Result<Value> {
        const OP: &str = "readStoredConversationEntry";
        let id = uuid_arg(OP, "id", &a.id)?;
        let read = self.read()?;
        let Some(r) = get_json::<RequestRecord>(&*read, &keys::request(&id))? else {
            return Ok(Value::Null);
        };
        if compacted(&r) {
            return Ok(Value::Null);
        }
        let entry = intent_pages(OP, &r)?
            .iter()
            .find(|p| entry_text(p, "generation").as_deref() == Some(a.generation.as_str()));
        Ok(entry.map_or(Value::Null, |p| jsonb_order(p.clone())))
    }

    /// `readPrincipalCounters(key)`.
    pub fn read_principal_counters(&self, a: &CounterArgs) -> Result<Value> {
        let read = self.read()?;
        Ok(read_counter(&*read, &a.key)?.map_or(Value::Null, |c| {
            json!({
                "outstanding_count": c.outstanding_count,
                "terminal_bytes": c.terminal_bytes,
                "lifetime_ids": c.lifetime_ids,
            })
        }))
    }

    /// `countConversationPagesToExtract(sourceId, pageTypes, force)`.
    pub fn count_conversation_pages_to_extract(&self, a: &PagesToExtractArgs) -> Result<i64> {
        if a.source_id.contains('\0') {
            return Ok(0);
        }
        let read = self.read()?;
        let mut n = 0;
        for page in source_pages(&*read, &a.source_id)? {
            if page.deleted_at_us.is_some() || !a.page_types.contains(&page.page_type) {
                continue;
            }
            let done = !a.force
                && page_rows(&*read, &a.source_id, &page.slug)?
                    .iter()
                    .any(|f| {
                        (f.source == TERMINAL_SOURCE || f.source == NON_EXTRACTABLE_SOURCE)
                            && f.expired_at_us.is_none()
                    });
            if !done {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `listMergedEntityAliases(sourceId, slugs)`.
    pub fn list_merged_entity_aliases(&self, a: &SourceSlugsArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for alias in &a.slugs {
            if alias.contains('\0') || a.source_id.contains('\0') || !seen.insert(alias.as_str()) {
                continue;
            }
            let Some(record) = read_slug_alias(&*read, &a.source_id, alias)? else {
                continue;
            };
            if !live_page(&*read, &a.source_id, alias)?
                && live_page(&*read, &a.source_id, &record.canonical_slug)?
            {
                out.push(json!({ "alias_slug": alias, "canonical_slug": record.canonical_slug }));
            }
        }
        Ok(out)
    }

    /// `listEntityHintPages(sourceId, slugs)`.
    pub fn list_entity_hint_pages(&self, a: &SourceSlugsArgs) -> Result<Vec<Value>> {
        if a.source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut seen = BTreeSet::new();
        let mut pages = Vec::new();
        for slug in &a.slugs {
            if slug.contains('\0') || !seen.insert(slug.as_str()) {
                continue;
            }
            if let Some(page) = read_page(&*read, &a.source_id, slug)?
                && page.deleted_at_us.is_none()
            {
                pages.push(page);
            }
        }
        pages.sort_by_key(|p| p.id);
        let mut out = Vec::with_capacity(pages.len());
        for p in pages {
            let folder_restricted = super::repair::folder_restricted(&*read, &p)?;
            out.push(json!({
                "slug": p.slug,
                "type": p.page_type,
                "retired": retired(&p.frontmatter),
                "frontmatter": jsonb_order(Value::Object(p.frontmatter)),
                "folder_restricted": folder_restricted,
            }));
        }
        Ok(out)
    }

    /// `readRelinkSource(sourceId)`.
    pub fn read_relink_source(&self, a: &SourceArgs) -> Result<Value> {
        if a.source_id.contains('\0') {
            return Ok(Value::Null);
        }
        let read = self.read()?;
        Ok(read_source(&*read, &a.source_id)?.map_or(Value::Null, |s| {
            json!({
                "incarnation": s.incarnation,
                "archived": s.archived,
                "local_path": s.local_path,
                "kind": s.config.get("kind").and_then(jsonb_field_text),
            })
        }))
    }

    /// `readReextractOutcomeRow(sourceId, slug)`.
    pub fn read_reextract_outcome_row(&self, a: &ConversationPageArgs) -> Result<Value> {
        a.check("readReextractOutcomeRow")?;
        let read = self.read()?;
        let Some(page) = read_page(&*read, &a.source_id, &a.slug)? else {
            return Ok(Value::Null);
        };
        if page.deleted_at_us.is_some() {
            return Ok(Value::Null);
        }
        let newest = page_rows(&*read, &a.source_id, &a.slug)?
            .into_iter()
            .filter(|f| f.source == TERMINAL_SOURCE && f.expired_at_us.is_none())
            .max_by_key(|f| f.id);
        Ok(newest.map_or(
            Value::Null,
            |f| json!({ "id": f.id, "hash": page.content_hash.unwrap_or_default() }),
        ))
    }

    /// `readConversationSlotValueHash(sourceId, entitySlug, dimension, validFrom)`.
    pub fn read_conversation_slot_value_hash(&self, a: &SlotValueArgs) -> Result<Value> {
        const OP: &str = "readConversationSlotValueHash";
        no_nul(
            OP,
            &[
                ("sourceId", &a.source_id),
                ("entitySlug", &a.entity_slug),
                ("dimension", &a.dimension),
            ],
        )?;
        let at = parse_iso(&a.valid_from).ok_or_else(|| {
            StoreError::invalid(format!(
                "{OP}: invalid input syntax for type timestamp with time zone: \"{}\"",
                a.valid_from
            ))
        })?;
        let read = self.read()?;
        let best = super::entity_rows(&*read, &a.source_id, &a.entity_slug)?
            .into_iter()
            .filter(|f| {
                f.dimension.as_deref() == Some(a.dimension.as_str())
                    && f.value_hash.is_some()
                    && f.expired_at_us.is_none()
                    && f.superseded_by.is_none()
                    && f.conversation_slot()
                    && f.valid_from_us <= at
            })
            .max_by_key(|f| (f.valid_from_us, f.id));
        Ok(best.map_or(Value::Null, |f| json!({ "value_hash": f.value_hash })))
    }

    /// `listPurgeTombstoneMatches(sourceId, claims)`.
    pub fn list_purge_tombstone_matches(&self, a: &TombstoneMatchArgs) -> Result<Vec<Value>> {
        let c = &a.claims;
        let len = c
            .facts
            .len()
            .max(c.visibilities.len())
            .max(c.entity_slugs.len())
            .max(c.sources.len());
        if a.source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let at = |v: &[Option<String>], i: usize| v.get(i).cloned().flatten();
        let read = self.read()?;
        let mut out = Vec::new();
        for i in 0..len {
            let (Some(fact), Some(visibility)) = (at(&c.facts, i), at(&c.visibilities, i)) else {
                continue;
            };
            let source = at(&c.sources, i);
            // `NOT (source IN (...) AND fact IN (...))`: a NULL source makes a marker's test NULL,
            // which drops the claim as a true test does.
            if OUTCOME_MARKERS.contains(&fact.as_str())
                && source
                    .as_deref()
                    .is_none_or(|s| AUDIT_ROW_SOURCES.contains(&s))
            {
                continue;
            }
            let hash = fact_fingerprint(&fact);
            let entity = at(&c.entity_slugs, i);
            let hit = match entity.as_deref() {
                Some(e) if !e.contains('/') && !live_page(&*read, &a.source_id, e)? => {
                    purge_hash_under(&*read, &a.source_id, &visibility, None, &hash)?
                }
                Some(e) => purge_hash_under(&*read, &a.source_id, &visibility, Some(e), &hash)?,
                None => purge_hash_under(&*read, &a.source_id, &visibility, Some("*"), &hash)?,
            };
            if hit {
                out.push(json!({ "ord": i + 1 }));
            }
        }
        Ok(out)
    }

    /// `findSameClaimFenceRow(sourceId, slug, fact, source)`.
    pub fn find_same_claim_fence_row(&self, a: &SameClaimArgs) -> Result<Value> {
        no_nul(
            "findSameClaimFenceRow",
            &[("sourceId", &a.source_id), ("slug", &a.slug)],
        )?;
        let Some(source) = a.source.as_deref() else {
            return Ok(Value::Null);
        };
        let read = self.read()?;
        let same = page_rows(&*read, &a.source_id, &a.slug)?
            .into_iter()
            .find(|f| {
                f.row_num.is_some()
                    && f.expired_at_us.is_none()
                    && f.fact == a.fact
                    && f.source == source
            });
        Ok(same.map_or(
            Value::Null,
            |f| json!({ "id": f.id, "visibility": f.visibility }),
        ))
    }

    /// `findOntologyTwin(sourceId, slug, factId)`.
    pub fn find_ontology_twin(&self, a: &OntologyTwinArgs) -> Result<Value> {
        const OP: &str = "findOntologyTwin";
        no_nul(OP, &[("sourceId", &a.source_id), ("slug", &a.slug)])?;
        let read = self.read()?;
        let Some(m) = fact_by_number(&*read, OP, "factId", a.fact_id)? else {
            return Ok(Value::Null);
        };
        let (Some(dimension), Some(hash)) = (m.dimension.as_deref(), m.value_hash.as_deref())
        else {
            return Ok(Value::Null);
        };
        if m.source_id != a.source_id {
            return Ok(Value::Null);
        }
        let twin = page_rows(&*read, &a.source_id, &a.slug)?
            .into_iter()
            .filter(|t| {
                t.id != m.id
                    && t.entity_slug.as_deref() == Some(a.slug.as_str())
                    && t.dimension.as_deref() == Some(dimension)
                    && t.value_hash.as_deref() == Some(hash)
                    && t.valid_from_us == m.valid_from_us
            })
            .min_by_key(|t| (t.expired_at_us.is_some(), t.id));
        Ok(twin.map_or(Value::Null, |t| json!({ "id": t.id })))
    }

    /// `listUnbackedConversationRows(sourceId, slugs)`.
    pub fn list_unbacked_conversation_rows(&self, a: &SourceSlugsArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut out = Vec::new();
        for row in conversation_page_rows(&*read, a)? {
            if row.active(now) && unbacked(&*read, &row)? {
                let mut v = relink_row(&row);
                v.insert("entity_slug".into(), json!(row.entity_slug));
                out.push(Value::Object(v));
            }
        }
        Ok(out)
    }

    /// `listUnlinkedConversationRows(sourceId, slugs)`.
    pub fn list_unlinked_conversation_rows(&self, a: &SourceSlugsArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        let now = self.env.now_micros();
        Ok(conversation_page_rows(&*read, a)?
            .into_iter()
            .filter(|row| row.entity_slug.is_none() && row.active(now))
            .map(|row| Value::Object(relink_row(&row)))
            .collect())
    }

    /// `listClearedRelinkedFacts(sourceId, slug)`.
    pub fn list_cleared_relinked_facts(&self, a: &ConversationPageArgs) -> Result<Vec<Value>> {
        a.check("listClearedRelinkedFacts")?;
        let read = self.read()?;
        let mut out = Vec::new();
        for f in page_rows(&*read, &a.source_id, &a.slug)?.into_iter().rev() {
            if !(f.conversation_slot() && f.expired_at_us.is_some()) {
                continue;
            }
            // `carried`: a relink had linked the row to an entity page that is still live.
            let entity = f.entity_slug.as_deref().unwrap_or_default();
            let carried = relinked(&f) && live_page(&*read, &a.source_id, entity)?;
            out.push(json!({
                "fact": f.fact, "entity_slug": f.entity_slug, "context": f.context,
                "carried": carried,
            }));
        }
        Ok(out)
    }

    /// `countEmbeddedFactsAmong(sourceId, ids)`.
    pub fn count_embedded_facts_among(&self, a: &EmbeddedAmongArgs) -> Result<i64> {
        const OP: &str = "countEmbeddedFactsAmong";
        let mut ids = BTreeSet::new();
        for id in &a.ids {
            ids.insert(super::bigint(OP, "ids", *id)?);
        }
        let read = self.read()?;
        let mut n = 0;
        for id in ids {
            let Ok(id) = u64::try_from(id) else {
                continue;
            };
            if read_fact(&*read, id)?
                .is_some_and(|f| f.source_id == a.source_id && f.embedding.is_some())
            {
                n += 1;
            }
        }
        Ok(n)
    }
}

/// The derived conversation rows of the distinct pages `slugs`, by page slug (bytes) then id.
fn conversation_page_rows(read: &dyn KvRead, a: &SourceSlugsArgs) -> Result<Vec<FactRecord>> {
    let slugs: BTreeSet<&str> = a
        .slugs
        .iter()
        .map(String::as_str)
        .filter(|s| !s.contains('\0'))
        .collect();
    if a.source_id.contains('\0') {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for slug in slugs {
        out.extend(
            page_rows(read, &a.source_id, slug)?
                .into_iter()
                .filter(derived_row),
        );
    }
    Ok(out)
}

/// `{ id, fact, context, visibility, slug, attributed_to }` of a relink row.
fn relink_row(row: &FactRecord) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("id".into(), json!(row.id));
    m.insert("fact".into(), json!(row.fact));
    m.insert("context".into(), json!(row.context));
    m.insert("visibility".into(), json!(row.visibility));
    m.insert("slug".into(), json!(row.source_markdown_slug));
    m.insert("attributed_to".into(), json!(row.attributed_to));
    m
}
