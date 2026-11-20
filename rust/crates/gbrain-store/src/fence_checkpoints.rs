//! The fence-repair checkpoint reads and the candidate part upsert (`upsertFenceCandidatePart`,
//! `readFenceCandidateRecords` and `readOpCheckpointRecords`, `src/core/engine-sql/collate-store-reads.ts`):
//! the census keeps one judged candidate per checkpoint row and the uncommitted-repair notices ride
//! the same table.
//!
//! Keys: none of its own. The rows are checkpoint parents (`op_checkpoint_values.rs`): key
//! `d 0x02 <op> 0x00 <fingerprint>`, value `{ completed_keys, updated_at_us }`, whose first
//! `completed_keys` element is the record. An op's rows list by fingerprint byte, the order
//! `ORDER BY fingerprint COLLATE "C"` gives.

use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::op_checkpoint_values::{CheckpointRow, parent_key};
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// One judged part of a fence-repair candidate (`FenceCandidatePartWrite`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FenceCandidatePartWrite {
    pub op: String,
    pub fingerprint: String,
    pub source_id: String,
    pub incarnation: String,
    pub key: String,
    pub part: String,
    pub finding: Value,
}

/// An op's rows as `(fingerprint, first completed_keys element)`, by fingerprint byte. A row
/// whose `completed_keys` has no first element reads as `null`, as `completed_keys->0` does.
fn op_rows(read: &dyn KvRead, op: &str) -> Result<Vec<(String, Value)>> {
    if op.contains('\0') {
        return Err(StoreError::invalid(
            "an op checkpoint op cannot contain NUL",
        ));
    }
    let mut prefix = vec![keys::PERSISTENCE, crate::persistence::HOUSEKEEPING];
    prefix.extend_from_slice(op.as_bytes());
    prefix.push(0);
    let mut raw = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, v| {
        raw.push((k[prefix.len()..].to_vec(), v.to_vec()));
        true
    })?;
    let mut out = Vec::new();
    for (fingerprint, value) in raw {
        let row: CheckpointRow = serde_json::from_slice(&value)?;
        let first = row.completed_keys.get(0).cloned().unwrap_or(Value::Null);
        out.push((String::from_utf8_lossy(&fingerprint).into_owned(), first));
    }
    Ok(out)
}

fn in_scope(record: &Value, source_ids: Option<&[String]>) -> bool {
    match source_ids {
        None => true,
        Some(ids) => record
            .get("source_id")
            .and_then(Value::as_str)
            .is_some_and(|id| ids.iter().any(|want| want == id)),
    }
}

impl Store {
    /// `upsertFenceCandidatePart(spec)`: a missing row holds `{ version: 1, source_id,
    /// incarnation, key, <part>: finding }`; an existing row keeps its other keys and stores the
    /// part, both stamped now.
    pub fn upsert_fence_candidate_part(&self, spec: &FenceCandidatePartWrite) -> Result<()> {
        let key = parent_key(&spec.op, &spec.fingerprint)?;
        let env: &dyn Env = &*self.env;
        let now = env.now_micros();
        self.write(|tx| {
            let old: Option<CheckpointRow> = get_json(&*tx, &key)?;
            let mut record = match old.as_ref().and_then(|r| r.completed_keys.get(0)) {
                Some(Value::Object(existing)) => existing.clone(),
                _ => {
                    let mut fresh = Map::new();
                    fresh.insert("version".into(), json!(1));
                    fresh.insert("source_id".into(), json!(spec.source_id));
                    fresh.insert("incarnation".into(), json!(spec.incarnation));
                    fresh.insert("key".into(), json!(spec.key));
                    fresh
                }
            };
            record.insert(spec.part.clone(), spec.finding.clone());
            let row = CheckpointRow {
                completed_keys: Value::Array(vec![Value::Object(record)]),
                updated_at_us: now,
            };
            put_json(tx, &key, &row)
        })
    }

    /// `readFenceCandidateRecords(op, sourceIds)`: the records whose source exists at the
    /// recorded incarnation (an archived or replaced source drops its candidates), limited to
    /// `source_ids` unless that is `None`, by fingerprint byte.
    pub fn read_fence_candidate_records(
        &self,
        op: &str,
        source_ids: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for (_, record) in op_rows(&*read, op)? {
            let (Some(id), Some(incarnation)) = (
                record.get("source_id").and_then(Value::as_str),
                record.get("incarnation").and_then(Value::as_str),
            ) else {
                continue;
            };
            if !in_scope(&record, source_ids) {
                continue;
            }
            if read_source(&*read, id)?.is_some_and(|s| s.incarnation == incarnation) {
                out.push(record);
            }
        }
        Ok(out)
    }

    /// `readOpCheckpointRecords(op, sourceIds)`: `[{ fingerprint, record }]` of the op's rows
    /// whose record names a source in `source_ids` (every row when `None`), by fingerprint byte.
    pub fn read_op_checkpoint_records(
        &self,
        op: &str,
        source_ids: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(op_rows(&*read, op)?
            .into_iter()
            .filter(|(_, record)| in_scope(record, source_ids))
            .map(|(fingerprint, record)| json!({ "fingerprint": fingerprint, "record": record }))
            .collect())
    }
}
