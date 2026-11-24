//! The statements `gbrain repair captured-facts` and `gbrain repair facts-rehome`
//! (src/core/repair/captured-facts.ts, facts-rehome.ts) ran through `executeRaw`, from
//! `src/core/engine-sql/facts-repair.ts`:
//!
//! - `listActiveSourceIds`: the sources that are not archived, by id.
//! - `listFenceRewriteRows(sourceId, ids)`: the named unexpired facts of the source with their claim and fence row number.
//! - `expireCapturedFacts(sourceId, ids, context)`: expires each named active database-only fact of the source and puts
//!   `context` before its own, `concat_ws(' | ', context, NULLIF(context_before, ''))`. Returns the changed ids.
//! - `listExpiredFactIds(sourceId, ids)`: the named facts of the source that read back expired.
//! - `listPagelessEntityFacts(sourceIds)`: per `entity_slug` with no live page in its source, the database-only fact ids
//!   (`ids`, none when there are none) and the count of fence-held facts (`fenced`), by (source, slug) in byte order.
//! - `listSourceIncarnations(sourceIds)`: the id and incarnation of each named source, archived or not, by id.
//! - `readEntityRehomeState(sourceId, from, to)`: whether each page is live in the source and the database-only fact ids
//!   keyed under `from`.
//! - `rehomeEntityFacts(sourceId, from, to)`: re-keys the database-only facts of `from` onto `to`.
//!
//! Each write reads the rows the statement's `WHERE` names and saves the changed ones through [`write_fact`], so the trust
//! stamp, the purge guard and the unique indexes run as they do for the `UPDATE`: a stint key another row holds refuses
//! with `23505` and rolls back every row of the call. [`preserve_withdrawal`] runs on the rows that set `entity_slug`
//! (a withdrawal of the claim that reaches the new entity expires the row, as `gbrain_preserve_fact_withdrawal` does).
//! `readRepairBrainId` is served from the brain identity in TypeScript (`store-members/facts-repair.ts`). Texts compare by
//! bytes, as the parity brains' `C` collation orders them.

use super::withdrawal_guard::preserve_withdrawal;
use super::{bigint, read_fact, write_fact};
use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::sources::{all_sources, read_source};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `listFenceRewriteRows(sourceId, ids)` and `listExpiredFactIds(sourceId, ids)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedFactsArgs {
    pub source_id: String,
    pub ids: Vec<f64>,
}

/// `expireCapturedFacts(sourceId, ids, context)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpireCapturedArgs {
    pub source_id: String,
    pub ids: Vec<f64>,
    pub context: String,
}

/// `listPagelessEntityFacts(sourceIds)` and `listSourceIncarnations(sourceIds)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceIdsArgs {
    pub source_ids: Vec<String>,
}

/// `readEntityRehomeState` and `rehomeEntityFacts`: the source and the two entity slugs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RehomeArgs {
    pub source_id: String,
    pub from: String,
    pub to: String,
}

/// The distinct ids of `= ANY($n::bigint[])`, ascending. An id no row can have (below 1) names nothing.
pub(super) fn id_set(op: &str, ids: &[f64]) -> Result<BTreeSet<u64>> {
    let mut out = BTreeSet::new();
    for id in ids {
        let id = bigint(op, "ids", *id)?;
        if let Ok(id) = u64::try_from(id)
            && id >= 1
        {
            out.insert(id);
        }
    }
    Ok(out)
}

/// The rows of `source_id` named by `ids`, by id.
pub(super) fn named_rows(
    read: &dyn KvRead,
    source_id: &str,
    ids: &BTreeSet<u64>,
) -> Result<Vec<super::FactRecord>> {
    let mut out = Vec::new();
    for id in ids {
        if let Some(row) = read_fact(read, *id)?
            && row.source_id == source_id
        {
            out.push(row);
        }
    }
    Ok(out)
}

/// The id lists of `listPagelessEntityFacts` and `readEntityRehomeState`: none when empty (`array_agg` of no row).
fn id_list(ids: Vec<u64>) -> Value {
    if ids.is_empty() {
        Value::Null
    } else {
        json!(ids)
    }
}

impl Store {
    /// `listActiveSourceIds()`: `SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id`.
    pub fn list_active_source_ids(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut ids: Vec<String> = all_sources(&*read)?
            .into_iter()
            .filter(|s| !s.archived)
            .map(|s| s.id)
            .collect();
        ids.sort();
        Ok(ids.into_iter().map(|id| json!({ "id": id })).collect())
    }

    /// `listFenceRewriteRows(sourceId, ids)`: `SELECT id, fact, row_num FROM facts WHERE source_id AND id = ANY(ids)
    /// AND expired_at IS NULL`, by id.
    pub fn list_fence_rewrite_rows(&self, a: &NamedFactsArgs) -> Result<Vec<Value>> {
        const OP: &str = "listFenceRewriteRows";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let ids = id_set(OP, &a.ids)?;
        let read = self.read()?;
        Ok(named_rows(&*read, &a.source_id, &ids)?
            .into_iter()
            .filter(|r| r.expired_at_us.is_none())
            .map(|r| json!({ "id": r.id, "fact": r.fact, "row_num": r.row_num }))
            .collect())
    }

    /// `listExpiredFactIds(sourceId, ids)`: `SELECT id FROM facts WHERE source_id AND id = ANY(ids) AND expired_at IS
    /// NOT NULL`, by id.
    pub fn list_expired_fact_ids(&self, a: &NamedFactsArgs) -> Result<Vec<Value>> {
        const OP: &str = "listExpiredFactIds";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let ids = id_set(OP, &a.ids)?;
        let read = self.read()?;
        Ok(named_rows(&*read, &a.source_id, &ids)?
            .into_iter()
            .filter(|r| r.expired_at_us.is_some())
            .map(|r| json!({ "id": r.id }))
            .collect())
    }

    /// `expireCapturedFacts(sourceId, ids, context)`: `UPDATE facts SET expired_at = now(), context =
    /// concat_ws(' | ', context, NULLIF(context, '')) WHERE source_id AND id = ANY(ids) AND expired_at IS NULL AND
    /// row_num IS NULL RETURNING id`. An empty `context` is still a part of the join.
    pub fn expire_captured_facts(&self, a: &ExpireCapturedArgs) -> Result<Vec<Value>> {
        const OP: &str = "expireCapturedFacts";
        no_nul(
            OP,
            &[
                ("sourceId", a.source_id.as_str()),
                ("context", a.context.as_str()),
            ],
        )?;
        let ids = id_set(OP, &a.ids)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut changed = Vec::new();
            for old in named_rows(&*tx, &a.source_id, &ids)? {
                if old.expired_at_us.is_some() || old.row_num.is_some() {
                    continue;
                }
                let mut new = old.clone();
                new.expired_at_us = Some(now);
                new.context = Some(match old.context.as_deref().filter(|c| !c.is_empty()) {
                    Some(own) => format!("{} | {own}", a.context),
                    None => a.context.clone(),
                });
                write_fact(tx, trust, Some(&old), &new)?;
                changed.push(json!({ "id": old.id }));
            }
            Ok(changed)
        })
    }

    /// `listSourceIncarnations(sourceIds)`: `SELECT id, incarnation::text FROM sources WHERE id = ANY(sourceIds) ORDER
    /// BY id COLLATE "C"` (byte order). An unknown id is skipped; an archived source answers.
    pub fn list_source_incarnations(&self, a: &SourceIdsArgs) -> Result<Vec<Value>> {
        const OP: &str = "listSourceIncarnations";
        let sources = source_set(OP, &a.source_ids)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for id in &sources {
            if let Some(s) = read_source(&*read, id)? {
                out.push(json!({ "id": s.id, "incarnation": s.incarnation }));
            }
        }
        Ok(out)
    }

    /// `readEntityRehomeState(sourceId, from, to)`: always one row: whether `from` and `to` are live pages of the
    /// source and the ids of the facts keyed under `from` with no `row_num`, by id (none when there are none).
    pub fn read_entity_rehome_state(&self, a: &RehomeArgs) -> Result<Value> {
        const OP: &str = "readEntityRehomeState";
        no_nul_rehome(OP, a)?;
        let read = self.read()?;
        let ids: Vec<u64> = super::entity_rows(&*read, &a.source_id, &a.from)?
            .into_iter()
            .filter(|r| r.row_num.is_none())
            .map(|r| r.id)
            .collect();
        Ok(json!({
            "from_live": live_page(&*read, &a.source_id, &a.from)?,
            "to_live": live_page(&*read, &a.source_id, &a.to)?,
            "ids": id_list(ids),
        }))
    }

    /// `rehomeEntityFacts(sourceId, from, to)`: `UPDATE facts SET entity_slug = to WHERE source_id AND entity_slug =
    /// from AND row_num IS NULL`. A stint key a row of `to` already holds refuses with `23505` and no row moves.
    pub fn rehome_entity_facts(&self, a: &RehomeArgs) -> Result<()> {
        const OP: &str = "rehomeEntityFacts";
        no_nul_rehome(OP, a)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            for old in super::entity_rows(&*tx, &a.source_id, &a.from)? {
                if old.row_num.is_some() {
                    continue;
                }
                let mut new = old.clone();
                new.entity_slug = Some(a.to.clone());
                preserve_withdrawal(&*tx, &mut new)?;
                write_fact(tx, trust, Some(&old), &new)?;
            }
            Ok(())
        })
    }
}

/// The distinct source ids of `= ANY($1::text[])`, in byte order.
pub(super) fn source_set(op: &str, ids: &[String]) -> Result<BTreeSet<String>> {
    for id in ids {
        no_nul(op, &[("sourceIds", id.as_str())])?;
    }
    Ok(ids.iter().cloned().collect())
}

fn no_nul_rehome(op: &str, a: &RehomeArgs) -> Result<()> {
    no_nul(
        op,
        &[
            ("sourceId", a.source_id.as_str()),
            ("from", a.from.as_str()),
            ("to", a.to.as_str()),
        ],
    )
}

/// `EXISTS (SELECT 1 FROM pages WHERE source_id AND slug AND deleted_at IS NULL)`.
fn live_page(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<bool> {
    Ok(read_page(read, source_id, slug)?.is_some_and(|p| p.deleted_at_us.is_none()))
}
