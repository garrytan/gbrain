//! The ontology statements the re-key and `gbrain repair ontology-facts` paths ran through `executeRaw`, from
//! `src/core/engine-sql/ontology-repair.ts`:
//!
//! - `listRekeyLosers(sourceId, move)`: of each set of ontology facts that would share an `idx_facts_ontology_stint_dedup`
//!   key once `move` applies (the moving rows plus the rows already under that key), every row but the survivor: the
//!   one that is not a conversation slot, then the active one, then the one already at the target, then the lowest id.
//! - `repointSupersededToKept(ids, keeps)`: supersession links to a dropped row follow its survivor.
//! - `clearOntologySlots(ids)`: a dropped conversation fact keeps its row and gives up its slot.
//! - `deleteRekeyLosers(ids)`: deletes the dropped ontology rows.
//! - `listOntologyFactCandidates(sourceIds)`: the ontology rows a fence step may have hidden, with whether each was
//!   withdrawn, consolidated or would duplicate another observation.
//! - `restoreOntologyFact(row)`: puts one row back on its own provenance, only while it is as the preview saw it.
//!
//! A re-key move is one of the closed shapes `src/core/engine-sql/ontology-repair.ts` lists; the member sends each by
//! name, and any other name refuses. Writes go through [`write_fact`] and [`delete_fact`], so the trust stamp, the purge
//! guard and the unique indexes run as they do for the SQL. `restoreOntologyFact` also runs the withdrawal guard
//! ([`preserve_withdrawal`]): `expired_at` is in its `SET` list.

use super::purge::unbacked;
use super::withdrawal_guard::preserve_withdrawal;
use super::{
    FactRecord, bigint, delete_fact, entity_rows, ids_under, read_fact, refs_prefix, source_rows,
    write_fact,
};
use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::links::no_nul;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// `listRekeyLosers(sourceId, move)`: `where`, `entity` and `sms` name the closed shapes; `params` are `$2` and `$3`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RekeyArgs {
    pub source_id: String,
    #[serde(rename = "where")]
    pub where_shape: String,
    pub entity: String,
    pub sms: String,
    pub params: (Option<String>, Option<String>),
}

/// `repointSupersededToKept(ids, keeps)`: `ids[i]` was dropped for `keeps[i]`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepointArgs {
    pub ids: Vec<f64>,
    pub keeps: Vec<f64>,
}

/// `clearOntologySlots(ids)` and `deleteRekeyLosers(ids)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdsArgs {
    pub ids: Vec<f64>,
}

/// `restoreOntologyFact(row)`: the row as the preview saw it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreArgs {
    pub id: f64,
    pub source_id: String,
    pub row_num: Option<f64>,
    pub page: Option<String>,
    pub expired_at: Option<String>,
}

/// `$2` and `$3` of a move, as the shapes read them.
struct Params<'a> {
    second: Option<&'a str>,
    third: Option<&'a str>,
}

/// The `where` shapes, in the order of `REKEY_WHERE_SHAPES`: whether row `f` moves.
fn moves(
    op: &str,
    read: &dyn KvRead,
    now: i64,
    shape: &str,
    p: &Params,
    f: &FactRecord,
) -> Result<bool> {
    let equal = |a: Option<&str>, b: Option<&str>| a.is_some() && a == b;
    Ok(match shape {
        "entity_unfenced" => equal(f.entity_slug.as_deref(), p.second) && f.row_num.is_none(),
        "unbacked_id" => {
            let id = p.second.and_then(|s| s.trim().parse::<i64>().ok());
            if p.second.is_some() && id.is_none() {
                return Err(StoreError::invalid(format!(
                    "{op}: invalid input syntax for type bigint: \"{}\"",
                    p.second.unwrap_or_default()
                )));
            }
            id == i64::try_from(f.id).ok() && unbacked(read, f)? && f.active(now)
        }
        "entity_off_page" => {
            equal(f.entity_slug.as_deref(), p.second)
                && f.source_markdown_slug.as_deref() != p.second
        }
        "entity" => equal(f.entity_slug.as_deref(), p.second),
        "page" => equal(f.source_markdown_slug.as_deref(), p.second),
        "page_live" => {
            equal(f.source_markdown_slug.as_deref(), p.third) && f.expired_at_us.is_none()
        }
        other => {
            return Err(StoreError::invalid(format!(
                "{op}: rekey move is not one of the supported shapes: where {other}"
            )));
        }
    })
}

const WHERE_SHAPES: [&str; 6] = [
    "entity_unfenced",
    "unbacked_id",
    "entity_off_page",
    "entity",
    "page",
    "page_live",
];
const TARGET_SHAPES: [&str; 3] = ["own", "param3", "param2"];

/// A re-key move names one of the closed shapes; any other name refuses.
fn shape(op: &str, what: &str, name: &str, known: &[&str]) -> Result<()> {
    if known.contains(&name) {
        return Ok(());
    }
    Err(StoreError::invalid(format!(
        "{op}: rekey move is not one of the supported shapes: {what} {name}"
    )))
}

/// The entity or page a moving row takes, by the closed shape's name.
fn target(
    op: &str,
    what: &str,
    shape: &str,
    own: Option<&String>,
    p: &Params,
) -> Result<Option<String>> {
    Ok(match shape {
        "own" => own.cloned(),
        "param3" => p.third.map(String::from),
        "param2" => p.second.map(String::from),
        other => {
            return Err(StoreError::invalid(format!(
                "{op}: rekey move is not one of the supported shapes: {what} {other}"
            )));
        }
    })
}

/// The ids of `= ANY($1::bigint[])`, ascending and distinct; an id no row can have names nothing.
fn id_set(op: &str, ids: &[f64]) -> Result<BTreeSet<u64>> {
    let mut out = BTreeSet::new();
    for id in ids {
        if let Ok(id) = u64::try_from(bigint(op, "ids", *id)?)
            && id >= 1
        {
            out.insert(id);
        }
    }
    Ok(out)
}

/// A conversation-slot-free ontology key: (entity, page, dimension, value hash, valid_from).
type Key = (String, String, String, String, i64);

fn key_of(f: &FactRecord, entity: Option<&String>, page: Option<&String>) -> Option<Key> {
    Some((
        entity?.clone(),
        page?.clone(),
        f.dimension.clone()?,
        f.value_hash.clone()?,
        f.valid_from_us,
    ))
}

/// The microsecond UTC text of an expiry (`to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`).
fn expiry_text(f: &FactRecord) -> Option<String> {
    f.expired_at_us.map(iso)
}

/// `DUPLICATE_F`: another row of the source with the key `f` would have once its provenance is restored.
fn duplicate(read: &dyn KvRead, f: &FactRecord) -> Result<bool> {
    let (Some(entity), Some(dimension), Some(hash)) = (
        f.entity_slug.as_deref(),
        f.dimension.as_deref(),
        f.value_hash.as_deref(),
    ) else {
        return Ok(false);
    };
    Ok(entity_rows(read, &f.source_id, entity)?
        .into_iter()
        .any(|d| {
            d.id != f.id
                && d.dimension.as_deref() == Some(dimension)
                && d.value_hash.as_deref() == Some(hash)
                && d.source_markdown_slug.as_deref() == Some(f.source.as_str())
                && d.valid_from_us == f.valid_from_us
        }))
}

impl Store {
    /// `listRekeyLosers`: `{ id, keep }` of every dropped row, by id.
    pub fn list_rekey_losers(&self, a: &RekeyArgs) -> Result<Vec<Value>> {
        const OP: &str = "listRekeyLosers";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let params = Params {
            second: a.params.0.as_deref(),
            third: a.params.1.as_deref(),
        };
        for text in [params.second, params.third].into_iter().flatten() {
            no_nul(OP, &[("params", text)])?;
        }
        shape(OP, "where", &a.where_shape, &WHERE_SHAPES)?;
        shape(OP, "entity", &a.entity, &TARGET_SHAPES)?;
        shape(OP, "sms", &a.sms, &TARGET_SHAPES)?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let rows: Vec<FactRecord> = source_rows(&*read, &a.source_id)?
            .into_iter()
            .filter(|f| f.dimension.is_some())
            .collect();
        // The moving rows with the entity and page they take.
        let mut cand: Vec<(FactRecord, bool, Option<String>, Option<String>)> = Vec::new();
        let mut moving_ids: HashSet<u64> = HashSet::new();
        let mut moving_keys: HashSet<Key> = HashSet::new();
        for f in &rows {
            if !moves(OP, &*read, now, &a.where_shape, &params, f)? {
                continue;
            }
            let e = target(OP, "entity", &a.entity, f.entity_slug.as_ref(), &params)?;
            let s = target(OP, "sms", &a.sms, f.source_markdown_slug.as_ref(), &params)?;
            if let Some(key) = key_of(f, e.as_ref(), s.as_ref()) {
                moving_keys.insert(key);
            }
            moving_ids.insert(f.id);
            cand.push((f.clone(), true, e, s));
        }
        // The rows already at a key a moving row takes.
        for t in &rows {
            if moving_ids.contains(&t.id) {
                continue;
            }
            if key_of(t, t.entity_slug.as_ref(), t.source_markdown_slug.as_ref())
                .is_some_and(|k| moving_keys.contains(&k))
            {
                cand.push((
                    t.clone(),
                    false,
                    t.entity_slug.clone(),
                    t.source_markdown_slug.clone(),
                ));
            }
        }
        let mut groups: BTreeMap<Key, Vec<(FactRecord, bool)>> = BTreeMap::new();
        for (row, moving, e, s) in cand {
            if let Some(key) = key_of(&row, e.as_ref(), s.as_ref()) {
                groups.entry(key).or_default().push((row, moving));
            }
        }
        let mut losers: Vec<(u64, u64)> = Vec::new();
        for (_, mut group) in groups {
            group.sort_by(|(a, am), (b, bm)| {
                a.conversation_slot()
                    .cmp(&b.conversation_slot())
                    .then(b.expired_at_us.is_none().cmp(&a.expired_at_us.is_none()))
                    .then(am.cmp(bm))
                    .then(a.id.cmp(&b.id))
            });
            let keep = group[0].0.id;
            losers.extend(group.into_iter().skip(1).map(|(row, _)| (row.id, keep)));
        }
        losers.sort();
        Ok(losers
            .into_iter()
            .map(|(id, keep)| json!({ "id": id, "keep": keep }))
            .collect())
    }

    /// `repointSupersededToKept`: every row that names `ids[i]` as its successor names `keeps[i]` instead, or none when
    /// it is `keeps[i]` itself. A repeated dropped id keeps its first survivor. Lists of different lengths pad with
    /// nulls as `unnest` does: an id with no survivor clears its referrers' link and a survivor with no id changes nothing.
    pub fn repoint_superseded_to_kept(&self, a: &RepointArgs) -> Result<()> {
        const OP: &str = "repointSupersededToKept";
        let whole = |what: &str, n: Option<&f64>| -> Result<Option<u64>> {
            n.map(|n| bigint(OP, what, *n))
                .transpose()
                .map(|n| n.and_then(|n| u64::try_from(n).ok()))
        };
        let mut keep_of: BTreeMap<u64, Option<u64>> = BTreeMap::new();
        for i in 0..a.ids.len().max(a.keeps.len()) {
            let (id, keep) = (whole("ids", a.ids.get(i))?, whole("keeps", a.keeps.get(i))?);
            if let Some(id) = id {
                keep_of.entry(id).or_insert(keep);
            }
        }
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut referrers: BTreeMap<u64, Option<u64>> = BTreeMap::new();
            for (id, keep) in &keep_of {
                for referrer in ids_under(&*tx, &refs_prefix(*id))? {
                    referrers.entry(referrer).or_insert(*keep);
                }
            }
            for (referrer, keep) in referrers {
                if let Some(old) = read_fact(&*tx, referrer)? {
                    let mut new = old.clone();
                    new.superseded_by = keep.filter(|keep| *keep != old.id);
                    write_fact(tx, trust, Some(&old), &new)?;
                }
            }
            Ok(())
        })
    }

    /// `clearOntologySlots`: a named conversation fact gives up `dimension`, `value`, `value_hash` and `dim_status`.
    pub fn clear_ontology_slots(&self, a: &IdsArgs) -> Result<()> {
        const OP: &str = "clearOntologySlots";
        let ids = id_set(OP, &a.ids)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            for id in ids.iter().copied() {
                let Some(old) = read_fact(&*tx, id)? else {
                    continue;
                };
                if !old.conversation_slot() {
                    continue;
                }
                let mut new = old.clone();
                new.dimension = None;
                new.value = None;
                new.value_hash = None;
                new.dim_status = None;
                write_fact(tx, trust, Some(&old), &new)?;
            }
            Ok(())
        })
    }

    /// `deleteRekeyLosers`: deletes the named facts that hold an ontology slot.
    pub fn delete_rekey_losers(&self, a: &IdsArgs) -> Result<()> {
        const OP: &str = "deleteRekeyLosers";
        let ids = id_set(OP, &a.ids)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            for id in ids.iter().copied() {
                if let Some(old) = read_fact(&*tx, id)?
                    && old.dimension.is_some()
                {
                    delete_fact(tx, trust, &old)?;
                }
            }
            Ok(())
        })
    }

    /// `restoreOntologyFact(row)`: sets `row_num` null, `source_markdown_slug` to the row's `source` and `expired_at`
    /// null, only while the row, its source, row number, page and expiry text are the ones given and it holds an ontology
    /// slot that is not a conversation slot and duplicates no other observation. Answers `[{ id, expired }]`, none when
    /// the row did not match; `expired` is true when a withdrawal expired it again.
    pub fn restore_ontology_fact(&self, a: &RestoreArgs) -> Result<Vec<Value>> {
        const OP: &str = "restoreOntologyFact";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        if let Some(page) = &a.page {
            no_nul(OP, &[("page", page.as_str())])?;
        }
        let id = bigint(OP, "id", a.id)?;
        let row_num = a
            .row_num
            .map(|n| {
                let n = bigint(OP, "rowNum", n)?;
                i32::try_from(n).map_err(|_| {
                    StoreError::invalid(format!(
                        "{OP}: value \"{n}\" is out of range for type integer"
                    ))
                })
            })
            .transpose()?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = u64::try_from(id)
                .ok()
                .map(|id| read_fact(&*tx, id))
                .transpose()?
                .flatten()
            else {
                return Ok(Vec::new());
            };
            if old.source_id != a.source_id
                || old.dimension.is_none()
                || old.conversation_slot()
                || old.row_num != row_num
                || old.source_markdown_slug != a.page
                || expiry_text(&old) != a.expired_at
                || duplicate(&*tx, &old)?
            {
                return Ok(Vec::new());
            }
            let mut new = old.clone();
            new.row_num = None;
            new.source_markdown_slug = Some(old.source.clone());
            new.expired_at_us = None;
            preserve_withdrawal(&*tx, &mut new)?;
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(vec![
                json!({ "id": new.id, "expired": new.expired_at_us.is_some() }),
            ])
        })
    }
}
