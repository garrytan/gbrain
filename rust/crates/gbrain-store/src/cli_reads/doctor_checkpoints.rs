//! Doctor checkpoint reads served from the store: the doctor last-known pair and the two `ingest_log`
//! reads (SQL in `src/core/engine-sql/doctor-checkpoints.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-checkpoints.md`).
//!
//! - Last known: one `op_checkpoints` row per (op, entry), in the housekeeping key space
//!   (`persistence/housekeeping.rs`: `d 0x02 <op> 0x00 <fingerprint>`, `HousekeepingRow`), where the
//!   fingerprint is the entry name and `completed_keys` is `[value]`.
//! - Ingest log: rows are keyed by `created_at` then id (`stats.rs`), so a reverse scan reads them
//!   `created_at DESC, id DESC`.

use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::scan_prefix;
use crate::persistence::{HousekeepingRow, turn_key};
use crate::stats::{IngestRecord, jsonb_normalize};
use crate::{keys, put_json};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const DAY_US: i64 = 86_400_000_000;
/// The `source_type` of the facts-absorb failure rows (`engine-sql/doctor-checkpoints.ts`).
const FACTS_ABSORB: &str = "facts:absorb";
const CONNECTOR: &str = "connector";

/// One last-known row to store: the doctor entry name and its value.
#[derive(Debug, Clone, Deserialize)]
pub struct LastKnownRow {
    pub entry: String,
    pub value: Value,
}

/// The `op` argument of the last-known members.
#[derive(Debug, Clone, Deserialize)]
pub struct LastKnownWrite {
    pub op: String,
    pub rows: Vec<LastKnownRow>,
}

impl Store {
    /// `writeDoctorLastKnown(op, rows)`: upserts one row per entry, `completed_keys = [value]` (a jsonb
    /// value: keys by length then bytes) and `updated_at` the store's clock.
    pub fn write_doctor_last_known(&self, input: &LastKnownWrite) -> Result<()> {
        let now = self.env.now_micros();
        let mut staged = Vec::with_capacity(input.rows.len());
        for row in &input.rows {
            let key = turn_key(&input.op, &row.entry)?;
            let record = HousekeepingRow {
                completed_keys: Value::Array(vec![jsonb_normalize(row.value.clone())]),
                updated_at_us: now,
            };
            staged.push((key, record));
        }
        self.write(|tx| {
            for (key, record) in &staged {
                put_json(tx, key, record)?;
            }
            Ok(())
        })
    }

    /// `readDoctorLastKnown(op)`: resolves `[{ fingerprint, entry }]`, the entry name and its value.
    pub fn read_doctor_last_known(&self, op: &str) -> Result<Vec<Value>> {
        // With an empty fingerprint the key is the op's prefix: it ends with the NUL after the op.
        let prefix = turn_key(op, "")?;
        let read = self.read()?;
        let mut rows = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &prefix, false, &mut |key, v| {
            match serde_json::from_slice::<HousekeepingRow>(v) {
                Ok(record) => {
                    let fingerprint = String::from_utf8_lossy(&key[prefix.len()..]).into_owned();
                    let entry = record.completed_keys.get(0).cloned().unwrap_or(Value::Null);
                    rows.push(json!({ "fingerprint": fingerprint, "entry": entry }));
                }
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        failure.map_or(Ok(rows), Err)
    }

    /// `readLatestConnectorReceipt()`: the summary of the newest `connector` ingest row, or null.
    pub fn read_latest_connector_receipt(&self) -> Result<Value> {
        let read = self.read()?;
        let mut found = Value::Null;
        let mut failure = None;
        scan_prefix(
            &*read,
            &[keys::INGEST_LOG],
            true,
            &mut |_, v| match serde_json::from_slice::<IngestRecord>(v) {
                Ok(record) if record.source_type == CONNECTOR => {
                    found = Value::String(record.summary);
                    false
                }
                Ok(_) => true,
                Err(e) => {
                    failure = Some(StoreError::from(e));
                    false
                }
            },
        )?;
        failure.map_or(Ok(found), Err)
    }

    /// `listFactsAbsorbFailureGroups()`: the `facts:absorb` ingest rows of the last 24 hours grouped by
    /// source and reason (the summary up to its first `:`), by source in byte order, then the larger
    /// count first (equal counts by reason; the SQL leaves that order open). Resolves
    /// `[{ source_id, reason, n, newest }]` with `n` the count as text and `newest` an ISO time.
    pub fn list_facts_absorb_failure_groups(&self) -> Result<Vec<Value>> {
        let since = self.env.now_micros() - DAY_US;
        let read = self.read()?;
        let mut groups: BTreeMap<(String, String), (u64, i64)> = BTreeMap::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::INGEST_LOG], true, &mut |_, v| {
            match serde_json::from_slice::<IngestRecord>(v) {
                // Newest first: the first row before the window ends the scan.
                Ok(record) if record.created_at_us < since => false,
                Ok(record) if record.source_type == FACTS_ABSORB => {
                    let reason = record
                        .summary
                        .split(':')
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    let group = groups
                        .entry((record.source_id, reason))
                        .or_insert((0, i64::MIN));
                    group.0 += 1;
                    group.1 = group.1.max(record.created_at_us);
                    true
                }
                Ok(_) => true,
                Err(e) => {
                    failure = Some(StoreError::from(e));
                    false
                }
            }
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut rows: Vec<((String, String), (u64, i64))> = groups.into_iter().collect();
        rows.sort_by(|(a, (an, _)), (b, (bn, _))| {
            a.0.cmp(&b.0).then(bn.cmp(an)).then(a.1.cmp(&b.1))
        });
        Ok(rows
            .into_iter()
            .map(|((source_id, reason), (n, newest))| {
                json!({ "source_id": source_id, "reason": reason, "n": n.to_string(), "newest": iso(newest) })
            })
            .collect())
    }
}
