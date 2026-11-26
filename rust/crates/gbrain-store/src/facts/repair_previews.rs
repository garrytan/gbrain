//! The reads behind the previews of `gbrain repair consolidate-ties`, `facts-rehome`,
//! `ontology-facts` and `duplicate-facts` (`src/core/engine-sql/facts-repair.ts`):
//!
//! - `listClosedConsolidationTies(sourceIds)`: active typed facts consolidated into a take whose
//!   `valid_until` equals their `valid_from`, with the other facts of the same take that state the
//!   same metric, unit and period at that instant (`partners`, null for none);
//! - `listPagelessEntityFacts(sourceIds)`: per `(source, entity_slug)` with no live page, the ids of
//!   its database-only facts (`row_num` null, null for none) and the count of its fenced facts;
//! - `listOntologyFactCandidates(sourceIds)`: ontology rows (`dimension` set, an entity, not a
//!   conversation slot) that carry the fence step's signature (a fence row or a provenance that
//!   differs from `source`), with their withdrawn, consolidated and duplicate flags;
//! - `listDuplicateFactRows(sourceIds, excludedSources)`: active, unexpired, valid, unsuperseded
//!   facts that share a source, visibility, speaker and fingerprint with another such fact.
//!
//! Each read walks the stored facts the way the SQL's `WHERE` filters them. Rows are ordered as the
//! SQL orders them; its text columns sort in the database collation, the store sorts them by byte
//! (the same for the lowercase ids, slugs and hex fingerprints these columns hold). Timestamps that
//! the SQL renders as text are rendered as Postgres does: `valid_from::text` with the UTC time
//! zone, and the `to_char` microsecond text of `expired_at`.

use super::extractor_classify::withdrawn;
use super::{FactRecord, fact_fingerprint, source_rows};
use crate::Store;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::env::iso;
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::read_page;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The conversation-extractor source prefix the ontology rows exclude (`NOT_CONVERSATION_SLOT_SQL`).
const CONVERSATION_PREFIX: &str = "cli:extract-conversation-facts";

/// `listClosedConsolidationTies(sourceIds)`, `listPagelessEntityFacts(sourceIds)` and
/// `listOntologyFactCandidates(sourceIds)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcesArgs {
    pub source_ids: Vec<String>,
}

/// `listDuplicateFactRows(sourceIds, excludedSources)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DuplicateRowsArgs {
    pub source_ids: Vec<String>,
    pub excluded_sources: Vec<String>,
}

/// `listFactsOnValidDay(sourceId, day)`: `day` is `YYYY-MM-DD`, the UTC day of `valid_from`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidDayArgs {
    pub source_id: String,
    pub day: String,
}

/// One partition of the duplicate read: `(visibility, speaker, fingerprint)` and its rows with their `fenced` flag.
type Partitions<'a> = BTreeMap<(String, String, String), Vec<(&'a FactRecord, bool)>>;

/// The facts of each named source, sources in byte order and each source's rows in id order.
fn by_source(
    store: &Store,
    op: &str,
    source_ids: &[String],
) -> Result<Vec<(String, Vec<FactRecord>)>> {
    let texts: Vec<(&str, &str)> = source_ids
        .iter()
        .map(|s| ("sourceIds", s.as_str()))
        .collect();
    no_nul(op, &texts)?;
    let read = store.read()?;
    let mut out = Vec::new();
    for source in source_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
    {
        let mut rows = source_rows(&*read, source)?;
        rows.sort_by_key(|r| r.id);
        out.push((source.to_string(), rows));
    }
    Ok(out)
}

impl Store {
    /// `listFactsOnValidDay`: the unexpired facts of the source whose `valid_from` falls on the UTC `day`, by id.
    /// `valid_from` is `timestamptz::text` in UTC and `valid_until_day` the `to_char` UTC day of `valid_until`.
    pub fn list_facts_on_valid_day(&self, a: &ValidDayArgs) -> Result<Vec<Value>> {
        no_nul(
            "listFactsOnValidDay",
            &[("sourceId", &a.source_id), ("day", &a.day)],
        )?;
        let mut rows: Vec<FactRecord> = source_rows(&*self.read()?, &a.source_id)?
            .into_iter()
            .filter(|f| f.expired_at_us.is_none() && iso(f.valid_from_us)[..10] == a.day)
            .collect();
        rows.sort_by_key(|f| f.id);
        Ok(rows
            .iter()
            .map(|f| {
                json!({
                    "id": f.id, "entity_slug": f.entity_slug, "fact": f.fact, "row_num": f.row_num,
                    "source_markdown_slug": f.source_markdown_slug,
                    "valid_from": timestamptz_text(f.valid_from_us),
                    "valid_until_day": f.valid_until_us.map(|u| iso(u)[..10].to_string()),
                })
            })
            .collect())
    }

    /// `listClosedConsolidationTies`: by (source, id).
    pub fn list_closed_consolidation_ties(&self, a: &SourcesArgs) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        for (source, rows) in by_source(self, "listClosedConsolidationTies", &a.source_ids)? {
            for f in &rows {
                let (Some(metric), Some(take), Some(entity), Some(until)) = (
                    &f.claim_metric,
                    f.consolidated_into,
                    &f.entity_slug,
                    f.valid_until_us,
                ) else {
                    continue;
                };
                if f.expired_at_us.is_some() || until != f.valid_from_us {
                    continue;
                }
                let partners: Vec<u64> = rows
                    .iter()
                    .filter(|g| {
                        g.id != f.id
                            && g.consolidated_into == Some(take)
                            && g.claim_metric.as_ref() == Some(metric)
                            && g.claim_unit == f.claim_unit
                            && g.claim_period == f.claim_period
                            && g.valid_from_us == f.valid_from_us
                    })
                    .map(|g| g.id)
                    .collect();
                out.push(json!({
                    "source_id": source, "id": f.id, "entity_slug": entity, "take_id": take,
                    "valid_from": timestamptz_text(f.valid_from_us),
                    "partners": if partners.is_empty() { Value::Null } else { json!(partners) },
                }));
            }
        }
        Ok(out)
    }

    /// `listPagelessEntityFacts`: by (source, entity slug).
    pub fn list_pageless_entity_facts(&self, a: &SourcesArgs) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let sources = by_source(self, "listPagelessEntityFacts", &a.source_ids)?;
        let read = self.read()?;
        for (source, rows) in sources {
            // (database-only ids, fenced count) per entity slug, in byte order of the slug.
            let mut groups: BTreeMap<&str, (Vec<u64>, u64)> = BTreeMap::new();
            for f in &rows {
                let Some(entity) = &f.entity_slug else {
                    continue;
                };
                let group = groups.entry(entity.as_str()).or_default();
                if f.row_num.is_none() {
                    group.0.push(f.id);
                } else {
                    group.1 += 1;
                }
            }
            for (slug, (ids, fenced)) in groups {
                let live =
                    read_page(&*read, &source, slug)?.is_some_and(|p| p.deleted_at_us.is_none());
                if live {
                    continue;
                }
                out.push(json!({
                    "source_id": source, "slug": slug, "fenced": fenced,
                    "ids": if ids.is_empty() { Value::Null } else { json!(ids) },
                }));
            }
        }
        Ok(out)
    }

    /// `listOntologyFactCandidates`: by id across the sources (the SQL's `ORDER BY f.id`).
    pub fn list_ontology_fact_candidates(&self, a: &SourcesArgs) -> Result<Vec<Value>> {
        let sources = by_source(self, "listOntologyFactCandidates", &a.source_ids)?;
        let read = self.read()?;
        let mut out: Vec<(u64, Value)> = Vec::new();
        for (_, rows) in &sources {
            for f in rows {
                let (Some(dimension), Some(entity)) = (&f.dimension, &f.entity_slug) else {
                    continue;
                };
                let moved = f.row_num.is_some()
                    || f.source_markdown_slug.as_deref() != Some(f.source.as_str());
                if !moved || f.source.starts_with(CONVERSATION_PREFIX) {
                    continue;
                }
                let duplicate = rows.iter().any(|d| {
                    d.id != f.id
                        && d.entity_slug.as_ref() == Some(entity)
                        && d.dimension.as_ref() == Some(dimension)
                        && d.value_hash.is_some()
                        && d.value_hash == f.value_hash
                        && d.source_markdown_slug.as_deref() == Some(f.source.as_str())
                        && d.valid_from_us == f.valid_from_us
                });
                out.push((
                    f.id,
                    json!({
                        "id": f.id, "source_id": f.source_id, "entity_slug": entity,
                        "dimension": dimension, "source": f.source,
                        "page": f.source_markdown_slug, "row_num": f.row_num,
                        "expired_at": f.expired_at_us.map(iso),
                        "withdrawn": withdrawn(&*read, f)?,
                        "consolidated": f.consolidated_into.is_some(),
                        "duplicate": duplicate,
                    }),
                ));
            }
        }
        out.sort_by_key(|(id, _)| *id);
        Ok(out.into_iter().map(|(_, row)| row).collect())
    }

    /// `listDuplicateFactRows`: by (source, visibility, fingerprint, speaker, fenced first,
    /// `created_at`, id).
    pub fn list_duplicate_fact_rows(&self, a: &DuplicateRowsArgs) -> Result<Vec<Value>> {
        let now = self.env.now_micros();
        let mut out = Vec::new();
        for (_, rows) in by_source(self, "listDuplicateFactRows", &a.source_ids)? {
            // The partition (visibility, speaker, fingerprint) of each candidate row.
            let mut groups: Partitions = BTreeMap::new();
            for f in &rows {
                if f.expired_at_us.is_some()
                    || f.valid_until_us.is_some_and(|u| u <= now)
                    || f.superseded_by.is_some()
                    || a.excluded_sources.contains(&f.source)
                {
                    continue;
                }
                let fenced = f.row_num.is_some()
                    && f.source_markdown_slug.is_some()
                    && !f.source.starts_with("cli:");
                let key = (
                    f.visibility.clone(),
                    f.attributed_to.clone().unwrap_or_default(),
                    fact_fingerprint(&f.fact),
                );
                groups.entry(key).or_default().push((f, fenced));
            }
            // The SQL orders by visibility, fingerprint, then speaker.
            let mut keys: Vec<_> = groups.keys().cloned().collect();
            keys.sort_by(|x, y| (&x.0, &x.2, &x.1).cmp(&(&y.0, &y.2, &y.1)));
            for key in keys {
                let mut members = groups.remove(&key).unwrap_or_default();
                if members.len() < 2 {
                    continue;
                }
                members.sort_by_key(|(f, fenced)| (!*fenced, f.created_at_us, f.id));
                for (f, fenced) in members {
                    out.push(json!({
                        "id": f.id, "source_id": f.source_id, "visibility": f.visibility,
                        "fp": key.2, "fact": f.fact, "entity_slug": f.entity_slug,
                        "fenced": fenced, "row_num": f.row_num,
                        "source_markdown_slug": f.source_markdown_slug, "speaker": key.1,
                    }));
                }
            }
        }
        Ok(out)
    }
}
