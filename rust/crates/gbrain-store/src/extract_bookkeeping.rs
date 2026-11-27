//! Extract bookkeeping: the two page reads an extract receipt write makes in its transaction
//! (`src/core/extract/receipt-writer.ts`) and the `extract_rollup_7d` day rows the extract steps
//! add to (`src/core/extract/rollup-writer.ts`). SQL in `src/core/engine-sql/extract-bookkeeping.ts`;
//! contract in `rust/docs/store/extract-bookkeeping.md`.
//!
//! Members: readExtractReceiptSlot, readExtractReceiptSeal, upsertExtractRollupDay. A Rust-only
//! reader, [`Store::list_extract_rollup_days`], gives a later typed rollup read the stored rows.
//!
//! Keys: `A 0x0A <kind> 0x00 <source> 0x00 <day YYYY-MM-DD>` -> [`RollupDay`] (JSON): the table's
//! `PRIMARY KEY (kind, source_id, day)`. The table has no foreign key, so a deleted source keeps its
//! rows, as in Postgres. A NUL byte in a kind or source is refused (Postgres text cannot hold one).
//!
//! `cost_usd` is a `REAL`: kept as `f32`, and an upsert adds in `f32` as `real + real` does. The
//! counts are `INT`: an add past the `i32` range is refused, as Postgres refuses it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::read_page;
use crate::{Store, get_json, keys, put_json};

const ROLLUP_DAY: u8 = 0x0A;
const OP: &str = "upsertExtractRollupDay";

/// One event's deltas for its `(kind, source_id, day)` row; `halt_reason` names the bucket the
/// halts count under (none: the row's `halt_reasons` is left as it is).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollupDelta {
    pub kind: String,
    pub source_id: String,
    pub day: String,
    pub cost_usd: f64,
    pub halt_count: i32,
    pub eval_fail_count: i32,
    pub eval_pass_count: i32,
    pub round_completed_count: i32,
    pub expected_limit_count: i32,
    pub rollup_write_failures: i32,
    #[serde(default)]
    pub halt_reason: Option<String>,
}

/// A stored `extract_rollup_7d` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RollupDay {
    pub kind: String,
    pub source_id: String,
    pub day: String,
    pub cost_usd: f32,
    pub halt_count: i32,
    pub eval_fail_count: i32,
    pub eval_pass_count: i32,
    pub round_completed_count: i32,
    pub expected_limit_count: i32,
    pub rollup_write_failures: i32,
    pub halt_reasons: Map<String, Value>,
    pub updated_at_us: i64,
}

fn day_key(kind: &str, source_id: &str, day: &str) -> Vec<u8> {
    let mut k = vec![keys::TAKE, ROLLUP_DAY];
    for part in [kind, source_id] {
        k.extend_from_slice(part.as_bytes());
        k.push(0);
    }
    k.extend_from_slice(day.as_bytes());
    k
}

/// `$3::date` for the ISO form every caller sends; anything else is refused.
fn check_day(day: &str) -> Result<()> {
    let b = day.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let shaped = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && digits(0..4)
        && digits(5..7)
        && digits(8..10);
    let ok = shaped && {
        let (m, d): (u32, u32) = (
            day[5..7].parse().unwrap_or(0),
            day[8..10].parse().unwrap_or(0),
        );
        (1..=12).contains(&m) && (1..=31).contains(&d)
    };
    if ok {
        Ok(())
    } else {
        Err(StoreError::invalid(format!(
            "{OP}: day must be YYYY-MM-DD, got {day:?}"
        )))
    }
}

fn add(a: i32, b: i32) -> Result<i32> {
    a.checked_add(b)
        .ok_or_else(|| StoreError::invalid(format!("{OP}: integer out of range")))
}

impl Store {
    /// `readExtractReceiptSlot(sourceId, slug)`: what the receipt write checks before it writes the
    /// slug (`type, source_path, source_uri, withheld_source_path`), live or a tombstone; null for no
    /// page. The store keeps no withheld origin, so `withheld_source_path` is always null.
    pub fn read_extract_receipt_slot(&self, source_id: &str, slug: &str) -> Result<Value> {
        Ok(read_page(&*self.read()?, source_id, slug)?.map_or(Value::Null, |p| {
            json!({ "type": p.page_type, "source_path": p.source_path, "source_uri": p.source_uri, "withheld_source_path": null })
        }))
    }

    /// `readExtractReceiptSeal(sourceId, slug)`: `chunker_version >= safe AND
    /// text_projection_revision = knowledge_revision` with SQL's three-valued AND (null when no page
    /// or the answer is NULL).
    pub fn read_extract_receipt_seal(
        &self,
        source_id: &str,
        slug: &str,
        safe_version: i16,
    ) -> Result<Option<bool>> {
        Ok(read_page(&*self.read()?, source_id, slug)?.and_then(|p| {
            let fenced = p.chunker_version.map(|v| v >= safe_version);
            let sealed = p
                .text_projection_revision
                .map(|t| t == p.knowledge_revision);
            match (fenced, sealed) {
                (Some(false), _) | (_, Some(false)) => Some(false),
                (Some(true), Some(true)) => Some(true),
                _ => None,
            }
        }))
    }

    /// `upsertExtractRollupDay(delta)`: inserts the day row, or adds the deltas to the stored one
    /// (`INSERT .. ON CONFLICT (kind, source_id, day) DO UPDATE`); a named halt reason adds the halt
    /// count to its bucket.
    pub fn upsert_extract_rollup_day(&self, d: &RollupDelta) -> Result<()> {
        no_nul(OP, &[("kind", &d.kind), ("source_id", &d.source_id)])?;
        check_day(&d.day)?;
        if let Some(reason) = &d.halt_reason {
            no_nul(OP, &[("halt_reason", reason)])?;
        }
        let cost = d.cost_usd as f32;
        if !d.cost_usd.is_finite() || cost.is_infinite() {
            return Err(StoreError::invalid(format!(
                "{OP}: cost_usd is out of range for type real"
            )));
        }
        let key = day_key(&d.kind, &d.source_id, &d.day);
        let now = self.env.now_micros();
        self.write(|tx| {
            let row = match get_json::<RollupDay>(&*tx, &key)? {
                None => RollupDay {
                    kind: d.kind.clone(),
                    source_id: d.source_id.clone(),
                    day: d.day.clone(),
                    cost_usd: cost,
                    halt_count: d.halt_count,
                    eval_fail_count: d.eval_fail_count,
                    eval_pass_count: d.eval_pass_count,
                    round_completed_count: d.round_completed_count,
                    expected_limit_count: d.expected_limit_count,
                    rollup_write_failures: d.rollup_write_failures,
                    halt_reasons: d
                        .halt_reason
                        .iter()
                        .map(|r| (r.clone(), json!(d.halt_count)))
                        .collect(),
                    updated_at_us: now,
                },
                Some(mut row) => {
                    row.cost_usd += cost;
                    row.halt_count = add(row.halt_count, d.halt_count)?;
                    row.eval_fail_count = add(row.eval_fail_count, d.eval_fail_count)?;
                    row.eval_pass_count = add(row.eval_pass_count, d.eval_pass_count)?;
                    row.round_completed_count =
                        add(row.round_completed_count, d.round_completed_count)?;
                    row.expected_limit_count =
                        add(row.expected_limit_count, d.expected_limit_count)?;
                    row.rollup_write_failures =
                        add(row.rollup_write_failures, d.rollup_write_failures)?;
                    if let Some(reason) = &d.halt_reason {
                        let prior = row
                            .halt_reasons
                            .get(reason)
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        let prior = i32::try_from(prior).map_err(|_| {
                            StoreError::invalid(format!("{OP}: integer out of range"))
                        })?;
                        row.halt_reasons
                            .insert(reason.clone(), json!(add(prior, d.halt_count)?));
                    }
                    row.updated_at_us = now;
                    row
                }
            };
            put_json(tx, &key, &row)
        })
    }

    /// The stored rollup rows of days on or after `since` (`YYYY-MM-DD`), in `(kind, source_id,
    /// day)` key order: the rows the 7-day readers (`readExtractRollup7d`, `listRecordedHaltReasons7d`,
    /// `readExtractKindRollup7d`, in store-members/doctor-derived.ts) aggregate.
    pub fn list_extract_rollup_days(&self, since: &str) -> Result<Vec<RollupDay>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        let mut bad = None;
        scan_prefix(
            &*read as &dyn KvRead,
            &[keys::TAKE, ROLLUP_DAY],
            false,
            &mut |_, v| match serde_json::from_slice::<RollupDay>(v) {
                Ok(row) => {
                    if row.day.as_str() >= since {
                        rows.push(row);
                    }
                    true
                }
                Err(e) => {
                    bad = Some(e);
                    false
                }
            },
        )?;
        match bad {
            Some(e) => Err(StoreError::invalid(format!(
                "extract_rollup_7d: unreadable row: {e}"
            ))),
            None => Ok(rows),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store as open_store;

    fn delta(kind: &str, day: &str, halts: i32, reason: Option<&str>, cost: f64) -> RollupDelta {
        RollupDelta {
            kind: kind.into(),
            source_id: "default".into(),
            day: day.into(),
            cost_usd: cost,
            halt_count: halts,
            eval_fail_count: 0,
            eval_pass_count: 1,
            round_completed_count: 1,
            expected_limit_count: 0,
            rollup_write_failures: 0,
            halt_reason: reason.map(Into::into),
        }
    }

    #[test]
    fn an_upsert_inserts_then_adds_to_the_day_row_and_its_halt_bucket() {
        let store = open_store();
        store
            .upsert_extract_rollup_day(&delta("atoms", "2026-11-19", 2, Some("llm_error"), 0.1))
            .unwrap();
        store
            .upsert_extract_rollup_day(&delta("atoms", "2026-11-19", 3, Some("llm_error"), 0.2))
            .unwrap();
        store
            .upsert_extract_rollup_day(&delta("atoms", "2026-11-19", 1, None, 0.0))
            .unwrap();
        store
            .upsert_extract_rollup_day(&delta("atoms", "2026-11-10", 0, None, 0.0))
            .unwrap();
        store
            .upsert_extract_rollup_day(&delta("facts", "2026-11-19", 0, None, 0.0))
            .unwrap();
        let rows = store.list_extract_rollup_days("2026-11-12").unwrap();
        let shape: Vec<_> = rows
            .iter()
            .map(|r| {
                (
                    r.kind.as_str(),
                    r.day.as_str(),
                    r.halt_count,
                    r.round_completed_count,
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![("atoms", "2026-11-19", 6, 3), ("facts", "2026-11-19", 0, 1)]
        );
        assert_eq!(
            rows[0].halt_reasons,
            json!({ "llm_error": 5 }).as_object().unwrap().clone()
        );
        assert_eq!(rows[0].cost_usd, 0.1f32 + 0.2f32);
        assert!(rows[1].halt_reasons.is_empty());
        assert_eq!(
            store.list_extract_rollup_days("2026-01-01").unwrap().len(),
            3
        );
    }

    #[test]
    fn an_upsert_refuses_a_bad_day_a_nul_and_an_overflow() {
        let store = open_store();
        for bad in ["2026-13-01", "2026/11/19", "yesterday"] {
            assert!(
                store
                    .upsert_extract_rollup_day(&delta("atoms", bad, 0, None, 0.0))
                    .is_err(),
                "{bad}"
            );
        }
        assert!(
            store
                .upsert_extract_rollup_day(&delta("a\0b", "2026-11-19", 0, None, 0.0))
                .is_err()
        );
        store
            .upsert_extract_rollup_day(&delta("atoms", "2026-11-19", i32::MAX, None, 0.0))
            .unwrap();
        assert!(
            store
                .upsert_extract_rollup_day(&delta("atoms", "2026-11-19", 1, None, 0.0))
                .is_err()
        );
        assert_eq!(
            store.list_extract_rollup_days("2026-11-19").unwrap()[0].halt_count,
            i32::MAX
        );
    }

    #[test]
    fn the_receipt_reads_see_the_slot_and_the_seal() {
        let store = open_store();
        assert_eq!(
            store
                .read_extract_receipt_slot("default", "extracts/r")
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            store
                .read_extract_receipt_seal("default", "extracts/r", 4)
                .unwrap(),
            None
        );
        let input = PageInput {
            page_type: "extract_receipt".into(),
            title: "r".into(),
            compiled_truth: "body".into(),
            chunker_version: Some(4.0),
            ..PageInput::default()
        };
        store
            .put_page(
                "extracts/r",
                &input,
                &PutPageOptions {
                    index: Some(false),
                    ..PutPageOptions::default()
                },
            )
            .unwrap();
        let slot = store
            .read_extract_receipt_slot("default", "extracts/r")
            .unwrap();
        assert_eq!(slot["type"], json!("extract_receipt"));
        assert_eq!(slot["withheld_source_path"], Value::Null);
        assert_eq!(
            store
                .read_extract_receipt_seal("default", "extracts/r", 5)
                .unwrap(),
            Some(false)
        );
    }
}
