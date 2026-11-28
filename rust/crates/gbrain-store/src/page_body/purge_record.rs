//! A fact purge's derivation sweep record (`page_segment_derivation_purges`; SQL in src/core/engine-sql/purge-receipt.ts).
//!
//! Members: `recordDerivationPurgeRow` (the purge's `INSERT ... ON CONFLICT (request_id) DO NOTHING`) and `readDerivationPurgeState`.
//! The record is the claim's folded forms (`needles`, `patterns`) and `page_ids`, the pages the purge rewrote, keyed by the
//! purge request: `b 0x09 <request id>`. The walk (derivation_sweep.rs) keeps its phase, cursor and found count in the record. The
//! store has no statement budget and no scope lock, so a record is never stalled and never waits on a lock
//! (`readDerivationPurgeState` answers `pending` with no reason for it, null for no record).
//!
//! While a record is there, `upsertSegmentDerivations` drops a row of the record's source that the sweep would delete (its
//! page rewritten by the purge, deleted, or no live segment backing the row: `purge_probe::swept`) and that holds the claim
//! (`purge_probe::holds_claim`), as the trigger `gbrain_refuse_purging_derivation` does (`sweep_drops`). The scope-entry
//! trigger's page notes (`page_segment_derivation_purge_pages`) have no reader here, because nothing walks the record.
//! The table probe streams the records as rows (`probe_records`).

use super::purge_probe::{holds_claim, swept};
use super::{DERIVATION_PURGE, DERIVATION_PURGE_BY_SOURCE, DerivationRecord, kind_key, violation};
use crate::Store;
use crate::facts::purge_probe::{EachRow, ProbeCell, ProbeRow, each_json};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::PageRecord;
use crate::sources::read_source;
use crate::{Result, StoreError, get_json, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

/// One recorded sweep. `page_ids` keep the order the purge gave them (the table's `int[]`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SweepRecord {
    pub(super) request_id: String,
    pub(super) source_id: String,
    pub(super) needles: Vec<String>,
    pub(super) patterns: Vec<String>,
    pub(super) page_ids: Vec<i64>,
    pub(super) created_at_us: i64,
    /// The walk the record is in: `sweep` (empty for a record kept before the store walked), then `verify` until a walk deletes nothing.
    #[serde(default)]
    pub(super) phase: String,
    /// The key of the last row the walk read: `(page, pipeline, occurrence)`; none before its first batch and after a walk ends.
    #[serde(default)]
    pub(super) cursor: Option<(u64, String, i64)>,
    /// The rows the current walk has deleted.
    #[serde(default)]
    pub(super) found: i64,
    /// Pages that entered the sweep's scope (soft-deleted, or a live segment retired) since the walk began, in the order they were
    /// noted: the end of a walk checks them again (`derivation_sweep::note_scope_entry`; the SQL engines' `page_segment_derivation_purge_pages`).
    #[serde(default)]
    pub(super) noted: Vec<u64>,
    /// More pages entered the scope than the record keeps: the end of the walk walks everything again instead of checking them.
    #[serde(default)]
    pub(super) noted_overflow: bool,
    /// The noted pages a `recheck` walk is limited to, in page order.
    #[serde(default)]
    pub(super) recheck: Option<Vec<u64>>,
}

/// `recordDerivationPurgeRow`'s arguments: the purge request and what its sweep searches for.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivationPurgeRecordArgs {
    pub request_id: String,
    pub source_id: String,
    pub needles: Vec<String>,
    pub patterns: Vec<String>,
    pub page_ids: Vec<i64>,
}

/// `readDerivationPurgeState`'s arguments.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivationPurgeStateArgs {
    pub request_id: String,
}

/// The index key of a record under its source (`DERIVATION_PURGE_BY_SOURCE`).
pub(super) fn index_key(source_id: &str, request_id: &str) -> Vec<u8> {
    let mut key = source_index_prefix(source_id);
    key.extend_from_slice(request_id.as_bytes());
    key
}

fn source_index_prefix(source_id: &str) -> Vec<u8> {
    let mut key = kind_key(DERIVATION_PURGE_BY_SOURCE);
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key
}

/// The sweep records of one source, read through the source's index: the records of other sources are not read.
pub(super) fn records_of_source(read: &dyn KvRead, source_id: &str) -> Result<Vec<SweepRecord>> {
    let mut requests: Vec<String> = Vec::new();
    scan_prefix(read, &source_index_prefix(source_id), false, &mut |_, v| {
        requests.push(String::from_utf8_lossy(v).into_owned());
        true
    })?;
    let mut out = Vec::with_capacity(requests.len());
    for request in requests {
        if let Some(record) = get_json::<SweepRecord>(read, &record_key(&request))? {
            out.push(record);
        }
    }
    Ok(out)
}

/// A source delete's cascade to the sweep records of the source (`page_segment_derivation_purges.source_id ... ON DELETE
/// CASCADE`): removes each record the source index names, with its index entry. A record's page notes live in the record,
/// so they go with it. The open-time repair (`backfill_source_index`) indexes every record before any write is admitted,
/// so the index names them all.
pub(crate) fn remove_source_records(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut requests: Vec<String> = Vec::new();
    scan_prefix(&*tx, &source_index_prefix(source_id), false, &mut |_, v| {
        requests.push(String::from_utf8_lossy(v).into_owned());
        true
    })?;
    for request in requests {
        tx.delete(&record_key(&request))?;
        tx.delete(&index_key(source_id, &request))?;
    }
    Ok(())
}

/// Records indexed per write transaction by the open-time repair.
const REPAIR_BATCH: usize = 256;

/// The marker of a completed repair of the source index.
pub(crate) fn repair_done_key() -> Vec<u8> {
    crate::keys::meta("derivation_purge_source_index")
}

/// Gives every sweep record its source index entry: records kept by the builds between the record's first commit and the index lack
/// one, and so are never selected by a sweep, noted or consulted by the write guard. Runs at open, to completion before the open
/// returns, so no write is admitted before every record is covered. A completed run leaves a marker, after which an open reads that
/// one key. It works in write transactions of `REPAIR_BATCH` records each, discovering and writing inside the same transaction, and
/// writes the marker in the one that reaches the end. A read-only open (its write is refused with `read_only_transaction`) does not
/// scan and leaves the records for the next writable open; any other failure to write fails the open. `before_commit` runs
/// inside each write right before it commits (the primary fence of a store that finishes this upkeep when it starts
/// serving, `primary.rs`); its error ends the run.
pub(crate) fn backfill_source_index(
    kv: &dyn crate::kv::Kv,
    before_commit: &dyn Fn(&mut dyn crate::kv::KvWrite) -> Result<()>,
) -> Result<()> {
    let done = repair_done_key();
    if kv.snapshot()?.get(&done)?.is_some() {
        return Ok(());
    }
    let prefix = kind_key(DERIVATION_PURGE);
    let end = crate::kv::prefix_end(&prefix).unwrap_or_else(|| vec![0xFF; 64]);
    let mut from = prefix;
    loop {
        let mut tx = match kv.begin_write() {
            Ok(tx) => tx,
            Err(e) if e.code == crate::error::READ_ONLY_TRANSACTION => return Ok(()),
            Err(e) => return Err(e),
        };
        // Another handle may have finished the repair between the marker's read and this write.
        if tx.get(&done)?.is_some() {
            return Ok(());
        }
        let mut batch: Vec<(Vec<u8>, SweepRecord)> = Vec::new();
        let mut failure = None;
        tx.scan(&from, &end, false, &mut |k, v| {
            match serde_json::from_slice::<SweepRecord>(v) {
                Ok(record) => batch.push((k.to_vec(), record)),
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none() && batch.len() < REPAIR_BATCH
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        for (_, record) in &batch {
            let key = index_key(&record.source_id, &record.request_id);
            if tx.get(&key)?.is_none() {
                tx.put(&key, record.request_id.as_bytes())?;
            }
        }
        let finished = batch.len() < REPAIR_BATCH;
        if finished {
            tx.put(&done, b"1")?;
        } else if let Some((last, _)) = batch.last() {
            // The smallest key after the last one the batch read.
            from = last.clone();
            from.push(0);
        }
        before_commit(&mut *tx)?;
        tx.commit()?;
        if finished {
            return Ok(());
        }
    }
}

pub(super) fn record_key(request_id: &str) -> Vec<u8> {
    let mut key = kind_key(DERIVATION_PURGE);
    key.extend_from_slice(request_id.as_bytes());
    key
}

/// `$1::uuid`: the canonical lowercase hyphenated text of a uuid, in every spelling Postgres accepts (`uuid_in`: optional braces,
/// two hex digits per byte, an optional hyphen after any group of four digits but the last, upper or lower case), or the
/// error Postgres raises for text that is not one. The record's key, its lookup and its conflict check all use this form.
pub(super) fn request_uuid(text: &str) -> Result<String> {
    let bad = || StoreError::invalid(format!("invalid input syntax for type uuid: \"{text}\""));
    let bytes = text.as_bytes();
    let braced = bytes.first() == Some(&b'{');
    let mut at = usize::from(braced);
    let mut digits = String::with_capacity(32);
    for i in 0..16 {
        let pair = bytes.get(at..at + 2).ok_or_else(bad)?;
        if !pair.iter().all(u8::is_ascii_hexdigit) {
            return Err(bad());
        }
        digits.extend(pair.iter().map(|b| char::from(b.to_ascii_lowercase())));
        at += 2;
        if i % 2 == 1 && i < 15 && bytes.get(at) == Some(&b'-') {
            at += 1;
        }
    }
    if braced {
        if bytes.get(at) != Some(&b'}') {
            return Err(bad());
        }
        at += 1;
    }
    if at != bytes.len() {
        return Err(bad());
    }
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &digits[..8],
        &digits[8..12],
        &digits[12..16],
        &digits[16..20],
        &digits[20..]
    ))
}

/// Whether a recorded sweep of the page's source drops this derivation row: the trigger's condition (the row is in a sweep's
/// scope and holds its claim). `occurrence` is the row's occurrence id.
pub(super) fn sweep_drops(
    read: &dyn KvRead,
    row: &DerivationRecord,
    page: &PageRecord,
    occurrence: i64,
) -> Result<bool> {
    // Read the records first: `swept` scans the manifest, and a write transaction takes one scan at a time.
    for record in records_of_source(read, &page.source_id)? {
        let rewritten: HashSet<i64> = record.page_ids.iter().copied().collect();
        if holds_claim(row, &record.needles, &record.patterns)
            && swept(read, row, page, occurrence, &rewritten)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The walk a record is in; a record kept before the store walked (no phase) is in the first.
pub(super) fn phase_of(record: &SweepRecord) -> &str {
    if record.phase.is_empty() {
        "sweep"
    } else {
        &record.phase
    }
}

/// The records as the table probe reads them: `source_id`, the two `text[]` columns, `page_ids` as `int[]` prints it, and the
/// phase and cursor pipeline of its walk; the recheck and the stall columns are NULL (the store has no scope lock or statement budget).
pub(crate) fn probe_records(read: &dyn KvRead, f: EachRow) -> Result<()> {
    each_json::<SweepRecord>(read, &kind_key(DERIVATION_PURGE), &mut |_, record| {
        let ids: Vec<String> = record.page_ids.iter().map(i64::to_string).collect();
        f(ProbeRow {
            source_id: Some(record.source_id.clone()),
            cells: vec![
                ("source_id", ProbeCell::text(&record.source_id)),
                ("needles", ProbeCell::text_array(&record.needles)),
                ("patterns", ProbeCell::text_array(&record.patterns)),
                (
                    "page_ids",
                    ProbeCell::text(&format!("{{{}}}", ids.join(","))),
                ),
                ("phase", ProbeCell::text(phase_of(&record))),
                (
                    "recheck",
                    record.recheck.as_ref().map_or(ProbeCell::Null, |pages| {
                        ProbeCell::text(&format!(
                            "{{{}}}",
                            pages
                                .iter()
                                .map(u64::to_string)
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    }),
                ),
                (
                    "cursor_pipeline",
                    record
                        .cursor
                        .as_ref()
                        .map_or(ProbeCell::Null, |c| ProbeCell::text(&c.1)),
                ),
                ("stalled_reason", ProbeCell::Null),
                ("pending_reason", ProbeCell::Null),
            ],
        })
    })
}

impl Store {
    /// `recordDerivationPurgeRow`: keeps the record of a purge's sweep unless the request has one already (`ON CONFLICT
    /// (request_id) DO NOTHING`). Refuses a request id that is not a uuid, a page id outside `integer`, and, for a new
    /// record, a source that does not exist (the `source_id` foreign key).
    pub fn record_derivation_purge_row(&self, q: &DerivationPurgeRecordArgs) -> Result<()> {
        const OP: &str = "recordDerivationPurgeRow";
        let request_id = request_uuid(&q.request_id)?;
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        for text in q.needles.iter().chain(&q.patterns) {
            no_nul(OP, &[("needles", text)])?;
        }
        if q.page_ids.iter().any(|id| i32::try_from(*id).is_err()) {
            return Err(StoreError::invalid(format!(
                "{OP}: a page id is out of range for type integer"
            )));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let key = record_key(&request_id);
            if let Some(kept) = get_json::<SweepRecord>(&*tx, &key)? {
                // A record kept before the source index existed gets its index entry here, as at open (`backfill_source_index`).
                tx.put(&index_key(&kept.source_id, &request_id), request_id.as_bytes())?;
                return Ok(());
            }
            if read_source(&*tx, &q.source_id)?.is_none() {
                return Err(violation(format!(
                    "insert or update on table \"page_segment_derivation_purges\" violates foreign key constraint (source \"{}\" does not exist)",
                    q.source_id
                )));
            }
            put_json(
                tx,
                &key,
                &SweepRecord {
                    request_id: request_id.clone(),
                    source_id: q.source_id.clone(),
                    needles: q.needles.clone(),
                    patterns: q.patterns.clone(),
                    page_ids: q.page_ids.clone(),
                    created_at_us: now,
                    phase: "sweep".to_string(),
                    cursor: None,
                    found: 0,
                    noted: Vec::new(),
                    noted_overflow: false,
                    recheck: None,
                },
            )?;
            tx.put(&index_key(&q.source_id, &request_id), request_id.as_bytes())
        })
    }

    /// `readDerivationPurgeState`: `{ state: "pending", reason: null }` for a recorded sweep, null for none. The store walks
    /// no sweep, so no record is stalled or waiting on a scope lock.
    pub fn read_derivation_purge_state(&self, q: &DerivationPurgeStateArgs) -> Result<Value> {
        let request_id = request_uuid(&q.request_id)?;
        let read = self.read()?;
        Ok(
            match get_json::<SweepRecord>(&*read, &record_key(&request_id))? {
                Some(_) => json!({ "state": "pending", "reason": null }),
                None => Value::Null,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OpenOptions;
    use crate::env::SystemEnv;
    use crate::error::{READ_ONLY_TRANSACTION, STORE_IO};
    use crate::kv::{Kv, KvWrite};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A kv that counts what the open-time repair reads and writes, and refuses a write with the code it is told to.
    struct Watched {
        inner: Arc<dyn Kv>,
        scans: Arc<AtomicUsize>,
        gets: Arc<AtomicUsize>,
        begins: Arc<AtomicUsize>,
        refuse: Option<&'static str>,
    }

    struct WatchedRead(Box<dyn KvRead>, Arc<AtomicUsize>, Arc<AtomicUsize>);
    struct WatchedWrite(Box<dyn KvWrite>, Arc<AtomicUsize>, Arc<AtomicUsize>);

    impl KvRead for WatchedRead {
        fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
            self.2.fetch_add(1, Ordering::SeqCst);
            self.0.get(key)
        }
        fn scan(
            &self,
            start: &[u8],
            end: &[u8],
            reverse: bool,
            f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
        ) -> Result<()> {
            self.1.fetch_add(1, Ordering::SeqCst);
            self.0.scan(start, end, reverse, f)
        }
    }

    impl KvRead for WatchedWrite {
        fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
            self.2.fetch_add(1, Ordering::SeqCst);
            self.0.get(key)
        }
        fn scan(
            &self,
            start: &[u8],
            end: &[u8],
            reverse: bool,
            f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
        ) -> Result<()> {
            self.1.fetch_add(1, Ordering::SeqCst);
            self.0.scan(start, end, reverse, f)
        }
    }

    impl KvWrite for WatchedWrite {
        fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
            self.0.put(key, value)
        }
        fn delete(&mut self, key: &[u8]) -> Result<()> {
            self.0.delete(key)
        }
        fn commit(self: Box<Self>) -> Result<u64> {
            self.0.commit()
        }
    }

    impl Kv for Watched {
        fn snapshot(&self) -> Result<Box<dyn KvRead>> {
            Ok(Box::new(WatchedRead(
                self.inner.snapshot()?,
                self.scans.clone(),
                self.gets.clone(),
            )))
        }
        fn versioned_snapshot(&self) -> Result<(Box<dyn KvRead + Send>, u64)> {
            self.inner.versioned_snapshot()
        }
        fn begin_write(&self) -> Result<Box<dyn KvWrite>> {
            self.begins.fetch_add(1, Ordering::SeqCst);
            if let Some(code) = self.refuse {
                return Err(StoreError::new(code, "refused"));
            }
            Ok(Box::new(WatchedWrite(
                self.inner.begin_write()?,
                self.scans.clone(),
                self.gets.clone(),
            )))
        }
        fn version(&self) -> Result<u64> {
            self.inner.version()
        }
    }

    fn watched(
        inner: &Arc<dyn Kv>,
        refuse: Option<&'static str>,
    ) -> (Watched, [Arc<AtomicUsize>; 3]) {
        let counters = [
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        ];
        let kv = Watched {
            inner: inner.clone(),
            scans: counters[0].clone(),
            gets: counters[1].clone(),
            begins: counters[2].clone(),
            refuse,
        };
        (kv, counters)
    }

    fn count(c: &Arc<AtomicUsize>) -> usize {
        c.load(Ordering::SeqCst)
    }

    /// `n` sweep records as an earlier build kept them: no source index entry, and no completion marker.
    fn unindexed(kv: &Arc<dyn Kv>, n: usize) {
        let store =
            Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
        let mut tx = kv.begin_write().unwrap();
        for i in 0..n {
            let request = format!("d0000000-0000-4000-8000-{i:012}");
            let record = SweepRecord {
                request_id: request.clone(),
                source_id: "default".into(),
                needles: vec![],
                patterns: vec![],
                page_ids: vec![],
                created_at_us: i as i64,
                phase: "sweep".into(),
                cursor: None,
                found: 0,
                noted: vec![],
                noted_overflow: false,
                recheck: None,
            };
            put_json(&mut *tx, &record_key(&request), &record).unwrap();
        }
        tx.delete(&repair_done_key()).unwrap();
        tx.commit().unwrap();
        drop(store);
    }

    fn indexed(kv: &Arc<dyn Kv>) -> usize {
        records_of_source(&*kv.snapshot().unwrap(), "default")
            .unwrap()
            .len()
    }

    #[test]
    fn a_read_only_open_does_not_scan_and_leaves_the_records_for_the_next_writable_open() {
        let kv = crate::test_support::mem_kv();
        unindexed(&kv, 3);
        let (read_only, [scans, _, begins]) = watched(&kv, Some(READ_ONLY_TRANSACTION));
        backfill_source_index(&read_only, &|_| Ok(())).unwrap();
        assert_eq!(
            (count(&scans), count(&begins)),
            (0, 1),
            "one refused write, no scan"
        );
        assert_eq!(indexed(&kv), 0);
    }

    #[test]
    fn once_the_repair_has_run_an_open_reads_only_the_marker() {
        let kv = crate::test_support::mem_kv();
        unindexed(&kv, 3);
        backfill_source_index(&*kv, &|_| Ok(())).unwrap();
        assert_eq!(indexed(&kv), 3);
        let (second, [scans, gets, begins]) = watched(&kv, None);
        backfill_source_index(&second, &|_| Ok(())).unwrap();
        assert_eq!((count(&scans), count(&gets), count(&begins)), (0, 1, 0));
    }

    #[test]
    fn a_repair_across_several_batches_indexes_every_record_and_marks_the_end_with_the_last_batch()
    {
        let kv = crate::test_support::mem_kv();
        let n = 2 * REPAIR_BATCH + 44;
        unindexed(&kv, n);
        let (counted, [_, _, begins]) = watched(&kv, None);
        backfill_source_index(&counted, &|_| Ok(())).unwrap();
        assert_eq!(indexed(&kv), n);
        assert_eq!(count(&begins), 3, "one write transaction per batch");
        assert!(
            kv.snapshot()
                .unwrap()
                .get(&repair_done_key())
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn a_write_that_fails_for_any_other_reason_fails_the_open() {
        let kv = crate::test_support::mem_kv();
        unindexed(&kv, 2);
        let failing: Arc<dyn Kv> = Arc::new(watched(&kv, Some(STORE_IO)).0);
        let opened = Store::open_kv(failing, Arc::new(SystemEnv), OpenOptions::default());
        assert_eq!(opened.err().map(|e| e.code), Some(STORE_IO));
        assert_eq!(indexed(&kv), 0);
    }
}
