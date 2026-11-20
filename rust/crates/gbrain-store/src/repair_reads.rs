//! The scans of `gbrain repair` that callers ran through `executeRaw` and that order by byte
//! (`src/core/engine-sql/collate-repair-reads.ts`).
//!
//! Members: countOrphanedAliasRows, listOrphanedAliasTargets, countSoftDeletedAliasTargets,
//! listDuplicateFactRows, listPagelessEntityFacts, listSourceIncarnations,
//! listClosedConsolidationTies.
//!
//! Keys: none. The alias scans read the alias rows (`aliases::alias_target_rows`) and look each
//! row's page up by `(source, slug)`; the fact scans read a source's fact rows
//! (`facts::source_rows`). Text sorts in byte order, as `COLLATE "C"` does and a Rust `String`
//! does.

use crate::Store;
use crate::aliases::alias_target_rows;
use crate::error::Result;
use crate::facts::{FactRecord, fact_fingerprint, source_rows};
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::sources::read_source;
use crate::telemetry::pg_timestamptz_text;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// What a page lookup says about an alias row's target.
#[derive(Clone, Copy, PartialEq)]
enum Target {
    Missing,
    SoftDeleted,
    Live,
}

fn target(read: &dyn KvRead, source: &str, slug: &str) -> Result<Target> {
    Ok(match read_page(read, source, slug)? {
        None => Target::Missing,
        Some(page) if page.deleted_at_us.is_some() => Target::SoftDeleted,
        Some(_) => Target::Live,
    })
}

/// The distinct ids, each checked for a NUL byte.
fn source_set(member: &str, ids: &[String]) -> Result<BTreeSet<String>> {
    no_nul(
        member,
        &ids.iter()
            .map(|id| ("sourceIds", id.as_str()))
            .collect::<Vec<_>>(),
    )?;
    Ok(ids.iter().cloned().collect())
}

/// The ids of a fact list as the JSON array `array_agg` gives, or null when it is empty.
fn id_list(ids: &[u64]) -> Value {
    if ids.is_empty() {
        Value::Null
    } else {
        json!(ids)
    }
}

impl Store {
    /// `countOrphanedAliasRows()`: per source, how many `slug_aliases` and `page_aliases` rows
    /// name a page row that is absent, in source byte order. A source with none is left out.
    pub fn count_orphaned_alias_rows(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let (redirects, pages) = alias_target_rows(&*read)?;
        let mut counts: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        for (source, slug) in redirects {
            if target(&*read, &source, &slug)? == Target::Missing {
                counts.entry(source).or_default().0 += 1;
            }
        }
        for (source, slug) in pages {
            if target(&*read, &source, &slug)? == Target::Missing {
                counts.entry(source).or_default().1 += 1;
            }
        }
        Ok(counts
            .into_iter()
            .map(|(source_id, (r, p))| json!({ "source_id": source_id, "slug_redirects": r, "page_aliases": p }))
            .collect())
    }

    /// `listOrphanedAliasTargets(sourceIds)`: per `(source, slug)` of these sources, how many alias
    /// rows name that page while it is absent, by source then slug in byte order.
    pub fn list_orphaned_alias_targets(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let sources = source_set("listOrphanedAliasTargets", source_ids)?;
        let read = self.read()?;
        let (redirects, pages) = alias_target_rows(&*read)?;
        let mut counts: BTreeMap<(String, String), (u64, u64)> = BTreeMap::new();
        for (source, slug) in pages.into_iter().filter(|(s, _)| sources.contains(s)) {
            if target(&*read, &source, &slug)? == Target::Missing {
                counts.entry((source, slug)).or_default().0 += 1;
            }
        }
        for (source, slug) in redirects.into_iter().filter(|(s, _)| sources.contains(s)) {
            if target(&*read, &source, &slug)? == Target::Missing {
                counts.entry((source, slug)).or_default().1 += 1;
            }
        }
        Ok(counts
            .into_iter()
            .map(|((source_id, slug), (p, r))| {
                json!({ "source_id": source_id, "slug": slug, "page_aliases": p, "slug_redirects": r })
            })
            .collect())
    }

    /// `countSoftDeletedAliasTargets(sourceIds)`: how many alias rows of these sources name a
    /// soft-deleted page.
    pub fn count_soft_deleted_alias_targets(&self, source_ids: &[String]) -> Result<u64> {
        let sources = source_set("countSoftDeletedAliasTargets", source_ids)?;
        let read = self.read()?;
        let (redirects, pages) = alias_target_rows(&*read)?;
        let mut n = 0;
        for (source, slug) in redirects
            .iter()
            .chain(&pages)
            .filter(|(s, _)| sources.contains(s))
        {
            n += u64::from(target(&*read, source, slug)? == Target::SoftDeleted);
        }
        Ok(n)
    }

    /// `listDuplicateFactRows(sourceIds, auditSources)`: the active facts of these sources that
    /// share a source, visibility, speaker and fingerprint with another, ordered by source,
    /// visibility, fingerprint and speaker in byte order, fenced copies first, then oldest first.
    pub fn list_duplicate_fact_rows(
        &self,
        source_ids: &[String],
        audit_sources: &[String],
    ) -> Result<Vec<Value>> {
        let sources = source_set("listDuplicateFactRows", source_ids)?;
        let now = self.env.now_micros();
        let read = self.read()?;
        type Group = (String, String, String, String);
        let mut groups: BTreeMap<Group, Vec<(bool, i64, u64, FactRecord)>> = BTreeMap::new();
        for source in &sources {
            for fact in source_rows(&*read, source)? {
                let active = fact.expired_at_us.is_none()
                    && fact.valid_until_us.is_none_or(|until| until > now)
                    && fact.superseded_by.is_none()
                    && !audit_sources.contains(&fact.source);
                if !active {
                    continue;
                }
                let fenced = fact.row_num.is_some()
                    && fact.source_markdown_slug.is_some()
                    && !fact.source.starts_with("cli:");
                let key = (
                    fact.source_id.clone(),
                    fact.visibility.clone(),
                    fact_fingerprint(&fact.fact),
                    fact.attributed_to.clone().unwrap_or_default(),
                );
                groups
                    .entry(key)
                    .or_default()
                    .push((fenced, fact.created_at_us, fact.id, fact));
            }
        }
        let mut out = Vec::new();
        for ((source_id, visibility, fp, speaker), mut rows) in groups {
            if rows.len() < 2 {
                continue;
            }
            rows.sort_by_key(|(fenced, created, id, _)| (!*fenced, *created, *id));
            for (fenced, _, id, fact) in rows {
                out.push(json!({
                    "id": id, "source_id": source_id, "visibility": visibility, "fp": fp,
                    "fact": fact.fact, "entity_slug": fact.entity_slug, "row_num": fact.row_num,
                    "source_markdown_slug": fact.source_markdown_slug, "fenced": fenced,
                    "speaker": speaker,
                }));
            }
        }
        Ok(out)
    }

    /// `listPagelessEntityFacts(sourceIds)`: per `(source, entity_slug)` of these sources with no
    /// live page at the slug, the ids of its database-only facts (no fence row) in id order, or
    /// null when it has none, and how many facts are a page's fence rows; by source then slug in
    /// byte order.
    pub fn list_pageless_entity_facts(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let sources = source_set("listPagelessEntityFacts", source_ids)?;
        let read = self.read()?;
        let mut entities: BTreeMap<(String, String), (Vec<u64>, u64)> = BTreeMap::new();
        for source in &sources {
            for fact in source_rows(&*read, source)? {
                let Some(slug) = fact.entity_slug.as_deref() else {
                    continue;
                };
                let entry = entities.entry((source.clone(), slug.to_string()));
                let (ids, fenced) = entry.or_default();
                match fact.row_num {
                    None => ids.push(fact.id),
                    Some(_) => *fenced += 1,
                }
            }
        }
        let mut out = Vec::new();
        for ((source_id, slug), (mut ids, fenced)) in entities {
            if target(&*read, &source_id, &slug)? == Target::Live {
                continue;
            }
            ids.sort_unstable();
            out.push(json!({
                "source_id": source_id, "slug": slug, "ids": id_list(&ids), "fenced": fenced,
            }));
        }
        Ok(out)
    }

    /// `listSourceIncarnations(sourceIds)`: the id and incarnation of each named source that
    /// exists, in id byte order.
    pub fn list_source_incarnations(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let sources = source_set("listSourceIncarnations", source_ids)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for id in sources {
            if let Some(source) = read_source(&*read, &id)? {
                out.push(json!({ "id": source.id, "incarnation": source.incarnation }));
            }
        }
        Ok(out)
    }

    /// `listClosedConsolidationTies(sourceIds)`: the unexpired facts consolidated into a take
    /// whose `valid_until` is their `valid_from` and that carry a claim metric and an entity, with
    /// the other facts consolidated into the same take that state the same claim at the same
    /// instant (null when there is none); by source in byte order, then id.
    pub fn list_closed_consolidation_ties(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let sources = source_set("listClosedConsolidationTies", source_ids)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for source in &sources {
            let mut rows = source_rows(&*read, source)?;
            rows.sort_by_key(|f| f.id);
            for f in &rows {
                let (Some(metric), Some(take), Some(entity)) =
                    (&f.claim_metric, f.consolidated_into, &f.entity_slug)
                else {
                    continue;
                };
                if f.expired_at_us.is_some() || f.valid_until_us != Some(f.valid_from_us) {
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
                    "valid_from": pg_timestamptz_text(f.valid_from_us),
                    "partners": id_list(&partners),
                }));
            }
        }
        Ok(out)
    }
}
