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
use super::{DERIVATION_PURGE, DerivationRecord, kind_key, violation};
use crate::Store;
use crate::facts::purge_probe::{EachRow, ProbeCell, ProbeRow, each_json, json_rows};
use crate::kv::KvRead;
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
    for record in json_rows::<SweepRecord>(read, &kind_key(DERIVATION_PURGE))? {
        if record.source_id != page.source_id {
            continue;
        }
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
                ("recheck", ProbeCell::Null),
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
            if get_json::<SweepRecord>(&*tx, &key)?.is_some() {
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
                },
            )
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
