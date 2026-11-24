//! Derivation inputs: the `derivation_inputs` table of the PGLite engine, the complete input edges
//! of a derived row (`src/core/facts/derivation-inputs.ts`).
//!
//! Members: recordDerivationInputs (`engine-sql/facts-purge.ts`), and the store side of
//! listDerivedRows (`facts/purge.rs`), the walk hop of `derivedRowsFrom`.
//!
//! Keys, under `keys::DERIVED_GENERATION` (`h`) with the generation rows (store format 6,
//! rust/docs/store/format.md):
//! - `h 0x0A derived_table \0 derived_id \0 input_table \0 input_id -> EdgeRecord`, one row of
//!   `derivation_inputs`; the key is its primary key. No part may hold a NUL byte (Postgres `text`
//!   refuses one too), so the split is exact.
//! - `h 0x0B input_table \0 input_id \0 derived_table \0 derived_id -> []` for each row: the index
//!   `idx_derivation_inputs_input`, so one walk hop reads one prefix per frontier row.
//!
//! A write keeps a row that exists (`ON CONFLICT DO NOTHING`), so its `source_id` and
//! `created_at` stay the first ones. A source delete removes the rows whose `source_id` is the
//! source (`ON DELETE CASCADE`); a row with no source stays. That delete reads every row, as the
//! store keeps no index by source. Text compares by bytes (the C collation): the derived rows of a
//! hop come back in byte order of (derived_table, derived_id), where Postgres under en_US orders by
//! that collation. The table names gbrain records (`facts`, `pages`, `takes`, `timeline_entries`)
//! and decimal ids of one width sort the same in both.

use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::facts::purge::DerivationRef;
use crate::kv::{KvRead, KvWrite, collect_prefix};
use crate::links::no_nul;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, VecDeque};

/// The sub-byte of a `derivation_inputs` row, keyed by its derived row.
pub(super) const BY_DERIVED: u8 = 0x0A;
/// The sub-byte of the input index, keyed by the input row.
pub(super) const BY_INPUT: u8 = 0x0B;
/// The first two bytes of every `derivation_inputs` row key and of every input index key.
const BY_DERIVED_HEAD: [u8; 2] = [keys::DERIVED_GENERATION, BY_DERIVED];
const BY_INPUT_HEAD: [u8; 2] = [keys::DERIVED_GENERATION, BY_INPUT];

/// One row of `derivation_inputs`; the key holds the four reference columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EdgeRecord {
    #[serde(default)]
    source_id: Option<String>,
    created_at_us: i64,
}

/// `recordDerivationInputs(derived, sourceId, inputs)`'s arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivationInputsArgs {
    pub derived: DerivationRef,
    #[serde(default)]
    pub source_id: Option<String>,
    pub inputs: Vec<DerivationRef>,
}

fn joined(head: [u8; 2], parts: &[&str]) -> Vec<u8> {
    let mut key = head.to_vec();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part.as_bytes());
    }
    key
}

/// The prefix of every key under `head` whose first two parts are `table` and `id`.
fn pair_prefix(head: [u8; 2], table: &str, id: &str) -> Vec<u8> {
    let mut key = joined(head, &[table, id]);
    key.push(0);
    key
}

/// The last two parts of a key under `prefix` (`pair_prefix`).
fn tail_pair(key: &[u8], prefix_len: usize) -> Result<(String, String)> {
    let tail = &key[prefix_len..];
    let corrupt = || {
        StoreError::new(
            crate::error::STORE_CORRUPT,
            "derivation_inputs key is malformed",
        )
    };
    let split = tail.iter().position(|b| *b == 0).ok_or_else(corrupt)?;
    let first = std::str::from_utf8(&tail[..split]).map_err(|_| corrupt())?;
    let second = std::str::from_utf8(&tail[split + 1..]).map_err(|_| corrupt())?;
    Ok((first.to_string(), second.to_string()))
}

/// The two parts after `(table, id)` of every key under `head` that starts with them.
fn pairs_under(
    read: &dyn KvRead,
    head: [u8; 2],
    table: &str,
    id: &str,
) -> Result<Vec<(String, String)>> {
    let prefix = pair_prefix(head, table, id);
    collect_prefix(read, &prefix, false, usize::MAX)?
        .iter()
        .map(|(k, _)| tail_pair(k, prefix.len()))
        .collect()
}

/// The inputs recorded for one derived row, in byte order.
pub(crate) fn inputs_of(read: &dyn KvRead, table: &str, id: &str) -> Result<Vec<(String, String)>> {
    pairs_under(read, BY_DERIVED_HEAD, table, id)
}

/// One hop of the derivation walk: the distinct rows derived from a frontier row, in byte order
/// of (derived_table, derived_id), at most `limit`.
pub(crate) fn derived_from(
    read: &dyn KvRead,
    frontier: &[DerivationRef],
    limit: usize,
) -> Result<Vec<(String, String)>> {
    let mut found = BTreeSet::new();
    for input in frontier {
        if input.table.contains('\0') || input.id.contains('\0') {
            continue;
        }
        found.extend(pairs_under(read, BY_INPUT_HEAD, &input.table, &input.id)?);
    }
    Ok(found.into_iter().take(limit).collect())
}

/// Whether a row with recorded inputs reaches, through them at any depth, a row `counts` accepts:
/// `gbrain_owner_only_lineage_strict`'s walk (v322). Each (table, id) is visited once, so a cycle
/// ends. A row with no recorded inputs costs one prefix read.
pub(crate) fn lineage_reaches(
    read: &dyn KvRead,
    table: &str,
    id: &str,
    counts: &mut dyn FnMut(&str, &str) -> Result<bool>,
) -> Result<bool> {
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    let mut queue: VecDeque<(String, String)> = inputs_of(read, table, id)?.into();
    while let Some(row) = queue.pop_front() {
        if !seen.insert(row.clone()) {
            continue;
        }
        if counts(&row.0, &row.1)? {
            return Ok(true);
        }
        for next in inputs_of(read, &row.0, &row.1)? {
            if !seen.contains(&next) {
                queue.push_back(next);
            }
        }
    }
    Ok(false)
}

/// Whether `(table, id)` has a recorded input.
pub(crate) fn has_inputs(read: &dyn KvRead, table: &str, id: &str) -> Result<bool> {
    Ok(!collect_prefix(read, &pair_prefix(BY_DERIVED_HEAD, table, id), false, 1)?.is_empty())
}

/// Every row derived, at any depth, from one of `seed` (the `down` walk of
/// `gbrain_owner_only_mark_derived`, v322), through the input index. Each row is visited once, so
/// a cycle ends.
pub(crate) fn derived_closure(
    read: &dyn KvRead,
    seed: &[(String, String)],
) -> Result<BTreeSet<(String, String)>> {
    let mut found: BTreeSet<(String, String)> = BTreeSet::new();
    let mut queue: VecDeque<(String, String)> = seed.iter().cloned().collect();
    while let Some((table, id)) = queue.pop_front() {
        if table.contains('\0') || id.contains('\0') {
            continue;
        }
        for next in pairs_under(read, BY_INPUT_HEAD, &table, &id)? {
            if found.insert(next.clone()) {
                queue.push_back(next);
            }
        }
    }
    Ok(found)
}

/// A source delete: every row whose `source_id` is the source goes, with its index entry.
pub(super) fn remove_source_edges(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let prefix = BY_DERIVED_HEAD;
    let mut doomed = Vec::new();
    for (key, value) in collect_prefix(&*tx, &prefix, false, usize::MAX)? {
        let edge: EdgeRecord = serde_json::from_slice(&value)?;
        if edge.source_id.as_deref() == Some(source_id) {
            doomed.push(key);
        }
    }
    for key in doomed {
        let parts = split_parts(&key[2..])?;
        tx.delete(&key)?;
        tx.delete(&joined(
            BY_INPUT_HEAD,
            &[&parts[2], &parts[3], &parts[0], &parts[1]],
        ))?;
    }
    Ok(())
}

fn split_parts(body: &[u8]) -> Result<Vec<String>> {
    let corrupt = || {
        StoreError::new(
            crate::error::STORE_CORRUPT,
            "derivation_inputs key is malformed",
        )
    };
    let parts: Vec<String> = body
        .split(|b| *b == 0)
        .map(|part| {
            std::str::from_utf8(part)
                .map(str::to_string)
                .map_err(|_| corrupt())
        })
        .collect::<Result<_>>()?;
    if parts.len() != 4 {
        return Err(corrupt());
    }
    Ok(parts)
}

impl Store {
    /// `recordDerivationInputs(derived, sourceId, inputs)`: one `derivation_inputs` row per input,
    /// with `source_id` and the transaction's time, keeping a row that exists. A NUL in a table or
    /// id is `invalid_argument`, as a text column refuses it; a `sourceId` that names no source is
    /// refused, as the foreign key refuses it. The TypeScript caller has checked the table names,
    /// the ids and the input count.
    pub fn record_derivation_inputs(&self, a: &DerivationInputsArgs) -> Result<Value> {
        const OP: &str = "recordDerivationInputs";
        no_nul(
            OP,
            &[
                ("derived.table", &a.derived.table),
                ("derived.id", &a.derived.id),
            ],
        )?;
        for input in &a.inputs {
            no_nul(
                OP,
                &[("input.table", &input.table), ("input.id", &input.id)],
            )?;
        }
        if let Some(source_id) = &a.source_id {
            no_nul(OP, &[("sourceId", source_id)])?;
        }
        if a.inputs.is_empty() {
            return Ok(Value::Null);
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            if let Some(source_id) = &a.source_id {
                crate::sources::require_source(&*tx, source_id)?;
            }
            let d = &a.derived;
            for input in &a.inputs {
                let key = joined(BY_DERIVED_HEAD, &[&d.table, &d.id, &input.table, &input.id]);
                if get_json::<EdgeRecord>(&*tx, &key)?.is_some() {
                    continue;
                }
                let edge = EdgeRecord {
                    source_id: a.source_id.clone(),
                    created_at_us: now,
                };
                put_json(tx, &key, &edge)?;
                tx.put(
                    &joined(BY_INPUT_HEAD, &[&input.table, &input.id, &d.table, &d.id]),
                    &[],
                )?;
            }
            Ok(())
        })?;
        Ok(Value::Null)
    }

    /// The rows of `derivation_inputs`, for tests: `(derived_table, derived_id, input_table,
    /// input_id, source_id)` in key order.
    #[cfg(test)]
    pub(crate) fn derivation_rows(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let prefix = BY_DERIVED_HEAD;
        collect_prefix(&*read, &prefix, false, usize::MAX)?
            .into_iter()
            .map(|(k, v)| {
                let parts = split_parts(&k[2..])?;
                let edge: EdgeRecord = serde_json::from_slice(&v)?;
                Ok(serde_json::json!([
                    parts[0],
                    parts[1],
                    parts[2],
                    parts[3],
                    edge.source_id
                ]))
            })
            .collect()
    }
}

/// A limit Postgres's `LIMIT` takes: a negative one is refused.
pub(crate) fn hop_limit(limit: i64) -> Result<usize> {
    if limit < 0 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            "LIMIT must not be negative",
        ));
    }
    Ok(usize::try_from(limit).unwrap_or(usize::MAX))
}
