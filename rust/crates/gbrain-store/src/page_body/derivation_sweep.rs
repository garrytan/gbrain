//! A fact purge's derivation sweep (`continueDerivationSweep`; the SQL engines run the walk in src/core/page-body/segment-derive.ts
//! `runDerivationSweep`, whose statements test/derivation-sweep-sql-pin.test.ts pins). The walk is the same here, batch for batch.
//!
//! A call picks a recorded sweep of the source (the request named `first` before the others, oldest first) and walks one batch of it in
//! one write transaction: the next `batchRows` derivation rows of the source's pages after the record's cursor, in (page, pipeline,
//! occurrence) order. A row in the sweep's scope (its page was rewritten by the purge, or is deleted, or no live segment backs the
//! row: `purge_probe::swept`) that holds a claim (`purge_probe::holds_claim`, after the prefilter `has_words`) is deleted. A batch that
//! read a full `batchRows` rows stores the cursor and the rows deleted (`found`); a shorter one ends the walk. The first walk
//! (`sweep`) is followed by a `verify` walk from the start, repeated until one deletes nothing; then the record is deleted.
//!
//! A call starts batches until `totalMs` (`inlineMs` for the purge's own call, `inline`) has passed, and always runs one. A bound
//! store (the Rust arm) has one writer and no statement budget, so no write is open at the end of a walk to wait for, no batch
//! times out (none is halved, no row is deleted unread, no record stalls) and `retry` has no stall to clear. The scope-entry
//! notes (`page_segment_derivation_purge_pages`) are never written, so a walk's end never re-checks a noted page.
//!
//! Returns `{ deleted, work }`: the rows deleted by the batches of the first walk, and per page the rows of that walk that were in
//! scope (`scanned`), passed the prefilter (`normalized`) and were deleted.

use super::purge_probe::{has_words, holds_claim, sql_text, swept};
use super::purge_record::{SweepRecord, phase_of, request_uuid};
use super::{DERIVATION, DERIVATION_PURGE, DerivationRecord, derivation_key, kind_key};
use crate::Store;
use crate::facts::purge_probe::json_rows;
use crate::kv::for_each_prefix_paged_from;
use crate::links::no_nul;
use crate::pages::read_page_by_id;
use crate::{Result, StoreError, put_json};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

/// `continueDerivationSweep(sourceId, opts, limits)` as the store takes it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivationSweepArgs {
    pub source_id: String,
    pub first: Option<String>,
    pub retry: Option<String>,
    pub inline: bool,
    pub batch_rows: i64,
    pub total_ms: i64,
    pub inline_ms: i64,
}

/// What one batch did, for the call's totals.
struct Batch {
    walk_is_sweep: bool,
    /// Per page: rows in scope, rows past the prefilter, rows deleted.
    pages: BTreeMap<u64, (i64, i64, i64)>,
}

impl Store {
    /// `continueDerivationSweep`: see the module comment.
    pub fn continue_derivation_sweep(&self, q: &DerivationSweepArgs) -> Result<Value> {
        const OP: &str = "continueDerivationSweep";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        let first = q.first.as_deref().map(request_uuid).transpose()?;
        // A stalled record is the only thing a retry clears, and this store stalls none: the id is read as a uuid, as the SQL binds it.
        q.retry.as_deref().map(request_uuid).transpose()?;
        let rows = usize::try_from(q.batch_rows)
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| {
                StoreError::invalid(format!("{OP}: batchRows must be a positive whole number"))
            })?;
        let budget = if q.inline {
            q.inline_ms.min(q.total_ms)
        } else {
            q.total_ms
        };
        let deadline = Instant::now() + Duration::from_millis(u64::try_from(budget).unwrap_or(0));
        let mut work: BTreeMap<u64, (i64, i64, i64)> = BTreeMap::new();
        let mut batches = 0usize;
        while batches == 0 || Instant::now() <= deadline {
            let Some(batch) = self.sweep_batch(&q.source_id, first.as_deref(), rows)? else {
                break;
            };
            if batch.walk_is_sweep {
                for (page, (scanned, normalized, deleted)) in batch.pages {
                    let total = work.entry(page).or_default();
                    *total = (total.0 + scanned, total.1 + normalized, total.2 + deleted);
                }
            }
            batches += 1;
        }
        let deleted: i64 = work.values().map(|w| w.2).sum();
        Ok(json!({
            "deleted": deleted,
            "work": work.iter().map(|(page, (scanned, normalized, deleted))|
                json!({ "pageId": page, "scanned": scanned, "normalized": normalized, "deleted": deleted })).collect::<Vec<_>>(),
        }))
    }

    /// One batch of the next record: none when the source has no record to walk.
    fn sweep_batch(
        &self,
        source_id: &str,
        first: Option<&str>,
        rows: usize,
    ) -> Result<Option<Batch>> {
        self.write(|tx| {
            let mut records: Vec<SweepRecord> = json_rows(&*tx, &kind_key(DERIVATION_PURGE))?;
            records.retain(|r| r.source_id == source_id);
            records.sort_by(|a, b| {
                let named = |r: &SweepRecord| first != Some(r.request_id.as_str());
                (named(a), a.created_at_us, &a.request_id).cmp(&(
                    named(b),
                    b.created_at_us,
                    &b.request_id,
                ))
            });
            let Some(mut record) = records.into_iter().next() else {
                return Ok(None);
            };
            let prefix = kind_key(DERIVATION);
            let from = match &record.cursor {
                None => prefix.clone(),
                Some((page, pipeline, occurrence)) => {
                    let mut key = derivation_key(*page, pipeline, *occurrence);
                    // The smallest key after the cursor's.
                    key.push(0);
                    key
                }
            };
            // The batch: the next `rows` derivation rows of the source's pages. One scan at a time in a write transaction, so read them
            // all first and judge them after.
            let mut batch: Vec<(
                Vec<u8>,
                u64,
                String,
                i64,
                DerivationRecord,
                crate::pages::PageRecord,
            )> = Vec::new();
            for_each_prefix_paged_from(&*tx, &prefix, &from, 8, &mut |key, value| {
                let (Some(page_id), Some(tail)) = (
                    key.get(2..10).and_then(crate::keys::be8),
                    key.len().checked_sub(8),
                ) else {
                    return Ok(true);
                };
                let Some(page) = read_page_by_id(&*tx, page_id)? else {
                    return Ok(true);
                };
                if page.source_id != source_id || tail < 11 {
                    return Ok(true);
                }
                let d: DerivationRecord =
                    serde_json::from_slice(value).map_err(StoreError::from)?;
                let pipeline = String::from_utf8_lossy(&key[10..tail - 1]).into_owned();
                let occurrence =
                    (crate::keys::be8(&key[tail..]).unwrap_or(0) ^ (1u64 << 63)) as i64;
                batch.push((key.to_vec(), page_id, pipeline, occurrence, d, page));
                Ok(batch.len() < rows)
            })?;
            let rewritten: HashSet<i64> = record.page_ids.iter().copied().collect();
            let mut pages: BTreeMap<u64, (i64, i64, i64)> = BTreeMap::new();
            let mut gone: Vec<Vec<u8>> = Vec::new();
            for (key, page_id, _, occurrence, d, page) in &batch {
                if !swept(&*tx, d, page, *occurrence, &rewritten)? {
                    continue;
                }
                let entry = pages.entry(*page_id).or_default();
                entry.0 += 1;
                if has_words(
                    &format!("{} {}", sql_text(&d.output), sql_text(&d.receipt)),
                    &record.patterns,
                ) {
                    entry.1 += 1;
                    if holds_claim(d, &record.needles, &record.patterns) {
                        entry.2 += 1;
                        gone.push(key.clone());
                    }
                }
            }
            for key in &gone {
                tx.delete(key)?;
            }
            let walk_is_sweep = phase_of(&record) == "sweep";
            let found = record.found + i64::try_from(gone.len()).unwrap_or(i64::MAX);
            let key = super::purge_record::record_key(&record.request_id);
            if batch.len() == rows {
                let (_, page, pipeline, occurrence, ..) =
                    batch.last().expect("a full batch has a last row");
                record.cursor = Some((*page, pipeline.clone(), *occurrence));
                record.found = found;
                put_json(tx, &key, &record)?;
            } else if walk_is_sweep || found > 0 {
                // The end of the first walk, or of a verify walk that still deleted rows: walk again from the start.
                record.phase = "verify".to_string();
                record.cursor = None;
                record.found = 0;
                put_json(tx, &key, &record)?;
            } else {
                // A verify walk that deleted nothing: every row it read is clean, and the record is done.
                tx.delete(&key)?;
            }
            Ok(Some(Batch {
                walk_is_sweep,
                pages,
            }))
        })
    }
}
