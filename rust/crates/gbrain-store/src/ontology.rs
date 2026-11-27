//! Ontology dimensions over facts (BrainEngine mergeOntologyFact, getOntology,
//! discoverOntologyDimensions, findOntologyConflicts, listOntologyStreamSlugs, readOntologyRival).
//!
//! The ontology owns no records of its own: an observation is a `facts` row whose `dimension`,
//! `value`, `value_hash` and `dim_status` columns are set, written and read through the facts
//! family's row writer and indexes (rust/docs/store/facts.md). The stint key
//! `idx_facts_ontology_stint_dedup` is the facts `F 0x07` entry. No key starts with
//! `keys::ONTOLOGY` (`N`).
//!
//! Each member follows PGLite (src/core/pglite-engine.ts) statement by statement. The
//! TypeScript member (src/core/rust-engine/store-members/ontology.ts) normalises the dimension,
//! computes the value hash, the default status and the fact text, and turns each time into ISO
//! text. The layout and the known divergences are in rust/docs/store/ontology.md.

use crate::Store;
use crate::env::{iso, parse_iso};
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::facts::{
    COUNTER, FactRecord, OwnerOnlyCache, PrivacyPolicy, check_row, entity_rows,
    hidden_by_deleted_page, hidden_by_policy, real, require_fact_source, source_rows, stint_holder,
    write_fact,
};
use crate::kv::{KvRead, KvWrite};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::sources::all_sources;
use crate::trust::{TrustTier, WriteTrust};
use serde::Deserialize;
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

const ACTIVE: &str = "active";
const DIARY_PREFIX: &str = "life/diary/";

/// One `OntologyObservationInput` as the TypeScript member resolves it: every default applied,
/// `dimension` normalised, `value_hash` and `fact` computed, times as ISO text.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct OntologyObservation {
    pub source_id: String,
    pub entity_slug: String,
    pub dimension: String,
    pub value: String,
    pub value_hash: String,
    pub fact: String,
    pub confidence: f64,
    pub status: String,
    pub visibility: String,
    pub source: String,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
}

/// The scope and filters of the three ontology reads. `source_ids` `None` reads every source.
/// `visibility` `None` reads every tier; an empty list reads none (`visibility = ANY('{}')`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct OntologyQuery {
    pub source_ids: Option<Vec<String>>,
    pub entity_slug: String,
    pub asof: Option<String>,
    pub min_confidence: f64,
    pub include_quarantined: bool,
    pub visibility: Option<Vec<String>>,
    pub exclude_diary: bool,
    /// `excludePrivate`: `privateFactFilterForReader('facts')`, which is the facts policy
    /// (`facts/privacy.rs`) for the callers the TypeScript member serves.
    pub exclude_private: Option<PrivacyPolicy>,
}

fn invalid(message: String) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, message)
}

fn time_arg(op: &str, what: &str, text: &Option<String>) -> Result<Option<i64>> {
    text.as_deref()
        .map(|t| {
            parse_iso(t).ok_or_else(|| invalid(format!("{op}: {what} is not an ISO time: \"{t}\"")))
        })
        .transpose()
}

/// `dim_status IS NULL OR dim_status = 'active'`.
fn status_active(r: &FactRecord) -> bool {
    r.dim_status.as_deref().is_none_or(|s| s == ACTIVE)
}

/// `ORDER BY valid_from DESC NULLS LAST, confidence DESC, id DESC`: `Greater` sorts first.
fn newest(a: &FactRecord, b: &FactRecord) -> Ordering {
    a.valid_from_us
        .cmp(&b.valid_from_us)
        .then(a.confidence.total_cmp(&b.confidence))
        .then(a.id.cmp(&b.id))
}

impl OntologyQuery {
    fn check(&self, op: &str) -> Result<()> {
        no_nul(op, &[("entitySlug", &self.entity_slug)])?;
        for id in self.source_ids.iter().flatten() {
            no_nul(op, &[("sourceIds", id)])?;
        }
        for v in self.visibility.iter().flatten() {
            no_nul(op, &[("visibility", v)])?;
        }
        Ok(())
    }

    /// The sources the read spans, each once.
    fn sources(&self, read: &dyn KvRead) -> Result<BTreeSet<String>> {
        Ok(match &self.source_ids {
            Some(ids) => ids.iter().cloned().collect(),
            None => all_sources(read)?.into_iter().map(|s| s.id).collect(),
        })
    }

    /// Every row of the scope (of `entity_slug` when `by_entity`), in id order.
    fn rows(&self, read: &dyn KvRead, by_entity: bool) -> Result<Vec<FactRecord>> {
        let mut out = Vec::new();
        for source in self.sources(read)? {
            out.extend(if by_entity {
                entity_rows(read, &source, &self.entity_slug)?
            } else {
                source_rows(read, &source)?
            });
        }
        out.sort_by_key(|r| r.id);
        Ok(out)
    }

    /// The page gates and filters getOntology and findOntologyConflicts share: a soft-deleted
    /// provenance or entity page, the private-provenance policy under `exclude_private`, a
    /// `life/diary/` provenance under `exclude_diary`, the visibility list and the confidence
    /// floor.
    fn admits(
        &self,
        read: &dyn KvRead,
        r: &FactRecord,
        owner_only: &mut OwnerOnlyCache,
    ) -> Result<bool> {
        // SQL binds the floor as the column's REAL type, so compare at f32: a stored 0.7 is
        // 0.699999988 and still meets a floor of 0.7.
        #[allow(clippy::cast_possible_truncation)]
        let floor = self.min_confidence as f32;
        if r.confidence < floor || floor.is_nan() {
            return Ok(false);
        }
        if self
            .visibility
            .as_ref()
            .is_some_and(|list| !list.contains(&r.visibility))
        {
            return Ok(false);
        }
        if self.exclude_diary
            && r.source_markdown_slug
                .as_deref()
                .unwrap_or("")
                .starts_with(DIARY_PREFIX)
        {
            return Ok(false);
        }
        Ok(!hidden_by_deleted_page(read, r)?
            && !hidden_by_policy(read, r, &self.exclude_private, owner_only)?)
    }
}

/// An ontology slot row: `dimension IS NOT NULL AND expired_at IS NULL` and not a conversation fact.
fn slot_row(r: &FactRecord) -> bool {
    r.dimension.is_some() && r.expired_at_us.is_none() && !r.conversation_slot()
}

/// `count(DISTINCT x)`: the distinct non-null values.
fn distinct<'a>(values: impl Iterator<Item = Option<&'a String>>) -> usize {
    values.flatten().collect::<BTreeSet<_>>().len()
}

impl Store {
    /// `mergeOntologyFact(obs)`: `{ action, factId, supersededId }`.
    ///
    /// The current value is the newest open, active, non-conversation row of the entity's
    /// dimension. A same-value observation that is not backdated corroborates it: a provenance
    /// that already observed it in the current stint is a `noop`; else a row is stored expired now
    /// and consolidated into the current one. Any other observation is stored live, and an active
    /// one dated on or after the current value closes it (`superseded_prior`). An observation whose
    /// stint key a row holds is a `noop`; a conversation fact holding the key first gives up its slot.
    pub fn merge_ontology_fact(&self, obs: &OntologyObservation) -> Result<Value> {
        const OP: &str = "mergeOntologyFact";
        no_nul(
            OP,
            &[
                ("sourceId", &obs.source_id),
                ("entitySlug", &obs.entity_slug),
                ("dimension", &obs.dimension),
                ("value", &obs.value),
                ("source", &obs.source),
                ("status", &obs.status),
                ("visibility", &obs.visibility),
            ],
        )?;
        let valid_from = time_arg(OP, "validFrom", &obs.valid_from)?;
        let valid_until = time_arg(OP, "validTo", &obs.valid_to)?;
        let now = self.env.now_micros();
        let noop = json!({ "action": "noop", "factId": null, "supersededId": null });
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let rows = entity_rows(tx, &obs.source_id, &obs.entity_slug)?;
            let same_dimension = |r: &&FactRecord| r.dimension.as_deref() == Some(&obs.dimension);
            let current = rows
                .iter()
                .filter(same_dimension)
                .filter(|r| {
                    r.expired_at_us.is_none()
                        && r.valid_until_us.is_none()
                        && status_active(r)
                        && !r.conversation_slot()
                })
                .max_by(|a, b| newest(a, b))
                .cloned();
            let mut row = FactRecord {
                source_id: obs.source_id.clone(),
                entity_slug: Some(obs.entity_slug.clone()),
                fact: obs.fact.clone(),
                kind: "fact".into(),
                visibility: obs.visibility.clone(),
                notability: "medium".into(),
                valid_from_us: valid_from.unwrap_or(now),
                valid_until_us: valid_until,
                source: obs.source.clone(),
                confidence: real_arg(OP, obs.confidence)?,
                created_at_us: now,
                source_markdown_slug: Some(obs.source.clone()),
                dimension: Some(obs.dimension.clone()),
                value: Some(obs.value.clone()),
                value_hash: Some(obs.value_hash.clone()),
                dim_status: Some(obs.status.clone()),
                ..FactRecord::default()
            };
            if let Some(cur) = &current
                && cur.value_hash.as_deref() == Some(&obs.value_hash)
                && valid_from.is_none_or(|from| from >= cur.valid_from_us)
            {
                let seen = rows.iter().filter(same_dimension).any(|r| {
                    r.value_hash.as_deref() == Some(&obs.value_hash)
                        && r.source_markdown_slug.as_deref() == Some(&obs.source)
                        && !r.conversation_slot()
                        && r.valid_from_us >= cur.valid_from_us
                });
                if seen {
                    return Ok(noop.clone());
                }
                free_key(tx, trust, obs, valid_from)?;
                row.expired_at_us = Some(now);
                row.consolidated_into = Some(cur.id as i64);
                return Ok(match insert(tx, trust, &mut row)? {
                    true => {
                        json!({ "action": "corroborated", "factId": row.id, "supersededId": null })
                    }
                    false => noop.clone(),
                });
            }
            free_key(tx, trust, obs, valid_from)?;
            if !insert(tx, trust, &mut row)? {
                return Ok(noop.clone());
            }
            let mut superseded = None;
            if let Some(cur) = &current
                && obs.status == ACTIVE
                && valid_from.is_none_or(|from| from >= cur.valid_from_us)
                && let Some(old) = crate::facts::read_fact(tx, cur.id)?
                && old.valid_until_us.is_none()
                // ONTOLOGY_SUPERSEDE_GUARD: a writer closes only a row no more trusted than it
                // (an undeclared writer ranks as `unknown`).
                && old.tier().rank() <= trust.writer.unwrap_or(TrustTier::Unknown).rank()
            {
                let mut new = old.clone();
                new.valid_until_us = Some(valid_from.unwrap_or(now));
                new.superseded_by = Some(row.id);
                write_fact(tx, trust, Some(&old), &new)?;
                superseded = Some(cur.id);
            }
            Ok(json!({
                "action": if superseded.is_some() { "superseded_prior" } else { "inserted" },
                "factId": row.id,
                "supersededId": superseded,
            }))
        })
    }

    /// `listOntologyStreamSlugs(sourceId, entitySlug, dimension)`: the distinct non-null
    /// `source_markdown_slug` of every open (unexpired, unclosed) non-conversation row of the
    /// entity's dimension, in byte order. `dimension` is already normalised.
    pub fn list_ontology_stream_slugs(
        &self,
        source_id: &str,
        entity_slug: &str,
        dimension: &str,
    ) -> Result<Vec<String>> {
        const OP: &str = "listOntologyStreamSlugs";
        no_nul(
            OP,
            &[
                ("sourceId", source_id),
                ("entitySlug", entity_slug),
                ("dimension", dimension),
            ],
        )?;
        let read = self.read()?;
        Ok(entity_rows(&*read, source_id, entity_slug)?
            .into_iter()
            .filter(|r| {
                r.dimension.as_deref() == Some(dimension)
                    && r.expired_at_us.is_none()
                    && r.valid_until_us.is_none()
                    && !r.conversation_slot()
            })
            .filter_map(|r| r.source_markdown_slug)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect())
    }

    /// `listBeliefStreamSlugs(table, ids)`: the ledger stream slug of each listed row found, by
    /// id, once each: a fact's `source_markdown_slug` else its `entity_slug`, a take's page slug, a
    /// page's own slug (deleted pages included); null where a fact has neither. `table` is
    /// `facts`, `takes` or `pages`; the caller filters, removes repeats and sorts.
    pub fn list_belief_stream_slugs(&self, table: &str, ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let wanted: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for id in wanted {
            let slug = match table {
                "facts" => match crate::facts::read_fact(&*read, id)? {
                    Some(fact) => Some(fact.source_markdown_slug.or(fact.entity_slug)),
                    None => None,
                },
                "takes" => match crate::takes::read_take(&*read, id)? {
                    Some(take) => {
                        crate::pages::read_page_by_id(&*read, take.page_id)?.map(|p| Some(p.slug))
                    }
                    None => None,
                },
                "pages" => crate::pages::read_page_by_id(&*read, id)?.map(|p| Some(p.slug)),
                other => {
                    return Err(StoreError::invalid(format!(
                        "listBeliefStreamSlugs: the stream slugs of facts, takes and pages, not \"{other}\""
                    )));
                }
            };
            if let Some(slug) = slug {
                out.push(json!(slug));
            }
        }
        Ok(out)
    }

    /// `readOntologyRival(sourceId, entitySlug, dimension, excludeId)`: `{ id, trust_tier }` of
    /// the newest open, active, non-conversation row of the entity's dimension other than
    /// `excludeId` (the stint mergeOntologyFact left open), or null. `dimension` is already
    /// normalised.
    pub fn read_ontology_rival(
        &self,
        source_id: &str,
        entity_slug: &str,
        dimension: &str,
        exclude_id: i64,
    ) -> Result<Value> {
        const OP: &str = "readOntologyRival";
        no_nul(
            OP,
            &[
                ("sourceId", source_id),
                ("entitySlug", entity_slug),
                ("dimension", dimension),
            ],
        )?;
        let read = self.read()?;
        let rival = entity_rows(&*read, source_id, entity_slug)?
            .into_iter()
            .filter(|r| {
                r.dimension.as_deref() == Some(dimension)
                    && r.id as i64 != exclude_id
                    && r.expired_at_us.is_none()
                    && r.valid_until_us.is_none()
                    && status_active(r)
                    && !r.conversation_slot()
            })
            .max_by(newest);
        Ok(match rival {
            Some(r) => json!({ "id": r.id, "trust_tier": r.trust_tier }),
            None => Value::Null,
        })
    }

    /// `getOntology(entitySlug, opts)`: the newest visible observation of each dimension as of
    /// `asof` (now when unset), in dimension order.
    pub fn get_ontology(&self, q: &OntologyQuery) -> Result<Vec<Value>> {
        const OP: &str = "getOntology";
        q.check(OP)?;
        let asof = time_arg(OP, "asof", &q.asof)?.unwrap_or_else(|| self.env.now_micros());
        let read = self.read()?;
        let mut best: BTreeMap<String, FactRecord> = BTreeMap::new();
        let mut owner_only = OwnerOnlyCache::default();
        for r in q.rows(&*read, true)? {
            let Some(dimension) = r.dimension.clone() else {
                continue;
            };
            if !slot_row(&r)
                || r.valid_from_us > asof
                || r.valid_until_us.is_some_and(|until| until <= asof)
                || !(q.include_quarantined || status_active(&r))
                || !q.admits(&*read, &r, &mut owner_only)?
            {
                continue;
            }
            match best.get(&dimension) {
                Some(kept) if newest(kept, &r) != Ordering::Less => {}
                _ => {
                    best.insert(dimension, r);
                }
            }
        }
        Ok(best
            .into_values()
            .map(|r| {
                json!({
                    "dimension": r.dimension,
                    "value": r.value,
                    "confidence": real(r.confidence),
                    "source": r.source_markdown_slug,
                    "valid_from": iso(r.valid_from_us),
                    "valid_to": r.valid_until_us.map(iso),
                    "status": r.dim_status.as_deref().unwrap_or(ACTIVE),
                    "fact_id": r.id,
                })
            })
            .collect())
    }

    /// `discoverOntologyDimensions(opts)`: per dimension, the distinct entities and the
    /// observations of every unexpired slot row (quarantined and closed rows included), most
    /// entities first, then by dimension.
    pub fn discover_ontology_dimensions(&self, q: &OntologyQuery) -> Result<Vec<Value>> {
        q.check("discoverOntologyDimensions")?;
        let read = self.read()?;
        let mut groups: BTreeMap<String, Vec<FactRecord>> = BTreeMap::new();
        for r in q.rows(&*read, false)? {
            if slot_row(&r)
                && let Some(dimension) = r.dimension.clone()
            {
                groups.entry(dimension).or_default().push(r);
            }
        }
        let mut out: Vec<(String, usize, usize)> = groups
            .into_iter()
            .map(|(dimension, rows)| {
                let entities = distinct(rows.iter().map(|r| r.entity_slug.as_ref()));
                (dimension, entities, rows.len())
            })
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(out
            .into_iter()
            .map(|(dimension, entities, observations)| {
                json!({ "dimension": dimension, "entities": entities, "observations": observations })
            })
            .collect())
    }

    /// `findOntologyConflicts(opts)`: each (entity, dimension) whose open, active, visible slot
    /// rows hold at least two distinct values from at least two distinct provenances, by entity
    /// (a null entity last) then dimension; each group's values in row order.
    pub fn find_ontology_conflicts(&self, q: &OntologyQuery) -> Result<Vec<Value>> {
        q.check("findOntologyConflicts")?;
        let read = self.read()?;
        let mut groups: BTreeMap<(bool, String, String), Vec<FactRecord>> = BTreeMap::new();
        let mut owner_only = OwnerOnlyCache::default();
        for r in q.rows(&*read, false)? {
            if !slot_row(&r)
                || r.valid_until_us.is_some()
                || !status_active(&r)
                || !q.admits(&*read, &r, &mut owner_only)?
            {
                continue;
            }
            let entity = r.entity_slug.clone();
            let dimension = r.dimension.clone().unwrap_or_default();
            groups
                .entry((entity.is_none(), entity.unwrap_or_default(), dimension))
                .or_default()
                .push(r);
        }
        Ok(groups
            .into_iter()
            .filter(|(_, rows)| {
                distinct(rows.iter().map(|r| r.value.as_ref())) >= 2
                    && distinct(rows.iter().map(|r| r.source_markdown_slug.as_ref())) >= 2
            })
            .map(|((null_entity, entity, dimension), rows)| {
                let values: Vec<Value> = rows
                    .iter()
                    .map(|r| {
                        json!({
                            "value": r.value,
                            "source": r.source_markdown_slug,
                            "confidence": real(r.confidence),
                            "fact_id": r.id,
                        })
                    })
                    .collect();
                json!({
                    "entity_slug": if null_entity { Value::Null } else { Value::String(entity) },
                    "dimension": dimension,
                    "values": values,
                })
            })
            .collect())
    }
}

/// A JavaScript number bound to the `REAL` confidence column.
fn real_arg(op: &str, value: f64) -> Result<f32> {
    let narrowed = value as f32;
    if value.is_finite() && narrowed.is_infinite() {
        return Err(invalid(format!(
            "{op}: value out of range: overflow (confidence)"
        )));
    }
    Ok(narrowed)
}

/// GBRA-574 B2: a conversation fact holding the observation's exact stint key gives up its slot
/// (dimension, value, value_hash and dim_status set null). Only a dated observation has a key.
fn free_key(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    obs: &OntologyObservation,
    valid_from: Option<i64>,
) -> Result<()> {
    let Some(from) = valid_from else {
        return Ok(());
    };
    for old in entity_rows(tx, &obs.source_id, &obs.entity_slug)? {
        if old.conversation_slot()
            && old.dimension.as_deref() == Some(&obs.dimension)
            && old.value_hash.as_deref() == Some(&obs.value_hash)
            && old.source_markdown_slug.as_deref() == Some(&obs.source)
            && old.valid_from_us == from
        {
            let mut new = old.clone();
            new.dimension = None;
            new.value = None;
            new.value_hash = None;
            new.dim_status = None;
            write_fact(tx, trust, Some(&old), &new)?;
        }
    }
    Ok(())
}

/// `INSERT ... ON CONFLICT (stint key) DO NOTHING`: the row's checks, then the stint key, then the
/// source (the foreign key Postgres checks after the row). True when the row was stored.
fn insert(tx: &mut dyn KvWrite, trust: &WriteTrust, row: &mut FactRecord) -> Result<bool> {
    check_row("mergeOntologyFact", row)?;
    let held = stint_holder(
        tx,
        &row.source_id,
        row.entity_slug.as_deref().unwrap_or(""),
        row.dimension.as_deref().unwrap_or(""),
        row.value_hash.as_deref().unwrap_or(""),
        row.source_markdown_slug.as_deref().unwrap_or(""),
        row.valid_from_us,
    )?;
    if held.is_some() {
        return Ok(false);
    }
    require_fact_source(tx, &row.source_id)?;
    row.id = next_id(tx, COUNTER)?;
    write_fact(tx, trust, None, row)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    fn obs(
        entity: &str,
        dimension: &str,
        value: &str,
        source: &str,
        from: Option<&str>,
    ) -> OntologyObservation {
        OntologyObservation {
            source_id: "default".into(),
            entity_slug: entity.into(),
            dimension: dimension.into(),
            value: value.into(),
            value_hash: format!("h-{}", value.to_lowercase()),
            fact: format!("{dimension}: {value}"),
            confidence: 0.7,
            status: ACTIVE.into(),
            visibility: "private".into(),
            source: source.into(),
            valid_from: from.map(|f| format!("{f}T00:00:00.000Z")),
            valid_to: None,
        }
    }

    fn action(v: &Value) -> (&str, bool, Option<u64>) {
        (
            v["action"].as_str().unwrap(),
            !v["factId"].is_null(),
            v["supersededId"].as_u64(),
        )
    }

    #[test]
    fn merge_matches_the_pglite_probe() {
        let s = store();
        let mut first = obs(
            "people/s",
            "role",
            "founder",
            "meetings/a",
            Some("2024-01-01"),
        );
        first.confidence = 0.8;
        assert_eq!(
            action(&s.merge_ontology_fact(&first).unwrap()),
            ("inserted", true, None)
        );
        assert_eq!(
            action(&s.merge_ontology_fact(&first).unwrap()),
            ("noop", false, None)
        );
        let corroborate = obs(
            "people/s",
            "role",
            "founder",
            "meetings/b",
            Some("2024-01-01"),
        );
        assert_eq!(
            action(&s.merge_ontology_fact(&corroborate).unwrap()),
            ("corroborated", true, None)
        );
        let advisor = obs(
            "people/s",
            "role",
            "advisor",
            "meetings/c",
            Some("2026-05-01"),
        );
        assert_eq!(
            action(&s.merge_ontology_fact(&advisor).unwrap()),
            ("superseded_prior", true, Some(1))
        );
        let again = obs(
            "people/s",
            "role",
            "advisor",
            "meetings/d",
            Some("2026-05-01"),
        );
        assert_eq!(
            action(&s.merge_ontology_fact(&again).unwrap()),
            ("corroborated", true, None)
        );

        let read = s.read().unwrap();
        let rows = entity_rows(&*read, "default", "people/s").unwrap();
        let view: Vec<_> = rows
            .iter()
            .map(|r| {
                (
                    r.id,
                    r.valid_until_us.is_some(),
                    r.expired_at_us.is_some(),
                    r.superseded_by,
                    r.consolidated_into,
                )
            })
            .collect();
        assert_eq!(
            view,
            vec![
                (1, true, false, Some(3), None),
                (2, false, true, None, Some(1)),
                (3, false, false, None, None),
                (4, false, true, None, Some(3)),
            ]
        );
        assert_eq!(rows[0].valid_until_us, rows[2].valid_from_us.into());

        let q = |asof: Option<&str>| OntologyQuery {
            entity_slug: "people/s".into(),
            asof: asof.map(String::from),
            ..OntologyQuery::default()
        };
        let now = s.get_ontology(&q(None)).unwrap();
        assert_eq!(now.len(), 1);
        assert_eq!(now[0]["value"], "advisor");
        assert_eq!(now[0]["valid_from"], "2026-05-01T00:00:00.000000Z");
        let past = s
            .get_ontology(&q(Some("2025-01-01T00:00:00.000Z")))
            .unwrap();
        assert_eq!(past[0]["value"], "founder");
        assert_eq!(past[0]["confidence"], 0.8);
        assert_eq!(past[0]["valid_to"], "2026-05-01T00:00:00.000000Z");
        assert!(
            s.find_ontology_conflicts(&OntologyQuery::default())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_confidence_floor_equal_to_the_stored_value_admits_it() {
        // 0.7 stores as the REAL 0.699999988; SQL compares the floor at REAL too, so it is kept.
        let s = store();
        let mut a = obs("people/c", "role", "advisor", "m/a", Some("2026-05-01"));
        a.confidence = 0.7;
        s.merge_ontology_fact(&a).unwrap();
        let mut b = obs("people/c", "role", "founder", "m/b", Some("2026-01-01"));
        b.confidence = 0.7;
        s.merge_ontology_fact(&b).unwrap();
        let read = OntologyQuery {
            entity_slug: "people/c".into(),
            min_confidence: 0.7,
            ..OntologyQuery::default()
        };
        assert_eq!(s.get_ontology(&read).unwrap().len(), 1);
        let floor = OntologyQuery {
            min_confidence: 0.7,
            ..OntologyQuery::default()
        };
        assert_eq!(s.find_ontology_conflicts(&floor).unwrap().len(), 1);
        let nan = OntologyQuery {
            entity_slug: "people/c".into(),
            min_confidence: f64::NAN,
            ..OntologyQuery::default()
        };
        assert!(s.get_ontology(&nan).unwrap().is_empty());
    }

    #[test]
    fn backdated_values_conflict_and_quarantine_never_supersedes() {
        let s = store();
        let mut a = obs("people/b", "role", "advisor", "m/a", Some("2026-05-01"));
        a.confidence = 0.9;
        s.merge_ontology_fact(&a).unwrap();
        let mut b = obs("people/b", "role", "founder", "m/b", Some("2026-01-01"));
        b.confidence = 0.6;
        assert_eq!(
            action(&s.merge_ontology_fact(&b).unwrap()),
            ("inserted", true, None)
        );
        let conflicts = s
            .find_ontology_conflicts(&OntologyQuery::default())
            .unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0]["entity_slug"], "people/b");
        assert_eq!(conflicts[0]["values"].as_array().unwrap().len(), 2);
        let confident = OntologyQuery {
            min_confidence: 0.8,
            ..OntologyQuery::default()
        };
        assert!(s.find_ontology_conflicts(&confident).unwrap().is_empty());
        let world = OntologyQuery {
            visibility: Some(vec!["world".into()]),
            ..OntologyQuery::default()
        };
        assert!(s.find_ontology_conflicts(&world).unwrap().is_empty());

        let mut q = obs("people/b", "role", "investor", "m/c", None);
        q.status = "quarantined".into();
        assert_eq!(
            action(&s.merge_ontology_fact(&q).unwrap()),
            ("inserted", true, None)
        );
        let read = OntologyQuery {
            entity_slug: "people/b".into(),
            ..OntologyQuery::default()
        };
        assert_eq!(s.get_ontology(&read).unwrap()[0]["value"], "advisor");
        let with_q = OntologyQuery {
            include_quarantined: true,
            ..read.clone()
        };
        let rows = s.get_ontology(&with_q).unwrap();
        assert_eq!(rows[0]["value"], "investor");
        assert_eq!(rows[0]["status"], "quarantined");
        let none = OntologyQuery {
            visibility: Some(vec![]),
            ..read
        };
        assert!(s.get_ontology(&none).unwrap().is_empty());
    }

    #[test]
    fn a_conversation_fact_gives_up_its_stint_key() {
        let s = store();
        let o = obs(
            "people/c",
            "role",
            "founder",
            "meetings/a",
            Some("2024-01-01"),
        );
        s.write(|tx| {
            let mut row = FactRecord {
                source_id: "default".into(),
                entity_slug: Some("people/c".into()),
                fact: "role: founder".into(),
                kind: "fact".into(),
                visibility: "private".into(),
                notability: "medium".into(),
                valid_from_us: parse_iso("2024-01-01T00:00:00.000Z").unwrap(),
                source: "cli:extract-conversation-facts:v3".into(),
                confidence: 1.0,
                source_markdown_slug: Some("meetings/a".into()),
                dimension: Some("role".into()),
                value: Some("founder".into()),
                value_hash: Some(o.value_hash.clone()),
                dim_status: Some(ACTIVE.into()),
                ..FactRecord::default()
            };
            row.id = next_id(tx, COUNTER)?;
            write_fact(tx, &WriteTrust::default(), None, &row)
        })
        .unwrap();
        assert_eq!(
            action(&s.merge_ontology_fact(&o).unwrap()),
            ("inserted", true, None)
        );
        let read = s.read().unwrap();
        let rows = entity_rows(&*read, "default", "people/c").unwrap();
        assert_eq!(rows[0].dimension, None);
        assert_eq!(rows[0].value_hash, None);
        assert_eq!(rows[1].dimension.as_deref(), Some("role"));
    }

    #[test]
    fn discover_counts_entities_then_dimension() {
        let s = store();
        s.merge_ontology_fact(&obs("people/a", "role", "founder", "m/a", None))
            .unwrap();
        s.merge_ontology_fact(&obs("people/b", "role", "advisor", "m/b", None))
            .unwrap();
        s.merge_ontology_fact(&obs("people/b", "employer", "Acme", "m/b", None))
            .unwrap();
        let all = s
            .discover_ontology_dimensions(&OntologyQuery::default())
            .unwrap();
        assert_eq!(
            all,
            vec![
                json!({ "dimension": "role", "entities": 2, "observations": 2 }),
                json!({ "dimension": "employer", "entities": 1, "observations": 1 }),
            ]
        );
        let missing = OntologyQuery {
            source_ids: Some(vec!["nope".into()]),
            ..OntologyQuery::default()
        };
        assert!(s.discover_ontology_dimensions(&missing).unwrap().is_empty());
    }

    #[test]
    fn a_missing_source_and_a_bad_confidence_refuse() {
        let s = store();
        let mut o = obs("people/a", "role", "founder", "m/a", None);
        o.source_id = "nope".into();
        let e = s.merge_ontology_fact(&o).unwrap_err();
        assert!(e.message.contains("facts_source_id_fkey"), "{}", e.message);
        let mut o = obs("people/a", "role", "founder", "m/a", None);
        o.confidence = 2.0;
        let e = s.merge_ontology_fact(&o).unwrap_err();
        assert!(
            e.message.contains("facts_confidence_check"),
            "{}",
            e.message
        );
        o.confidence = 1e300;
        let e = s.merge_ontology_fact(&o).unwrap_err();
        assert!(e.message.contains("overflow"), "{}", e.message);
    }
}
