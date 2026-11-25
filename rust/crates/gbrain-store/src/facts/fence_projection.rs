//! The fact statements of a page publication's fence projection and of its fence guard
//! (`src/core/engine-sql/fence-projection.ts`, `engine-sql/trust-fence.ts`): the reads that decide
//! which rows a write may retire, move or widen, and the writes that expire, detach, move and
//! refresh the page's fact rows. A put_page that updates a page with a `## Facts` fence runs them
//! inside its publication; every write joins the bound transaction (`Store::write`).
//!
//! Members: listPageFenceFactCells, hasPositionedPageFacts, expireFenceFacts, refreshFenceFactFields,
//! detachFenceFactRows, listOccupiedFenceRowNums, moveGuardedFenceRows, listTrustedPrivateCopies,
//! readLiveFenceFactAt, listFactsAboveWriter. They add no keys. The writer's tier and the opened fact
//! ids come from the store's write trust context ([`FenceContext`]), as the SQL reads
//! `gbrain.write_trust_tier` and `gbrain.write_open_facts`. See rust/docs/store/facts.md, "The fence
//! projection's statements".

use super::fence::{cells, in_play, opened};
use super::{
    FactRecord, FenceContext, bigint, check_row, entity_rows, invalid, page_rows, read_fact,
    write_fact,
};
use crate::Store;
use crate::dream::int4;
use crate::error::Result;
use crate::links::no_nul;
use crate::persistence::parse_timestamptz;
use crate::write_receipt::float_distinct;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The page's facts at a fence position (`row_num IS NOT NULL`), any state, by id.
fn positioned(rows: Vec<FactRecord>) -> Vec<(i32, FactRecord)> {
    let mut out: Vec<(i32, FactRecord)> = rows
        .into_iter()
        .filter_map(|row| row.row_num.map(|n| (n, row)))
        .collect();
    out.sort_by_key(|(_, row)| row.id);
    out
}

/// The JS numbers of a `bigint[]` parameter that name a row (a negative id matches none).
fn row_ids(op: &str, ids: &[f64]) -> Result<BTreeSet<u64>> {
    let mut out = BTreeSet::new();
    for id in ids {
        if let Ok(id) = u64::try_from(bigint(op, "ids", *id)?) {
            out.insert(id);
        }
    }
    Ok(out)
}

/// One row of `refreshFenceFactFields`' document (`jsonb_to_recordset ... AS r(...)`).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct FieldRow {
    row_num: Option<f64>,
    kind: Option<String>,
    notability: Option<String>,
    context: Option<String>,
    valid_from: Option<String>,
    valid_until: Option<String>,
    expired_at: Option<String>,
    source: Option<String>,
    confidence: Option<f64>,
    claim_metric: Option<String>,
    claim_value: Option<f64>,
    claim_unit: Option<String>,
    claim_period: Option<String>,
    attributed_to: Option<String>,
}

/// One move of `moveGuardedFenceRows` (`AS m(id bigint, row_num integer, visibility text)`).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RowMove {
    id: Option<f64>,
    row_num: Option<f64>,
    visibility: Option<String>,
}

/// One restatement of `listTrustedPrivateCopies` (`AS r(row_num integer, fact text, entity text)`).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Restatement {
    row_num: Option<f64>,
    fact: Option<String>,
    entity: Option<String>,
}

/// `jsonb_to_recordset($n::text::jsonb)`: an array of objects, each decoded as `T`; anything else
/// is the error PGLite raises.
fn records<T: for<'de> Deserialize<'de>>(op: &str, text: &str) -> Result<Vec<T>> {
    let bad = |what: &str| invalid(format!("{op}: {what}"));
    let Value::Array(items) =
        serde_json::from_str::<Value>(text).map_err(|_| bad("not a JSON document"))?
    else {
        return Err(bad("the record set is not an array"));
    };
    items
        .into_iter()
        .map(|item| {
            if !item.is_object() {
                return Err(bad("a record is not an object"));
            }
            serde_json::from_value(item).map_err(|_| bad("a record field has the wrong type"))
        })
        .collect()
}

/// An `integer` record field: a whole JS number in range, or the cast error.
fn int_field(op: &str, what: &str, value: Option<f64>) -> Result<Option<i32>> {
    value.map(|v| int4(op, what, v)).transpose()
}

/// A `text::timestamptz` cast of a record field (null stays null).
fn time_field(op: &str, what: &str, value: &Option<String>) -> Result<Option<i64>> {
    value
        .as_deref()
        .map(|t| parse_timestamptz(t, &format!("{op}: {what}")))
        .transpose()
}

impl Store {
    /// `listPageFenceFactCells(sourceId, slug)`: `{ row_num, fact, visibility }` of every fact of the
    /// page at a fence position, live or expired. The SQL sets no order; the store answers by id.
    pub fn list_page_fence_fact_cells(&self, source_id: &str, slug: &str) -> Result<Vec<Value>> {
        no_nul(
            "listPageFenceFactCells",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        Ok(positioned(page_rows(&*read, source_id, slug)?)
            .iter()
            .map(|(n, row)| json!({ "row_num": n, "fact": row.fact, "visibility": row.visibility }))
            .collect())
    }

    /// `hasPositionedPageFacts(sourceId, slug)`: whether the page has a fact at a fence position
    /// whose `source` is not a conversation extractor's, in any state.
    pub fn has_positioned_page_facts(&self, source_id: &str, slug: &str) -> Result<bool> {
        no_nul(
            "hasPositionedPageFacts",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        Ok(page_rows(&*read, source_id, slug)?
            .iter()
            .any(|row| row.row_num.is_some() && !row.conversation_slot()))
    }

    /// `expireFenceFacts(sourceId, slug, incoming, ids)`: each fact of `ids` on the page at a fence
    /// position that the incoming fence does not state as it is (same number, claim and
    /// visibility) is detached (`row_num` NULL) and expired (`expired_at` kept when set, else the
    /// transaction's now). A conversation-extractor row counts only when a cell claims its number;
    /// a row `gbrain repair open-facts` opens in place never does.
    pub fn expire_fence_facts(
        &self,
        source_id: &str,
        slug: &str,
        incoming: &str,
        ids: &[f64],
        ctx: &FenceContext,
    ) -> Result<()> {
        const OP: &str = "expireFenceFacts";
        no_nul(OP, &[("sourceId", source_id), ("slug", slug)])?;
        let ids = row_ids(OP, ids)?;
        let cells = cells(incoming)?;
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            for (n, old) in positioned(page_rows(&*tx, source_id, slug)?) {
                if !ids.contains(&old.id)
                    || !in_play(&old, n, &cells)
                    || cells.iter().any(|c| c.holds(&old, n, &old.visibility))
                    || opened(&old, n, &cells, ctx)
                {
                    continue;
                }
                let mut new = old.clone();
                new.expired_at_us = Some(old.expired_at_us.unwrap_or(now));
                new.row_num = None;
                write_fact(tx, trust, Some(&old), &new)?;
            }
            Ok(())
        })
    }

    /// `refreshFenceFactFields(sourceId, slug, fieldRows)`: for each record, the page's fact at its
    /// row number (any state) takes the record's kind, notability, context, valid_from (kept when
    /// the record has none), valid_until, expired_at, source, confidence, the four claim columns and
    /// attributed_to, when any of them differs. Every record is cast first, as Postgres casts the
    /// document before it updates a row.
    pub fn refresh_fence_fact_fields(
        &self,
        source_id: &str,
        slug: &str,
        field_rows: &str,
    ) -> Result<()> {
        const OP: &str = "refreshFenceFactFields";
        no_nul(OP, &[("sourceId", source_id), ("slug", slug)])?;
        struct Fields {
            row: FieldRow,
            valid_from: Option<i64>,
            valid_until: Option<i64>,
            expired_at: Option<i64>,
            confidence: Option<f32>,
        }
        let mut by_row: BTreeMap<i32, Vec<Fields>> = BTreeMap::new();
        for row in records::<FieldRow>(OP, field_rows)? {
            let Some(n) = int_field(OP, "row_num", row.row_num)? else {
                continue;
            };
            let fields = Fields {
                valid_from: time_field(OP, "valid_from", &row.valid_from)?,
                valid_until: time_field(OP, "valid_until", &row.valid_until)?,
                expired_at: time_field(OP, "expired_at", &row.expired_at)?,
                confidence: row
                    .confidence
                    .map(|c| crate::takes::real(c, OP))
                    .transpose()?,
                row,
            };
            by_row.entry(n).or_default().push(fields);
        }
        if by_row.is_empty() {
            return Ok(());
        }
        let trust = &self.write_trust()?;
        self.write(|tx| {
            for (n, old) in positioned(page_rows(&*tx, source_id, slug)?) {
                // `UPDATE ... FROM`: a row two records match is updated once, from the first.
                let Some(f) = by_row.get(&n).and_then(|v| v.first()) else {
                    continue;
                };
                let mut new = old.clone();
                let r = &f.row;
                let not_null = super::not_null;
                new.kind = r.kind.clone().ok_or_else(|| not_null("kind"))?;
                new.notability = r.notability.clone().ok_or_else(|| not_null("notability"))?;
                new.context = r.context.clone();
                new.valid_from_us = f.valid_from.unwrap_or(old.valid_from_us);
                new.valid_until_us = f.valid_until;
                new.expired_at_us = f.expired_at;
                new.source = r.source.clone().ok_or_else(|| not_null("source"))?;
                new.confidence = f.confidence.ok_or_else(|| not_null("confidence"))?;
                new.claim_metric = r.claim_metric.clone();
                new.claim_value = r.claim_value;
                new.claim_unit = r.claim_unit.clone();
                new.claim_period = r.claim_period.clone();
                new.attributed_to = r.attributed_to.clone();
                let distinct = (
                    &old.kind,
                    &old.notability,
                    &old.context,
                    old.valid_from_us,
                    old.valid_until_us,
                    old.expired_at_us,
                    &old.source,
                    &old.claim_metric,
                    &old.claim_unit,
                    &old.claim_period,
                    &old.attributed_to,
                ) != (
                    &new.kind,
                    &new.notability,
                    &new.context,
                    new.valid_from_us,
                    new.valid_until_us,
                    new.expired_at_us,
                    &new.source,
                    &new.claim_metric,
                    &new.claim_unit,
                    &new.claim_period,
                    &new.attributed_to,
                ) || float_distinct(Some(old.confidence), Some(new.confidence))
                    || float_distinct(old.claim_value, new.claim_value);
                if !distinct {
                    continue;
                }
                check_row(OP, &new)?;
                write_fact(tx, trust, Some(&old), &new)?;
            }
            Ok(())
        })
    }

    /// `detachFenceFactRows(ids)`: facts `ids` (of any source) leave their fence position
    /// (`row_num` NULL).
    pub fn detach_fence_fact_rows(&self, ids: &[f64]) -> Result<()> {
        let ids = row_ids("detachFenceFactRows", ids)?;
        if ids.is_empty() {
            return Ok(());
        }
        let trust = &self.write_trust()?;
        self.write(|tx| {
            for id in &ids {
                // An UPDATE that sets the value a row already holds still runs the row triggers.
                if let Some(old) = read_fact(&*tx, *id)? {
                    let mut new = old.clone();
                    new.row_num = None;
                    write_fact(tx, trust, Some(&old), &new)?;
                }
            }
            Ok(())
        })
    }

    /// `listOccupiedFenceRowNums(sourceId, slug)`: the row numbers the page's live facts hold, by
    /// id of the row that holds each.
    pub fn list_occupied_fence_row_nums(&self, source_id: &str, slug: &str) -> Result<Vec<i32>> {
        no_nul(
            "listOccupiedFenceRowNums",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        Ok(positioned(page_rows(&*read, source_id, slug)?)
            .into_iter()
            .filter(|(_, row)| row.expired_at_us.is_none())
            .map(|(n, _)| n)
            .collect())
    }

    /// `moveGuardedFenceRows(moves)`: each move's fact takes its row number and visibility. Every
    /// move is cast first; a move whose id names no fact changes nothing.
    pub fn move_guarded_fence_rows(&self, moves: &str) -> Result<()> {
        const OP: &str = "moveGuardedFenceRows";
        let mut planned: Vec<(u64, Option<i32>, Option<String>)> = Vec::new();
        for m in records::<RowMove>(OP, moves)? {
            let row_num = int_field(OP, "row_num", m.row_num)?;
            let Some(id) = m.id.map(|v| bigint(OP, "id", v)).transpose()? else {
                continue;
            };
            if let Some(v) = &m.visibility {
                no_nul(OP, &[("visibility", v)])?;
            }
            if let Ok(id) = u64::try_from(id) {
                planned.push((id, row_num, m.visibility));
            }
        }
        if planned.is_empty() {
            return Ok(());
        }
        let trust = &self.write_trust()?;
        self.write(|tx| {
            // `UPDATE ... FROM`: a fact two moves name is updated once, from the first.
            let mut seen = BTreeSet::new();
            for (id, row_num, visibility) in &planned {
                if !seen.insert(*id) {
                    continue;
                }
                let Some(old) = read_fact(&*tx, *id)? else {
                    continue;
                };
                let mut new = old.clone();
                new.row_num = *row_num;
                new.visibility = visibility
                    .clone()
                    .ok_or_else(|| super::not_null("visibility"))?;
                check_row(OP, &new)?;
                write_fact(tx, trust, Some(&old), &new)?;
            }
            Ok(())
        })
    }

    /// `listTrustedPrivateCopies(sourceId, slug, restated)`: for each restatement's row number, the
    /// first live narrower fact more trusted than the writer that states its claim, the page's own
    /// facts first and then by id: on the page while no live world fact of the page states the
    /// claim, or of the restatement's entity on another page (or on none), still valid, while no
    /// live valid world fact of that entity states it. `[{ row_num, id, visibility, trust_tier }]`
    /// by row number.
    pub fn list_trusted_private_copies(
        &self,
        source_id: &str,
        slug: &str,
        restated: &str,
        ctx: &FenceContext,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listTrustedPrivateCopies";
        no_nul(OP, &[("sourceId", source_id), ("slug", slug)])?;
        let mut wanted: Vec<(i32, String, Option<String>)> = Vec::new();
        for r in records::<Restatement>(OP, restated)? {
            let n = int_field(OP, "row_num", r.row_num)?;
            if let (Some(n), Some(fact)) = (n, r.fact) {
                wanted.push((n, fact, r.entity));
            }
        }
        if wanted.is_empty() {
            return Ok(Vec::new());
        }
        let writer = ctx.writer_rank();
        let now = self.env.now_micros();
        let read = self.read()?;
        let live = |row: &FactRecord| row.expired_at_us.is_none();
        let valid = |row: &FactRecord| row.valid_until_us.is_none_or(|until| until > now);
        let page = page_rows(&*read, source_id, slug)?;
        let page_world = |fact: &str| {
            page.iter()
                .any(|w| live(w) && w.visibility == "world" && w.fact == fact)
        };
        let mut best: BTreeMap<i32, (bool, u64, Value)> = BTreeMap::new();
        for (n, fact, entity) in &wanted {
            let mut pool: BTreeMap<u64, FactRecord> = BTreeMap::new();
            for row in &page {
                pool.insert(row.id, row.clone());
            }
            let entity_pool = match entity {
                Some(entity) => entity_rows(&*read, source_id, entity)?,
                None => Vec::new(),
            };
            for row in &entity_pool {
                pool.insert(row.id, row.clone());
            }
            let entity_world = |fact: &str| {
                entity_pool
                    .iter()
                    .any(|w| live(w) && w.visibility == "world" && w.fact == fact && valid(w))
            };
            for f in pool.values() {
                let on_page = f.source_markdown_slug.as_deref() == Some(slug);
                let of_entity = entity.is_some() && f.entity_slug == *entity;
                if !live(f)
                    || !(on_page || of_entity)
                    || f.fact != *fact
                    || f.visibility == "world"
                    || f.tier().rank() <= writer
                {
                    continue;
                }
                let keep = (on_page && !page_world(&f.fact))
                    || (of_entity && !on_page && valid(f) && !entity_world(&f.fact));
                if !keep {
                    continue;
                }
                let candidate = (
                    !on_page,
                    f.id,
                    json!({
                        "row_num": n,
                        "id": f.id,
                        "visibility": f.visibility,
                        "trust_tier": f.tier().as_str(),
                    }),
                );
                match best.get(n) {
                    Some((page_last, id, _)) if (*page_last, *id) <= (candidate.0, candidate.1) => {
                    }
                    _ => {
                        best.insert(*n, candidate);
                    }
                }
            }
        }
        Ok(best.into_values().map(|(_, _, row)| row).collect())
    }

    /// `readLiveFenceFactAt(sourceId, slug, rowNum)`: `{ id, trust_tier }` of the page's live fact
    /// at that row number, or null.
    pub fn read_live_fence_fact_at(
        &self,
        source_id: &str,
        slug: &str,
        row_num: f64,
    ) -> Result<Option<Value>> {
        const OP: &str = "readLiveFenceFactAt";
        no_nul(OP, &[("sourceId", source_id), ("slug", slug)])?;
        let n = int4(OP, "rowNum", row_num)?;
        let read = self.read()?;
        Ok(positioned(page_rows(&*read, source_id, slug)?)
            .into_iter()
            .find(|(at, row)| *at == n && row.expired_at_us.is_none())
            .map(|(_, row)| json!({ "id": row.id, "trust_tier": row.tier().as_str() })))
    }

    /// `listFactsAboveWriter(sourceId, slug)`: `[{ id, trust_tier }]` of the page's live facts at a
    /// fence position whose stored tier ranks above the writer's, by id.
    pub fn list_facts_above_writer(
        &self,
        source_id: &str,
        slug: &str,
        ctx: &FenceContext,
    ) -> Result<Vec<Value>> {
        no_nul(
            "listFactsAboveWriter",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let writer = ctx.writer_rank();
        let read = self.read()?;
        Ok(positioned(page_rows(&*read, source_id, slug)?)
            .into_iter()
            .filter(|(_, row)| row.expired_at_us.is_none() && row.tier().rank() > writer)
            .map(|(_, row)| json!({ "id": row.id, "trust_tier": row.tier().as_str() }))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{InsertFactsArgs, NewFactInput};
    use super::*;
    use crate::test_support::store;

    const SLUG: &str = "people/alice-example";

    /// Declares `tier` as the writer's tier (with a promotion to it) for the next writes.
    fn declare(store: &Store, tier: &str) {
        let names = ["gbrain.write_trust_tier", "gbrain.write_trust_promotion"].map(String::from);
        store
            .apply_write_trust(&names, &[tier.to_string(), tier.to_string()])
            .unwrap();
    }

    /// A seeded row: fact, row number, visibility, source and page slug.
    type Seed<'a> = (&'a str, Option<f64>, &'a str, &'a str, Option<&'a str>);

    fn insert(store: &Store, rows: &[Seed<'_>]) -> Vec<u64> {
        let rows = rows
            .iter()
            .map(|(fact, row_num, visibility, source, slug)| NewFactInput {
                fact: Some((*fact).into()),
                source: Some((*source).into()),
                visibility: Some((*visibility).into()),
                valid_from: Some("2026-01-01T00:00:00.000Z".into()),
                entity_slug: Some(SLUG.into()),
                row_num: *row_num,
                source_markdown_slug: slug.map(String::from),
                ..NewFactInput::default()
            })
            .collect();
        let out = store
            .insert_facts(&InsertFactsArgs {
                rows,
                source_id: "default".into(),
                delete_for_page_first: None,
            })
            .unwrap();
        serde_json::from_value(out["ids"].clone()).unwrap()
    }

    #[test]
    fn a_narrower_copy_above_the_writer_is_found_page_first_then_by_id() {
        let store = store();
        declare(&store, "tool_observed");
        // An entity copy off the page, then the page's own private row, both tool_observed.
        let ids = insert(
            &store,
            &[
                ("Claim", None, "private", "chat", Some("notes/other")),
                ("Claim", Some(5.0), "private", "fence", Some(SLUG)),
            ],
        );
        let writer = |tier: &str| FenceContext {
            writer: Some(tier.into()),
            opened: Vec::new(),
        };
        let restated = r#"[{"row_num":1,"fact":"Claim","entity":"people/alice-example"}]"#;
        let low = store
            .list_trusted_private_copies("default", SLUG, restated, &writer("agent_written"))
            .unwrap();
        assert_eq!(low.len(), 1);
        assert_eq!(
            low[0]["id"],
            json!(ids[1]),
            "the page's own row comes first"
        );
        assert_eq!(low[0]["trust_tier"], json!("tool_observed"));
        // A writer at the copies' tier finds none.
        assert!(
            store
                .list_trusted_private_copies("default", SLUG, restated, &writer("tool_observed"))
                .unwrap()
                .is_empty()
        );
        let above = store
            .list_facts_above_writer("default", SLUG, &writer("agent_written"))
            .unwrap();
        assert_eq!(
            above,
            vec![json!({ "id": ids[1], "trust_tier": "tool_observed" })]
        );
    }

    #[test]
    fn the_expiry_keeps_a_stated_row_and_an_unclaimed_conversation_row() {
        let store = store();
        let ids = insert(
            &store,
            &[
                ("Kept", Some(1.0), "private", "fence", Some(SLUG)),
                ("Gone", Some(2.0), "private", "fence", Some(SLUG)),
                (
                    "Talk",
                    Some(3.0),
                    "private",
                    "cli:extract-conversation-facts:v2",
                    Some(SLUG),
                ),
            ],
        );
        let incoming = r#"[{"row_num":1,"fact":"Kept","visibility":"private"}]"#;
        let all: Vec<f64> = ids.iter().map(|id| *id as f64).collect();
        store
            .expire_fence_facts("default", SLUG, incoming, &all, &FenceContext::default())
            .unwrap();
        let read = store.read().unwrap();
        let row = |id: u64| read_fact(&*read, id).unwrap().unwrap();
        assert_eq!(
            (row(ids[0]).row_num, row(ids[0]).expired_at_us.is_some()),
            (Some(1), false)
        );
        assert_eq!(
            (row(ids[1]).row_num, row(ids[1]).expired_at_us.is_some()),
            (None, true)
        );
        assert_eq!(
            (row(ids[2]).row_num, row(ids[2]).expired_at_us.is_some()),
            (Some(3), false)
        );
        assert!(
            store
                .expire_fence_facts("default", SLUG, "{}", &all, &FenceContext::default())
                .is_err(),
            "a document that is not an array is refused"
        );
    }
}
