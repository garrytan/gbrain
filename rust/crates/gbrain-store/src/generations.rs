//! Derived generations: the `derived_generations` and `derived_generation_items` tables of the
//! PGLite engine, the generation ledger of `src/core/generations/publish.ts`.
//!
//! Members: readLiveGenerationRow, activateGenerationRows, recordHeldGenerationRow (the ledger
//! statements of `engine-sql/derived-generations.ts`), listFenceHoldRows and clearFenceHoldRows
//! (the held fence statements of `engine-sql/fence-holds.ts`).
//!
//! Keys, all under `keys::DERIVED_GENERATION` (`h`):
//! - `h 0x01 id(8) -> GenerationRecord`, one row of `derived_generations`. Ids come from the
//!   `next_derived_generation_id` counter, as `BIGSERIAL` gives them.
//! - `h 0x02 source \0 kind \0 owner_key \0 state -> id(8)`, for `state` `live` and `held` only:
//!   the partial unique indexes `derived_generations_one_live` and `derived_generations_one_hold`.
//!   No part may hold a NUL byte (Postgres `text` refuses one too), so the split is exact.
//! - `h 0x03 id(8) item_key -> ItemRecord`, one row of `derived_generation_items`; the key is the
//!   `(generation_id, item_key)` primary key.
//!
//! Time: `created_at` and `updated_at` are UTC microseconds from the store's clock; in a
//! transaction that is the transaction's clock, as Postgres `now()` is the transaction's start.
//!
//! JSON columns (`completeness`, `held_context`, `proposal`, `preimage`) arrive as JSON text or
//! values, are refused where Postgres `jsonb` refuses them, and are stored in Postgres `jsonb` key
//! order (`dream::jsonb`).
//!
//! The store keeps no `derived_generation_attempts` rows (`recordAttempt` still runs raw SQL, which
//! this engine refuses), so the attempt counter delete of an activation has nothing to delete.
//!
//! Every write goes through `Store::write`, so it runs on `access_flag::FlaggingWriter`. This
//! family writes no page record, so it never sets the member-access flag itself; a page write in the
//! same write closure still does.

use crate::dream::{int4, jsonb, jsonb_check};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, collect_prefix, scan_prefix};
use crate::links::no_nul;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const RECORD: u8 = 0x01;
const POINTER: u8 = 0x02;
const ITEM: u8 = 0x03;

/// The id counter (`pages::next_id`).
const ID_COUNTER: &str = "next_derived_generation_id";

/// `derived_generations.held_reason` CHECK.
const HELD_REASONS: &[&str] = &[
    "shrunk",
    "oversize",
    "valve",
    "no_proof",
    "fence_absent",
    "attempts_exhausted",
    "segmented_unsupported",
    "tie",
];

/// `derived_generation_items.action` CHECK.
const ITEM_ACTIONS: &[&str] = &["published", "retired", "revived", "kept", "adopted"];

/// The item actions a generation owns (`readLiveGenerationRow`).
const OWNED_ACTIONS: &[&str] = &["published", "kept", "adopted", "revived"];

/// The held reasons a readable fence clears (`clearFenceHoldRows`).
const FENCE_CLEARED: &[&str] = &["fence_absent", "no_proof"];

/// One row of `derived_generations`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct GenerationRecord {
    id: u64,
    source_id: String,
    kind: String,
    owner_key: String,
    generation: i32,
    state: String,
    #[serde(default)]
    run_id: Option<String>,
    operation_id: String,
    #[serde(default)]
    hold_id: Option<String>,
    #[serde(default)]
    input_pin: Option<String>,
    #[serde(default)]
    input_size: Option<i64>,
    completeness: Value,
    item_set_hash: String,
    #[serde(default)]
    held_reason: Option<String>,
    #[serde(default)]
    held_context: Option<Value>,
    #[serde(default)]
    proposal: Option<Value>,
    #[serde(default)]
    proposal_bytes: Option<i32>,
    attempts: i32,
    #[serde(default)]
    superseded_by: Option<u64>,
    #[serde(default)]
    restore_of: Option<i64>,
    created_at_us: i64,
    updated_at_us: i64,
    #[serde(default)]
    locator: Option<String>,
    #[serde(default)]
    activation_id: Option<String>,
}

/// One row of `derived_generation_items`; the key holds `(generation_id, item_key)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ItemRecord {
    identity_hash: String,
    action: String,
    #[serde(default)]
    preimage: Option<Value>,
    #[serde(default)]
    preimage_bytes: Option<i32>,
    pending: bool,
}

/// A generation key (`GenerationRowKey`, engine-sql/derived-generations.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationKey {
    pub source_id: String,
    pub kind: String,
    pub owner_key: String,
}

/// `GenerationActivationRow`. `completeness` is JSON text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationInput {
    pub generation: f64,
    #[serde(default)]
    pub run_id: Option<String>,
    pub operation_id: String,
    #[serde(default)]
    pub input_pin: Option<String>,
    #[serde(default)]
    pub input_size: Option<f64>,
    pub completeness: String,
    pub set_hash: String,
    #[serde(default)]
    pub restore_of: Option<f64>,
    #[serde(default)]
    pub activation_id: Option<String>,
    #[serde(default)]
    pub locator: Option<String>,
}

/// `GenerationLedgerRow`, in the column names of `derived_generation_items`.
#[derive(Debug, Clone, Deserialize)]
pub struct LedgerItemInput {
    pub item_key: String,
    pub identity_hash: String,
    pub action: String,
    #[serde(default)]
    pub preimage: Option<Value>,
    #[serde(default)]
    pub preimage_bytes: Option<f64>,
    #[serde(default)]
    pub pending: bool,
}

/// `HeldGenerationRow`. `context` and `proposal` are JSON text; a null `proposal` keeps no copy.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldInput {
    pub hold_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub input_pin: Option<String>,
    #[serde(default)]
    pub input_size: Option<f64>,
    pub set_hash: String,
    pub reason: String,
    pub context: String,
    #[serde(default)]
    pub proposal: Option<String>,
    pub proposal_bytes: f64,
}

fn record_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::DERIVED_GENERATION, RECORD];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn pointer_prefix(parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::DERIVED_GENERATION, POINTER];
    for part in parts {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key
}

fn pointer_key(key: &GenerationKey, state: &str) -> Vec<u8> {
    let mut out = pointer_prefix(&[&key.source_id, &key.kind, &key.owner_key]);
    out.extend_from_slice(state.as_bytes());
    out
}

fn item_prefix(id: u64) -> Vec<u8> {
    let mut key = vec![keys::DERIVED_GENERATION, ITEM];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn item_key(id: u64, item: &str) -> Vec<u8> {
    let mut key = item_prefix(id);
    key.extend_from_slice(item.as_bytes());
    key
}

fn corrupt(what: &str) -> StoreError {
    StoreError::new(STORE_CORRUPT, format!("derived_generations: bad {what}"))
}

fn check_key(op: &str, key: &GenerationKey) -> Result<()> {
    no_nul(
        op,
        &[
            ("source_id", &key.source_id),
            ("kind", &key.kind),
            ("owner_key", &key.owner_key),
        ],
    )
}

/// The id a pointer of `state` names, or None.
fn pointed(read: &dyn KvRead, key: &GenerationKey, state: &str) -> Result<Option<u64>> {
    match read.get(&pointer_key(key, state))? {
        Some(bytes) => Ok(Some(keys::be8(&bytes).ok_or_else(|| corrupt("pointer"))?)),
        None => Ok(None),
    }
}

fn read_record(read: &dyn KvRead, id: u64) -> Result<Option<GenerationRecord>> {
    get_json(read, &record_key(id))
}

/// The record a pointer names; a pointer to no record is corrupt.
fn pointed_record(
    read: &dyn KvRead,
    key: &GenerationKey,
    state: &str,
) -> Result<Option<GenerationRecord>> {
    match pointed(read, key, state)? {
        Some(id) => Ok(Some(
            read_record(read, id)?.ok_or_else(|| corrupt("pointer target"))?,
        )),
        None => Ok(None),
    }
}

fn record_generation_key(record: &GenerationRecord) -> GenerationKey {
    GenerationKey {
        source_id: record.source_id.clone(),
        kind: record.kind.clone(),
        owner_key: record.owner_key.clone(),
    }
}

/// Deletes the row `id` with its pointer and its items (`ON DELETE CASCADE` of the items).
fn delete_row(tx: &mut dyn KvWrite, record: &GenerationRecord) -> Result<()> {
    if record.state == "live" || record.state == "held" {
        let key = record_generation_key(record);
        if pointed(&*tx, &key, &record.state)? == Some(record.id) {
            tx.delete(&pointer_key(&key, &record.state))?;
        }
    }
    for (k, _) in collect_prefix(&*tx, &item_prefix(record.id), false, usize::MAX)? {
        tx.delete(&k)?;
    }
    tx.delete(&record_key(record.id))
}

/// A JavaScript number bound to a `BIGINT` column: an integer, or refused.
fn int8(op: &str, column: &str, value: f64) -> Result<i64> {
    if value.fract() != 0.0 || !value.is_finite() || value.abs() > 9.007_199_254_740_992e15 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: invalid input syntax for type bigint: \"{value}\" ({column})"),
        ));
    }
    Ok(value as i64)
}

/// JSON text bound to a `::text::jsonb` cast: parsed, checked and in `jsonb` key order.
fn jsonb_text(op: &str, column: &str, text: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(text).map_err(|e| {
        StoreError::new(
            INVALID_ARGUMENT,
            format!("{op}: invalid input syntax for type json ({column}): {e}"),
        )
    })?;
    jsonb_check(op, column, &value)?;
    Ok(jsonb(&value))
}

fn check_violation(constraint: &str, table: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("new row for relation \"{table}\" violates check constraint \"{constraint}\""),
    )
}

fn unique_violation(constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("duplicate key value violates unique constraint \"{constraint}\""),
    )
}

fn optional_text<'a>(name: &'a str, value: &'a Option<String>) -> Option<(&'a str, &'a str)> {
    value.as_deref().map(|text| (name, text))
}

impl Store {
    /// `readLiveGenerationRow(key)`: the live row of `key` with the items it owns, or null.
    pub fn read_live_generation_row(&self, key: &GenerationKey) -> Result<Value> {
        check_key("readLiveGenerationRow", key)?;
        let read = self.read()?;
        let Some(record) = pointed_record(&*read, key, "live")? else {
            return Ok(Value::Null);
        };
        let mut items = Vec::new();
        let prefix = item_prefix(record.id);
        let mut failure = None;
        scan_prefix(&*read, &prefix, false, &mut |k, v| {
            match serde_json::from_slice::<ItemRecord>(v) {
                Ok(item) if OWNED_ACTIONS.contains(&item.action.as_str()) => {
                    items.push(json!({
                        "item_key": String::from_utf8_lossy(&k[prefix.len()..]),
                        "identity_hash": item.identity_hash,
                    }));
                }
                Ok(_) => {}
                Err(e) => {
                    failure = Some(StoreError::from(e));
                    return false;
                }
            }
            true
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        Ok(json!({
            "id": record.id,
            "generation": record.generation,
            "input_pin": record.input_pin,
            "input_size": record.input_size,
            "locator": record.locator,
            "items": items,
        }))
    }

    /// `activateGenerationRows(key, liveId, row, items)`: supersedes the live row `live_id`,
    /// inserts `row` as the live generation of `key` with `items`, and deletes the key's held row.
    /// Resolves the new row's id.
    pub fn activate_generation_rows(
        &self,
        key: &GenerationKey,
        live_id: Option<f64>,
        row: &ActivationInput,
        items: &[LedgerItemInput],
    ) -> Result<u64> {
        const OP: &str = "activateGenerationRows";
        check_key(OP, key)?;
        let mut texts = vec![
            ("operation_id", row.operation_id.as_str()),
            ("item_set_hash", row.set_hash.as_str()),
        ];
        texts.extend(optional_text("run_id", &row.run_id));
        texts.extend(optional_text("input_pin", &row.input_pin));
        texts.extend(optional_text("activation_id", &row.activation_id));
        texts.extend(optional_text("locator", &row.locator));
        no_nul(OP, &texts)?;
        let live_id = live_id.map(|id| int8(OP, "id", id)).transpose()?;
        let generation = int4(OP, "generation", row.generation)?;
        let input_size = row
            .input_size
            .map(|v| int8(OP, "input_size", v))
            .transpose()?;
        let restore_of = row
            .restore_of
            .map(|v| int8(OP, "restore_of", v))
            .transpose()?;
        let completeness = jsonb_text(OP, "completeness", &row.completeness)?;
        let mut ledger = Vec::with_capacity(items.len());
        for item in items {
            no_nul(
                OP,
                &[
                    ("item_key", &item.item_key),
                    ("identity_hash", &item.identity_hash),
                    ("action", &item.action),
                ],
            )?;
            if !ITEM_ACTIONS.contains(&item.action.as_str()) {
                return Err(check_violation(
                    "derived_generation_items_action_check",
                    "derived_generation_items",
                ));
            }
            let preimage = match &item.preimage {
                None | Some(Value::Null) => None,
                Some(value) => {
                    jsonb_check(OP, "preimage", value)?;
                    Some(jsonb(value))
                }
            };
            let preimage_bytes = item
                .preimage_bytes
                .map(|v| int4(OP, "preimage_bytes", v))
                .transpose()?;
            ledger.push((
                item.item_key.clone(),
                ItemRecord {
                    identity_hash: item.identity_hash.clone(),
                    action: item.action.clone(),
                    preimage,
                    preimage_bytes,
                    pending: item.pending,
                },
            ));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            // UPDATE ... SET state='superseded' WHERE id=$1 AND state='live'
            if let Some(id) = live_id.and_then(|id| u64::try_from(id).ok())
                && let Some(mut live) = read_record(&*tx, id)?
                && live.state == "live"
            {
                let live_key = record_generation_key(&live);
                if pointed(&*tx, &live_key, "live")? == Some(id) {
                    tx.delete(&pointer_key(&live_key, "live"))?;
                }
                live.state = "superseded".into();
                live.updated_at_us = now;
                put_json(tx, &record_key(id), &live)?;
            }
            crate::sources::require_source(&*tx, &key.source_id)?;
            if pointed(&*tx, key, "live")?.is_some() {
                return Err(unique_violation("derived_generations_one_live"));
            }
            let id = crate::pages::next_id(tx, ID_COUNTER)?;
            let record = GenerationRecord {
                id,
                source_id: key.source_id.clone(),
                kind: key.kind.clone(),
                owner_key: key.owner_key.clone(),
                generation,
                state: "live".into(),
                run_id: row.run_id.clone(),
                operation_id: row.operation_id.clone(),
                hold_id: None,
                input_pin: row.input_pin.clone(),
                input_size,
                completeness: completeness.clone(),
                item_set_hash: row.set_hash.clone(),
                held_reason: None,
                held_context: None,
                proposal: None,
                proposal_bytes: None,
                attempts: 0,
                superseded_by: None,
                restore_of,
                created_at_us: now,
                updated_at_us: now,
                locator: row.locator.clone(),
                activation_id: row.activation_id.clone(),
            };
            put_json(tx, &record_key(id), &record)?;
            tx.put(&pointer_key(key, "live"), &id.to_be_bytes())?;
            // UPDATE derived_generations SET superseded_by=$1 WHERE id=$2
            if let Some(old) = live_id.and_then(|old| u64::try_from(old).ok())
                && let Some(mut superseded) = read_record(&*tx, old)?
            {
                superseded.superseded_by = Some(id);
                put_json(tx, &record_key(old), &superseded)?;
            }
            let mut seen = BTreeSet::new();
            for (item, record) in &ledger {
                if !seen.insert(item.as_str()) {
                    return Err(unique_violation("derived_generation_items_pkey"));
                }
                put_json(tx, &item_key(id, item), record)?;
            }
            if let Some(held) = pointed_record(&*tx, key, "held")? {
                delete_row(tx, &held)?;
            }
            Ok(id)
        })
    }

    /// `recordHeldGenerationRow(key, row)`: the same hold counts one more attempt; another hold
    /// replaces the key's held row.
    pub fn record_held_generation_row(&self, key: &GenerationKey, row: &HeldInput) -> Result<()> {
        const OP: &str = "recordHeldGenerationRow";
        check_key(OP, key)?;
        let mut texts = vec![
            ("hold_id", row.hold_id.as_str()),
            ("item_set_hash", row.set_hash.as_str()),
            ("held_reason", row.reason.as_str()),
        ];
        texts.extend(optional_text("run_id", &row.run_id));
        texts.extend(optional_text("input_pin", &row.input_pin));
        no_nul(OP, &texts)?;
        let input_size = row
            .input_size
            .map(|v| int8(OP, "input_size", v))
            .transpose()?;
        let proposal_bytes = int4(OP, "proposal_bytes", row.proposal_bytes)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            if let Some(mut existing) = pointed_record(&*tx, key, "held")? {
                if existing.hold_id.as_deref() == Some(row.hold_id.as_str()) {
                    existing.attempts = existing.attempts.saturating_add(1);
                    existing.updated_at_us = now;
                    return put_json(tx, &record_key(existing.id), &existing);
                }
                delete_row(tx, &existing)?;
            }
            if !HELD_REASONS.contains(&row.reason.as_str()) {
                return Err(check_violation(
                    "derived_generations_held_reason_check",
                    "derived_generations",
                ));
            }
            let held_context = jsonb_text(OP, "held_context", &row.context)?;
            let proposal = row
                .proposal
                .as_deref()
                .map(|text| jsonb_text(OP, "proposal", text))
                .transpose()?;
            crate::sources::require_source(&*tx, &key.source_id)?;
            let id = crate::pages::next_id(tx, ID_COUNTER)?;
            let record = GenerationRecord {
                id,
                source_id: key.source_id.clone(),
                kind: key.kind.clone(),
                owner_key: key.owner_key.clone(),
                generation: 0,
                state: "held".into(),
                run_id: row.run_id.clone(),
                operation_id: format!("held:{}", row.hold_id),
                hold_id: Some(row.hold_id.clone()),
                input_pin: row.input_pin.clone(),
                input_size,
                completeness: json!({}),
                item_set_hash: row.set_hash.clone(),
                held_reason: Some(row.reason.clone()),
                held_context: Some(held_context),
                proposal,
                proposal_bytes: Some(proposal_bytes),
                attempts: 1,
                superseded_by: None,
                restore_of: None,
                created_at_us: now,
                updated_at_us: now,
                locator: None,
                activation_id: None,
            };
            put_json(tx, &record_key(id), &record)?;
            tx.put(&pointer_key(key, "held"), &id.to_be_bytes())
        })
    }

    /// `listFenceHoldRows(sourceIds, kinds, ownerKey?)`: the held rows of `kinds` in `source_ids`
    /// (one owner with `owner_key`), ordered by `created_at, id`. `created_at` is
    /// `timestamptz::text`.
    pub fn list_fence_hold_rows(
        &self,
        source_ids: &[String],
        kinds: &[String],
        owner_key: Option<&str>,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listFenceHoldRows";
        for text in source_ids
            .iter()
            .chain(kinds)
            .map(String::as_str)
            .chain(owner_key)
        {
            no_nul(OP, &[("argument", text)])?;
        }
        let read = self.read()?;
        let mut held = Vec::new();
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let kinds: BTreeSet<&str> = kinds.iter().map(String::as_str).collect();
        for source in &sources {
            for kind in &kinds {
                let ids = match owner_key {
                    Some(owner) => {
                        let key = GenerationKey {
                            source_id: (*source).into(),
                            kind: (*kind).into(),
                            owner_key: owner.into(),
                        };
                        pointed(&*read, &key, "held")?
                            .into_iter()
                            .collect::<Vec<_>>()
                    }
                    None => {
                        let mut ids = Vec::new();
                        for (k, v) in collect_prefix(
                            &*read,
                            &pointer_prefix(&[source, kind]),
                            false,
                            usize::MAX,
                        )? {
                            if k.ends_with(b"\0held") {
                                ids.push(keys::be8(&v).ok_or_else(|| corrupt("pointer"))?);
                            }
                        }
                        ids
                    }
                };
                for id in ids {
                    held.push(read_record(&*read, id)?.ok_or_else(|| corrupt("pointer target"))?);
                }
            }
        }
        held.sort_by_key(|record| (record.created_at_us, record.id));
        Ok(held
            .into_iter()
            .map(|record| {
                json!({
                    "source_id": record.source_id,
                    "kind": record.kind,
                    "owner_key": record.owner_key,
                    "held_reason": record.held_reason,
                    "held_context": record.held_context,
                    "created_at": crate::cli_reads::pg_text::timestamptz_text(record.created_at_us),
                })
            })
            .collect())
    }

    /// `clearFenceHoldRows(key)`: deletes the key's held row when it waits for a readable fence
    /// (`held_reason` `fence_absent` or `no_proof`).
    pub fn clear_fence_hold_rows(&self, key: &GenerationKey) -> Result<()> {
        check_key("clearFenceHoldRows", key)?;
        self.write(|tx| {
            if let Some(held) = pointed_record(&*tx, key, "held")?
                && held
                    .held_reason
                    .as_deref()
                    .is_some_and(|r| FENCE_CLEARED.contains(&r))
            {
                delete_row(tx, &held)?;
            }
            Ok(())
        })
    }
}

/// `ON DELETE CASCADE` of `derived_generations.source_id` (and of the items with their row).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    let mut failure = None;
    scan_prefix(
        &*tx,
        &[keys::DERIVED_GENERATION, RECORD],
        false,
        &mut |_, v| {
            match serde_json::from_slice::<GenerationRecord>(v) {
                Ok(record) if record.source_id == source_id => doomed.push(record),
                Ok(_) => {}
                Err(e) => {
                    failure = Some(StoreError::from(e));
                    return false;
                }
            }
            true
        },
    )?;
    if let Some(e) = failure {
        return Err(e);
    }
    for record in &doomed {
        delete_row(tx, record)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! The family's writes run on the store's `FlaggingWriter`: a page record put with readers in
    //! the same write closure as a generation write still sets the member-access flag.

    use super::*;
    use crate::access_flag::RESTRICTIONS_PRESENT_KEY as FLAG;
    use crate::test_support::store;

    fn key() -> GenerationKey {
        GenerationKey {
            source_id: "default".into(),
            kind: "facts_fence".into(),
            owner_key: "page:notes/a".into(),
        }
    }

    fn held(hold: &str, reason: &str) -> HeldInput {
        HeldInput {
            hold_id: hold.into(),
            run_id: None,
            input_pin: None,
            input_size: None,
            set_hash: "set".into(),
            reason: reason.into(),
            context: r#"{"slug":"notes/a","read":"absent","rows":1}"#.into(),
            proposal: Some("[]".into()),
            proposal_bytes: 2.0,
        }
    }

    #[test]
    fn a_generation_write_and_a_reader_page_put_in_one_write_set_the_flag() {
        let store = store();
        assert_eq!(store.get_config(FLAG).unwrap(), None);
        store
            .write(|tx| {
                crate::sources::require_source(&*tx, "default")?;
                let id = crate::pages::next_id(tx, ID_COUNTER)?;
                tx.put(&pointer_key(&key(), "held"), &id.to_be_bytes())?;
                tx.delete(&pointer_key(&key(), "held"))?;
                let page = keys::page("default", "notes/closed");
                let record = json!({"slug": "notes/closed", "frontmatter": {"readable_by": ["alice-example"]}});
                tx.put(&page, &serde_json::to_vec(&record)?)
            })
            .unwrap();
        assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn a_generation_write_alone_leaves_the_flag_unset() {
        let store = store();
        store
            .record_held_generation_row(&key(), &held("h1", "no_proof"))
            .unwrap();
        assert_eq!(store.get_config(FLAG).unwrap(), None);
    }

    #[test]
    fn the_family_writes_only_through_store_write() {
        let source = include_str!("generations.rs");
        let begin = ["begin", "_write("].concat();
        assert!(
            !source.contains(&begin),
            "generations.rs must write through Store::write"
        );
    }

    #[test]
    fn the_same_hold_counts_an_attempt_and_another_hold_replaces_it() {
        let store = store();
        store
            .record_held_generation_row(&key(), &held("h1", "no_proof"))
            .unwrap();
        store
            .record_held_generation_row(&key(), &held("h1", "no_proof"))
            .unwrap();
        let read = store.read().unwrap();
        let first = pointed_record(&*read, &key(), "held").unwrap().unwrap();
        assert_eq!((first.attempts, first.hold_id.as_deref()), (2, Some("h1")));
        drop(read);
        store
            .record_held_generation_row(&key(), &held("h2", "fence_absent"))
            .unwrap();
        let read = store.read().unwrap();
        let second = pointed_record(&*read, &key(), "held").unwrap().unwrap();
        assert_eq!(
            (second.attempts, second.hold_id.as_deref()),
            (1, Some("h2"))
        );
        assert!(read_record(&*read, first.id).unwrap().is_none());
    }

    #[test]
    fn a_source_delete_removes_its_rows() {
        let store = store();
        store
            .record_held_generation_row(&key(), &held("h1", "no_proof"))
            .unwrap();
        store.write(|tx| remove_source_rows(tx, "default")).unwrap();
        let read = store.read().unwrap();
        assert!(
            collect_prefix(&*read, &[keys::DERIVED_GENERATION], false, 10)
                .unwrap()
                .is_empty()
        );
    }
}
