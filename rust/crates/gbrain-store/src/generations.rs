//! Derived generations: the `derived_generations` and `derived_generation_items` tables of the
//! PGLite engine, the generation ledger of `src/core/generations/publish.ts`.
//!
//! Members: readLiveGenerationRow, activateGenerationRows, recordHeldGenerationRow,
//! heldGenerationRowsForInput, readHeldGenerationContext, liveGenerationForOperation,
//! countGenerationAttempt, clearGenerationAttempts, readGenerationValve and bumpGenerationValve
//! (the statements of `engine-sql/derived-generations.ts`), listFenceHoldRows and
//! clearFenceHoldRows (the held fence statements of `engine-sql/fence-holds.ts`), and
//! scrubGenerationPageRows and scrubGenerationTextRows (the purge scrub of
//! `engine-sql/generation-ledger.ts`).
//!
//! Keys, all under `keys::DERIVED_GENERATION` (`h`):
//! - `h 0x01 id(8) -> GenerationRecord`, one row of `derived_generations`. Ids come from the
//!   `next_derived_generation_id` counter, as `BIGSERIAL` gives them.
//! - `h 0x02 source \0 kind \0 owner_key \0 state -> id(8)`, for `state` `live` and `held` only:
//!   the partial unique indexes `derived_generations_one_live` and `derived_generations_one_hold`.
//!   No part may hold a NUL byte (Postgres `text` refuses one too), so the split is exact.
//! - `h 0x03 id(8) item_key -> ItemRecord`, one row of `derived_generation_items`; the key is the
//!   `(generation_id, item_key)` primary key.
//! - `h 0x04 hold_id -> AttemptRecord`, one row of `derived_generation_attempts` (its primary key).
//! - `h 0x05 source \0 kind \0 window_key -> ValveRecord`, one row of `derived_generation_valve`
//!   (its primary key).
//! - `h 0x06 operation_id \0 id(8) -> []` for each live row: the replay lookup
//!   (`liveGenerationForOperation`) reads one prefix instead of every row.
//! - `h 0x07 source \0 kind \0 owner_key \0 hold_id -> []` for each attempt row: the index
//!   `derived_generation_attempts_key`, so an activation deletes its key's counters by prefix.
//! - `h 0x08` and `h 0x09`: the managed activation rows of `derived_generation_activations` and
//!   their generation index (`generations/activations.rs`, members recordGenerationActivation,
//!   markGenerationActivated, readGenerationActivationState, settleGenerationMember,
//!   listPendingGenerationMembers and listGenerationOrphanCandidates).
//! - The reads of `gbrain repair generations` add no keys (`generations/repair.rs`, members
//!   readGenerationItemsByIds, listUnmatchedGenerationRows, listRestorableGenerationRows,
//!   listHeldGenerationRows and readHeldGenerationProposal).
//! - The doctor's generation reads add no keys (`generations/doctor_reads.rs`, members
//!   listLiveGenerationRetirements and listHeldGenerations).
//! - The fence evidence reads of `generations/fence-evidence.ts` and the fence restore reads of
//!   `generations/fence-restore.ts` add no keys (`generations/fence_evidence.rs`, members
//!   listRecordedFenceItemKeys, hasBodylessPageVersion and listFenceVersionBodies;
//!   `generations/fence_restore.rs`, members readGenerationFenceBlocks, listOwnedGenerationItems
//!   and readLiveGenerationId).
//!
//! Time: `created_at` and `updated_at` are UTC microseconds from the store's clock; in a
//! transaction that is the transaction's clock, as Postgres `now()` is the transaction's start.
//!
//! JSON columns (`completeness`, `held_context`, `proposal`, `preimage`) arrive as JSON text or
//! values, are refused where Postgres `jsonb` refuses them, and are stored in Postgres `jsonb` key
//! order (`jsonb::ordered`).
//!
//! A source delete removes the source's rows of all five tables (`remove_source_rows`); a deleted
//! generation row sets its activations' `generation_id` to null.
//!
//! Every write goes through `Store::write`, so it runs on `access_flag::FlaggingWriter`. This
//! family writes no page record, so it never sets the member-access flag itself; a page write in the
//! same write closure still does.

use crate::cli_reads::pg_jsonb;
use crate::cli_reads::pg_text::{jsonb_text as jsonb_text_of, pg_lower};
use crate::dream::{int4, jsonb_check};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, STORE_CORRUPT, StoreError};
use crate::facts::purge_probe::{EachRow, ProbeCell, ProbeRow, each_json};
use crate::jsonb::ordered;
use crate::kv::{KvRead, KvWrite, collect_prefix, scan_prefix};
use crate::links::no_nul;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

mod activations;
mod atom_reads;
mod chronicle_events;
pub(crate) mod derivation_inputs;
mod doctor_reads;
mod fence_evidence;
mod fence_restore;
mod lost_fence;
pub mod needs_rederive;
mod page_rows;
mod repair;
pub use activations::ActivationRecordInput;
pub use chronicle_events::{
    ChronicleSlugSpec, ChronicleSlugsSpec, OrphanedOwnersSpec, PageContentHashQuery,
    RetiredItemKeysSpec,
};
pub use derivation_inputs::DerivationInputsArgs;
pub(crate) use derivation_inputs::{
    derived_closure, derived_from, has_inputs, hop_limit, inputs_of, lineage_reaches,
};
pub use page_rows::GenerationPageRowsQuery;
pub use repair::RepairFilter;

const RECORD: u8 = 0x01;
const POINTER: u8 = 0x02;
const ITEM: u8 = 0x03;
const ATTEMPT: u8 = 0x04;
const VALVE: u8 = 0x05;
const LIVE_OPERATION: u8 = 0x06;
const ATTEMPT_BY_KEY: u8 = 0x07;

/// The id counter (`pages::next_id`).
pub(crate) const ID_COUNTER: &str = "next_derived_generation_id";

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
    /// `held_context::text`, `proposal::text` and `(completeness->'fence')::text` as Postgres
    /// prints them, kept from the written JSON text (`pg_jsonb`): the digits of a number as
    /// `numeric` keeps them, and a JSON `null` apart from SQL NULL (a stored `null` value reads
    /// back as None, so `Some("null")` beside it is the JSON null). A record written before these
    /// fields renders its text from the value (`JsonbColumn`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    held_context_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proposal_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fence_text: Option<String>,
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
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    preimage: Option<Value>,
    #[serde(default)]
    preimage_bytes: Option<i32>,
    pending: bool,
}

/// One row of `derived_generation_attempts`; the key holds `hold_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AttemptRecord {
    source_id: String,
    kind: String,
    owner_key: String,
    attempts: i32,
    codes: Vec<String>,
    updated_at_us: i64,
}

/// One row of `derived_generation_valve`; the key holds `(source_id, kind, window_key)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ValveRecord {
    retired: i32,
    updated_at_us: i64,
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

fn attempt_key(hold_id: &str) -> Vec<u8> {
    let mut key = vec![keys::DERIVED_GENERATION, ATTEMPT];
    key.extend_from_slice(hold_id.as_bytes());
    key
}

fn attempt_index_prefix(parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::DERIVED_GENERATION, ATTEMPT_BY_KEY];
    for part in parts {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key
}

fn attempt_index_key(record: &AttemptRecord, hold_id: &str) -> Vec<u8> {
    let mut key = attempt_index_prefix(&[&record.source_id, &record.kind, &record.owner_key]);
    key.extend_from_slice(hold_id.as_bytes());
    key
}

fn valve_prefix(parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::DERIVED_GENERATION, VALVE];
    for part in parts {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key
}

fn valve_key(source_id: &str, kind: &str, window_key: &str) -> Vec<u8> {
    let mut key = valve_prefix(&[source_id, kind]);
    key.extend_from_slice(window_key.as_bytes());
    key
}

fn live_operation_prefix(operation_id: &str) -> Vec<u8> {
    let mut key = vec![keys::DERIVED_GENERATION, LIVE_OPERATION];
    key.extend_from_slice(operation_id.as_bytes());
    key.push(0);
    key
}

fn live_operation_key(record: &GenerationRecord) -> Vec<u8> {
    let mut key = live_operation_prefix(&record.operation_id);
    key.extend_from_slice(&record.id.to_be_bytes());
    key
}

/// Deletes the attempt row `hold_id` with its index entry.
fn delete_attempt(tx: &mut dyn KvWrite, hold_id: &str) -> Result<()> {
    if let Some(record) = get_json::<AttemptRecord>(&*tx, &attempt_key(hold_id))? {
        tx.delete(&attempt_index_key(&record, hold_id))?;
        tx.delete(&attempt_key(hold_id))?;
    }
    Ok(())
}

/// Deletes the attempt rows whose index entries start with `prefix` (a key, or a source).
fn delete_attempts_under(tx: &mut dyn KvWrite, prefix: &[u8]) -> Result<()> {
    for (k, _) in collect_prefix(&*tx, prefix, false, usize::MAX)? {
        let hold_id = k
            .iter()
            .rposition(|b| *b == 0)
            .map(|at| String::from_utf8_lossy(&k[at + 1..]).into_owned())
            .ok_or_else(|| corrupt("attempt index"))?;
        tx.delete(&k)?;
        tx.delete(&attempt_key(&hold_id))?;
    }
    Ok(())
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

/// Whether the held row of `key` is held for `reason` (`state='held' AND held_reason=…`; the gate of
/// `listHeldFenceTakeRows`).
pub(crate) fn held_for(read: &dyn KvRead, key: &GenerationKey, reason: &str) -> Result<bool> {
    Ok(
        pointed_record(read, key, "held")?
            .is_some_and(|r| r.held_reason.as_deref() == Some(reason)),
    )
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
    if record.state == "live" {
        tx.delete(&live_operation_key(record))?;
    }
    if record.state == "live" || record.state == "held" {
        let key = record_generation_key(record);
        if pointed(&*tx, &key, &record.state)? == Some(record.id) {
            tx.delete(&pointer_key(&key, &record.state))?;
        }
    }
    for (k, _) in collect_prefix(&*tx, &item_prefix(record.id), false, usize::MAX)? {
        tx.delete(&k)?;
    }
    activations::unlink_generation(tx, record.id)?;
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

/// `column::text` of JSON text bound to a `::text::jsonb` cast that `jsonb_text` took as `value`.
fn kept_text(text: &str, value: &Value) -> String {
    pg_jsonb::parse(text).map_or_else(|| jsonb_text_of(value), |parsed| parsed.text())
}

/// `(completeness->'fence')::text` of the completeness JSON text, or None without a `fence` key.
fn fence_text(text: &str, completeness: &Value) -> Option<String> {
    match pg_jsonb::parse(text) {
        Some(parsed) => parsed.get("fence").map(pg_jsonb::Jsonb::text),
        None => completeness.get("fence").map(jsonb_text_of),
    }
}

/// A nullable jsonb column of a record: its value and its kept text.
struct JsonbColumn<'a> {
    value: &'a Option<Value>,
    text: &'a Option<String>,
}

impl JsonbColumn<'_> {
    /// The column's value: `Some(Value::Null)` for a JSON null, None for SQL NULL.
    fn value(&self) -> Option<Value> {
        match (self.value, self.text) {
            (Some(value), _) => Some(value.clone()),
            (None, Some(_)) => Some(Value::Null),
            (None, None) => None,
        }
    }

    /// `column::text`, or None for SQL NULL.
    fn text(&self) -> Option<String> {
        self.text
            .clone()
            .or_else(|| self.value.as_ref().map(jsonb_text_of))
    }
}

impl GenerationRecord {
    fn held_context_column(&self) -> JsonbColumn<'_> {
        JsonbColumn {
            value: &self.held_context,
            text: &self.held_context_text,
        }
    }

    fn proposal_column(&self) -> JsonbColumn<'_> {
        JsonbColumn {
            value: &self.proposal,
            text: &self.proposal_text,
        }
    }

    /// `(completeness->'fence')::text`, or None without a `fence` key.
    fn fence_text(&self) -> Option<String> {
        let fence = self.completeness.as_object()?.get("fence")?;
        Some(
            self.fence_text
                .clone()
                .unwrap_or_else(|| jsonb_text_of(fence)),
        )
    }

    /// `SET proposal=NULL`.
    fn null_proposal(&mut self) {
        self.proposal = None;
        self.proposal_text = None;
    }
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
    Ok(ordered(&value))
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
    /// `hasFenceAbsentHold(sourceId, kind, ownerKey)` (`engine-sql/fence-projection.ts`): whether the
    /// held row of the key was held because a write dropped its fence (`state='held' AND
    /// held_reason='fence_absent'`).
    pub fn has_fence_absent_hold(&self, key: &GenerationKey) -> Result<bool> {
        check_key("hasFenceAbsentHold", key)?;
        let read = self.read()?;
        held_for(&*read, key, "fence_absent")
    }

    /// `listLiveTranscriptGenerations(sourceId, kind, keyPrefix)`: `{ id, owner_key, locator, input_pin }` of each live
    /// generation of the source and kind whose owner key starts with `keyPrefix` (`owner_key LIKE keyPrefix || '%'`; the
    /// TypeScript member refuses a prefix with a wildcard), in owner-key byte order.
    pub fn list_live_transcript_generations(
        &self,
        source_id: &str,
        kind: &str,
        key_prefix: &str,
    ) -> Result<Value> {
        no_nul(
            "listLiveTranscriptGenerations",
            &[
                ("source_id", source_id),
                ("kind", kind),
                ("key_prefix", key_prefix),
            ],
        )?;
        let read = self.read()?;
        let prefix = pointer_prefix(&[source_id, kind]);
        let mut ids = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &prefix, false, &mut |k, v| {
            let rest = &k[prefix.len()..];
            let Some(at) = rest.iter().rposition(|b| *b == 0) else {
                failure = Some(corrupt("pointer"));
                return false;
            };
            if &rest[at + 1..] == b"live" && rest[..at].starts_with(key_prefix.as_bytes()) {
                match keys::be8(v) {
                    Some(id) => ids.push(id),
                    None => {
                        failure = Some(corrupt("pointer"));
                        return false;
                    }
                }
            }
            true
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut out = Vec::new();
        for id in ids {
            let record = read_record(&*read, id)?.ok_or_else(|| corrupt("pointer target"))?;
            out.push(json!({
                "id": record.id, "owner_key": record.owner_key, "locator": record.locator, "input_pin": record.input_pin,
            }));
        }
        Ok(Value::Array(out))
    }

    /// `moveGenerationLocator(id, locator)`: the generation `id` points at `locator`, stamped now; nothing for an
    /// unknown id.
    pub fn move_generation_locator(&self, id: i64, locator: &str) -> Result<()> {
        no_nul("moveGenerationLocator", &[("locator", locator)])?;
        let Ok(id) = u64::try_from(id) else {
            return Ok(());
        };
        self.write(|tx| {
            let Some(mut record) = read_record(&*tx, id)? else {
                return Ok(());
            };
            record.locator = Some(locator.to_owned());
            record.updated_at_us = self.env.now_micros();
            put_json(tx, &record_key(id), &record)
        })
    }

    /// `readLiveGenerationLocator(sourceId, kind, ownerKey)`: `{ locator }` of the live generation, or null.
    pub fn read_live_generation_locator(&self, key: &GenerationKey) -> Result<Value> {
        check_key("readLiveGenerationLocator", key)?;
        let read = self.read()?;
        Ok(match pointed_record(&*read, key, "live")? {
            Some(record) => json!({ "locator": record.locator }),
            None => Value::Null,
        })
    }

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
        let completeness_fence = fence_text(&row.completeness, &completeness);
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
                    Some(ordered(value))
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
                tx.delete(&live_operation_key(&live))?;
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
                held_context_text: None,
                proposal_text: None,
                fence_text: completeness_fence.clone(),
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
            tx.put(&live_operation_key(&record), &[])?;
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
            // ... DELETE FROM derived_generation_attempts WHERE source_id=$1 AND kind=$2 AND owner_key=$3
            delete_attempts_under(
                tx,
                &attempt_index_prefix(&[&key.source_id, &key.kind, &key.owner_key]),
            )?;
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
            let held_context_text = kept_text(&row.context, &held_context);
            let proposal = row
                .proposal
                .as_deref()
                .map(|text| jsonb_text(OP, "proposal", text))
                .transpose()?;
            let proposal_text = row
                .proposal
                .as_deref()
                .zip(proposal.as_ref())
                .map(|(text, value)| kept_text(text, value));
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
                held_context_text: Some(held_context_text),
                proposal_text,
                fence_text: None,
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

    /// `readGenerationRestored(key)`: whether the key's live row is a restore (`restore_of` set);
    /// false when the key has no live row.
    pub fn read_generation_restored(&self, key: &GenerationKey) -> Result<bool> {
        check_key("readGenerationRestored", key)?;
        let read = self.read()?;
        Ok(pointed_record(&*read, key, "live")?.is_some_and(|record| record.restore_of.is_some()))
    }

    /// `clearTieHeldGenerationRows(sourceId, kind, ownerPrefix)`: deletes the held rows of `kind`
    /// in `source_id` held `tie` whose owner key starts with `owner_prefix`, with their items. The
    /// prefix is compared as `left(owner_key, <UTF-16 length of the prefix>)`, as the caller sends
    /// Postgres its JavaScript length.
    pub fn clear_tie_held_generation_rows(
        &self,
        source_id: &str,
        kind: &str,
        owner_prefix: &str,
    ) -> Result<()> {
        no_nul(
            "clearTieHeldGenerationRows",
            &[
                ("sourceId", source_id),
                ("kind", kind),
                ("ownerPrefix", owner_prefix),
            ],
        )?;
        let width = owner_prefix.encode_utf16().count();
        self.write(|tx| {
            let mut held = Vec::new();
            for (k, v) in
                collect_prefix(&*tx, &pointer_prefix(&[source_id, kind]), false, usize::MAX)?
            {
                if k.ends_with(b"\0held") {
                    held.push(keys::be8(&v).ok_or_else(|| corrupt("pointer"))?);
                }
            }
            for id in held {
                let record = read_record(&*tx, id)?.ok_or_else(|| corrupt("pointer target"))?;
                if record.held_reason.as_deref() == Some("tie")
                    && record.owner_key.chars().take(width).collect::<String>() == owner_prefix
                {
                    delete_row(tx, &record)?;
                }
            }
            Ok(())
        })
    }

    /// `heldGenerationRowsForInput(key, pin)`: the held rows of `key` whose `input_pin` is `pin`
    /// (at most one: a key holds one held row).
    pub fn held_generation_rows_for_input(&self, key: &GenerationKey, pin: &str) -> Result<Value> {
        const OP: &str = "heldGenerationRowsForInput";
        check_key(OP, key)?;
        no_nul(OP, &[("input_pin", pin)])?;
        let read = self.read()?;
        let rows = match pointed_record(&*read, key, "held")? {
            Some(held) if held.input_pin.as_deref() == Some(pin) => vec![json!({
                "hold_id": held.hold_id,
                "item_set_hash": held.item_set_hash,
                "held_reason": held.held_reason,
            })],
            _ => Vec::new(),
        };
        Ok(Value::Array(rows))
    }

    /// `readHeldGenerationContext(key, holdId)`: `{ held_context }` of the key's held row when its
    /// `hold_id` is `hold_id`, or null.
    pub fn read_held_generation_context(
        &self,
        key: &GenerationKey,
        hold_id: &str,
    ) -> Result<Value> {
        const OP: &str = "readHeldGenerationContext";
        check_key(OP, key)?;
        no_nul(OP, &[("hold_id", hold_id)])?;
        let read = self.read()?;
        Ok(match pointed_record(&*read, key, "held")? {
            Some(held) if held.hold_id.as_deref() == Some(hold_id) => {
                json!({ "held_context": held.held_context })
            }
            _ => Value::Null,
        })
    }

    /// `liveGenerationForOperation(operationId)`: the `generation` of a live row whose
    /// `operation_id` is `operation_id`, or null.
    pub fn live_generation_for_operation(&self, operation_id: &str) -> Result<Value> {
        const OP: &str = "liveGenerationForOperation";
        no_nul(OP, &[("operation_id", operation_id)])?;
        let read = self.read()?;
        let prefix = live_operation_prefix(operation_id);
        let Some((k, _)) = collect_prefix(&*read, &prefix, false, 1)?
            .into_iter()
            .next()
        else {
            return Ok(Value::Null);
        };
        let id = keys::be8(&k[prefix.len()..]).ok_or_else(|| corrupt("operation index"))?;
        let record = read_record(&*read, id)?.ok_or_else(|| corrupt("operation index target"))?;
        if record.state != "live" {
            return Err(corrupt("operation index state"));
        }
        Ok(json!(record.generation))
    }

    /// `countGenerationAttempt(key, holdId, code)`: inserts the attempt row `hold_id` with one
    /// attempt and `[code]`, or adds one attempt and appends `code`; resolves
    /// `{ attempts, codes }`.
    pub fn count_generation_attempt(
        &self,
        key: &GenerationKey,
        hold_id: &str,
        code: &str,
    ) -> Result<Value> {
        const OP: &str = "countGenerationAttempt";
        check_key(OP, key)?;
        no_nul(OP, &[("hold_id", hold_id), ("code", code)])?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let record = match get_json::<AttemptRecord>(&*tx, &attempt_key(hold_id))? {
                // ON CONFLICT (hold_id) DO UPDATE: the row keeps its own key columns.
                Some(mut existing) => {
                    existing.attempts = existing.attempts.checked_add(1).ok_or_else(|| {
                        StoreError::new(
                            INVALID_ARGUMENT,
                            format!("{OP}: integer out of range (attempts)"),
                        )
                    })?;
                    existing.codes.push(code.to_owned());
                    existing.updated_at_us = now;
                    existing
                }
                None => {
                    crate::sources::require_source(&*tx, &key.source_id)?;
                    AttemptRecord {
                        source_id: key.source_id.clone(),
                        kind: key.kind.clone(),
                        owner_key: key.owner_key.clone(),
                        attempts: 1,
                        codes: vec![code.to_owned()],
                        updated_at_us: now,
                    }
                }
            };
            put_json(tx, &attempt_key(hold_id), &record)?;
            tx.put(&attempt_index_key(&record, hold_id), &[])?;
            Ok(json!({ "attempts": record.attempts, "codes": record.codes }))
        })
    }

    /// `clearGenerationAttempts(holdId)`: deletes the attempt row `hold_id`.
    pub fn clear_generation_attempts(&self, hold_id: &str) -> Result<()> {
        no_nul("clearGenerationAttempts", &[("hold_id", hold_id)])?;
        self.write(|tx| delete_attempt(tx, hold_id))
    }

    /// `readGenerationValve(key, windowKey)`: `{ retired, owned }`: the retirements of the
    /// source and kind's valve window (null: no row), and the items the live generations of the
    /// source and kind own.
    pub fn read_generation_valve(&self, key: &GenerationKey, window_key: &str) -> Result<Value> {
        const OP: &str = "readGenerationValve";
        check_key(OP, key)?;
        no_nul(OP, &[("window_key", window_key)])?;
        let read = self.read()?;
        let retired =
            get_json::<ValveRecord>(&*read, &valve_key(&key.source_id, &key.kind, window_key))?
                .map(|valve| valve.retired);
        let mut live = Vec::new();
        let prefix = pointer_prefix(&[&key.source_id, &key.kind]);
        for (k, v) in collect_prefix(&*read, &prefix, false, usize::MAX)? {
            if k.ends_with(b"\0live") {
                live.push(keys::be8(&v).ok_or_else(|| corrupt("pointer"))?);
            }
        }
        let mut owned: i64 = 0;
        for id in live {
            let mut failure = None;
            scan_prefix(&*read, &item_prefix(id), false, &mut |_, v| {
                match serde_json::from_slice::<ItemRecord>(v) {
                    Ok(item) if OWNED_ACTIONS.contains(&item.action.as_str()) => owned += 1,
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
        }
        Ok(json!({ "retired": retired, "owned": owned }))
    }

    /// `bumpGenerationValve(key, windowKey, retired)`: adds `retired` to the valve window of the
    /// key's source and kind (inserted at `retired`).
    pub fn bump_generation_valve(
        &self,
        key: &GenerationKey,
        window_key: &str,
        retired: f64,
    ) -> Result<()> {
        const OP: &str = "bumpGenerationValve";
        check_key(OP, key)?;
        no_nul(OP, &[("window_key", window_key)])?;
        let retired = int4(OP, "retired", retired)?;
        let now = self.env.now_micros();
        let at = valve_key(&key.source_id, &key.kind, window_key);
        self.write(|tx| {
            let total = match get_json::<ValveRecord>(&*tx, &at)? {
                Some(valve) => valve.retired.checked_add(retired).ok_or_else(|| {
                    StoreError::new(
                        INVALID_ARGUMENT,
                        format!("{OP}: integer out of range (retired)"),
                    )
                })?,
                None => {
                    crate::sources::require_source(&*tx, &key.source_id)?;
                    retired
                }
            };
            put_json(
                tx,
                &at,
                &ValveRecord {
                    retired: total,
                    updated_at_us: now,
                },
            )
        })
    }

    /// `scrubGenerationPageRows(sourceId, kinds, slug)`, the page purge scrub, in the order of
    /// its four statements: deletes the held rows of `kinds` owned by `page:<slug>`; nulls the
    /// preimage of the item `slug` in every generation of the source; nulls every proposal whose
    /// owner key ends in `:<slug>` or that proposes an object with `"key": slug`; drops the
    /// `fence` key of the completeness of every row owned by `page:<slug>`. Resolves
    /// `{ derived_generation_items, derived_generations }`, each the rows its statements changed.
    pub fn scrub_generation_page_rows(
        &self,
        source_id: &str,
        kinds: &[String],
        slug: &str,
    ) -> Result<Value> {
        const OP: &str = "scrubGenerationPageRows";
        no_nul(OP, &[("source_id", source_id), ("slug", slug)])?;
        for kind in kinds {
            no_nul(OP, &[("kind", kind)])?;
        }
        let now = self.env.now_micros();
        let owner = format!("page:{slug}");
        let suffix = format!(":{slug}");
        self.write(|tx| {
            let (mut items, mut generations) = (0u64, 0u64);
            let mut kept = Vec::new();
            for record in source_records(&*tx, source_id)? {
                if record.state == "held"
                    && record.owner_key == owner
                    && kinds.contains(&record.kind)
                {
                    delete_row(tx, &record)?;
                    generations += 1;
                } else {
                    kept.push(record);
                }
            }
            for record in &kept {
                let at = item_key(record.id, slug);
                if let Some(mut item) = get_json::<ItemRecord>(&*tx, &at)?
                    && item.preimage.is_some()
                {
                    item.preimage = None;
                    put_json(tx, &at, &item)?;
                    items += 1;
                }
            }
            for record in &mut kept {
                let named = record.proposal_column().value().is_some_and(|proposal| {
                    record.owner_key.ends_with(&suffix) || proposes_key(&proposal, slug)
                });
                if named {
                    record.null_proposal();
                    record.updated_at_us = now;
                    put_json(tx, &record_key(record.id), &*record)?;
                    generations += 1;
                }
            }
            for record in &mut kept {
                if record.owner_key == owner && drop_fence(record) {
                    record.updated_at_us = now;
                    put_json(tx, &record_key(record.id), &*record)?;
                    generations += 1;
                }
            }
            Ok(json!({ "derived_generation_items": items, "derived_generations": generations }))
        })
    }

    /// `scrubGenerationTextRows(sourceId, needles)`, the fact purge scrub, in the order of its
    /// three statements: nulls every item preimage of the source whose jsonb text, lowered,
    /// contains a needle; nulls both the proposal and the held context of every row where either
    /// does; drops the `fence` key of every completeness whose `fence` value does. The needles
    /// arrive lowercase. Resolves `{ derived_generation_items, derived_generations }`.
    pub fn scrub_generation_text_rows(&self, source_id: &str, needles: &[String]) -> Result<Value> {
        const OP: &str = "scrubGenerationTextRows";
        no_nul(OP, &[("source_id", source_id)])?;
        for needle in needles {
            no_nul(OP, &[("needle", needle)])?;
        }
        let carries_text = |text: &str| {
            let text = pg_lower(text);
            needles.iter().any(|needle| text.contains(needle.as_str()))
        };
        let carries = |value: &Value| carries_text(&jsonb_text_of(value));
        let now = self.env.now_micros();
        self.write(|tx| {
            let (mut items, mut generations) = (0u64, 0u64);
            let mut records = source_records(&*tx, source_id)?;
            for record in &records {
                for (k, v) in collect_prefix(&*tx, &item_prefix(record.id), false, usize::MAX)? {
                    let mut item: ItemRecord = serde_json::from_slice(&v)?;
                    if item.preimage.as_ref().is_some_and(&carries) {
                        item.preimage = None;
                        put_json(tx, &k, &item)?;
                        items += 1;
                    }
                }
            }
            for record in &mut records {
                if record
                    .proposal_column()
                    .text()
                    .is_some_and(|t| carries_text(&t))
                    || record
                        .held_context_column()
                        .text()
                        .is_some_and(|t| carries_text(&t))
                {
                    record.null_proposal();
                    record.held_context = None;
                    record.held_context_text = None;
                    record.updated_at_us = now;
                    put_json(tx, &record_key(record.id), &*record)?;
                    generations += 1;
                }
            }
            for record in &mut records {
                let fenced = record.fence_text().is_some_and(|t| carries_text(&t));
                if fenced && drop_fence(record) {
                    record.updated_at_us = now;
                    put_json(tx, &record_key(record.id), &*record)?;
                    generations += 1;
                }
            }
            Ok(json!({ "derived_generation_items": items, "derived_generations": generations }))
        })
    }
}

/// The `derived_generations` rows of `source_id`, in id order (the records carry no source index).
fn source_records(read: &dyn KvRead, source_id: &str) -> Result<Vec<GenerationRecord>> {
    let mut rows = Vec::new();
    let mut failure = None;
    scan_prefix(
        read,
        &[keys::DERIVED_GENERATION, RECORD],
        false,
        &mut |_, v| {
            match serde_json::from_slice::<GenerationRecord>(v) {
                Ok(record) if record.source_id == source_id => rows.push(record),
                Ok(_) => {}
                Err(e) => {
                    failure = Some(StoreError::from(e));
                    return false;
                }
            }
            true
        },
    )?;
    match failure {
        Some(e) => Err(e),
        None => Ok(rows),
    }
}

/// One `derived_generations` row with its `derived_generation_items`, as other families read the
/// ledger (`facts::generations`, `listUnwithdrawnFacts`).
pub(crate) struct GenerationView {
    pub id: u64,
    pub owner_key: String,
    pub generation: i32,
    pub state: String,
    pub created_at_us: i64,
    pub items: Vec<GenerationItemView>,
}

/// One `derived_generation_items` row of a [`GenerationView`].
pub(crate) struct GenerationItemView {
    pub action: String,
    pub preimage: Option<Value>,
}

/// The generation rows of `source_id` of `kind` with their items, in id order and item key
/// order: the one read of this ledger outside this module.
pub(crate) fn source_generation_views(
    read: &dyn KvRead,
    source_id: &str,
    kind: &str,
) -> Result<Vec<GenerationView>> {
    let mut out = Vec::new();
    for record in source_records(read, source_id)? {
        if record.kind != kind {
            continue;
        }
        let mut items = Vec::new();
        for (_, v) in collect_prefix(read, &item_prefix(record.id), false, usize::MAX)? {
            let item: ItemRecord = serde_json::from_slice(&v)?;
            items.push(GenerationItemView {
                action: item.action,
                preimage: item.preimage,
            });
        }
        out.push(GenerationView {
            id: record.id,
            owner_key: record.owner_key,
            generation: record.generation,
            state: record.state,
            created_at_us: record.created_at_us,
            items,
        });
    }
    Ok(out)
}

/// What the shadow seed (`seed/history.rs`) copies of a `derived_generations` row.
pub(crate) struct SeedGeneration {
    pub source_id: String,
    pub kind: String,
    pub owner_key: String,
    pub generation: i32,
    pub state: String,
    pub created_at_us: i64,
}

/// The shadow seed: stores a generation copied from another engine under its own id, with no
/// items yet. The columns the seed does not copy keep their defaults (no operation, an empty
/// completeness); a live or held row takes its key's pointer, as the store's own writers do.
/// `false` when the id already holds a generation.
pub(crate) fn seed_generation(
    tx: &mut dyn KvWrite,
    id: u64,
    seed: &SeedGeneration,
) -> Result<bool> {
    if read_record(&*tx, id)?.is_some() {
        return Ok(false);
    }
    let key = GenerationKey {
        source_id: seed.source_id.clone(),
        kind: seed.kind.clone(),
        owner_key: seed.owner_key.clone(),
    };
    let pointed_state = matches!(seed.state.as_str(), "live" | "held");
    if pointed_state && pointed(&*tx, &key, &seed.state)?.is_some() {
        return Err(unique_violation("derived_generations_one_live"));
    }
    crate::sources::require_source(&*tx, &seed.source_id)?;
    let record = GenerationRecord {
        id,
        source_id: seed.source_id.clone(),
        kind: seed.kind.clone(),
        owner_key: seed.owner_key.clone(),
        generation: seed.generation,
        state: seed.state.clone(),
        run_id: None,
        operation_id: String::new(),
        hold_id: None,
        input_pin: None,
        input_size: None,
        completeness: json!({}),
        item_set_hash: String::new(),
        held_reason: None,
        held_context: None,
        proposal: None,
        held_context_text: None,
        proposal_text: None,
        fence_text: None,
        proposal_bytes: None,
        attempts: 0,
        superseded_by: None,
        restore_of: None,
        created_at_us: seed.created_at_us,
        updated_at_us: seed.created_at_us,
        locator: None,
        activation_id: None,
    };
    put_json(tx, &record_key(id), &record)?;
    if pointed_state {
        tx.put(&pointer_key(&key, &seed.state), &id.to_be_bytes())?;
    }
    crate::seed::raise_counter(tx, ID_COUNTER, id)?;
    Ok(true)
}

/// The shadow follow (`seed/follow.rs`): removes the generation `id` with its items, pointers and
/// activation links. `false` when there is none.
pub(crate) fn remove_generation(tx: &mut dyn KvWrite, id: u64) -> Result<bool> {
    let Some(record) = read_record(&*tx, id)? else {
        return Ok(false);
    };
    delete_row(tx, &record)?;
    Ok(true)
}

/// The shadow follow: replaces the header of generation `id` and keeps its items and the columns
/// the seed does not copy, as an `UPDATE` of the row does. Stores a new generation when there is
/// none. A state change moves the key's `live` or `held` pointer with it.
pub(crate) fn replace_generation(
    tx: &mut dyn KvWrite,
    id: u64,
    seed: &SeedGeneration,
) -> Result<()> {
    let Some(old) = read_record(&*tx, id)? else {
        seed_generation(tx, id, seed)?;
        return Ok(());
    };
    // Release what the old header pointed at, then point the new one.
    if old.state == "live" {
        tx.delete(&live_operation_key(&old))?;
    }
    if old.state == "live" || old.state == "held" {
        let old_key = record_generation_key(&old);
        if pointed(&*tx, &old_key, &old.state)? == Some(id) {
            tx.delete(&pointer_key(&old_key, &old.state))?;
        }
    }
    let key = GenerationKey {
        source_id: seed.source_id.clone(),
        kind: seed.kind.clone(),
        owner_key: seed.owner_key.clone(),
    };
    let pointed_state = matches!(seed.state.as_str(), "live" | "held");
    if pointed_state && pointed(&*tx, &key, &seed.state)?.is_some_and(|other| other != id) {
        return Err(unique_violation("derived_generations_one_live"));
    }
    crate::sources::require_source(&*tx, &seed.source_id)?;
    let mut record = old;
    record.source_id = seed.source_id.clone();
    record.kind = seed.kind.clone();
    record.owner_key = seed.owner_key.clone();
    record.generation = seed.generation;
    record.state = seed.state.clone();
    record.created_at_us = seed.created_at_us;
    put_json(tx, &record_key(id), &record)?;
    if pointed_state {
        tx.put(&pointer_key(&key, &seed.state), &id.to_be_bytes())?;
    }
    if record.state == "live" {
        tx.put(&live_operation_key(&record), &[])?;
    }
    Ok(())
}

/// The shadow follow: removes the item `item_key_text` of generation `generation_id`. `false` when
/// there is none.
pub(crate) fn remove_item(
    tx: &mut dyn KvWrite,
    generation_id: u64,
    item_key_text: &str,
) -> Result<bool> {
    let key = item_key(generation_id, item_key_text);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}

/// The shadow seed: appends an item to its generation, where the items' foreign key keeps them. A
/// generation that is not stored is the foreign key violation; `false` when it already holds the
/// item key.
pub(crate) fn seed_item(
    tx: &mut dyn KvWrite,
    generation_id: u64,
    item_key_text: &str,
    action: &str,
    preimage: Option<Value>,
) -> Result<bool> {
    if read_record(&*tx, generation_id)?.is_none() {
        return Err(crate::takes::fk_failed(
            "derived_generation_items",
            "derived_generation_items_generation_id_fkey",
        ));
    }
    if !ITEM_ACTIONS.contains(&action) {
        return Err(check_violation(
            "derived_generation_items_action_check",
            "derived_generation_items",
        ));
    }
    let key = item_key(generation_id, item_key_text);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    let preimage = match preimage {
        None | Some(Value::Null) => None,
        Some(value) => Some(ordered(&value)),
    };
    put_json(
        tx,
        &key,
        &ItemRecord {
            identity_hash: String::new(),
            action: action.to_string(),
            preimage,
            preimage_bytes: None,
            pending: false,
        },
    )?;
    Ok(true)
}

/// `proposal @> jsonb_build_array(jsonb_build_object('key', slug))`: the proposal is an array
/// with an object element whose `key` is the string `slug`.
fn proposes_key(proposal: &Value, slug: &str) -> bool {
    proposal.as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item.get("key").and_then(Value::as_str) == Some(slug))
    })
}

/// `completeness - 'fence'` where `completeness->'fence' IS NOT NULL`: true when the key was there.
fn drop_fence(record: &mut GenerationRecord) -> bool {
    record.fence_text = None;
    record
        .completeness
        .as_object_mut()
        .is_some_and(|o| o.remove("fence").is_some())
}

/// `ON DELETE CASCADE` of `derived_generations.source_id` (and of the items with their row).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let doomed = source_records(&*tx, source_id)?;
    for record in &doomed {
        delete_row(tx, record)?;
    }
    activations::remove_source_activations(tx, source_id)?;
    derivation_inputs::remove_source_edges(tx, source_id)?;
    needs_rederive::remove_source_rows(tx, source_id)?;
    delete_attempts_under(tx, &attempt_index_prefix(&[source_id]))?;
    for (k, _) in collect_prefix(&*tx, &valve_prefix(&[source_id]), false, usize::MAX)? {
        tx.delete(&k)?;
    }
    Ok(())
}

/// The `derived_generations` rows as the table probe of a fact purge's receipt reads them (`facts/purge_probe.rs`): the ledger's
/// own columns, the jsonb ones as Postgres prints them.
pub(crate) fn probe_generations(read: &dyn KvRead, f: EachRow) -> Result<()> {
    each_json::<GenerationRecord>(read, &[keys::DERIVED_GENERATION, RECORD], &mut |_, g| {
        let jsonb = |text: &Option<String>, value: &Option<Value>| match text {
            Some(_) => ProbeCell::opt_jsonb_text(text.as_deref()),
            None => ProbeCell::opt_jsonb(value.as_ref()),
        };
        let cells = vec![
            ("source_id", ProbeCell::text(&g.source_id)),
            ("kind", ProbeCell::text(&g.kind)),
            ("owner_key", ProbeCell::text(&g.owner_key)),
            ("state", ProbeCell::text(&g.state)),
            ("run_id", ProbeCell::opt_text(g.run_id.as_deref())),
            ("operation_id", ProbeCell::text(&g.operation_id)),
            ("hold_id", ProbeCell::opt_text(g.hold_id.as_deref())),
            ("input_pin", ProbeCell::opt_text(g.input_pin.as_deref())),
            ("completeness", ProbeCell::jsonb(&g.completeness)),
            ("item_set_hash", ProbeCell::text(&g.item_set_hash)),
            ("held_reason", ProbeCell::opt_text(g.held_reason.as_deref())),
            ("held_context", jsonb(&g.held_context_text, &g.held_context)),
            ("proposal", jsonb(&g.proposal_text, &g.proposal)),
            ("locator", ProbeCell::opt_text(g.locator.as_deref())),
            (
                "activation_id",
                ProbeCell::opt_text(g.activation_id.as_deref()),
            ),
        ];
        f(ProbeRow {
            source_id: Some(g.source_id),
            cells,
        })
    })
}

/// The `derived_generation_items` rows as the table probe reads them: the table has no `source_id`, so the probe is brain-wide.
pub(crate) fn probe_items(read: &dyn KvRead, f: EachRow) -> Result<()> {
    each_json::<ItemRecord>(read, &[keys::DERIVED_GENERATION, ITEM], &mut |k, item| {
        // The key is `h 0x03 id(8) item_key`.
        let item_key = String::from_utf8_lossy(k.get(10..).unwrap_or_default()).into_owned();
        f(ProbeRow {
            source_id: None,
            cells: vec![
                ("item_key", ProbeCell::text(&item_key)),
                ("identity_hash", ProbeCell::text(&item.identity_hash)),
                ("action", ProbeCell::text(&item.action)),
                ("preimage", ProbeCell::opt_jsonb(item.preimage.as_ref())),
            ],
        })
    })
}

#[cfg(test)]
mod tests {
    //! The family's writes run on the store's `FlaggingWriter`: a page record put with readers in
    //! the same write closure as a generation write still sets the member-access flag.

    use super::*;
    use crate::access_flag::RESTRICTIONS_PRESENT_KEY as FLAG;
    use crate::test_support::store;

    /// A stored page with no readers (a real `put_page`), so a raw write can name its readers.
    fn put_open_page(store: &Store, slug: &str) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": {"tags": ["a"]}
        }))
        .unwrap();
        let opts: crate::pages::PutPageOptions =
            serde_json::from_value(json!({"sourceId": "default"})).unwrap();
        store.put_page(slug, &input, &opts).unwrap();
    }

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
        put_open_page(&store, "notes/closed");
        assert_eq!(store.get_config(FLAG).unwrap(), None);
        store
            .write(|tx| {
                crate::sources::require_source(&*tx, "default")?;
                let id = crate::pages::next_id(tx, ID_COUNTER)?;
                tx.put(&pointer_key(&key(), "held"), &id.to_be_bytes())?;
                tx.delete(&pointer_key(&key(), "held"))?;
                let page = keys::page("default", "notes/closed");
                let mut record: serde_json::Value =
                    serde_json::from_slice(&tx.get(&page)?.unwrap())?;
                record["frontmatter"]["readable_by"] = json!(["alice-example"]);
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

    fn activation(operation: &str, generation: f64) -> ActivationInput {
        ActivationInput {
            generation,
            run_id: None,
            operation_id: operation.into(),
            input_pin: None,
            input_size: None,
            completeness: "{}".into(),
            set_hash: "set".into(),
            restore_of: None,
            activation_id: None,
            locator: None,
        }
    }

    fn owned(item: &str) -> LedgerItemInput {
        LedgerItemInput {
            item_key: item.into(),
            identity_hash: item.into(),
            action: "published".into(),
            preimage: None,
            preimage_bytes: None,
            pending: false,
        }
    }

    #[test]
    fn attempts_count_up_and_an_activation_deletes_its_keys_counters() {
        let store = store();
        let one = store
            .count_generation_attempt(&key(), "a1", "boom")
            .unwrap();
        assert_eq!(one, json!({"attempts": 1, "codes": ["boom"]}));
        let two = store
            .count_generation_attempt(&key(), "a1", "bang")
            .unwrap();
        assert_eq!(two, json!({"attempts": 2, "codes": ["boom", "bang"]}));
        store.clear_generation_attempts("a1").unwrap();
        let again = store
            .count_generation_attempt(&key(), "a1", "boom")
            .unwrap();
        assert_eq!(again["attempts"], json!(1));
        store
            .activate_generation_rows(&key(), None, &activation("op1", 1.0), &[owned("x")])
            .unwrap();
        let read = store.read().unwrap();
        assert!(
            collect_prefix(&*read, &[keys::DERIVED_GENERATION, ATTEMPT], false, 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_replay_lookup_finds_only_the_live_row_of_an_operation() {
        let store = store();
        assert_eq!(
            store.live_generation_for_operation("op1").unwrap(),
            Value::Null
        );
        let first = store
            .activate_generation_rows(&key(), None, &activation("op1", 1.0), &[owned("x")])
            .unwrap();
        assert_eq!(
            store.live_generation_for_operation("op1").unwrap(),
            json!(1)
        );
        store
            .activate_generation_rows(&key(), Some(first as f64), &activation("op2", 2.0), &[])
            .unwrap();
        assert_eq!(
            store.live_generation_for_operation("op1").unwrap(),
            Value::Null
        );
        assert_eq!(
            store.live_generation_for_operation("op2").unwrap(),
            json!(2)
        );
    }

    #[test]
    fn the_valve_adds_retirements_and_counts_live_owned_items() {
        let store = store();
        let empty = store
            .read_generation_valve(&key(), "day:2026-11-19")
            .unwrap();
        assert_eq!(empty, json!({"retired": null, "owned": 0}));
        store
            .activate_generation_rows(
                &key(),
                None,
                &activation("op1", 1.0),
                &[owned("x"), owned("y")],
            )
            .unwrap();
        store
            .bump_generation_valve(&key(), "day:2026-11-19", 2.0)
            .unwrap();
        store
            .bump_generation_valve(&key(), "day:2026-11-19", 3.0)
            .unwrap();
        let valve = store
            .read_generation_valve(&key(), "day:2026-11-19")
            .unwrap();
        assert_eq!(valve, json!({"retired": 5, "owned": 2}));
        let err = store
            .bump_generation_valve(&key(), "day:x", 0.5)
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
    }

    #[test]
    fn the_held_reads_match_the_held_row() {
        let store = store();
        let mut row = held("h1", "attempts_exhausted");
        row.input_pin = Some("pin-1".into());
        store.record_held_generation_row(&key(), &row).unwrap();
        let rows = store
            .held_generation_rows_for_input(&key(), "pin-1")
            .unwrap();
        assert_eq!(rows[0]["hold_id"], json!("h1"));
        assert_eq!(
            store
                .held_generation_rows_for_input(&key(), "pin-2")
                .unwrap(),
            json!([])
        );
        let context = store.read_held_generation_context(&key(), "h1").unwrap();
        assert_eq!(context["held_context"]["slug"], json!("notes/a"));
        assert_eq!(
            store.read_held_generation_context(&key(), "h2").unwrap(),
            Value::Null
        );
    }

    #[test]
    fn an_attempt_and_a_reader_page_put_in_one_write_set_the_flag() {
        let store = store();
        put_open_page(&store, "notes/closed");
        assert_eq!(store.get_config(FLAG).unwrap(), None);
        store
            .write(|tx| {
                let record = AttemptRecord {
                    source_id: "default".into(),
                    kind: "facts_fence".into(),
                    owner_key: "page:notes/a".into(),
                    attempts: 1,
                    codes: vec!["boom".into()],
                    updated_at_us: 0,
                };
                put_json(tx, &attempt_key("a1"), &record)?;
                tx.put(&attempt_index_key(&record, "a1"), &[])?;
                let page = keys::page("default", "notes/closed");
                let mut page_record: serde_json::Value =
                    serde_json::from_slice(&tx.get(&page)?.unwrap())?;
                page_record["frontmatter"]["readable_by"] = json!(["alice-example"]);
                tx.put(&page, &serde_json::to_vec(&page_record)?)
            })
            .unwrap();
        assert_eq!(store.get_config(FLAG).unwrap().as_deref(), Some("1"));
        let alone = crate::test_support::store();
        alone
            .count_generation_attempt(&key(), "a1", "boom")
            .unwrap();
        alone.bump_generation_valve(&key(), "day:x", 1.0).unwrap();
        assert_eq!(alone.get_config(FLAG).unwrap(), None);
    }

    #[test]
    fn a_source_delete_removes_its_rows() {
        let store = store();
        store
            .record_held_generation_row(&key(), &held("h1", "no_proof"))
            .unwrap();
        store
            .activate_generation_rows(&key(), None, &activation("op1", 1.0), &[owned("x")])
            .unwrap();
        store
            .count_generation_attempt(&key(), "a1", "boom")
            .unwrap();
        store.bump_generation_valve(&key(), "day:x", 1.0).unwrap();
        store.write(|tx| remove_source_rows(tx, "default")).unwrap();
        let read = store.read().unwrap();
        assert!(
            collect_prefix(&*read, &[keys::DERIVED_GENERATION], false, 10)
                .unwrap()
                .is_empty()
        );
    }

    fn scrub_fixture(store: &Store) -> (GenerationKey, GenerationKey) {
        store
            .record_held_generation_row(&key(), &held("h1", "no_proof"))
            .unwrap();
        let live = GenerationKey {
            kind: "other".into(),
            ..key()
        };
        let mut row = activation("op1", 1.0);
        row.completeness = r#"{"fence":{"text":"Hello World"},"complete":true}"#.into();
        let mut a = owned("notes/a");
        a.preimage = Some(json!({"body": "Hello World"}));
        let mut b = owned("notes/b");
        b.preimage = Some(json!({"body": "other"}));
        store
            .activate_generation_rows(&live, None, &row, &[a, b])
            .unwrap();
        let input = GenerationKey {
            kind: "other".into(),
            owner_key: "input:q".into(),
            ..key()
        };
        let mut proposing = held("h2", "no_proof");
        proposing.proposal = Some(r#"[{"key":"notes/a","n":1}]"#.into());
        proposing.context = r#"{"note":"HELLO world"}"#.into();
        store
            .record_held_generation_row(&input, &proposing)
            .unwrap();
        (live, input)
    }

    fn row_of(store: &Store, key: &GenerationKey, state: &str) -> Option<GenerationRecord> {
        pointed_record(&*store.read().unwrap(), key, state).unwrap()
    }

    fn preimage_of(store: &Store, id: u64, item: &str) -> Option<Value> {
        get_json::<ItemRecord>(&*store.read().unwrap(), &item_key(id, item))
            .unwrap()
            .unwrap()
            .preimage
    }

    #[test]
    fn the_page_scrub_deletes_holds_and_clears_preimages_proposals_and_fences() {
        let store = store();
        let (live, input) = scrub_fixture(&store);
        let kinds = vec!["facts_fence".to_string()];
        let counts = store
            .scrub_generation_page_rows("default", &kinds, "notes/a")
            .unwrap();
        assert_eq!(
            counts,
            json!({"derived_generation_items": 1, "derived_generations": 3})
        );
        assert!(row_of(&store, &key(), "held").is_none());
        let live_row = row_of(&store, &live, "live").unwrap();
        assert_eq!(live_row.completeness, json!({"complete": true}));
        assert_eq!(preimage_of(&store, live_row.id, "notes/a"), None);
        assert_eq!(
            preimage_of(&store, live_row.id, "notes/b"),
            Some(json!({"body": "other"}))
        );
        let input_row = row_of(&store, &input, "held").unwrap();
        assert_eq!(input_row.proposal, None);
        assert!(input_row.held_context.is_some());
        // A second scrub finds nothing left to change.
        let again = store
            .scrub_generation_page_rows("default", &kinds, "notes/a")
            .unwrap();
        assert_eq!(
            again,
            json!({"derived_generation_items": 0, "derived_generations": 0})
        );
        // Another source is untouched.
        let other = store
            .scrub_generation_page_rows("elsewhere", &kinds, "notes/b")
            .unwrap();
        assert_eq!(
            other,
            json!({"derived_generation_items": 0, "derived_generations": 0})
        );
    }

    #[test]
    fn the_text_scrub_matches_the_lowered_jsonb_text() {
        let store = store();
        let (live, input) = scrub_fixture(&store);
        let counts = store
            .scrub_generation_text_rows("default", &["hello world".to_string()])
            .unwrap();
        // The preimage of notes/a, the held context of h2 and the fence of the live row.
        assert_eq!(
            counts,
            json!({"derived_generation_items": 1, "derived_generations": 2})
        );
        let live_row = row_of(&store, &live, "live").unwrap();
        assert_eq!(live_row.completeness, json!({"complete": true}));
        assert_eq!(preimage_of(&store, live_row.id, "notes/a"), None);
        let input_row = row_of(&store, &input, "held").unwrap();
        assert_eq!((input_row.proposal, input_row.held_context), (None, None));
        assert!(row_of(&store, &key(), "held").unwrap().proposal.is_some());
        // The jsonb text separators count: `"body": "other"` matches, `"body":"other"` does not.
        let spaced = store
            .scrub_generation_text_rows("default", &["\"body\": \"other\"".to_string()])
            .unwrap();
        assert_eq!(spaced["derived_generation_items"], json!(1));
        assert!(
            store
                .scrub_generation_text_rows("default", &["a\0b".to_string()])
                .is_err()
        );
    }

    #[test]
    fn the_text_scrub_reads_the_digits_and_the_json_null_postgres_keeps() {
        let store = store();
        let scrub = |needle: &str| {
            store
                .scrub_generation_text_rows("default", &[needle.to_string()])
                .unwrap()["derived_generations"]
                .clone()
        };
        let mut numbers = held("h1", "no_proof");
        numbers.context = r#"{"n":1.50,"m":-0.0}"#.into();
        store.record_held_generation_row(&key(), &numbers).unwrap();
        let fenced = GenerationKey {
            kind: "other".into(),
            ..key()
        };
        let mut row = activation("op1", 1.0);
        row.completeness = r#"{"fence":{"n":100e-2}}"#.into();
        store
            .activate_generation_rows(&fenced, None, &row, &[owned("notes/a")])
            .unwrap();
        // `jsonb` keeps `1.50`, prints `-0.0` as `0.0` and `100e-2` as `1.00`.
        assert_eq!(scrub(r#""n": 1.5}"#), json!(0));
        assert_eq!(scrub("1.00}"), json!(1));
        assert_eq!(scrub(r#""m": -0.0"#), json!(0));
        assert_eq!(scrub(r#""m": 0.0"#), json!(1));
        assert_eq!(row_of(&store, &key(), "held").unwrap().held_context, None);

        // A JSON `null` context and proposal are values (`IS NOT NULL`) whose text is `null`.
        let nulls = GenerationKey {
            owner_key: "input:n".into(),
            ..key()
        };
        let mut both = held("h2", "no_proof");
        both.context = "null".into();
        both.proposal = Some("null".into());
        store.record_held_generation_row(&nulls, &both).unwrap();
        let record = row_of(&store, &nulls, "held").unwrap();
        assert_eq!(record.proposal_column().value(), Some(Value::Null));
        assert_eq!(record.held_context_column().text().as_deref(), Some("null"));
        assert_eq!(scrub("null"), json!(1));
        let record = row_of(&store, &nulls, "held").unwrap();
        assert_eq!(
            (
                record.proposal_column().value(),
                record.held_context_column().text()
            ),
            (None, None)
        );
        assert_eq!(scrub("null"), json!(0));
    }

    fn consolidation(source: &str, kind: &str, owner: &str) -> GenerationKey {
        GenerationKey {
            source_id: source.into(),
            kind: kind.into(),
            owner_key: owner.into(),
        }
    }

    #[test]
    fn a_live_row_reads_restored_only_when_it_restores_another() {
        let store = store();
        let k = consolidation("default", "consolidation", "entity:a:cluster:1");
        assert!(!store.read_generation_restored(&k).unwrap());
        let first = store
            .activate_generation_rows(&k, None, &activation("op-1", 1.0), &[])
            .unwrap();
        assert!(!store.read_generation_restored(&k).unwrap());
        let mut again = activation("op-2", 2.0);
        again.restore_of = Some(first as f64);
        store
            .activate_generation_rows(&k, Some(first as f64), &again, &[])
            .unwrap();
        assert!(store.read_generation_restored(&k).unwrap());
    }

    #[test]
    fn clearing_ties_deletes_only_the_tie_holds_of_one_owner_prefix() {
        let store = store();
        let keys = [
            consolidation("default", "consolidation", "entity:a:cluster:1"),
            consolidation("default", "consolidation", "entity:a:cluster:2"),
            consolidation("default", "consolidation", "entity:ab:cluster:1"),
            consolidation("default", "facts_fence", "entity:a:cluster:3"),
        ];
        for (n, k) in keys.iter().enumerate() {
            store
                .record_held_generation_row(k, &held(&format!("h{n}"), "tie"))
                .unwrap();
        }
        let proof = consolidation("default", "consolidation", "entity:a:cluster:4");
        store
            .record_held_generation_row(&proof, &held("h9", "no_proof"))
            .unwrap();
        store
            .clear_tie_held_generation_rows("default", "consolidation", "entity:a:cluster:")
            .unwrap();
        let read = store.read().unwrap();
        let kept = |k: &GenerationKey| pointed_record(&*read, k, "held").unwrap().is_some();
        assert_eq!(
            keys.iter().map(kept).collect::<Vec<_>>(),
            vec![false, false, true, true]
        );
        assert!(kept(&proof));
    }
}
