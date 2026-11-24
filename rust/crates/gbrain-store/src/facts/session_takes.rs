//! The statements `gbrain repair agent-session-facts` (src/core/repair/agent-session-facts.ts) ran through
//! `executeRaw`, from `src/core/engine-sql/facts-repair.ts`:
//!
//! - `listAgentSessionTakeCandidates(sourceIds, ids, noteMark)`: the active, unresolved `kind: fact` / `holder: self`
//!   takes of the sources with the facts of those sources consolidated into each: `fact_ids`, `user_fact_ids` (the
//!   contributors attributed to the user or unset) and `noted` (an `other` contributor whose context holds `noteMark`).
//!   A take created more than one second before its first consolidation is left out. Ordered by the page's source,
//!   then slug, by bytes (`COLLATE "C"`), then take id.
//! - `listSettledSessionFacts(sourceId, ids)`: the named facts of the source attributed to `other`, unexpired and
//!   unsuperseded, with their context.
//! - `reattributeSessionFacts(sourceId, facts, separator)`: sets each named active database-only user (or unset) fact
//!   to `other` and appends its note after `separator` unless the context already holds it. Returns the changed ids.
//! - `retireSessionTakes(sourceId, takeIds)`: sets `active = false` on each named take of a page of the source that is
//!   still an active, unresolved self fact take with no user (or unset) contributor of any source. Returns the ids.
//! - `listOtherAttributedFactIds(sourceId, ids)`: the named facts of the source attributed to `other`.
//! - `listInactiveTakeIds(ids)`: the named takes that read back inactive.
//!
//! The fact write saves through [`write_fact`] (the trust stamp, the purge guard and the unique indexes run as for
//! the `UPDATE`); the take write saves through [`store_take`]. The store keeps no index of `consolidated_into`, so the
//! take reads scan the facts of the named sources and the retirement scans every fact. Answers come in id order where
//! the SQL has no `ORDER BY`.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::{Value, json};

use super::captured::{NamedFactsArgs, id_set, named_rows, source_set};
use super::trust_reads::all_fact_rows;
use super::{FactRecord, bigint, source_rows, write_fact};
use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::read_page_by_id;
use crate::takes::{TakeRecord, read_take, store_take};

/// `interval '1 second'`, in microseconds.
const ONE_SECOND_US: i64 = 1_000_000;

/// `listAgentSessionTakeCandidates(sourceIds, ids, noteMark)`. `ids` null is every take.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTakeCandidatesArgs {
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub ids: Option<Vec<f64>>,
    pub note_mark: String,
}

/// One `{ id, note }` of `reattributeSessionFacts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotedFact {
    pub id: f64,
    pub note: String,
}

/// `reattributeSessionFacts(sourceId, facts, separator)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReattributeArgs {
    pub source_id: String,
    pub facts: Vec<NotedFact>,
    pub separator: String,
}

/// `retireSessionTakes(sourceId, takeIds)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetireTakesArgs {
    pub source_id: String,
    pub take_ids: Vec<f64>,
}

/// `listInactiveTakeIds(ids)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeIdsArgs {
    pub ids: Vec<f64>,
}

/// `attributed_to IS NULL OR attributed_to = 'user'`.
fn user_or_unset(row: &FactRecord) -> bool {
    matches!(row.attributed_to.as_deref(), None | Some("user"))
}

fn other(row: &FactRecord) -> bool {
    row.attributed_to.as_deref() == Some("other")
}

/// `kind = 'fact' AND holder = 'self' AND active AND resolved_at IS NULL`.
fn open_self_fact_take(take: &TakeRecord) -> bool {
    take.kind == "fact" && take.holder == "self" && take.active && take.resolved_at_us.is_none()
}

/// `t.created_at >= min(f.consolidated_at) - interval '1 second'`: false when no contributor has a consolidation time
/// (`min` of no value is null).
fn created_after_first_consolidation(take: &TakeRecord, first: Option<i64>) -> bool {
    first.is_some_and(|first| take.created_at_us >= first.saturating_sub(ONE_SECOND_US))
}

/// The contributors of one take, as the `contributing` CTE groups them.
#[derive(Default)]
struct Contributors {
    fact_ids: Vec<u64>,
    user_fact_ids: Vec<u64>,
    noted: bool,
    first_consolidated_at: Option<i64>,
}

impl Contributors {
    fn add(&mut self, row: &FactRecord, note_mark: &str) {
        self.fact_ids.push(row.id);
        if user_or_unset(row) {
            self.user_fact_ids.push(row.id);
        }
        if other(row) && row.context.as_deref().unwrap_or("").contains(note_mark) {
            self.noted = true;
        }
        if let Some(at) = row.consolidated_at_us {
            self.first_consolidated_at = Some(self.first_consolidated_at.map_or(at, |f| f.min(at)));
        }
    }
}

/// The contributors of every take a fact of `rows` is consolidated into, keyed by take id.
fn contributors_by_take<'a>(
    rows: impl Iterator<Item = &'a FactRecord>,
    wanted: Option<&BTreeSet<u64>>,
    note_mark: &str,
) -> BTreeMap<u64, Contributors> {
    let mut out: BTreeMap<u64, Contributors> = BTreeMap::new();
    for row in rows {
        let Some(take) = row.consolidated_into.and_then(|t| u64::try_from(t).ok()) else {
            continue;
        };
        if wanted.is_some_and(|w| !w.contains(&take)) {
            continue;
        }
        out.entry(take).or_default().add(row, note_mark);
    }
    for c in out.values_mut() {
        c.fact_ids.sort_unstable();
        c.user_fact_ids.sort_unstable();
    }
    out
}

/// The named facts of the source, as `named_rows` reads them, filtered.
fn named_ids(
    read: &dyn KvRead,
    a: &NamedFactsArgs,
    op: &str,
    keep: impl Fn(&FactRecord) -> bool,
    shape: impl Fn(&FactRecord) -> Value,
) -> Result<Vec<Value>> {
    no_nul(op, &[("sourceId", a.source_id.as_str())])?;
    let ids = id_set(op, &a.ids)?;
    Ok(named_rows(read, &a.source_id, &ids)?
        .iter()
        .filter(|r| keep(r))
        .map(shape)
        .collect())
}

impl Store {
    /// `listAgentSessionTakeCandidates(sourceIds, ids, noteMark)`: see the module doc.
    pub fn list_agent_session_take_candidates(
        &self,
        a: &SessionTakeCandidatesArgs,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listAgentSessionTakeCandidates";
        let sources = source_set(OP, &a.source_ids)?;
        no_nul(OP, &[("noteMark", a.note_mark.as_str())])?;
        let wanted = a.ids.as_deref().map(|ids| id_set(OP, ids)).transpose()?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for source in &sources {
            rows.extend(source_rows(&*read, source)?);
        }
        let groups = contributors_by_take(rows.iter(), wanted.as_ref(), &a.note_mark);
        let mut out = Vec::new();
        for (take_id, c) in groups {
            let Some(take) = read_take(&*read, take_id)? else {
                continue;
            };
            let Some(page) = read_page_by_id(&*read, take.page_id)? else {
                continue;
            };
            if !sources.contains(&page.source_id)
                || !open_self_fact_take(&take)
                || !created_after_first_consolidation(&take, c.first_consolidated_at)
            {
                continue;
            }
            out.push((
                (page.source_id.clone(), page.slug.clone(), take.id),
                json!({
                    "id": take.id, "source_id": page.source_id, "slug": page.slug, "row_num": take.row_num,
                    "claim": take.claim, "fact_ids": c.fact_ids, "user_fact_ids": c.user_fact_ids, "noted": c.noted,
                }),
            ));
        }
        out.sort_by(|x, y| x.0.cmp(&y.0));
        Ok(out.into_iter().map(|(_, v)| v).collect())
    }

    /// `listSettledSessionFacts(sourceId, ids)`: `SELECT id, context FROM facts WHERE source_id AND id = ANY(ids) AND
    /// attributed_to = 'other' AND expired_at IS NULL AND superseded_by IS NULL`, by id.
    pub fn list_settled_session_facts(&self, a: &NamedFactsArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        named_ids(
            &*read,
            a,
            "listSettledSessionFacts",
            |r| other(r) && r.expired_at_us.is_none() && r.superseded_by.is_none(),
            |r| json!({ "id": r.id, "context": r.context }),
        )
    }

    /// `listOtherAttributedFactIds(sourceId, ids)`: `SELECT id FROM facts WHERE source_id AND id = ANY(ids) AND
    /// attributed_to = 'other'`, by id.
    pub fn list_other_attributed_fact_ids(&self, a: &NamedFactsArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        named_ids(
            &*read,
            a,
            "listOtherAttributedFactIds",
            other,
            |r| json!({ "id": r.id }),
        )
    }

    /// `reattributeSessionFacts(sourceId, facts, separator)`: `UPDATE facts SET attributed_to = 'other', context = CASE
    /// WHEN position(note in COALESCE(context, '')) > 0 THEN context ELSE concat_ws(separator, NULLIF(context, ''),
    /// note) END ... WHERE source_id AND id AND (attributed_to IS NULL OR 'user') AND expired_at IS NULL AND
    /// superseded_by IS NULL AND row_num IS NULL RETURNING id`. A repeated id is updated once, with its first note.
    pub fn reattribute_session_facts(&self, a: &ReattributeArgs) -> Result<Vec<Value>> {
        const OP: &str = "reattributeSessionFacts";
        no_nul(
            OP,
            &[
                ("sourceId", a.source_id.as_str()),
                ("separator", a.separator.as_str()),
            ],
        )?;
        let mut notes: BTreeMap<u64, &str> = BTreeMap::new();
        for f in &a.facts {
            no_nul(OP, &[("note", f.note.as_str())])?;
            let id = bigint(OP, "id", f.id)?;
            if let Ok(id) = u64::try_from(id)
                && id >= 1
            {
                notes.entry(id).or_insert(f.note.as_str());
            }
        }
        let ids: BTreeSet<u64> = notes.keys().copied().collect();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut changed = Vec::new();
            for old in named_rows(&*tx, &a.source_id, &ids)? {
                if !user_or_unset(&old)
                    || old.expired_at_us.is_some()
                    || old.superseded_by.is_some()
                    || old.row_num.is_some()
                {
                    continue;
                }
                let note = notes[&old.id];
                let mut new = old.clone();
                new.attributed_to = Some("other".into());
                if !old.context.as_deref().unwrap_or("").contains(note) {
                    new.context = Some(match old.context.as_deref().filter(|c| !c.is_empty()) {
                        Some(own) => format!("{own}{}{note}", a.separator),
                        None => note.to_string(),
                    });
                }
                write_fact(tx, trust, Some(&old), &new)?;
                changed.push(json!({ "id": old.id }));
            }
            Ok(changed)
        })
    }

    /// `retireSessionTakes(sourceId, takeIds)`: `UPDATE takes SET active = false, updated_at = now() FROM pages WHERE
    /// the take's page is in the source AND id = ANY(takeIds) AND it is an open self fact take created no more than one
    /// second before its first consolidation AND no user (or unset) fact is consolidated into it RETURNING id`, by id.
    pub fn retire_session_takes(&self, a: &RetireTakesArgs) -> Result<Vec<Value>> {
        const OP: &str = "retireSessionTakes";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let ids = id_set(OP, &a.take_ids)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        self.write(|tx| {
            let facts = all_fact_rows(&*tx)?;
            let groups = contributors_by_take(facts.iter(), Some(&ids), "");
            let now = self.env.now_micros();
            let mut retired = Vec::new();
            for id in &ids {
                let Some(mut take) = read_take(&*tx, *id)? else {
                    continue;
                };
                let in_source = read_page_by_id(&*tx, take.page_id)?
                    .is_some_and(|p| p.source_id == a.source_id);
                let group = groups.get(id);
                if !in_source
                    || !open_self_fact_take(&take)
                    || !created_after_first_consolidation(
                        &take,
                        group.and_then(|g| g.first_consolidated_at),
                    )
                    || group.is_some_and(|g| !g.user_fact_ids.is_empty())
                {
                    continue;
                }
                take.active = false;
                take.updated_at_us = now;
                store_take(tx, &take)?;
                retired.push(json!({ "id": take.id }));
            }
            Ok(retired)
        })
    }

    /// `listInactiveTakeIds(ids)`: `SELECT id FROM takes WHERE id = ANY(ids) AND active = false`, by id.
    pub fn list_inactive_take_ids(&self, a: &TakeIdsArgs) -> Result<Vec<Value>> {
        let ids = id_set("listInactiveTakeIds", &a.ids)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(take) = read_take(&*read, id)?
                && !take.active
            {
                out.push(json!({ "id": take.id }));
            }
        }
        Ok(out)
    }
}
