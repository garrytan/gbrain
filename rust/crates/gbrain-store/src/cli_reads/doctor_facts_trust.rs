//! Doctor facts, fence and trust reads served from the store (SQL in `src/core/engine-sql/doctor-facts-trust.ts`,
//! docs in `rust/docs/store/cli-reads-doctor-facts-trust.md`). Each read takes one snapshot.
//!
//! Text rules (rust/docs/store/cli-reads-ops.md, "Text semantics"): `LIKE` is the store's own (`facts.rs`, `\` escape),
//! and every order is bytewise, as PGLite's C.UTF-8 collation orders.

use crate::Store;
use crate::error::{Result, StoreError};
use crate::facts::like;
use crate::facts::trust_reads::all_fact_rows;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{all_pages, read_page_by_id};
use crate::takes::all_takes;
use crate::timeline::TimelineRecord;
use crate::trust::TrustTier;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The arguments of `countConversationPipelinePages(types, slugPatterns)`.
#[derive(Debug, Clone, Deserialize)]
pub struct ConversationPipelineSpec {
    pub types: Vec<String>,
    pub slug_patterns: Vec<String>,
}

impl Store {
    /// `countConversationPipelinePages`: live pages of one of `types` whose slug matches none of the `LIKE` patterns.
    pub fn count_conversation_pipeline_pages(
        &self,
        spec: &ConversationPipelineSpec,
    ) -> Result<u64> {
        let read = self.read()?;
        let mut n = 0;
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || !spec.types.contains(&page.page_type) {
                continue;
            }
            let mut rescued = false;
            for pattern in &spec.slug_patterns {
                rescued |= like(&page.slug, pattern, false)?;
            }
            n += u64::from(!rescued);
        }
        Ok(n)
    }
}

/// One row of a table with a stamped trust tier, as the doctor's counts read it.
struct TrustedRow {
    /// The page's source for a take or timeline entry (the SQL joins `pages`), the row's own otherwise.
    source_id: String,
    id: u64,
    tier: TrustTier,
    origin: Option<Value>,
    /// A page is live when it is not soft-deleted; the other tables have no such state.
    live: bool,
}

/// The tables whose trust columns the doctor reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrustedTable {
    Pages,
    Facts,
    Takes,
    Timeline,
}

fn trusted_table(op: &str, name: &str) -> Result<TrustedTable> {
    match name {
        "pages" => Ok(TrustedTable::Pages),
        "facts" => Ok(TrustedTable::Facts),
        "takes" => Ok(TrustedTable::Takes),
        "timeline_entries" => Ok(TrustedTable::Timeline),
        other => Err(StoreError::invalid(format!(
            "{op}: no trust columns on \"{other}\""
        ))),
    }
}

pub(crate) fn timeline_entries(read: &dyn KvRead) -> Result<Vec<TimelineRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::TIMELINE], false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(entry) => out.push(entry),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// The rows of `table` with their stored tier and origin, by id. A take or timeline entry whose page is
/// gone has no row (the SQL joins `pages` for the source).
fn trusted_rows(read: &dyn KvRead, table: TrustedTable) -> Result<Vec<TrustedRow>> {
    let mut out = Vec::new();
    match table {
        TrustedTable::Pages => {
            for page in all_pages(read)? {
                out.push(TrustedRow {
                    source_id: page.source_id.clone(),
                    id: page.id,
                    tier: TrustTier::stored(page.trust_tier.as_deref()),
                    origin: page.write_origin.clone(),
                    live: page.deleted_at_us.is_none(),
                });
            }
        }
        TrustedTable::Facts => {
            for fact in all_fact_rows(read)? {
                out.push(TrustedRow {
                    source_id: fact.source_id.clone(),
                    id: fact.id,
                    tier: fact.tier(),
                    origin: fact.write_origin.clone(),
                    live: true,
                });
            }
        }
        TrustedTable::Takes => {
            for take in all_takes(read)? {
                let Some(page) = read_page_by_id(read, take.page_id)? else {
                    continue;
                };
                out.push(TrustedRow {
                    source_id: page.source_id,
                    id: take.id,
                    tier: take.trust.tier(),
                    origin: take.trust.write_origin.clone(),
                    live: true,
                });
            }
        }
        TrustedTable::Timeline => {
            for entry in timeline_entries(read)? {
                let Some(page) = read_page_by_id(read, entry.page_id)? else {
                    continue;
                };
                out.push(TrustedRow {
                    source_id: page.source_id,
                    id: entry.id,
                    tier: entry.trust.tier(),
                    origin: entry.trust.write_origin.clone(),
                    live: true,
                });
            }
        }
    }
    out.sort_by_key(|r| r.id);
    Ok(out)
}

/// `write_origin->>'channel' = 'trust_claim'`: a row a source claim lifted.
fn origin_is_trust_claim(origin: &Option<Value>) -> bool {
    matches!(origin, Some(Value::Object(map)) if map.get("channel").and_then(Value::as_str) == Some("trust_claim"))
}

/// `countRowTrustTiers`, `countClaimLiftedRows`: the table to read.
#[derive(Debug, Clone, Deserialize)]
pub struct TrustTableSpec {
    pub table: String,
}

/// The legacy ceilings: each table's greatest id when the trust migrations ran.
#[derive(Debug, Clone, Deserialize)]
pub struct LegacyCeilings {
    pub pages: i64,
    pub facts: i64,
    pub takes: i64,
    pub timeline_entries: i64,
}

/// `countLegacyUnknownBySource({ceilings, sourceIds})`: no ceilings means every row is legacy.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyUnknownSpec {
    pub ceilings: Option<LegacyCeilings>,
    pub source_ids: Option<Vec<String>>,
}

impl Store {
    /// `countRowTrustTiers(table)`: rows of facts, takes or timeline entries per stored tier. Rows: `{tier, n}`.
    pub fn count_row_trust_tiers(&self, spec: &TrustTableSpec) -> Result<Vec<Value>> {
        let table = trusted_table("countRowTrustTiers", &spec.table)?;
        let read = self.read()?;
        let mut per_tier: BTreeMap<&'static str, u64> = BTreeMap::new();
        for row in trusted_rows(&*read, table)? {
            *per_tier.entry(row.tier.as_str()).or_default() += 1;
        }
        Ok(per_tier
            .into_iter()
            .map(|(tier, n)| json!({ "tier": tier, "n": n }))
            .collect())
    }

    /// `countClaimLiftedRows(table)`: the rows of pages, facts, takes or timeline entries a source claim lifted
    /// (`write_origin.channel` `trust_claim`). One number.
    pub fn count_claim_lifted_rows(&self, spec: &TrustTableSpec) -> Result<Value> {
        let table = trusted_table("countClaimLiftedRows", &spec.table)?;
        let read = self.read()?;
        let n = trusted_rows(&*read, table)?
            .iter()
            .filter(|row| origin_is_trust_claim(&row.origin))
            .count();
        Ok(json!(n))
    }

    /// `countLegacyUnknownBySource(spec)`: per source, the rows still at `unknown` that were there when the trust
    /// migrations ran (id at or below the table's ceiling, every id when there is none), across live pages, facts,
    /// takes and timeline entries; only `sourceIds` when given. Rows: `{source_id, n}` by source.
    pub fn count_legacy_unknown_by_source(&self, spec: &LegacyUnknownSpec) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut per_source: BTreeMap<String, u64> = BTreeMap::new();
        let tables = [
            (TrustedTable::Pages, spec.ceilings.as_ref().map(|c| c.pages)),
            (TrustedTable::Facts, spec.ceilings.as_ref().map(|c| c.facts)),
            (TrustedTable::Takes, spec.ceilings.as_ref().map(|c| c.takes)),
            (
                TrustedTable::Timeline,
                spec.ceilings.as_ref().map(|c| c.timeline_entries),
            ),
        ];
        for (table, ceiling) in tables {
            for row in trusted_rows(&*read, table)? {
                let in_scope = spec
                    .source_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&row.source_id));
                let legacy = ceiling.is_none_or(|c| i128::from(row.id) <= i128::from(c));
                if row.live && row.tier == TrustTier::Unknown && in_scope && legacy {
                    *per_source.entry(row.source_id).or_default() += 1;
                }
            }
        }
        Ok(per_source
            .into_iter()
            .map(|(source_id, n)| json!({ "source_id": source_id, "n": n }))
            .collect())
    }
}
