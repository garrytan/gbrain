//! The fence guard's two reads of a page's fact rows: `listFenceRetireCandidates` (the facts a page
//! publication's fence projection would retire, `engine-sql/facts.ts`) and `listFenceFactRows`
//! (the live fence rows the writer may not supersede, `engine-sql/trust-fence.ts`).
//!
//! Both read the rows of one page through the by-page index (`F 0x04 source_id slug id`), keep the
//! rows that sit at a fence position (`row_num IS NOT NULL`), and compare each with the incoming
//! fence: a JSON array of `{ row_num, fact, visibility }` cells (PGLite's `jsonb_to_recordset`
//! text). A cell field that is absent or null equals nothing, as SQL `=` does.
//!
//! Context: PGLite reads two transaction settings inside these statements: the writer's tier
//! (`gbrain.write_trust_tier`) and the ids `gbrain repair open-facts` opens
//! (`gbrain.write_open_facts`). [`FenceContext`] carries both; the napi members take it from the
//! store's write trust context (`Store::fence_context`, `write_trust.rs`). The default is no writer
//! (read as `unknown`) and no opened ids, which is what a PGLite transaction that declares none
//! gives. Each row is compared at its stored tier (`trust_tier`, stamped by the facts writer), and
//! the held arm reads the widening proposals of `trust_proposals` (`trust::proposals`). See
//! rust/docs/store/facts.md, "The fence guard's reads".

use super::withdrawal_guard::preserve_withdrawal;
use super::{FactRecord, bigint, fence_row, foreign_key, page_rows, read_fact, write_fact};
use crate::Store;
use crate::dream::int4;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::persistence::parse_timestamptz;
use crate::timeline_queries::timestamptz_text;
use crate::trust::TrustTier;
use crate::trust::proposals::held_narrower;
use serde::Deserialize;
use serde_json::{Value, json};

/// The page a fence read asks about and the fence it compares with. `incoming` is the JSON text of
/// the cells (`[{ "row_num": 1, "fact": "...", "visibility": "world" }]`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FenceTarget {
    pub source_id: String,
    pub slug: String,
    pub incoming: String,
}

/// `listFactIdsBySourcePrefix` input: a page coordinate and the literal prefix of `source` (the TS
/// member refuses a LIKE wildcard, so `LIKE prefix || '%'` is `starts_with`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactSourcePrefix {
    pub source_id: String,
    pub slug: String,
    pub source_prefix: String,
}

/// What the SQL reads from the transaction: the writer's declared tier by name (`None` or empty:
/// undeclared, read as `unknown`; a name that is no tier ranks 0, below every tier, as the rank
/// `CASE` does) and the fact ids `gbrain repair open-facts` opens.
#[derive(Debug, Clone, Default)]
pub struct FenceContext {
    pub writer: Option<String>,
    pub opened: Vec<u64>,
}

impl FenceContext {
    /// `trustRankSql(COALESCE(NULLIF(current_setting('gbrain.write_trust_tier', true), ''), 'unknown'))`.
    pub(crate) fn writer_rank(&self) -> u8 {
        match self.writer.as_deref() {
            None | Some("") => TrustTier::Unknown.rank(),
            Some(name) => TrustTier::parse(name).map_or(0, TrustTier::rank),
        }
    }
}

/// One cell of the incoming fence. A field the JSON leaves out or null compares equal to nothing.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct Cell {
    row_num: Option<f64>,
    fact: Option<String>,
    visibility: Option<String>,
}

impl Cell {
    fn at(&self, row_num: i32) -> bool {
        self.row_num == Some(f64::from(row_num))
    }

    pub(super) fn holds(&self, row: &FactRecord, row_num: i32, visibility: &str) -> bool {
        self.at(row_num)
            && self.fact.as_deref() == Some(row.fact.as_str())
            && self.visibility.as_deref() == Some(visibility)
    }
}

/// `jsonb_to_recordset(incoming) AS c(row_num integer, fact text, visibility text)`: a non-array,
/// a non-object cell or a `row_num` that is no integer is the error PGLite raises.
pub(super) fn cells(incoming: &str) -> Result<Vec<Cell>> {
    let bad = |what: &str| StoreError::new(INVALID_ARGUMENT, format!("incoming fence: {what}"));
    let Value::Array(items) =
        serde_json::from_str::<Value>(incoming).map_err(|_| bad("not a JSON document"))?
    else {
        return Err(bad("not an array"));
    };
    items
        .into_iter()
        .map(|item| {
            if !item.is_object() {
                return Err(bad("a cell is not an object"));
            }
            let cell: Cell =
                serde_json::from_value(item).map_err(|_| bad("a cell field has the wrong type"))?;
            match cell.row_num {
                Some(n) if n.fract() != 0.0 || n.abs() > f64::from(i32::MAX) => {
                    Err(bad("row_num is not an integer"))
                }
                _ => Ok(cell),
            }
        })
        .collect()
}

/// The page's rows at a fence position, by row number and then id (`ORDER BY f.row_num, f.id`).
fn fence_rows(store: &Store, target: &FenceTarget) -> Result<Vec<(i32, FactRecord)>> {
    no_nul(
        "fence read",
        &[("source_id", &target.source_id), ("slug", &target.slug)],
    )?;
    let read = store.read()?;
    let mut rows: Vec<(i32, FactRecord)> = page_rows(&*read, &target.source_id, &target.slug)?
        .into_iter()
        .filter_map(|row| row.row_num.map(|n| (n, row)))
        .collect();
    rows.sort_by_key(|(n, row)| (*n, row.id));
    Ok(rows)
}

/// A conversation-extractor row is in play only when a fence cell claims its number.
pub(super) fn in_play(row: &FactRecord, row_num: i32, cells: &[Cell]) -> bool {
    !row.conversation_slot() || cells.iter().any(|c| c.at(row_num))
}

/// `openedFactRowSql`: a private row `gbrain repair open-facts` names, whose cell is the same
/// number and claim at world.
pub(super) fn opened(row: &FactRecord, row_num: i32, cells: &[Cell], ctx: &FenceContext) -> bool {
    row.visibility == "private"
        && ctx.opened.contains(&row.id)
        && cells.iter().any(|c| c.holds(row, row_num, "world"))
}

/// The held arm: a row not at world that a widening proposal holds narrower
/// (`trust::proposals::held_narrower`), while a cell still asks for world at its number and claim.
fn held(read: &dyn KvRead, row: &FactRecord, row_num: i32, cells: &[Cell]) -> Result<bool> {
    if row.visibility == "world" || !cells.iter().any(|c| c.holds(row, row_num, "world")) {
        return Ok(false);
    }
    held_narrower(read, row.id)
}

/// `timestamptz` as `jsonb_build_object` writes it: `2026-06-18T09:00:00.5+00:00`.
pub(crate) fn jsonb_time(micros: i64) -> String {
    let text = timestamptz_text(micros).replacen(' ', "T", 1);
    format!("{}:00", text)
}

fn opt_time(micros: Option<i64>) -> Value {
    micros.map_or(Value::Null, |us| json!(jsonb_time(us)))
}

/// The before-state `restoreFactPreimage` puts back (`FACT_PREIMAGE_SQL` as the generation ledger
/// recorded it; other keys are ignored). Times are `timestamptz` text.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct FactRestore {
    pub id: Option<f64>,
    pub fact: Option<String>,
    pub visibility: Option<String>,
    pub expired_at: Option<String>,
    pub valid_until: Option<String>,
    pub superseded_by: Option<f64>,
    pub consolidated_at: Option<String>,
    pub consolidated_into: Option<f64>,
    pub row_num: Option<f64>,
}

/// `FACT_PREIMAGE_SQL`: a fact's before-state.
fn preimage(row: &FactRecord) -> Value {
    json!({
        "id": row.id,
        "row_num": row.row_num,
        "fact": row.fact,
        "visibility": row.visibility,
        "kind": row.kind,
        "entity_slug": row.entity_slug,
        "source": row.source,
        "expired_at": opt_time(row.expired_at_us),
        "valid_from": jsonb_time(row.valid_from_us),
        "valid_until": opt_time(row.valid_until_us),
        "superseded_by": row.superseded_by,
        "consolidated_at": opt_time(row.consolidated_at_us),
        "consolidated_into": row.consolidated_into,
        "attributed_to": row.attributed_to,
    })
}

impl Store {
    /// `listFenceRetireCandidates({ sourceId, slug, incoming })`: the before-state of each row of the
    /// page at a fence position, in row number and then id order, that the incoming fence does not
    /// hold at the same number, claim and visibility, and that `gbrain repair open-facts` does not
    /// open in place. A conversation-extractor row is a candidate only when a cell claims its number.
    /// Expired rows are included.
    pub fn list_fence_retire_candidates(
        &self,
        target: &FenceTarget,
        ctx: &FenceContext,
    ) -> Result<Vec<Value>> {
        let cells = cells(&target.incoming)?;
        Ok(fence_rows(self, target)?
            .iter()
            .filter(|(n, row)| {
                in_play(row, *n, &cells)
                    && !cells.iter().any(|c| c.holds(row, *n, &row.visibility))
                    && !opened(row, *n, &cells, ctx)
            })
            .map(|(_, row)| preimage(row))
            .collect())
    }

    /// `readFactPreimages(sourceId, ids)`: the before-state (`FACT_PREIMAGE_SQL`) of each fact of `ids`
    /// that exists in `source_id`, in id order, once per id. The generation adapters record it before
    /// rows change. A negative id is no fact, as `f.id = ANY($2::bigint[])` matches none.
    pub fn read_fact_preimages(&self, source_id: &str, ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let ids: std::collections::BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for id in ids {
            if let Some(row) = read_fact(&*read, id)?
                && row.source_id == source_id
            {
                out.push(preimage(&row));
            }
        }
        Ok(out)
    }

    /// `listFactIdsBySourcePrefix({ sourceId, slug, sourcePrefix })`: the ids of the page
    /// coordinate's facts (`source_markdown_slug`) whose `source` starts with the prefix, by id. The
    /// extracted facts generation reads its own rows with it.
    pub fn list_fact_ids_by_source_prefix(&self, q: &FactSourcePrefix) -> Result<Vec<u64>> {
        no_nul(
            "listFactIdsBySourcePrefix",
            &[
                ("sourceId", &q.source_id),
                ("slug", &q.slug),
                ("sourcePrefix", &q.source_prefix),
            ],
        )?;
        let read = self.read()?;
        Ok(page_rows(&*read, &q.source_id, &q.slug)?
            .iter()
            .filter(|row| row.source.starts_with(&q.source_prefix))
            .map(|row| row.id)
            .collect())
    }

    /// `expireFactRows(sourceId, ids)`: sets `expired_at` to now on each still-live fact of `ids` in
    /// the source; nothing else changes. Returns how many it ended. A negative id is no fact.
    pub fn expire_fact_rows(&self, source_id: &str, ids: &[i64]) -> Result<usize> {
        no_nul("expireFactRows", &[("sourceId", source_id)])?;
        let ids: std::collections::BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        if ids.is_empty() {
            return Ok(0);
        }
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut ended = 0;
            for id in &ids {
                let Some(old) = read_fact(&*tx, *id)? else {
                    continue;
                };
                if old.source_id != source_id || old.expired_at_us.is_some() {
                    continue;
                }
                let mut new = old.clone();
                new.expired_at_us = Some(now);
                write_fact(tx, trust, Some(&old), &new)?;
                ended += 1;
            }
            Ok(ended)
        })
    }

    /// `restoreFactPreimage(sourceId, preimage)`: puts a fact's recorded before-state back. Sets
    /// `expired_at`, `valid_until`, `superseded_by`, `consolidated_at` and `consolidated_into`, and
    /// the fence position `row_num` when no other row of the page holds it. Only the row of the
    /// source whose claim and visibility still match is changed; returns whether it was. Every
    /// argument is checked first, as Postgres casts the parameters before it reads a row. The
    /// withdrawal guard runs (`expired_at` is in the `SET` list): a row restored active that a
    /// withdrawal of its claim reaches comes back expired at that withdrawal.
    pub fn restore_fact_preimage(&self, source_id: &str, p: &FactRestore) -> Result<bool> {
        const OP: &str = "restoreFactPreimage";
        let time = |what: &str, t: &Option<String>| {
            t.as_deref()
                .map(|t| parse_timestamptz(t, &format!("{OP}: {what}")))
                .transpose()
        };
        let num = |what: &str, v: Option<f64>| v.map(|v| bigint(OP, what, v)).transpose();
        let id = num("id", p.id)?;
        let expired_at = time("expired_at", &p.expired_at)?;
        let valid_until = time("valid_until", &p.valid_until)?;
        let superseded_by = num("superseded_by", p.superseded_by)?;
        let consolidated_at = time("consolidated_at", &p.consolidated_at)?;
        let consolidated_into = num("consolidated_into", p.consolidated_into)?;
        let row_num = p.row_num.map(|v| int4(OP, "row_num", v)).transpose()?;
        let (Some(id), Some(fact), Some(visibility)) = (id, &p.fact, &p.visibility) else {
            return Ok(false);
        };
        let Ok(id) = u64::try_from(id) else {
            return Ok(false);
        };
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = read_fact(&*tx, id)? else {
                return Ok(false);
            };
            if old.source_id != source_id || &old.fact != fact || &old.visibility != visibility {
                return Ok(false);
            }
            let mut new = old.clone();
            new.expired_at_us = expired_at;
            new.valid_until_us = valid_until;
            new.consolidated_at_us = consolidated_at;
            new.consolidated_into = consolidated_into;
            new.superseded_by = match superseded_by {
                None => None,
                Some(by) if old.superseded_by == u64::try_from(by).ok() => old.superseded_by,
                Some(by) => match u64::try_from(by) {
                    Ok(by) if read_fact(&*tx, by)?.is_some() => Some(by),
                    _ => return Err(foreign_key("facts_superseded_by_fkey")),
                },
            };
            if let Some(n) = row_num
                && old.row_num != Some(n)
            {
                let taken = match &old.source_markdown_slug {
                    Some(slug) => {
                        fence_row(&*tx, &old.source_id, slug, n)?.is_some_and(|o| o.id != old.id)
                    }
                    None => false,
                };
                if !taken {
                    new.row_num = Some(n);
                }
            }
            preserve_withdrawal(&*tx, &mut new)?;
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(true)
        })
    }

    /// `listFenceFactRows({ sourceId, slug, incoming })`: the page's live fence rows, by row number,
    /// that the writer may not simply supersede: a row more trusted than the writer (`above`), held
    /// narrower by a widening proposal while the incoming fence still asks for world at its number
    /// and claim, or opened (`opened`). Rows the incoming fence states as they are, and
    /// conversation-extractor rows no cell claims, are left out. `trust_tier` is the stored tier.
    pub fn list_fence_fact_rows(
        &self,
        target: &FenceTarget,
        ctx: &FenceContext,
    ) -> Result<Vec<Value>> {
        let cells = cells(&target.incoming)?;
        let writer = ctx.writer_rank();
        let rows = fence_rows(self, target)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for (n, row) in &rows {
            if row.expired_at_us.is_some()
                || !in_play(row, *n, &cells)
                || cells.iter().any(|c| c.holds(row, *n, &row.visibility))
            {
                continue;
            }
            let stored = row.tier();
            let above = stored.rank() > writer;
            let is_opened = opened(row, *n, &cells, ctx);
            if !(above || is_opened || held(&*read, row, *n, &cells)?) {
                continue;
            }
            out.push(json!({
                "id": row.id,
                "row_num": n,
                "fact": row.fact,
                "visibility": row.visibility,
                "trust_tier": stored.as_str(),
                "above": above,
                "opened": is_opened,
            }));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_jsonb_time_trims_the_fraction_and_writes_the_offset_in_full() {
        let at = crate::env::parse_iso("2026-06-18T09:00:00Z").unwrap();
        assert_eq!(jsonb_time(at), "2026-06-18T09:00:00+00:00");
        assert_eq!(jsonb_time(at + 500_000), "2026-06-18T09:00:00.5+00:00");
        assert_eq!(jsonb_time(at + 120), "2026-06-18T09:00:00.00012+00:00");
    }

    #[test]
    fn a_cell_that_is_no_object_or_has_a_fractional_row_number_is_refused() {
        assert!(cells("[1]").is_err());
        assert!(cells("{}").is_err());
        assert!(cells("not json").is_err());
        assert!(cells(r#"[{"row_num": 1.5}]"#).is_err());
        assert_eq!(cells(r#"[{"row_num": 2}, {}]"#).unwrap().len(), 2);
    }
}
