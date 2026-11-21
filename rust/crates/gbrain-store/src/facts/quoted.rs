//! The quote and slot-history reads of a fact recall (`engine-sql/facts-recall.ts`): `listFactsFromQuotedPages`,
//! `listFactIdsAtTrustFloor`, `readPageTypesByIds` and `listReadablePageSlugs`.
//!
//! - `listFactsFromQuotedPages`: of `ids`, the facts taken from a page of one of `pageTypes`: the page that holds the
//!   fact (`source_markdown_slug`, deleted or not), or the page a backstop fact's `source_session` names (the first
//!   `(source, prefix)` pair whose source is the fact's and whose prefix starts the session), or a page a
//!   `derivation_inputs` edge of the fact names ([`derivation_page_id`]: input table `pages`, an id of 1 to 18 digits),
//!   in any source, deleted or not, as the SQL join on `p.id` does.
//! - `listFactIdsAtTrustFloor`: of `ids`, the facts whose stored tier ranks at or above `floor` (`trustRankSql`: a
//!   tier name the store does not know ranks 0).
//! - `readPageTypesByIds`: each page id's stored type, deleted or not; an id with no page is absent.
//! - `listReadablePageSlugs`: of `slugs` in source `sourceId`, the pages `pageReadFilter(.., live = true)` admits
//!   under `scope` (chunk_queries `PageReadPolicy`), at most `limit`, in ask order.
//!
//! See rust/docs/store/facts.md, "Quote and slot-history reads".

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::{Value, json};

use super::read_fact;
use crate::Store;
use crate::chunk_queries::{ChunkReadScope, PageReadPolicy};
use crate::error::{Result, StoreError};
use crate::generations::inputs_of;
use crate::links::no_nul;
use crate::pages::{read_page, read_page_by_id};
use crate::trust::TrustTier;

/// `listFactsFromQuotedPages` input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct QuotedFactsQuery {
    pub ids: Vec<i64>,
    pub page_types: Vec<String>,
    /// `(facts.source, source_session prefix)` pairs, in the order the SQL `CASE` tries them.
    pub backstop_sessions: Vec<(String, String)>,
}

/// `listFactIdsAtTrustFloor` input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustFloorQuery {
    pub ids: Vec<i64>,
    pub floor: String,
}

/// `listReadablePageSlugs` input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadablePageSlugsQuery {
    pub source_id: String,
    pub slugs: Vec<String>,
    pub scope: ChunkReadScope,
    pub limit: u32,
}

/// The distinct non-negative ids of `ids` (a `bigint[]` id below 0 names no row).
fn distinct_ids(ids: &[i64]) -> BTreeSet<u64> {
    ids.iter()
        .filter_map(|id| u64::try_from(*id).ok())
        .collect()
}

/// The page id a `derivation_inputs` edge names, as the SQL reads it: input table `pages` and an `input_id` that
/// matches `^[0-9]{1,18}$`, cast to `bigint` (leading zeros allowed). Any other edge names no page.
fn derivation_page_id(table: &str, id: &str) -> Option<u64> {
    let digits = (1..=18).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit());
    if table != "pages" || !digits {
        return None;
    }
    id.parse().ok()
}

/// `trustRankSql`: the rank of a stored tier name, 0 for a name that is no tier. An empty name (a record written before
/// the store kept the column) is the `unknown` its Postgres row holds.
fn stored_rank(name: &str) -> u8 {
    if name.is_empty() {
        return TrustTier::Unknown.rank();
    }
    TrustTier::parse(name).map_or(0, TrustTier::rank)
}

impl Store {
    /// `listFactsFromQuotedPages`: the ids, ascending.
    pub fn list_facts_from_quoted_pages(&self, q: &QuotedFactsQuery) -> Result<Vec<u64>> {
        for t in &q.page_types {
            no_nul("listFactsFromQuotedPages", &[("pageTypes", t)])?;
        }
        let read = self.read()?;
        let typed = |source_id: &str, slug: &str| -> Result<bool> {
            Ok(read_page(&*read, source_id, slug)?
                .is_some_and(|p| q.page_types.contains(&p.page_type)))
        };
        let mut out = Vec::new();
        for id in distinct_ids(&q.ids) {
            let Some(fact) = read_fact(&*read, id)? else {
                continue;
            };
            if let Some(slug) = fact.source_markdown_slug.as_deref()
                && typed(&fact.source_id, slug)?
            {
                out.push(id);
                continue;
            }
            let mut from_input = false;
            for (table, input) in inputs_of(&*read, "facts", &id.to_string())? {
                if let Some(page_id) = derivation_page_id(&table, &input)
                    && read_page_by_id(&*read, page_id)?
                        .is_some_and(|p| q.page_types.contains(&p.page_type))
                {
                    from_input = true;
                    break;
                }
            }
            if from_input {
                out.push(id);
                continue;
            }
            let named = fact.source_session.as_deref().and_then(|session| {
                q.backstop_sessions
                    .iter()
                    .find(|(source, prefix)| {
                        *source == fact.source && session.starts_with(prefix.as_str())
                    })
                    .map(|(_, prefix)| &session[prefix.len()..])
            });
            if let Some(slug) = named
                && typed(&fact.source_id, slug)?
            {
                out.push(id);
            }
        }
        Ok(out)
    }

    /// `listFactIdsAtTrustFloor`: the ids, ascending. A floor that names no tier is refused.
    pub fn list_fact_ids_at_trust_floor(&self, q: &TrustFloorQuery) -> Result<Vec<u64>> {
        let floor = TrustTier::parse(&q.floor)
            .ok_or_else(|| {
                StoreError::invalid(format!(
                    "listFactIdsAtTrustFloor: no trust tier {:?}",
                    q.floor
                ))
            })?
            .rank();
        let read = self.read()?;
        let mut out = Vec::new();
        for id in distinct_ids(&q.ids) {
            if read_fact(&*read, id)?.is_some_and(|f| stored_rank(&f.trust_tier) >= floor) {
                out.push(id);
            }
        }
        Ok(out)
    }

    /// `readPageTypesByIds`: `[{ id, type }]`, by id.
    pub fn read_page_types_by_ids(&self, ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for id in distinct_ids(ids) {
            if let Some(page) = read_page_by_id(&*read, id)? {
                out.push(json!({ "id": page.id, "type": page.page_type }));
            }
        }
        Ok(out)
    }

    /// `listReadablePageSlugs`: the admitted slugs, in ask order, at most `limit`.
    pub fn list_readable_page_slugs(&self, q: &ReadablePageSlugsQuery) -> Result<Vec<String>> {
        no_nul("listReadablePageSlugs", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        // The SQL drops the scope's sources (`sourceId` / `sourceIds`): the page's source is `sourceId` alone.
        let scope = ChunkReadScope {
            source_id: None,
            source_ids: None,
            ..q.scope.clone()
        };
        let mut policy = PageReadPolicy::new(&*read);
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for slug in &q.slugs {
            if out.len() >= q.limit as usize {
                break;
            }
            if !seen.insert(slug.as_str()) {
                continue;
            }
            let Some(page) = read_page(&*read, &q.source_id, slug)? else {
                continue;
            };
            if policy.passes(&page, &scope)? {
                out.push(page.slug);
            }
        }
        Ok(out)
    }
}
