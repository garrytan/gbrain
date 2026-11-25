//! A fact purge's derivation sweep (`continueDerivationSweep`; the SQL engines run the walk in src/core/page-body/segment-derive.ts
//! `runDerivationSweep`, whose statements test/derivation-sweep-sql-pin.test.ts pins). The walk is the same here, batch for batch.
//!
//! A call picks a recorded sweep of the source (the request named `first` before the others, oldest first; the source's records come
//! from its index, so other sources' records are never read) and walks one batch of it in one write transaction: the next `batchRows`
//! derivation rows of the source's pages after the record's cursor, in (page, pipeline, occurrence) order. A row in the sweep's scope (its
//! page was rewritten by the purge, or is deleted, or no live segment backs the row: `purge_probe::swept`) that holds a claim
//! (`purge_probe::holds_claim`, after the prefilter `has_words`) is deleted. A batch that did not reach the end of the walk stores the
//! cursor and the rows deleted (`found`); one that did ends the walk. The first walk (`sweep`) is followed by a `verify` walk from the
//! start, repeated until one deletes nothing.
//!
//! Scope entry. A page can enter a sweep's scope behind the walk without a derivation write: it is soft-deleted, or a live segment of
//! it is retired. The writers call [`note_scope_entry`], which notes the page on every record of its source (the SQL engines' trigger
//! writes `page_segment_derivation_purge_pages`); the end of a verify walk takes the notes, reads the first batch of the noted pages'
//! rows, and when it is not the whole of them or a row in it holds the claim walks only those pages again (`recheck`) before it
//! deletes the record. A record keeps at most `NOTE_CAP` notes; past that it walks everything again instead.
//!
//! Bounds. The derivation keys are not grouped by source, so a batch reads the physical keys in order and keeps those of the source's
//! pages; one batch visits at most `physical_cap(batchRows)` keys, however many belong to other sources, and when it stops there it
//! stores the physical cursor and the walk goes on (an interrupted scan is not the end of the walk). A call starts batches until
//! `totalMs` (`inlineMs` for the purge's own call, `inline`) has passed and always runs one. A bound store (the Rust arm) has one writer
//! and no statement budget, so no write is open at the end of a walk to wait for, no batch times out (none is halved, no row is deleted
//! unread, no record stalls) and `retry` has no stall to clear.
//!
//! Returns `{ deleted, work }`: the rows deleted by the batches of the first walk, and per page the rows of that walk that were in
//! scope (`scanned`), passed the prefilter (`normalized`) and were deleted.

use super::purge_probe::{has_words, holds_claim, sql_text, swept};
use super::purge_record::{
    SweepRecord, index_key, phase_of, record_key, records_of_source, request_uuid,
};
use super::{DERIVATION, DerivationRecord, derivation_key, derivation_prefix, kind_key};
use crate::Store;
use crate::kv::{KvRead, KvWrite, for_each_prefix_paged_from};
use crate::links::no_nul;
use crate::pages::{PageRecord, read_page_by_id};
use crate::{Result, StoreError, put_json};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

/// The most pages a record keeps notes for; past it the end of a walk walks everything again.
const NOTE_CAP: usize = 1000;

/// The most physical derivation keys one batch visits: a multiple of the batch, never less than a floor that keeps a small batch useful.
fn physical_cap(rows: usize) -> usize {
    rows.saturating_mul(8).max(512)
}

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

type PageWork = BTreeMap<u64, (i64, i64, i64)>;
/// A derivation row of the source with its page: key, page id, pipeline, occurrence, record.
type Row = (Vec<u8>, u64, String, i64, DerivationRecord, PageRecord);

/// What one batch did, for the call's totals.
struct Batch {
    walk_is_sweep: bool,
    /// Per page: rows in scope, rows past the prefilter, rows deleted.
    pages: PageWork,
    /// The derivation keys the batch visited (read by the tests that bound it).
    #[cfg_attr(not(test), allow(dead_code))]
    visited: usize,
}

/// What a scan of one batch found.
struct Scan {
    rows: Vec<Row>,
    visited: usize,
    /// The last key visited (not necessarily one of the source's): the cursor a batch that did not end the walk stores.
    last: Option<(u64, String, i64)>,
    /// The scan ran out of keys: no later key is left to walk.
    end: bool,
}

/// The page of a derivation key and its pipeline and occurrence, or none for a key that is not one.
fn parse_key(key: &[u8]) -> Option<(u64, String, i64)> {
    let page = key.get(2..10).and_then(crate::keys::be8)?;
    let tail = key.len().checked_sub(8).filter(|t| *t >= 11)?;
    let pipeline = String::from_utf8_lossy(&key[10..tail - 1]).into_owned();
    let occurrence = (crate::keys::be8(&key[tail..]).unwrap_or(0) ^ (1u64 << 63)) as i64;
    Some((page, pipeline, occurrence))
}

/// The smallest key after the row `(page, pipeline, occurrence)`.
fn after(cursor: &(u64, String, i64)) -> Vec<u8> {
    let mut key = derivation_key(cursor.0, &cursor.1, cursor.2);
    key.push(0);
    key
}

/// Up to `rows` derivation rows of the source's pages after `cursor`, in key order, visiting at most `cap` keys. With `only` it reads the
/// rows of those pages alone (page by page) instead of the whole namespace.
fn scan(
    read: &dyn KvRead,
    source_id: &str,
    cursor: Option<&(u64, String, i64)>,
    only: Option<&[u64]>,
    rows: usize,
    cap: usize,
) -> Result<Scan> {
    let mut out = Scan {
        rows: Vec::new(),
        visited: 0,
        last: None,
        end: true,
    };
    // The page of the last key, so a run of keys of one page is looked up once.
    let mut known: Option<(u64, Option<PageRecord>)> = None;
    let mut visit = |key: &[u8], value: &[u8], out: &mut Scan| -> Result<bool> {
        let Some((page_id, pipeline, occurrence)) = parse_key(key) else {
            return Ok(true);
        };
        out.visited += 1;
        out.last = Some((page_id, pipeline.clone(), occurrence));
        if known.as_ref().map(|(id, _)| *id) != Some(page_id) {
            known = Some((page_id, read_page_by_id(read, page_id)?));
        }
        if let Some((_, Some(page))) = &known
            && page.source_id == source_id
        {
            let d: DerivationRecord = serde_json::from_slice(value).map_err(StoreError::from)?;
            out.rows
                .push((key.to_vec(), page_id, pipeline, occurrence, d, page.clone()));
        }
        // Stop at a full batch or at the cap: the walk is not at its end.
        Ok(out.rows.len() < rows && out.visited < cap)
    };
    let mut stopped = false;
    match only {
        None => {
            let prefix = kind_key(DERIVATION);
            let from = cursor.map_or_else(|| prefix.clone(), after);
            for_each_prefix_paged_from(read, &prefix, &from, 8, &mut |k, v| {
                let go = visit(k, v, &mut out)?;
                stopped = !go;
                Ok(go)
            })?;
        }
        Some(pages) => {
            for page in pages
                .iter()
                .copied()
                .filter(|p| cursor.is_none_or(|c| *p >= c.0))
            {
                let prefix = derivation_prefix(page);
                let from = match cursor {
                    Some(c) if c.0 == page => after(c),
                    _ => prefix.clone(),
                };
                for_each_prefix_paged_from(read, &prefix, &from, 8, &mut |k, v| {
                    let go = visit(k, v, &mut out)?;
                    stopped = !go;
                    Ok(go)
                })?;
                if stopped {
                    break;
                }
            }
        }
    }
    out.end = !stopped;
    Ok(out)
}

/// What the sweep makes of one row: in scope, past the prefilter, holding the claim.
fn judge(
    read: &dyn KvRead,
    record: &SweepRecord,
    rewritten: &HashSet<i64>,
    row: &Row,
) -> Result<(bool, bool, bool)> {
    let (_, _, _, occurrence, d, page) = row;
    if !swept(read, d, page, *occurrence, rewritten)? {
        return Ok((false, false, false));
    }
    let candidate = has_words(
        &format!("{} {}", sql_text(&d.output), sql_text(&d.receipt)),
        &record.patterns,
    );
    Ok((
        true,
        candidate,
        candidate && holds_claim(d, &record.needles, &record.patterns),
    ))
}

/// Notes that `page_id` of `source_id` entered a sweep's scope without a derivation write (it was soft-deleted, or a live segment of it was
/// retired): every sweep record of the source gets the note, and its walk checks the page again before the record is deleted. The
/// SQL engines' triggers on `pages` and `page_body_manifest` do this into `page_segment_derivation_purge_pages`.
pub(crate) fn note_scope_entry(tx: &mut dyn KvWrite, source_id: &str, page_id: u64) -> Result<()> {
    for mut record in records_of_source(&*tx, source_id)? {
        if record.noted_overflow || record.noted.contains(&page_id) {
            continue;
        }
        if record.noted.len() >= NOTE_CAP {
            record.noted.clear();
            record.noted_overflow = true;
        } else {
            record.noted.push(page_id);
        }
        put_json(tx, &record_key(&record.request_id), &record)?;
    }
    Ok(())
}

/// A manifest row is deleted: when it is a live published row (no close, no staging) its page enters the scope of every sweep of the row's
/// own source (`source_id` of the row, as the SQL trigger on `page_body_manifest` reads `OLD.source_id`, not the page's).
pub(crate) fn note_row_gone(tx: &mut dyn KvWrite, row: &super::ManifestRow) -> Result<()> {
    if row.gen_to.is_none()
        && row.staging_id.is_none()
        && let Ok(page) = u64::try_from(row.page_id)
    {
        note_scope_entry(tx, &row.source_id, page)?;
    }
    Ok(())
}

/// The record goes back to the start of a full verify walk; the notes taken so far are covered by it.
fn to_verify(record: &mut SweepRecord) {
    record.phase = "verify".to_string();
    record.cursor = None;
    record.found = 0;
    record.recheck = None;
    record.noted.clear();
    record.noted_overflow = false;
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
        let mut work: PageWork = BTreeMap::new();
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
            let mut records = records_of_source(&*tx, source_id)?;
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
            let cap = physical_cap(rows);
            let only = record.recheck.clone();
            let scanned = scan(
                &*tx,
                source_id,
                record.cursor.as_ref(),
                only.as_deref(),
                rows,
                cap,
            )?;
            let rewritten: HashSet<i64> = record.page_ids.iter().copied().collect();
            let mut pages: PageWork = BTreeMap::new();
            let mut gone: Vec<Vec<u8>> = Vec::new();
            for row in &scanned.rows {
                let (in_scope, candidate, hit) = judge(&*tx, &record, &rewritten, row)?;
                if !in_scope {
                    continue;
                }
                let entry = pages.entry(row.1).or_default();
                entry.0 += 1;
                entry.1 += i64::from(candidate);
                if hit {
                    entry.2 += 1;
                    gone.push(row.0.clone());
                }
            }
            for key in &gone {
                tx.delete(key)?;
            }
            let walk_is_sweep = phase_of(&record) == "sweep";
            let found = record.found + i64::try_from(gone.len()).unwrap_or(i64::MAX);
            let key = record_key(&record.request_id);
            if !scanned.end {
                // Not at the end of the walk: a full batch, or a scan the cap stopped: store where it got to.
                record.cursor = scanned.last.clone();
                record.found = found;
                put_json(tx, &key, &record)?;
            } else if walk_is_sweep || (phase_of(&record) == "verify" && found > 0) {
                // The end of the first walk, or of a verify walk that still deleted rows: walk everything again.
                to_verify(&mut record);
                put_json(tx, &key, &record)?;
            } else if record.noted_overflow {
                to_verify(&mut record);
                put_json(tx, &key, &record)?;
            } else {
                // The end of a verify or recheck walk that deleted nothing, under the notes: check the pages noted since.
                let noted = std::mem::take(&mut record.noted);
                let mut again = false;
                if !noted.is_empty() {
                    let mut pages_noted = noted.clone();
                    pages_noted.sort_unstable();
                    pages_noted.dedup();
                    let check = scan(&*tx, source_id, None, Some(&pages_noted), rows, cap)?;
                    let mut hit = false;
                    for row in &check.rows {
                        hit |= judge(&*tx, &record, &rewritten, row)?.2;
                    }
                    if !check.end || hit {
                        record.phase = "recheck".to_string();
                        record.recheck = Some(pages_noted);
                        record.cursor = None;
                        record.found = 0;
                        again = true;
                    }
                }
                if again {
                    put_json(tx, &key, &record)?;
                } else {
                    // Nothing left holds the claim: the record is done.
                    tx.delete(&key)?;
                    tx.delete(&index_key(&record.source_id, &record.request_id))?;
                }
            }
            Ok(Some(Batch {
                walk_is_sweep,
                pages,
                visited: scanned.visited,
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::page_body::{SegmentDerivationInput, SegmentedPageMeta};
    use crate::sources::SourceInput;

    fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_batch_visits_a_bounded_number_of_keys_however_many_other_sources_hold() {
        let store = crate::test_support::store();
        let other: SourceInput = args(json!({ "id": "other", "name": "other", "config": {} }));
        store.upsert_source(&other).unwrap();
        let meta: SegmentedPageMeta = args(json!({ "type": "note", "title": "other" }));
        let page = store
            .create_segmented_page_shell(
                "notes/other",
                &meta,
                &args(json!({ "sourceId": "other" })),
            )
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        let hash = "00".repeat(32);
        let derivations: Vec<SegmentDerivationInput> = (1..=3000)
            .map(|occurrence| {
                args(json!({ "pageId": page, "kind": "links", "occurrenceId": occurrence, "version": 1,
                    "segmentSha256": hash, "contextHash": hash, "state": "done", "output": { "excerpt": "harmless" } }))
            })
            .collect();
        store.upsert_segment_derivations(&derivations).unwrap();
        // A record of `default`, which has no derivation at all, while `other` has three thousand.
        store
            .record_derivation_purge_row(&args(json!({ "requestId": "d0000000-0000-4000-8000-0000000000d1", "sourceId": "default",
                "needles": [" alice likes tea "], "patterns": ["%alice%likes%tea%"], "pageIds": [] })))
            .unwrap();
        let cap = physical_cap(2);
        let mut visited = Vec::new();
        for _ in 0..40 {
            match store.sweep_batch("default", None, 2).unwrap() {
                Some(batch) => visited.push(batch.visited),
                None => break,
            }
        }
        // Every batch visited at most the cap; the first ones were stopped by it, so the walk went on past them instead of ending on the first.
        assert!(visited.iter().all(|n| *n <= cap), "{visited:?}");
        assert_eq!(visited[0], cap);
        assert!(visited.len() > 6, "{visited:?}");
        // The walk still ends: the sweep walk, a verify walk of the same keys, then the record is gone.
        assert!(store.sweep_batch("default", None, 2).unwrap().is_none());
        assert_eq!(
            visited.iter().sum::<usize>(),
            2 * 3000 + visited.len().saturating_sub(2 * 3000 / cap + 2)
        );
    }

    #[test]
    fn a_record_kept_before_the_source_index_existed_is_found_after_the_repair_at_open() {
        use crate::OpenOptions;
        use crate::env::SystemEnv;
        use std::sync::Arc;
        let kv = crate::test_support::mem_kv();
        let open =
            || Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
        let found = |store: &Store| {
            records_of_source(&*store.read().unwrap(), "default")
                .unwrap()
                .len()
        };
        let store = open();
        let request = "d0000000-0000-4000-8000-0000000000d1";
        let record = |claim: &str| {
            store
                .record_derivation_purge_row(&args(json!({ "requestId": request, "sourceId": "default",
                    "needles": [format!(" {claim} ")], "patterns": [format!("%{claim}%")], "pageIds": [] })))
                .unwrap();
        };
        let unindex = || {
            let mut tx = kv.begin_write().unwrap();
            tx.delete(&index_key("default", request)).unwrap();
            // A brain an earlier build wrote: no completion marker of the repair either.
            tx.delete(&super::super::purge_record::repair_done_key())
                .unwrap();
            tx.commit().unwrap();
        };
        record("alice");
        assert_eq!(found(&store), 1);
        // The record as an earlier build wrote it: no index entry, so no sweep selects it.
        unindex();
        assert_eq!(found(&store), 0);
        assert!(store.sweep_batch("default", None, 2).unwrap().is_none());
        // Recording it again repairs the entry (the conflict path).
        record("other");
        assert_eq!(found(&store), 1);
        // The next open repairs it too, and the sweep then walks the record.
        unindex();
        drop(store);
        let reopened = open();
        assert_eq!(found(&reopened), 1);
        assert!(reopened.sweep_batch("default", None, 2).unwrap().is_some());
    }
}
