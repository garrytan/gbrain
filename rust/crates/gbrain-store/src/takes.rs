//! Takes and synthesis evidence: the `takes` and `synthesis_evidence` tables of the PGLite engine.
//!
//! Members: addTakesBatch, listTakes, searchTakes, updateTake, supersedeTake, resolveTake,
//! getScorecard, getCalibrationCurve, addSynthesisEvidence, listActiveTakesForPages, the reads of
//! `takes/reads.rs`, the fence guard's held takes (`takes/held.rs`), and the reads and the delete of
//! `takes/extract.rs`.
//!
//! Keys (every record starts with `keys::TAKE`, `A`; ids and page ids are u64 BE, a `row_num` is
//! its i32 with the sign bit flipped, BE, so keys sort by row number):
//! - `A 0x01 <take id>` -> `TakeRecord` (JSON).
//! - `A 0x02 <page id> <row_num>` -> the take id (u64 BE): the `UNIQUE (page_id, row_num)` index.
//! - `A 0x03 <synthesis page id> <take page id> <take row_num>` -> `EvidenceRecord` (JSON).
//! - `A 0x04 <take page id> <take row_num> <synthesis page id>` -> empty: the reverse index.
//! - Id counter: `M next_take_id`. Every row an `addTakesBatch` call reads takes an id, as the
//!   Postgres sequence default does, inserted or not.
//!
//! A take records the source of its page (`source_id`) and an evidence row the source of its
//! synthesis page, so `remove_source_rows` can sweep a deleted source without its pages.
//!
//! `claim_rev` counts claim changes. Postgres nulls a take's embedding when its claim changes; so does
//! `addTakesBatch` here (`embeddings::remove_take_vector`, which also raises the vector generation the
//! warm vector index is keyed by). The embeddings family stores the rev with the vector and treats a
//! vector with another rev as stale, so a vector written for an older claim never counts.
//! A claim edited A -> B -> A is then stale, as it is in Postgres (an md5 compare would miss it).

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::facts::PrivacyPolicy;
use crate::facts::take_purges::refuse_purged_take;
use crate::keyword::{TRGM_WORD_SIMILARITY_THRESHOLD, trgm_word_similarity};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{PageRecord, next_id, read_page_by_id};
use crate::trust::{RowTrust, TrustPolicy, TrustTable, check_insert, stamp_row};

use crate::write_receipt::WriteReceipt;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

mod extract;
mod held;
mod reads;

pub use extract::{FenceRowClaim, IncomingTake, TakesLeavingFence};
pub use held::HeldTakeSpec;
pub use reads::{
    HeldFenceTakeSpec, IncomingTakeRow, McpResolvedInput, PurgeTakesInput, TakePreimageInput,
};

pub(crate) const NEXT_TAKE_ID: &str = "next_take_id";
const TAKE: u8 = 0x01;
const BY_ROW: u8 = 0x02;
const EVIDENCE: u8 = 0x03;
const CITED: u8 = 0x04;
const TAKES: &str = "takes";
const EVIDENCE_TABLE: &str = "synthesis_evidence";
const QUALITIES: [&str; 4] = ["correct", "incorrect", "partial", "unresolvable"];

fn row_bytes(row_num: i32) -> [u8; 4] {
    ((row_num as u32) ^ 0x8000_0000).to_be_bytes()
}

fn row_from(bytes: &[u8]) -> i32 {
    (u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) ^ 0x8000_0000) as i32
}

fn take_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::TAKE, TAKE];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn row_prefix(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::TAKE, BY_ROW];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn row_key(page_id: u64, row_num: i32) -> Vec<u8> {
    let mut key = row_prefix(page_id);
    key.extend_from_slice(&row_bytes(row_num));
    key
}

fn evidence_prefix(synthesis_page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::TAKE, EVIDENCE];
    key.extend_from_slice(&synthesis_page_id.to_be_bytes());
    key
}

fn evidence_key(synthesis_page_id: u64, take_page_id: u64, row_num: i32) -> Vec<u8> {
    let mut key = evidence_prefix(synthesis_page_id);
    key.extend_from_slice(&take_page_id.to_be_bytes());
    key.extend_from_slice(&row_bytes(row_num));
    key
}

fn cited_page_prefix(take_page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::TAKE, CITED];
    key.extend_from_slice(&take_page_id.to_be_bytes());
    key
}

fn cited_prefix(take_page_id: u64, row_num: i32) -> Vec<u8> {
    let mut key = cited_page_prefix(take_page_id);
    key.extend_from_slice(&row_bytes(row_num));
    key
}

fn cited_key(take_page_id: u64, row_num: i32, synthesis_page_id: u64) -> Vec<u8> {
    let mut key = cited_prefix(take_page_id, row_num);
    key.extend_from_slice(&synthesis_page_id.to_be_bytes());
    key
}

/// One `takes` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TakeRecord {
    pub id: u64,
    pub page_id: u64,
    /// The source of the take's page when the row was inserted.
    pub source_id: String,
    pub row_num: i32,
    pub claim: String,
    pub kind: String,
    pub holder: String,
    pub weight: f32,
    #[serde(default)]
    pub since_date: Option<String>,
    #[serde(default)]
    pub until_date: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub superseded_by: Option<i32>,
    pub active: bool,
    #[serde(default)]
    pub resolved_at_us: Option<i64>,
    #[serde(default)]
    pub resolved_outcome: Option<bool>,
    #[serde(default)]
    pub resolved_quality: Option<String>,
    #[serde(default)]
    pub resolved_value: Option<f32>,
    #[serde(default)]
    pub resolved_unit: Option<String>,
    #[serde(default)]
    pub resolved_source: Option<String>,
    #[serde(default)]
    pub resolved_by: Option<String>,
    pub created_at_us: i64,
    pub updated_at_us: i64,
    /// Goes up by one each time the claim changes.
    #[serde(default)]
    pub claim_rev: u64,
    /// `trust_tier` and `write_origin`, stamped by [`store_take`]. Absent in a record stored before
    /// them, and omitted while the tier is `unknown` with no origin.
    #[serde(default, skip_serializing_if = "RowTrust::is_empty")]
    pub trust: RowTrust,
    /// The write receipt (`write_*`, `last_*`). Absent in a record stored before it, and omitted
    /// while every column is null. [`write_take`] stamps it.
    #[serde(default, skip_serializing_if = "WriteReceipt::is_empty")]
    pub receipt: WriteReceipt,
}

impl TakeRecord {
    /// The content tuple the attribution trigger compares
    /// (`WRITE_ATTRIBUTION_CONTENT_COLUMNS.takes`); `updated_at` and the embedding are projection.
    fn attribution_content_changed(&self, new: &TakeRecord) -> bool {
        use crate::write_receipt::float_distinct;
        let (a, b) = (self, new);
        (
            a.id,
            a.page_id,
            a.row_num,
            &a.claim,
            &a.kind,
            &a.holder,
            &a.since_date,
            &a.until_date,
            &a.source,
            a.superseded_by,
            a.active,
        ) != (
            b.id,
            b.page_id,
            b.row_num,
            &b.claim,
            &b.kind,
            &b.holder,
            &b.since_date,
            &b.until_date,
            &b.source,
            b.superseded_by,
            b.active,
        ) || (
            a.resolved_at_us,
            a.resolved_outcome,
            &a.resolved_unit,
            &a.resolved_source,
            &a.resolved_by,
            a.created_at_us,
            &a.resolved_quality,
        ) != (
            b.resolved_at_us,
            b.resolved_outcome,
            &b.resolved_unit,
            &b.resolved_source,
            &b.resolved_by,
            b.created_at_us,
            &b.resolved_quality,
        ) || float_distinct(Some(a.weight), Some(b.weight))
            || float_distinct(a.resolved_value, b.resolved_value)
    }
}

/// One `synthesis_evidence` row (the key holds the three key columns).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EvidenceRecord {
    citation_index: i32,
    created_at_us: i64,
    /// The source of the synthesis page when the row was inserted.
    synthesis_source_id: String,
}

/// A `real` (float4) column as Postgres reads it back: the shortest text that names the f32,
/// read as a JavaScript number.
pub(crate) fn real_out(value: f32) -> f64 {
    format!("{value}").parse().unwrap_or(f64::from(value))
}

impl TakeRecord {
    /// The hit `takeHitRowToHit` reads from `searchTakes` and `searchTakesVector`, with its `real`
    /// score.
    fn hit_json(&self, page_slug: &str, score: f32) -> Value {
        json!({
            "take_id": self.id,
            "page_id": self.page_id,
            "page_slug": page_slug,
            "row_num": self.row_num,
            "claim": self.claim,
            "kind": self.kind,
            "holder": self.holder,
            "weight": real_out(self.weight),
            "since_date": self.since_date,
            "until_date": self.until_date,
            "source": self.source,
            "score": real_out(score),
        })
    }

    /// The row `takeRowToTake` reads (`t.*` plus `p.slug AS page_slug`).
    fn to_json(&self, page_slug: &str) -> Value {
        json!({
            "id": self.id,
            "page_id": self.page_id,
            "page_slug": page_slug,
            "row_num": self.row_num,
            "claim": self.claim,
            "kind": self.kind,
            "holder": self.holder,
            "weight": real_out(self.weight),
            "since_date": self.since_date,
            "until_date": self.until_date,
            "source": self.source,
            "superseded_by": self.superseded_by,
            "active": self.active,
            "resolved_at": self.resolved_at_us.map(iso),
            "resolved_outcome": self.resolved_outcome,
            "resolved_quality": self.resolved_quality,
            "resolved_value": self.resolved_value.map(real_out),
            "resolved_unit": self.resolved_unit,
            "resolved_source": self.resolved_source,
            "resolved_by": self.resolved_by,
            "created_at": iso(self.created_at_us),
            "updated_at": iso(self.updated_at_us),
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Inputs.

/// One `TakeBatchInput`. Numbers stay JSON values so a non-integer fails as Postgres fails it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TakeInput {
    pub page_id: Value,
    pub row_num: Value,
    pub claim: Option<String>,
    pub kind: Option<String>,
    pub holder: Option<String>,
    pub weight: Option<f64>,
    pub since_date: Option<String>,
    pub until_date: Option<String>,
    pub source: Option<String>,
    pub superseded_by: Value,
    pub active: Option<bool>,
}

/// The filter of `listTakes`, as the TypeScript member resolves it: `active` is already
/// defaulted, `limit` clamped and `offset` floored; `source_ids` is the source scope (none means
/// every source; null elements match nothing).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ListTakesOptions {
    pub page_id: Value,
    pub page_slug: Option<String>,
    pub holder: Option<String>,
    pub kind: Option<String>,
    pub active: Option<bool>,
    pub resolved: Option<bool>,
    pub allow_list: Option<Vec<Option<String>>>,
    pub sort_by: Option<String>,
    pub oldest_first: Option<bool>,
    pub since_on_or_before: Option<String>,
    pub limit: Option<u64>,
    pub offset: Value,
    pub source_ids: Option<Vec<Option<String>>>,
    /// A read-eligibility policy was given: hide the takes `projectionEligibleSql` always hides.
    pub eligible_only: bool,
    /// `eligibility.floor`: `trustFloorSql` over the take's stored tier; null sets none.
    pub min_trust: Option<String>,
    /// `eligibility.suppressFlagged`: drop a take `activationSuppressedSql('takes')` flags.
    pub suppress_flagged: bool,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`); null reads every page.
    pub exclude_private: Option<PrivacyPolicy>,
}

/// `listActiveTakesForPages(pageIds, { takesHoldersAllowList })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ActiveTakesInput {
    pub page_ids: Vec<Value>,
    pub allow_list: Option<Vec<Option<String>>>,
}

/// `searchTakes(query, opts)`, resolved: `limit` is clamped by the TypeScript member.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SearchTakesOptions {
    pub query: Option<String>,
    pub limit: Option<u64>,
    pub allow_list: Option<Vec<Option<String>>>,
    pub source_ids: Option<Vec<Option<String>>>,
    /// A read-eligibility policy was given: hide the takes `projectionEligibleSql` always hides.
    pub eligible_only: bool,
    /// `eligibility.floor`: `trustFloorSql` over the take's stored tier; null sets none.
    pub min_trust: Option<String>,
    /// `eligibility.suppressFlagged`: drop a take `activationSuppressedSql('takes')` flags.
    pub suppress_flagged: bool,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`); null reads every page.
    pub exclude_private: Option<PrivacyPolicy>,
}

/// `updateTake(pageId, rowNum, fields)`; `weight` is already normalized.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct UpdateTakeInput {
    pub page_id: Value,
    pub row_num: Value,
    pub weight: Option<f64>,
    pub since_date: Option<String>,
    pub source: Option<String>,
}

/// `supersedeTake(pageId, oldRow, newRow)`; `weight` is already clamped.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SupersedeTakeInput {
    pub page_id: Value,
    pub old_row: Value,
    pub claim: Option<String>,
    pub kind: Option<String>,
    pub holder: Option<String>,
    pub weight: Option<f64>,
    pub since_date: Option<String>,
    pub until_date: Option<String>,
    pub source: Option<String>,
    pub active: Option<bool>,
}

/// The `(quality, outcome)` tuple `deriveResolutionTuple` gives, plus the resolution metadata.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct TakeResolutionInput {
    pub quality: Option<String>,
    pub outcome: Option<bool>,
    pub value: Option<f64>,
    pub unit: Option<String>,
    pub source: Option<String>,
    pub resolved_by: Option<String>,
}

/// `resolveTake(pageId, rowNum, resolution)`. Without a resolution the call only reports the
/// row's state (the TypeScript member does so when `deriveResolutionTuple` throws).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ResolveTakeInput {
    pub page_id: Value,
    pub row_num: Value,
    pub resolution: Option<TakeResolutionInput>,
}

/// The filters of `getScorecard`; the TypeScript member drops falsy ones.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ScorecardOptions {
    pub holder: Option<String>,
    pub domain_prefix: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub allow_list: Option<Vec<Option<String>>>,
    pub source_ids: Option<Vec<Option<String>>>,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`); null reads every page.
    pub exclude_private: Option<PrivacyPolicy>,
}

/// The filters of `getCalibrationCurve`; `bucket_size` is already resolved (0.1 by default).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CalibrationOptions {
    pub holder: Option<String>,
    pub bucket_size: Option<f64>,
    pub allow_list: Option<Vec<Option<String>>>,
    pub source_ids: Option<Vec<Option<String>>>,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`); null reads every page.
    pub exclude_private: Option<PrivacyPolicy>,
}

/// One fence row of `matchTakeRows`: the identity fields a stored take is compared with. A null
/// field is distinct from any stored text.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct FenceRowInput {
    pub row_num: Value,
    pub claim: Option<String>,
    pub kind: Option<String>,
    pub holder: Option<String>,
}

/// One `SynthesisEvidenceInput`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct EvidenceInput {
    pub synthesis_page_id: Value,
    pub take_page_id: Value,
    pub take_row_num: Value,
    pub citation_index: Value,
}

// ---------------------------------------------------------------------------------------------
// Errors and value checks.

pub(crate) fn not_null(table: &str, column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"{table}\" violates not-null constraint"
        ),
    )
}

fn check_failed(table: &str, constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("new row for relation \"{table}\" violates check constraint \"{constraint}\""),
    )
}

pub(crate) fn fk_failed(table: &str, constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "insert or update on table \"{table}\" violates foreign key constraint \"{constraint}\""
        ),
    )
}

/// An `INTEGER` parameter: null stays null; a whole number inside `i32` is the value; anything
/// else is `invalid_argument`, as Postgres refuses it before any row is read.
pub(crate) fn int4(value: &Value, op: &str, column: &str) -> Result<Option<i32>> {
    let refused = || {
        StoreError::invalid(format!(
            "{op}: {column} must be an integer in the int4 range, got {value}"
        ))
    };
    match value {
        Value::Null => Ok(None),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return i32::try_from(i).map(Some).map_err(|_| refused());
            }
            let f = n.as_f64().ok_or_else(refused)?;
            if f.fract() != 0.0 || f < f64::from(i32::MIN) || f > f64::from(i32::MAX) {
                return Err(refused());
            }
            // Whole and in range, so the cast is exact.
            Ok(Some(f as i32))
        }
        _ => Err(refused()),
    }
}

/// A `real` parameter: a finite value that rounds to infinity, or a nonzero one that rounds to
/// zero, is out of range (`float4in`). Subnormal results are kept.
pub(crate) fn real(value: f64, op: &str) -> Result<f32> {
    let narrowed = value as f32;
    if value.is_finite() && narrowed.is_infinite() {
        return Err(StoreError::invalid(format!(
            "{op}: \"{value}\" is out of range for type real (overflow)"
        )));
    }
    if value != 0.0 && narrowed == 0.0 {
        return Err(StoreError::invalid(format!(
            "{op}: \"{value}\" is out of range for type real (underflow)"
        )));
    }
    Ok(narrowed)
}

fn texts<'a>(parts: &[(&'a str, &'a Option<String>)]) -> Vec<(&'a str, &'a str)> {
    parts
        .iter()
        .filter_map(|(name, value)| value.as_deref().map(|v| (*name, v)))
        .collect()
}

fn list_texts<'a>(name: &'a str, list: &'a Option<Vec<Option<String>>>) -> Vec<(&'a str, &'a str)> {
    list.iter()
        .flatten()
        .flatten()
        .map(|v| (name, v.as_str()))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Record access.

/// The take at `id`.
pub(crate) fn read_take(read: &dyn KvRead, id: u64) -> Result<Option<TakeRecord>> {
    get_json(read, &take_key(id))
}

/// The take at `(page_id, row_num)`.
pub(crate) fn take_at(read: &dyn KvRead, page_id: u64, row_num: i32) -> Result<Option<TakeRecord>> {
    let Some(bytes) = read.get(&row_key(page_id, row_num))? else {
        return Ok(None);
    };
    let id = keys::be8(&bytes)
        .ok_or_else(|| StoreError::new(crate::error::STORE_CORRUPT, "bad take row index"))?;
    get_json(read, &take_key(id))
}

/// Every take of a page, by row number.
pub(crate) fn page_takes(read: &dyn KvRead, page_id: u64) -> Result<Vec<TakeRecord>> {
    let mut ids = Vec::new();
    scan_prefix(read, &row_prefix(page_id), false, &mut |_, v| {
        ids.push(v.to_vec());
        true
    })?;
    let mut out = Vec::with_capacity(ids.len());
    for bytes in ids {
        let id = keys::be8(&bytes)
            .ok_or_else(|| StoreError::new(crate::error::STORE_CORRUPT, "bad take row index"))?;
        if let Some(take) = get_json(read, &take_key(id))? {
            out.push(take);
        }
    }
    Ok(out)
}

/// Every take, by id.
pub(crate) fn all_takes(read: &dyn KvRead) -> Result<Vec<TakeRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &[keys::TAKE, TAKE], false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

/// Writes a take's record (its row index never changes: `page_id` and `row_num` are fixed),
/// stamped with the open write's receipt as the PGLite attribution trigger stamps it
/// (`write_receipt.rs`): an insert when no record is stored under its id, else an update. The
/// trust columns are written as given: a write that changes no trust column (the embedding) uses
/// it; a takes writer uses [`store_take`].
pub(crate) fn write_take(tx: &mut dyn KvWrite, take: &TakeRecord) -> Result<()> {
    let old = read_take(&*tx, take.id)?;
    let mut stamped = take.clone();
    stamped.receipt = WriteReceipt::stamp(
        old.as_ref().map(|o| &o.receipt),
        &take.receipt,
        old.as_ref()
            .is_some_and(|o| o.attribution_content_changed(take)),
    )?;
    put_json(tx, &take_key(take.id), &stamped)
}

/// Writes `take` with the trust tier and write origin PGLite's `trust_tier_stamp` trigger gives it
/// (`trust::stamp_row`): an insert when no row with its id is stored, else an update of the stored
/// row, restamped only when `claim`, `kind` or `holder` changed. A refused raise is the trigger's
/// error; the caller's write then rolls back.
pub(crate) fn store_take(tx: &mut dyn KvWrite, take: &TakeRecord) -> Result<()> {
    let old: Option<TakeRecord> = get_json(&*tx, &take_key(take.id))?;
    let content_changed = old
        .as_ref()
        .is_some_and(|o| (&o.claim, &o.kind, &o.holder) != (&take.claim, &take.kind, &take.holder));
    let mut stamped = take.clone();
    stamped.trust = stamp_row(
        TrustTable::Takes,
        old.as_ref().map(|o| &o.trust),
        &take.trust,
        content_changed,
    )?;
    write_take(tx, &stamped)
}

fn insert_take(tx: &mut dyn KvWrite, take: &TakeRecord) -> Result<()> {
    store_take(tx, take)?;
    tx.put(&row_key(take.page_id, take.row_num), &take.id.to_be_bytes())
}

/// The shadow seed (`seed.rs`): stores a take copied from another engine with its own id and row.
/// `false` when the id already holds a take; a row held by another take is the unique
/// `(page_id, row_num)` violation. The caller checked the page.
pub(crate) fn seed_take(tx: &mut dyn KvWrite, take: &TakeRecord) -> Result<bool> {
    if read_take(&*tx, take.id)?.is_some() {
        return Ok(false);
    }
    if tx.get(&row_key(take.page_id, take.row_num))?.is_some() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "duplicate key value violates unique constraint on takes (page_id, row_num)",
        ));
    }
    insert_take(tx, take)?;
    Ok(true)
}

/// The shadow seed (`seed.rs`): stores the evidence row of `synthesis` citing the take
/// `(take_page_id, take_row_num)`, copied from another engine with its own `created_at`, with its
/// reverse index. `false` when the row is already stored; a take that is not stored is the foreign
/// key violation. The caller checked the synthesis page.
pub(crate) fn seed_evidence(
    tx: &mut dyn KvWrite,
    synthesis: &PageRecord,
    take_page_id: u64,
    take_row_num: i32,
    citation_index: i32,
    created_at_us: i64,
) -> Result<bool> {
    if tx.get(&row_key(take_page_id, take_row_num))?.is_none() {
        return Err(fk_failed(
            EVIDENCE_TABLE,
            "synthesis_evidence_take_page_id_take_row_num_fkey",
        ));
    }
    let key = evidence_key(synthesis.id, take_page_id, take_row_num);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    let record = EvidenceRecord {
        citation_index,
        created_at_us,
        synthesis_source_id: synthesis.source_id.clone(),
    };
    put_json(tx, &key, &record)?;
    tx.put(&cited_key(take_page_id, take_row_num, synthesis.id), &[])?;
    Ok(true)
}

/// Deletes a take with its evidence rows.
fn delete_take(tx: &mut dyn KvWrite, take: &TakeRecord) -> Result<()> {
    delete_take_evidence(tx, take)?;
    delete_take_record(tx, take)
}

/// The evidence rows that cite `take`, with their reverse index rows.
fn delete_take_evidence(tx: &mut dyn KvWrite, take: &TakeRecord) -> Result<()> {
    let mut synths = Vec::new();
    scan_prefix(
        &*tx,
        &cited_prefix(take.page_id, take.row_num),
        false,
        &mut |k, _| {
            synths.push(k.to_vec());
            true
        },
    )?;
    for key in synths {
        let synth = keys::be8(&key[key.len() - 8..])
            .ok_or_else(|| StoreError::new(crate::error::STORE_CORRUPT, "bad evidence key"))?;
        tx.delete(&evidence_key(synth, take.page_id, take.row_num))?;
        tx.delete(&key)?;
    }
    Ok(())
}

/// The take's own records: its row, its vector and its id key. Evidence that cites it stays.
fn delete_take_record(tx: &mut dyn KvWrite, take: &TakeRecord) -> Result<()> {
    tx.delete(&row_key(take.page_id, take.row_num))?;
    crate::embeddings::remove_take_vector(tx, take.id)?;
    tx.delete(&take_key(take.id))
}

/// `deletePurgedTakes` (a fact purge): deletes the takes with these ids, each with its evidence
/// and embedding (`ON DELETE CASCADE`); how many existed.
pub(crate) fn delete_takes_by_id(tx: &mut dyn KvWrite, ids: &BTreeSet<u64>) -> Result<u64> {
    let mut deleted = 0;
    for id in ids {
        if let Some(take) = read_take(&*tx, *id)? {
            delete_take(tx, &take)?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// The shadow follow (`seed/follow.rs`): removes the take `id`. `keep_evidence` leaves the
/// evidence rows that cite it, for a take that is replaced by a row of the same `(page_id,
/// row_num)`. `false` when no such take is stored.
pub(crate) fn remove_take(tx: &mut dyn KvWrite, id: u64, keep_evidence: bool) -> Result<bool> {
    let Some(take) = read_take(&*tx, id)? else {
        return Ok(false);
    };
    if !keep_evidence {
        delete_take_evidence(tx, &take)?;
    }
    delete_take_record(tx, &take)?;
    Ok(true)
}

/// The shadow follow: removes the evidence row of `synthesis` citing the take `(take_page_id,
/// take_row_num)`. `false` when there is none.
pub(crate) fn remove_evidence(
    tx: &mut dyn KvWrite,
    synthesis: u64,
    take_page_id: u64,
    take_row_num: i32,
) -> Result<bool> {
    let key = evidence_key(synthesis, take_page_id, take_row_num);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    delete_evidence(tx, &[key])?;
    Ok(true)
}

/// Deletes evidence rows by their `A 0x03` keys, with their reverse index rows.
fn delete_evidence(tx: &mut dyn KvWrite, evidence_keys: &[Vec<u8>]) -> Result<()> {
    for key in evidence_keys {
        // A 0x03 <synth 8> <take page 8> <row 4>
        let synth = keys::be8(&key[2..10]);
        let page = keys::be8(&key[10..18]);
        let (Some(synth), Some(page)) = (synth, page) else {
            return Err(StoreError::new(
                crate::error::STORE_CORRUPT,
                "bad evidence key",
            ));
        };
        let row = row_from(&key[18..22]);
        tx.delete(&cited_key(page, row, synth))?;
        tx.delete(key)?;
    }
    Ok(())
}

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`):
/// the page's takes with the evidence citing them, and the evidence of the page as a synthesis.
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    for take in page_takes(&*tx, page.id)? {
        delete_take(tx, &take)?;
    }
    let mut doomed = Vec::new();
    scan_prefix(&*tx, &evidence_prefix(page.id), false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    delete_evidence(tx, &doomed)
}

/// Deletes this family's records keyed by a source that is deleted (`cascade::remove_source_rows`):
/// every take whose page was in that source, with its evidence, and every evidence row whose
/// synthesis page was in it. Core removes the source's pages first, so `remove_page_rows` has
/// already taken these rows; this sweep is defensive and finds nothing on a consistent store.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for take in all_takes(&*tx)? {
        if take.source_id == source_id {
            delete_take(tx, &take)?;
        }
    }
    let mut doomed = Vec::new();
    let mut bad = false;
    scan_prefix(&*tx, &[keys::TAKE, EVIDENCE], false, &mut |k, v| {
        match serde_json::from_slice::<EvidenceRecord>(v) {
            Ok(record) if record.synthesis_source_id == source_id => doomed.push(k.to_vec()),
            Ok(_) => {}
            Err(_) => {
                bad = true;
                return false;
            }
        }
        true
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "bad evidence record",
        ));
    }
    delete_evidence(tx, &doomed)
}

// ---------------------------------------------------------------------------------------------
// Filters shared by the reads.

/// `holder = ANY(list)` when a list is given (a null element matches nothing).
fn allowed(list: &Option<Vec<Option<String>>>, holder: &str) -> bool {
    list.as_ref()
        .is_none_or(|l| l.iter().any(|h| h.as_deref() == Some(holder)))
}

/// `p.source_id = ANY(list)` when a scope is given.
fn in_scope(scope: &Option<Vec<Option<String>>>, source_id: &str) -> bool {
    scope
        .as_ref()
        .is_none_or(|l| l.iter().any(|s| s.as_deref() == Some(source_id)))
}

/// Pages by id, read once per call. A take's page always exists (its foreign key cascades).
struct PageCache<'a> {
    read: &'a dyn KvRead,
    pages: HashMap<u64, Option<PageRecord>>,
}

impl<'a> PageCache<'a> {
    fn new(read: &'a dyn KvRead) -> Self {
        PageCache {
            read,
            pages: HashMap::new(),
        }
    }

    fn get(&mut self, id: u64) -> Result<Option<&PageRecord>> {
        if !self.pages.contains_key(&id) {
            let page = read_page_by_id(self.read, id)?;
            self.pages.insert(id, page);
        }
        Ok(self.pages.get(&id).and_then(|p| p.as_ref()))
    }
}

/// Whether `excludePrivate`'s page policy hides `page` (`privatePagesFilterForCaller` on the
/// take's page); no policy hides nothing.
fn private_page(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &Option<PrivacyPolicy>,
) -> Result<bool> {
    match policy {
        Some(policy) => crate::facts::page_hidden(read, page, policy),
        None => Ok(false),
    }
}

/// The part of `projectionEligibleSql('takes', ..)` a policy without `floor` or
/// `suppressFlagged` applies: a take of a soft-deleted page, or of a page whose frontmatter has a
/// `quarantine` key (any value, deleted or not), is hidden. Its third clause hides rows listed in
/// `needs_rederive`, which only a raw-SQL purge writes; this engine has no such rows.
fn eligible_page(page: &PageRecord) -> bool {
    page.deleted_at_us.is_none() && !page.frontmatter.contains_key("quarantine")
}

/// `since_date ~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'`.
fn iso_date_like(text: &str) -> bool {
    let b = text.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    match b.len() {
        7 => digits(0..4) && b[4] == b'-' && digits(5..7),
        10 => digits(0..4) && b[4] == b'-' && digits(5..7) && b[7] == b'-' && digits(8..10),
        _ => false,
    }
}

/// Postgres `LIKE` with the default escape `\`: `%` is any run, `_` one character.
fn like(text: &str, pattern: &str) -> Result<bool> {
    enum Tok {
        Any,
        One,
        Lit(char),
    }
    let mut toks = Vec::new();
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        toks.push(match c {
            '%' => Tok::Any,
            '_' => Tok::One,
            '\\' => match chars.next() {
                Some(next) => Tok::Lit(next),
                None => {
                    return Err(StoreError::invalid(
                        "LIKE pattern must not end with escape character",
                    ));
                }
            },
            other => Tok::Lit(other),
        });
    }
    let text: Vec<char> = text.chars().collect();
    // matched[i]: the tokens so far can match text[..i].
    let mut matched = vec![false; text.len() + 1];
    matched[0] = true;
    for tok in &toks {
        let mut next = vec![false; text.len() + 1];
        match tok {
            Tok::Any => {
                let mut seen = false;
                for i in 0..=text.len() {
                    seen = seen || matched[i];
                    next[i] = seen;
                }
            }
            Tok::One => {
                next[1..].copy_from_slice(&matched[..text.len()]);
            }
            Tok::Lit(c) => {
                for i in 0..text.len() {
                    next[i + 1] = matched[i] && text[i] == *c;
                }
            }
        }
        matched = next;
    }
    Ok(matched[text.len()])
}

/// A decimal `mantissa * 10^exp`.
#[derive(Debug, Clone, Copy)]
struct Decimal {
    mantissa: i128,
    exp: i32,
}

impl Decimal {
    /// Parses plain or scientific decimal text (no sign).
    fn parse(text: &str) -> Option<Decimal> {
        let (body, exp) = match text.split_once(['e', 'E']) {
            Some((body, exp)) => (body, exp.parse::<i32>().ok()?),
            None => (text, 0),
        };
        let (int, frac) = body.split_once('.').unwrap_or((body, ""));
        let digits = format!("{int}{frac}");
        let mantissa = digits.parse::<i128>().ok()?;
        Some(Decimal {
            mantissa,
            exp: exp - frac.len() as i32,
        })
    }

    /// `w::numeric` for a `real`: `float4_numeric` prints six significant digits.
    fn of_real(value: f32) -> Decimal {
        Decimal::parse(&format!("{:.5e}", f64::from(value))).unwrap_or(Decimal {
            mantissa: 0,
            exp: 0,
        })
    }

    fn to_f64(self) -> f64 {
        format!("{}e{}", self.mantissa, self.exp)
            .parse()
            .unwrap_or(f64::NAN)
    }
}

fn pow10(n: u32) -> Option<i128> {
    10i128.checked_pow(n)
}

/// `FLOOR(a / b)` for nonnegative decimals, `b > 0`, computed exactly. A quotient whose
/// denominator does not fit i128 is below one (a is a six-digit `real`), so it floors to 0.
fn floor_div(a: Decimal, b: Decimal) -> i128 {
    if a.mantissa == 0 {
        return 0;
    }
    let shift = a.exp - b.exp;
    if shift >= 0 {
        match pow10(shift as u32).and_then(|p| a.mantissa.checked_mul(p)) {
            Some(num) => num / b.mantissa,
            None => i128::MAX,
        }
    } else {
        match pow10((-shift) as u32).and_then(|p| b.mantissa.checked_mul(p)) {
            Some(den) => a.mantissa / den,
            None => 0,
        }
    }
}

fn int_out_of_range(op: &str) -> StoreError {
    StoreError::invalid(format!("{op}: integer out of range"))
}

// ---------------------------------------------------------------------------------------------
// Members.

impl Store {
    /// `addTakesBatch(rows)`: inserts each row, or updates the row at its `(page_id, row_num)` in
    /// place when any of the nine written columns differs (`updated_at` moves; `created_at` stays).
    /// Returns the number of rows given. A second row for a `(page_id, row_num)` this call already
    /// inserted or updated fails as Postgres's `ON CONFLICT DO UPDATE` does; a missing page fails
    /// at the end, as the deferred foreign-key check does.
    pub fn add_takes_batch(&self, rows: &[TakeInput]) -> Result<u64> {
        const OP: &str = "addTakesBatch";
        if rows.is_empty() {
            return Ok(0);
        }
        // The JSONB document is parsed whole, then the record set converted whole, before any row
        // is written.
        for r in rows {
            no_nul(
                OP,
                &texts(&[
                    ("claim", &r.claim),
                    ("kind", &r.kind),
                    ("holder", &r.holder),
                    ("since_date", &r.since_date),
                    ("until_date", &r.until_date),
                    ("source", &r.source),
                ]),
            )?;
        }
        let mut parsed = Vec::with_capacity(rows.len());
        for r in rows {
            let page_id = int4(&r.page_id, OP, "page_id")?;
            let row_num = int4(&r.row_num, OP, "row_num")?;
            let weight = r.weight.map(|w| real(w, OP)).transpose()?;
            let superseded_by = int4(&r.superseded_by, OP, "superseded_by")?;
            parsed.push((page_id, row_num, weight, superseded_by));
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut touched: HashSet<(i32, i32)> = HashSet::new();
            let mut missing_page = false;
            for (r, (page_id, row_num, weight, superseded_by)) in rows.iter().zip(parsed.iter()) {
                // The purge trigger runs BEFORE INSERT on every proposed row, an upsert's too.
                refuse_purged_take(&*tx, *page_id, r.claim.as_deref())?;
                let id = next_id(tx, NEXT_TAKE_ID)?;
                // The BEFORE INSERT trigger runs on every proposed row, before its NOT NULL and
                // CHECK constraints and before ON CONFLICT decides (`trust::check_insert`).
                check_insert(TrustTable::Takes)?;
                let page_id = page_id.ok_or_else(|| not_null(TAKES, "page_id"))?;
                let row_num = row_num.ok_or_else(|| not_null(TAKES, "row_num"))?;
                let claim = r.claim.clone().ok_or_else(|| not_null(TAKES, "claim"))?;
                let kind = r.kind.clone().ok_or_else(|| not_null(TAKES, "kind"))?;
                let holder = r.holder.clone().ok_or_else(|| not_null(TAKES, "holder"))?;
                let weight = weight.ok_or_else(|| not_null(TAKES, "weight"))?;
                let active = r.active.ok_or_else(|| not_null(TAKES, "active"))?;
                if !(0.0..=1.0).contains(&weight) {
                    return Err(check_failed(TAKES, "takes_weight_check"));
                }
                let Ok(page) = u64::try_from(page_id) else {
                    // No page has a negative id: the row is new and its foreign key fails.
                    if !touched.insert((page_id, row_num)) {
                        return Err(StoreError::new(
                            CONSTRAINT_VIOLATION,
                            "ON CONFLICT DO UPDATE command cannot affect row a second time",
                        ));
                    }
                    missing_page = true;
                    continue;
                };
                if let Some(mut existing) = take_at(&*tx, page, row_num)? {
                    if touched.contains(&(page_id, row_num)) {
                        return Err(StoreError::new(
                            CONSTRAINT_VIOLATION,
                            "ON CONFLICT DO UPDATE command cannot affect row a second time",
                        ));
                    }
                    let same = existing.claim == claim
                        && existing.kind == kind
                        && existing.holder == holder
                        && existing.weight == weight
                        && existing.since_date == r.since_date
                        && existing.until_date == r.until_date
                        && existing.source == r.source
                        && existing.superseded_by == *superseded_by
                        && existing.active == active;
                    if same {
                        continue;
                    }
                    if existing.claim != claim {
                        existing.claim_rev += 1;
                        // Postgres nulls the embedding in this upsert. Dropping the vector also raises the vector
                        // generation, so a warm vector index rebuilds instead of ranking the old claim's vector.
                        crate::embeddings::remove_take_vector(tx, existing.id)?;
                    }
                    existing.claim = claim;
                    existing.kind = kind;
                    existing.holder = holder;
                    existing.weight = weight;
                    existing.since_date = r.since_date.clone();
                    existing.until_date = r.until_date.clone();
                    existing.source = r.source.clone();
                    existing.superseded_by = *superseded_by;
                    existing.active = active;
                    existing.updated_at_us = now;
                    store_take(tx, &existing)?;
                } else {
                    let source_id = match read_page_by_id(&*tx, page)? {
                        Some(p) => p.source_id,
                        None => {
                            missing_page = true;
                            String::new()
                        }
                    };
                    insert_take(
                        tx,
                        &TakeRecord {
                            id,
                            page_id: page,
                            source_id,
                            row_num,
                            claim,
                            kind,
                            holder,
                            weight,
                            since_date: r.since_date.clone(),
                            until_date: r.until_date.clone(),
                            source: r.source.clone(),
                            superseded_by: *superseded_by,
                            active,
                            resolved_at_us: None,
                            resolved_outcome: None,
                            resolved_quality: None,
                            resolved_value: None,
                            resolved_unit: None,
                            resolved_source: None,
                            resolved_by: None,
                            created_at_us: now,
                            updated_at_us: now,
                            claim_rev: 0,
                            trust: RowTrust::default(),
                            receipt: WriteReceipt::default(),
                        },
                    )?;
                }
                touched.insert((page_id, row_num));
            }
            if missing_page {
                return Err(fk_failed(TAKES, "takes_page_id_fkey"));
            }
            Ok(rows.len() as u64)
        })
    }

    /// `listTakes(opts)`: filtered takes ordered by the requested key, then `id DESC`, paged.
    pub fn list_takes(&self, options: &ListTakesOptions) -> Result<Vec<Value>> {
        const OP: &str = "listTakes";
        let page_id = int4(&options.page_id, OP, "page_id")?;
        let mut parts = texts(&[
            ("page_slug", &options.page_slug),
            ("holder", &options.holder),
            ("kind", &options.kind),
            ("since_on_or_before", &options.since_on_or_before),
        ]);
        parts.extend(list_texts("takesHoldersAllowList", &options.allow_list));
        parts.extend(list_texts("sourceIds", &options.source_ids));
        no_nul(OP, &parts)?;
        let offset = match &options.offset {
            Value::Null => 0usize,
            Value::Number(n) => match n.as_f64() {
                Some(f) if f.is_finite() && f >= 0.0 && f <= i64::MAX as f64 => f as usize,
                _ => {
                    return Err(StoreError::invalid(format!(
                        "{OP}: OFFSET must be a bigint, got {n}"
                    )));
                }
            },
            other => {
                return Err(StoreError::invalid(format!(
                    "{OP}: invalid input syntax for type bigint: {other}"
                )));
            }
        };
        let limit = options.limit.unwrap_or(100) as usize;
        let trust = TrustPolicy::parse(options.min_trust.as_deref(), options.suppress_flagged)?;
        let read = self.read()?;
        let takes = match page_id {
            Some(p) => match u64::try_from(p) {
                Ok(p) => page_takes(&*read, p)?,
                Err(_) => Vec::new(),
            },
            None => all_takes(&*read)?,
        };
        let mut pages = PageCache::new(&*read);
        let mut rows: Vec<(TakeRecord, String)> = Vec::new();
        for take in takes {
            let Some(page) = pages.get(take.page_id)? else {
                continue;
            };
            if options.page_slug.as_ref().is_some_and(|s| *s != page.slug)
                || !in_scope(&options.source_ids, &page.source_id)
                || (options.eligible_only && !eligible_page(page))
                || private_page(&*read, page, &options.exclude_private)?
                || options.holder.as_ref().is_some_and(|h| *h != take.holder)
                || options.kind.as_ref().is_some_and(|k| *k != take.kind)
                || options.active.is_some_and(|a| a != take.active)
                || options
                    .resolved
                    .is_some_and(|r| r != take.resolved_at_us.is_some())
                || !allowed(&options.allow_list, &take.holder)
                || !trust.admits(&*read, TAKES, take.id, take.trust.tier())?
            {
                continue;
            }
            if let Some(cutoff) = &options.since_on_or_before {
                let Some(since) = &take.since_date else {
                    continue;
                };
                if iso_date_like(since) {
                    let padded = if since.len() == 7 {
                        format!("{since}-15")
                    } else {
                        since.clone()
                    };
                    if padded.as_str() > cutoff.as_str() {
                        continue;
                    }
                }
            }
            let slug = page.slug.clone();
            rows.push((take, slug));
        }
        let sort_by = options.sort_by.as_deref().unwrap_or("created_at");
        let oldest_first = options.oldest_first.unwrap_or(false);
        rows.sort_by(|(a, _), (b, _)| {
            use std::cmp::Ordering;
            // NULLS LAST in both directions.
            let nulls_last = |x: &Option<String>, y: &Option<String>, desc: bool| match (x, y) {
                (Some(x), Some(y)) => {
                    if desc {
                        y.cmp(x)
                    } else {
                        x.cmp(y)
                    }
                }
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            };
            let first = match sort_by {
                "since_date" => nulls_last(&a.since_date, &b.since_date, !oldest_first),
                "weight" => b.weight.total_cmp(&a.weight),
                "created_at" => b.created_at_us.cmp(&a.created_at_us),
                _ => Ordering::Equal,
            };
            first.then(b.id.cmp(&a.id))
        });
        Ok(rows
            .iter()
            .skip(offset)
            .take(limit)
            .map(|(t, slug)| t.to_json(slug))
            .collect())
    }

    /// `listActiveTakesForPages(pageIds, opts)`: the active takes of those pages, by
    /// `(page_id, row_num)`. The TypeScript member groups them per page.
    pub fn list_active_takes_for_pages(&self, input: &ActiveTakesInput) -> Result<Vec<Value>> {
        const OP: &str = "listActiveTakesForPages";
        let mut ids = BTreeSet::new();
        for value in &input.page_ids {
            if let Some(id) = int4(value, OP, "page_ids")? {
                ids.insert(id);
            }
        }
        no_nul(OP, &list_texts("takesHoldersAllowList", &input.allow_list))?;
        let read = self.read()?;
        let mut pages = PageCache::new(&*read);
        let mut out = Vec::new();
        for id in ids {
            let Ok(id) = u64::try_from(id) else {
                continue;
            };
            for take in page_takes(&*read, id)? {
                if !take.active || !allowed(&input.allow_list, &take.holder) {
                    continue;
                }
                if let Some(page) = pages.get(take.page_id)? {
                    out.push(take.to_json(&page.slug));
                }
            }
        }
        Ok(out)
    }

    /// `searchTakes(query, opts)`: active takes whose claim the query matches by pg_trgm's
    /// `query <% claim` (`word_similarity >= 0.6`), best `word_similarity` first, then heavier
    /// weight, then older take.
    pub fn search_takes(&self, options: &SearchTakesOptions) -> Result<Vec<Value>> {
        const OP: &str = "searchTakes";
        let mut parts = texts(&[("query", &options.query)]);
        parts.extend(list_texts("takesHoldersAllowList", &options.allow_list));
        parts.extend(list_texts("sourceIds", &options.source_ids));
        no_nul(OP, &parts)?;
        let Some(query) = options.query.as_deref() else {
            return Ok(Vec::new());
        };
        let limit = options.limit.unwrap_or(30) as usize;
        let trust = TrustPolicy::parse(options.min_trust.as_deref(), options.suppress_flagged)?;
        let read = self.read()?;
        let mut pages = PageCache::new(&*read);
        let mut hits: Vec<(f32, TakeRecord, String)> = Vec::new();
        for take in all_takes(&*read)? {
            if !take.active || !allowed(&options.allow_list, &take.holder) {
                continue;
            }
            let score = trgm_word_similarity(query, &take.claim);
            if f64::from(score) < TRGM_WORD_SIMILARITY_THRESHOLD {
                continue;
            }
            let Some(page) = pages.get(take.page_id)? else {
                continue;
            };
            if !in_scope(&options.source_ids, &page.source_id)
                || (options.eligible_only && !eligible_page(page))
                || private_page(&*read, page, &options.exclude_private)?
                || !trust.admits(&*read, TAKES, take.id, take.trust.tier())?
            {
                continue;
            }
            let slug = page.slug.clone();
            hits.push((score, take, slug));
        }
        hits.sort_by(|(sa, a, _), (sb, b, _)| {
            sb.total_cmp(sa)
                .then(b.weight.total_cmp(&a.weight))
                .then(a.id.cmp(&b.id))
        });
        Ok(hits
            .iter()
            .take(limit)
            .map(|(score, t, slug)| t.hit_json(slug, *score))
            .collect())
    }

    /// `updateTake(pageId, rowNum, fields)`: sets the given weight, since_date and source (a null
    /// keeps the stored value) and moves `updated_at`. Returns false when no such take exists.
    pub fn update_take(&self, input: &UpdateTakeInput) -> Result<bool> {
        const OP: &str = "updateTake";
        let page_id = int4(&input.page_id, OP, "pageId")?;
        let row_num = int4(&input.row_num, OP, "rowNum")?;
        no_nul(
            OP,
            &texts(&[("since_date", &input.since_date), ("source", &input.source)]),
        )?;
        let weight = input.weight.map(|w| real(w, OP)).transpose()?;
        let (Some(page_id), Some(row_num)) = (page_id, row_num) else {
            return Ok(false);
        };
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(false);
        };
        self.write(|tx| {
            let Some(mut take) = take_at(&*tx, page_id, row_num)? else {
                return Ok(false);
            };
            if let Some(w) = weight {
                if !(0.0..=1.0).contains(&w) {
                    return Err(check_failed(TAKES, "takes_weight_check"));
                }
                take.weight = w;
            }
            if let Some(d) = &input.since_date {
                take.since_date = Some(d.clone());
            }
            if let Some(s) = &input.source {
                take.source = Some(s.clone());
            }
            take.updated_at_us = self.env.now_micros();
            store_take(tx, &take)?;
            Ok(true)
        })
    }

    /// `supersedeTake(pageId, oldRow, newRow)`: appends the new take at `max(row_num) + 1` and
    /// marks the old one inactive and superseded by it. Resolves `{ status }`: `not_found`,
    /// `resolved` (a resolved take is immutable) or `ok` with `old_row` and `new_row`.
    pub fn supersede_take(&self, input: &SupersedeTakeInput) -> Result<Value> {
        const OP: &str = "supersedeTake";
        let page_id = int4(&input.page_id, OP, "pageId")?;
        let old_row = int4(&input.old_row, OP, "oldRow")?;
        no_nul(
            OP,
            &texts(&[
                ("claim", &input.claim),
                ("kind", &input.kind),
                ("holder", &input.holder),
                ("since_date", &input.since_date),
                ("until_date", &input.until_date),
                ("source", &input.source),
            ]),
        )?;
        let weight = input.weight.map(|w| real(w, OP)).transpose()?;
        let not_found = || Ok(json!({ "status": "not_found" }));
        let (Some(page_id), Some(old_row)) = (page_id, old_row) else {
            return not_found();
        };
        let Ok(page) = u64::try_from(page_id) else {
            return not_found();
        };
        self.write(|tx| {
            let Some(mut old) = take_at(&*tx, page, old_row)? else {
                return not_found();
            };
            if old.resolved_at_us.is_some() {
                return Ok(json!({ "status": "resolved" }));
            }
            let mut max_row = None;
            scan_prefix(&*tx, &row_prefix(page), true, &mut |k, _| {
                max_row = Some(row_from(&k[k.len() - 4..]));
                false
            })?;
            let new_row = max_row
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| int_out_of_range(OP))?;
            let now = self.env.now_micros();
            refuse_purged_take(&*tx, Some(page_id), input.claim.as_deref())?;
            let id = next_id(tx, NEXT_TAKE_ID)?;
            let claim = input
                .claim
                .clone()
                .ok_or_else(|| not_null(TAKES, "claim"))?;
            let kind = input.kind.clone().ok_or_else(|| not_null(TAKES, "kind"))?;
            let holder = input
                .holder
                .clone()
                .ok_or_else(|| not_null(TAKES, "holder"))?;
            let weight = weight.ok_or_else(|| not_null(TAKES, "weight"))?;
            let active = input.active.ok_or_else(|| not_null(TAKES, "active"))?;
            if !(0.0..=1.0).contains(&weight) {
                return Err(check_failed(TAKES, "takes_weight_check"));
            }
            insert_take(
                tx,
                &TakeRecord {
                    id,
                    page_id: page,
                    source_id: old.source_id.clone(),
                    row_num: new_row,
                    claim,
                    kind,
                    holder,
                    weight,
                    since_date: input.since_date.clone(),
                    until_date: input.until_date.clone(),
                    source: input.source.clone(),
                    superseded_by: None,
                    active,
                    resolved_at_us: None,
                    resolved_outcome: None,
                    resolved_quality: None,
                    resolved_value: None,
                    resolved_unit: None,
                    resolved_source: None,
                    resolved_by: None,
                    created_at_us: now,
                    updated_at_us: now,
                    claim_rev: 0,
                    trust: RowTrust::default(),
                    receipt: WriteReceipt::default(),
                },
            )?;
            old.active = false;
            old.superseded_by = Some(new_row);
            old.updated_at_us = now;
            store_take(tx, &old)?;
            Ok(json!({ "status": "ok", "old_row": old_row, "new_row": new_row }))
        })
    }

    /// `resolveTake(pageId, rowNum, resolution)`: returns `not_found`, `resolved` (already
    /// resolved; immutable) or `ok`. Writes only for `ok` with a resolution: `resolved_at` and
    /// `updated_at` move to now. The table's `CHECK` constraints refuse a bad quality/outcome pair.
    pub fn resolve_take(&self, input: &ResolveTakeInput) -> Result<String> {
        const OP: &str = "resolveTake";
        let page_id = int4(&input.page_id, OP, "pageId")?;
        let row_num = int4(&input.row_num, OP, "rowNum")?;
        let (Some(page_id), Some(row_num)) = (page_id, row_num) else {
            return Ok("not_found".into());
        };
        let Ok(page) = u64::try_from(page_id) else {
            return Ok("not_found".into());
        };
        self.write(|tx| {
            let Some(mut take) = take_at(&*tx, page, row_num)? else {
                return Ok("not_found".into());
            };
            if take.resolved_at_us.is_some() {
                return Ok("resolved".into());
            }
            let Some(resolution) = &input.resolution else {
                return Ok("ok".into());
            };
            no_nul(
                OP,
                &texts(&[
                    ("quality", &resolution.quality),
                    ("unit", &resolution.unit),
                    ("source", &resolution.source),
                    ("resolvedBy", &resolution.resolved_by),
                ]),
            )?;
            let value = resolution.value.map(|v| real(v, OP)).transpose()?;
            let quality = resolution.quality.as_deref();
            let outcome = resolution.outcome;
            // Postgres checks constraints in name order. A CHECK passes when its expression is
            // NULL, so a null outcome passes `quality = 'correct' AND outcome = true`, and a null
            // quality passes every arm that names one.
            let consistent = match quality {
                None => true,
                Some("correct") => outcome != Some(false),
                Some("incorrect") => outcome != Some(true),
                Some("partial" | "unresolvable") => outcome.is_none(),
                Some(_) => false,
            };
            if !consistent {
                return Err(check_failed(TAKES, "takes_resolution_consistency"));
            }
            if quality.is_some_and(|q| !QUALITIES.contains(&q)) {
                return Err(check_failed(TAKES, "takes_resolved_quality_values"));
            }
            let now = self.env.now_micros();
            take.resolved_at_us = Some(now);
            take.resolved_quality = resolution.quality.clone();
            take.resolved_outcome = outcome;
            take.resolved_value = value;
            take.resolved_unit = resolution.unit.clone();
            take.resolved_source = resolution.source.clone();
            take.resolved_by = resolution.resolved_by.clone();
            take.updated_at_us = now;
            store_take(tx, &take)?;
            Ok("ok".into())
        })
    }

    /// `getScorecard(opts, allowList)`: the raw counts `finalizeScorecard` reads. `brier` is the
    /// mean of `(weight - hit)^2` over correct and incorrect takes, or null when there are none.
    pub fn get_scorecard(&self, options: &ScorecardOptions) -> Result<Value> {
        const OP: &str = "getScorecard";
        let mut parts = texts(&[
            ("holder", &options.holder),
            ("domainPrefix", &options.domain_prefix),
            ("since", &options.since),
            ("until", &options.until),
        ]);
        parts.extend(list_texts("allowList", &options.allow_list));
        parts.extend(list_texts("sourceIds", &options.source_ids));
        no_nul(OP, &parts)?;
        let pattern = options.domain_prefix.as_ref().map(|p| format!("{p}%"));
        if let Some(p) = &pattern {
            // A malformed pattern fails even with no rows to match.
            like("", p)?;
        }
        let read = self.read()?;
        let mut pages = PageCache::new(&*read);
        let (
            mut total_bets,
            mut resolved,
            mut correct,
            mut incorrect,
            mut partial,
            mut unresolvable,
        ) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
        let (mut brier_sum, mut brier_n) = (0f64, 0u64);
        for take in all_takes(&*read)? {
            if options.holder.as_ref().is_some_and(|h| *h != take.holder)
                || !allowed(&options.allow_list, &take.holder)
            {
                continue;
            }
            if let Some(since) = &options.since
                && take.since_date.as_ref().is_none_or(|d| d < since)
            {
                continue;
            }
            if let Some(until) = &options.until
                && take.since_date.as_ref().is_none_or(|d| d > until)
            {
                continue;
            }
            if pattern.is_some()
                || options.source_ids.is_some()
                || options.exclude_private.is_some()
            {
                let Some(page) = pages.get(take.page_id)? else {
                    continue;
                };
                if let Some(p) = &pattern
                    && !like(&page.slug, p)?
                {
                    continue;
                }
                if !in_scope(&options.source_ids, &page.source_id)
                    || private_page(&*read, page, &options.exclude_private)?
                {
                    continue;
                }
            }
            if take.kind == "bet" {
                total_bets += 1;
            }
            match take.resolved_quality.as_deref() {
                Some("correct") => {
                    resolved += 1;
                    correct += 1;
                }
                Some("incorrect") => {
                    resolved += 1;
                    incorrect += 1;
                }
                Some("partial") => {
                    resolved += 1;
                    partial += 1;
                }
                Some("unresolvable") => unresolvable += 1,
                _ => {}
            }
            if let Some(q @ ("correct" | "incorrect")) = take.resolved_quality.as_deref() {
                let hit = if q == "correct" { 1.0 } else { 0.0 };
                brier_sum += (f64::from(take.weight) - hit).powi(2);
                brier_n += 1;
            }
        }
        let brier = (brier_n > 0).then(|| brier_sum / brier_n as f64);
        Ok(json!({
            "total_bets": total_bets,
            "resolved": resolved,
            "correct": correct,
            "incorrect": incorrect,
            "partial": partial,
            "unresolvable_count": unresolvable,
            "brier": brier,
        }))
    }

    /// `getCalibrationCurve(opts, allowList)`: correct and incorrect takes binned by weight in
    /// exact decimal arithmetic, as Postgres's `NUMERIC` bucketing does (`weight::numeric` has six
    /// significant digits); the last bucket also holds weight 1.
    pub fn get_calibration_curve(&self, options: &CalibrationOptions) -> Result<Vec<Value>> {
        const OP: &str = "getCalibrationCurve";
        let mut parts = texts(&[("holder", &options.holder)]);
        parts.extend(list_texts("allowList", &options.allow_list));
        parts.extend(list_texts("sourceIds", &options.source_ids));
        no_nul(OP, &parts)?;
        let size = options.bucket_size.unwrap_or(0.1);
        if !(size > 0.0 && size <= 1.0) {
            return Err(StoreError::invalid(format!("{OP}: bad bucket size {size}")));
        }
        let max_idx = (1.0 / size).floor() - 1.0;
        if max_idx < f64::from(i32::MIN) || max_idx > f64::from(i32::MAX) {
            return Err(int_out_of_range(OP));
        }
        let max_idx = max_idx as i128;
        let bucket = Decimal::parse(&format!("{size}"))
            .ok_or_else(|| StoreError::invalid(format!("{OP}: bad bucket size {size}")))?;
        let read = self.read()?;
        let mut pages = PageCache::new(&*read);
        // idx -> (n, hits, sum of weights)
        let mut bins: BTreeMap<i128, (u64, u64, f64)> = BTreeMap::new();
        for take in all_takes(&*read)? {
            let hit = match take.resolved_quality.as_deref() {
                Some("correct") => 1,
                Some("incorrect") => 0,
                _ => continue,
            };
            if options.holder.as_ref().is_some_and(|h| *h != take.holder)
                || !allowed(&options.allow_list, &take.holder)
            {
                continue;
            }
            if options.source_ids.is_some() || options.exclude_private.is_some() {
                let Some(page) = pages.get(take.page_id)? else {
                    continue;
                };
                if !in_scope(&options.source_ids, &page.source_id)
                    || private_page(&*read, page, &options.exclude_private)?
                {
                    continue;
                }
            }
            let floor = floor_div(Decimal::of_real(take.weight), bucket);
            if floor > i128::from(i32::MAX) {
                return Err(int_out_of_range(OP));
            }
            let idx = floor.min(max_idx);
            let bin = bins.entry(idx).or_insert((0, 0, 0.0));
            bin.0 += 1;
            bin.1 += hit;
            bin.2 += f64::from(take.weight);
        }
        let bound = |idx: i128| {
            Decimal {
                mantissa: idx * bucket.mantissa,
                exp: bucket.exp,
            }
            .to_f64()
        };
        Ok(bins
            .into_iter()
            .map(|(idx, (n, hits, sum))| {
                json!({
                    "bucket_lo": bound(idx),
                    "bucket_hi": bound(idx + 1),
                    "n": n,
                    "observed": hits as f64 / n as f64,
                    "predicted": sum / n as f64,
                })
            })
            .collect())
    }

    /// `matchTakeRows(pageId, rows, limit)`: the row numbers of the page's stored takes that
    /// differ in claim, kind or holder (a null fence field differs) from a fence row of the same
    /// number, ascending, at most `limit` (a null limit is no limit, a negative one is
    /// `invalid_argument`). A stored take that several fence rows of its number differ from is
    /// listed once for each, as the join lists it.
    pub fn match_take_rows(
        &self,
        page_id: i64,
        rows: &[FenceRowInput],
        limit: &Value,
    ) -> Result<Vec<i32>> {
        const OP: &str = "matchTakeRows";
        let mut fence = Vec::with_capacity(rows.len());
        for row in rows {
            fence.push((int4(&row.row_num, OP, "row_num")?, row));
        }
        let limit = match int4(limit, OP, "limit")? {
            None => usize::MAX,
            Some(n) => usize::try_from(n)
                .map_err(|_| StoreError::invalid(format!("{OP}: LIMIT must not be negative")))?,
        };
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let stored: BTreeMap<i32, TakeRecord> = page_takes(&*read, page_id)?
            .into_iter()
            .map(|t| (t.row_num, t))
            .collect();
        let mut out = Vec::new();
        for (row_num, row) in fence {
            let Some(take) = row_num.and_then(|n| stored.get(&n)) else {
                continue;
            };
            let same = row.claim.as_deref() == Some(take.claim.as_str())
                && row.kind.as_deref() == Some(take.kind.as_str())
                && row.holder.as_deref() == Some(take.holder.as_str());
            if !same {
                out.push(take.row_num);
            }
        }
        out.sort_unstable();
        out.truncate(limit);
        Ok(out)
    }

    /// `deleteTakeRows(pageId, rowNums)`: deletes the page's takes at the listed row numbers with
    /// the evidence rows that cite them (`ON DELETE CASCADE`) and their embeddings. A null entry
    /// or a number with no take deletes nothing; an empty list is no write.
    pub fn delete_take_rows(&self, page_id: i64, row_nums: &[Value]) -> Result<()> {
        const OP: &str = "deleteTakeRows";
        let mut wanted = BTreeSet::new();
        for value in row_nums {
            if let Some(n) = int4(value, OP, "row_nums")? {
                wanted.insert(n);
            }
        }
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(());
        };
        if wanted.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            for row_num in wanted.iter().copied() {
                if let Some(take) = take_at(&*tx, page_id, row_num)? {
                    delete_take(tx, &take)?;
                }
            }
            Ok(())
        })
    }

    /// `addSynthesisEvidence(rows)`: inserts each row unless its
    /// `(synthesis_page_id, take_page_id, take_row_num)` is already stored (this call's earlier
    /// rows included). Returns the number inserted. A missing synthesis page or take fails at the
    /// end, as the deferred foreign-key checks do.
    pub fn add_synthesis_evidence(&self, rows: &[EvidenceInput]) -> Result<u64> {
        const OP: &str = "addSynthesisEvidence";
        if rows.is_empty() {
            return Ok(0);
        }
        let mut parsed = Vec::with_capacity(rows.len());
        for column in [
            "synthesis_page_id",
            "take_page_id",
            "take_row_num",
            "citation_index",
        ] {
            for (i, r) in rows.iter().enumerate() {
                let value = match column {
                    "synthesis_page_id" => &r.synthesis_page_id,
                    "take_page_id" => &r.take_page_id,
                    "take_row_num" => &r.take_row_num,
                    _ => &r.citation_index,
                };
                let v = int4(value, OP, column)?;
                if parsed.len() <= i {
                    parsed.push([None; 4]);
                }
                let slot = match column {
                    "synthesis_page_id" => 0,
                    "take_page_id" => 1,
                    "take_row_num" => 2,
                    _ => 3,
                };
                parsed[i][slot] = v;
            }
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut inserted: Vec<(i32, i32, i32)> = Vec::new();
            for row in &parsed {
                let synth = row[0].ok_or_else(|| not_null(EVIDENCE_TABLE, "synthesis_page_id"))?;
                let take_page = row[1].ok_or_else(|| not_null(EVIDENCE_TABLE, "take_page_id"))?;
                let take_row = row[2].ok_or_else(|| not_null(EVIDENCE_TABLE, "take_row_num"))?;
                let citation = row[3].ok_or_else(|| not_null(EVIDENCE_TABLE, "citation_index"))?;
                let (Ok(s), Ok(p)) = (u64::try_from(synth), u64::try_from(take_page)) else {
                    // No page has a negative id: the row is new and a foreign key fails.
                    inserted.push((synth, take_page, take_row));
                    continue;
                };
                let key = evidence_key(s, p, take_row);
                if tx.get(&key)?.is_some() {
                    continue;
                }
                let synthesis_source_id = read_page_by_id(&*tx, s)?
                    .map(|page| page.source_id)
                    .unwrap_or_default();
                put_json(
                    tx,
                    &key,
                    &EvidenceRecord {
                        citation_index: citation,
                        created_at_us: now,
                        synthesis_source_id,
                    },
                )?;
                tx.put(&cited_key(p, take_row, s), &[])?;
                inserted.push((synth, take_page, take_row));
            }
            for (synth, take_page, take_row) in &inserted {
                let synth_ok = match u64::try_from(*synth) {
                    Ok(s) => read_page_by_id(&*tx, s)?.is_some(),
                    Err(_) => false,
                };
                if !synth_ok {
                    return Err(fk_failed(
                        EVIDENCE_TABLE,
                        "synthesis_evidence_synthesis_page_id_fkey",
                    ));
                }
                let take_ok = match u64::try_from(*take_page) {
                    Ok(p) => tx.get(&row_key(p, *take_row))?.is_some(),
                    Err(_) => false,
                };
                if !take_ok {
                    return Err(fk_failed(
                        EVIDENCE_TABLE,
                        "synthesis_evidence_take_page_id_take_row_num_fkey",
                    ));
                }
            }
            Ok(inserted.len() as u64)
        })
    }
}

#[cfg(test)]
mod tests {
    //! The crate-private hooks are tested here; the members through the public API in
    //! `tests/takes.rs`.
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::sources::SourceInput;
    use crate::test_support::store;

    fn put(store: &Store, source: &str, slug: &str) -> u64 {
        let input: PageInput =
            serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "x"}))
                .unwrap();
        let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
        store.put_page(slug, &input, &opts).unwrap();
        let read = store.read().unwrap();
        crate::pages::read_page(&*read, source, slug)
            .unwrap()
            .unwrap()
            .id
    }

    fn source(store: &Store, id: &str) {
        let input: SourceInput = serde_json::from_value(json!({"id": id, "name": id})).unwrap();
        store.upsert_source(&input).unwrap();
    }

    fn add(store: &Store, page: u64, row: i32) {
        let input: TakeInput = serde_json::from_value(json!({
            "page_id": page, "row_num": row, "claim": format!("c{page}-{row}"), "kind": "take",
            "holder": "garry", "weight": 0.5, "active": true,
        }))
        .unwrap();
        store.add_takes_batch(&[input]).unwrap();
    }

    #[test]
    fn a_take_tombstone_refuses_its_claim_under_star_or_the_page_and_goes_with_its_source() {
        use crate::facts::take_purges::{TakePurgeInsert, has_take_purges, tombstoned_hashes};
        let store = store();
        source(&store, "team");
        let page = put(&store, "team", "people/a");
        let other = put(&store, "team", "people/b");
        let hash = |c: &str| crate::facts::fact_fingerprint(c);
        let purge = |subject: &str, claim: &str| {
            let row = TakePurgeInsert {
                source_id: "team".into(),
                subject: subject.into(),
                claim_hash: hash(claim),
                request_id: None,
            };
            store.insert_take_purge(&row).unwrap()
        };
        add(&store, page, 1);
        assert!(purge("*", &format!("c{page}-1")));
        assert!(purge("people/a", "page only"));
        let row = |page: u64, row: i32, claim: &str| -> TakeInput {
            serde_json::from_value(json!({
                "page_id": page, "row_num": row, "claim": claim, "kind": "take",
                "holder": "garry", "weight": 0.5, "active": true,
            }))
            .unwrap()
        };
        let code = |r: Result<u64>| r.unwrap_err().code;
        // An unchanged upsert row is refused: the trigger runs BEFORE INSERT on every proposed row.
        let same = row(page, 1, &format!("c{page}-1"));
        assert_eq!(code(store.add_takes_batch(&[same])), "purged_content");
        assert_eq!(
            code(store.add_takes_batch(&[row(page, 2, "ok"), row(page, 3, "page only")])),
            "purged_content"
        );
        assert!(take_at(&*store.read().unwrap(), page, 2).unwrap().is_none());
        assert_eq!(
            store
                .add_takes_batch(&[row(other, 1, "page only")])
                .unwrap(),
            1
        );
        let read = store.read().unwrap();
        let asked = [hash("page only"), hash("nothing")];
        assert_eq!(
            tombstoned_hashes(&*read, "team", &asked).unwrap(),
            BTreeSet::from([hash("page only")])
        );
        drop(read);
        store
            .write(|tx| crate::cascade::remove_source_rows(tx, "team"))
            .unwrap();
        assert!(!has_take_purges(&*store.read().unwrap(), "team").unwrap());
    }

    #[test]
    fn a_page_take_purge_tombstones_each_distinct_claim_of_the_page_once() {
        use crate::facts::take_purges::{PageTakePurgeInsert, TakePurgeRow, tombstoned_hashes};
        let store = store();
        source(&store, "team");
        let page = put(&store, "team", "people/a");
        let other = put(&store, "team", "people/b");
        let claim = |page: u64, row: i32, claim: &str| -> TakeInput {
            serde_json::from_value(json!({
                "page_id": page, "row_num": row, "claim": claim, "kind": "take",
                "holder": "garry", "weight": 0.5, "active": true,
            }))
            .unwrap()
        };
        store
            .add_takes_batch(&[
                claim(page, 1, "Acme will win"),
                claim(page, 2, "  ACME will win. "),
                claim(page, 3, "Rates fall"),
                claim(other, 1, "Other page claim"),
            ])
            .unwrap();
        let purge = |page_id: i64, request_id: Option<&str>| {
            let row = TakePurgeRow::Page(PageTakePurgeInsert {
                source_id: "team".into(),
                subject: "people/a".into(),
                page_id,
                request_id: request_id.map(str::to_string),
            });
            store.insert_take_purge_row(&row)
        };
        assert!(purge(page as i64, None).unwrap());
        assert!(!purge(page as i64, Some("6f9619ff-8b86-4d01-b42d-00cf4fc964aa")).unwrap());
        assert!(!purge(987_654, None).unwrap());
        assert!(!purge(-1, None).unwrap());
        assert!(
            purge(page as i64, Some("not-a-uuid"))
                .unwrap_err()
                .message
                .contains("requestId is not a UUID")
        );
        let hash = |c: &str| crate::facts::fact_fingerprint(c);
        let asked = [
            hash("Acme will win"),
            hash("Rates fall"),
            hash("Other page claim"),
        ];
        assert_eq!(
            tombstoned_hashes(&*store.read().unwrap(), "team", &asked).unwrap(),
            BTreeSet::from([hash("Acme will win"), hash("Rates fall")])
        );
    }

    fn cite(store: &Store, synth: u64, page: u64, row: i32) {
        let input: EvidenceInput = serde_json::from_value(json!({
            "synthesis_page_id": synth, "take_page_id": page, "take_row_num": row, "citation_index": 1,
        }))
        .unwrap();
        assert_eq!(store.add_synthesis_evidence(&[input]).unwrap(), 1);
    }

    /// Every key of this family, as (kind byte, rest).
    fn family_keys(store: &Store) -> Vec<Vec<u8>> {
        let read = store.read().unwrap();
        let mut out = Vec::new();
        scan_prefix(&*read, &[keys::TAKE], false, &mut |k, _| {
            out.push(k.to_vec());
            true
        })
        .unwrap();
        out
    }

    #[test]
    fn remove_page_rows_drops_the_pages_takes_and_evidence_both_ways() {
        let store = store();
        let a = put(&store, "default", "people/a");
        let b = put(&store, "default", "people/b");
        let synth = put(&store, "default", "notes/synth");
        add(&store, a, 1);
        add(&store, a, 2);
        add(&store, b, 1);
        cite(&store, synth, a, 1);
        cite(&store, synth, b, 1);
        let before = family_keys(&store).len();
        // 3 takes x 2 keys + 2 evidence x 2 keys
        assert_eq!(before, 10);

        let page_a = read_page_by_id(&*store.read().unwrap(), a)
            .unwrap()
            .unwrap();
        store.write(|tx| remove_page_rows(tx, &page_a)).unwrap();
        // b's take and the evidence citing it stay.
        assert_eq!(family_keys(&store).len(), 4);
        assert!(take_at(&*store.read().unwrap(), b, 1).unwrap().is_some());

        let page_synth = read_page_by_id(&*store.read().unwrap(), synth)
            .unwrap()
            .unwrap();
        store.write(|tx| remove_page_rows(tx, &page_synth)).unwrap();
        assert_eq!(family_keys(&store).len(), 2);
    }

    #[test]
    fn remove_source_rows_drops_every_take_and_evidence_row_of_the_source() {
        let store = store();
        source(&store, "side");
        let main = put(&store, "default", "people/a");
        let side = put(&store, "side", "people/a");
        let main_synth = put(&store, "default", "notes/synth");
        let side_synth = put(&store, "side", "notes/synth");
        add(&store, main, 1);
        add(&store, side, 1);
        add(&store, side, 2);
        // main synthesis cites a side take; side synthesis cites a main take.
        cite(&store, main_synth, side, 1);
        cite(&store, side_synth, main, 1);
        cite(&store, main_synth, main, 1);

        // The pages are still there: the sweep works from the records alone.
        store.write(|tx| remove_source_rows(tx, "side")).unwrap();
        let read = store.read().unwrap();
        assert!(take_at(&*read, main, 1).unwrap().is_some());
        assert!(take_at(&*read, side, 1).unwrap().is_none());
        assert!(take_at(&*read, side, 2).unwrap().is_none());
        // Only main synthesis -> main take is left: 1 take x 2 keys + 1 evidence x 2 keys.
        drop(read);
        let left = family_keys(&store);
        assert_eq!(left.len(), 4);
        let read = store.read().unwrap();
        assert!(
            read.get(&evidence_key(main_synth, main, 1))
                .unwrap()
                .is_some()
        );
        assert!(read.get(&cited_key(main, 1, main_synth)).unwrap().is_some());
        drop(read);

        // Another source is untouched; sweeping it again is a no-op.
        store.write(|tx| remove_source_rows(tx, "side")).unwrap();
        assert_eq!(family_keys(&store).len(), 4);
        store.write(|tx| remove_source_rows(tx, "default")).unwrap();
        assert!(family_keys(&store).is_empty());
    }

    #[test]
    fn row_numbers_sort_in_key_order_with_negatives_first() {
        let mut keys: Vec<Vec<u8>> = [5, -1, 0, i32::MIN, i32::MAX, 2]
            .iter()
            .map(|r| row_key(1, *r))
            .collect();
        keys.sort();
        let rows: Vec<i32> = keys.iter().map(|k| row_from(&k[10..14])).collect();
        assert_eq!(rows, vec![i32::MIN, -1, 0, 2, 5, i32::MAX]);
    }

    #[test]
    fn like_and_calibration_arithmetic_match_postgres() {
        assert!(like("companies/acme", "companies/%").unwrap());
        assert!(like("companiesXacme", "companies_%").unwrap());
        assert!(!like("companiesXacme", "companies\\_%").unwrap());
        assert!(like("a%b", "a\\%%").unwrap());
        assert!(like("", "%").unwrap());
        assert!(like("x", "\\").is_err());
        let tenth = Decimal::parse("0.1").unwrap();
        // 0.7 / 0.1 is 7 exactly in NUMERIC (6.999... in floats).
        assert_eq!(floor_div(Decimal::of_real(0.7), tenth), 7);
        assert_eq!(floor_div(Decimal::of_real(0.95), tenth), 9);
        assert_eq!(floor_div(Decimal::of_real(1.0), tenth), 10);
        assert_eq!(floor_div(Decimal::of_real(0.0), tenth), 0);
        assert_eq!(floor_div(Decimal::of_real(1e-40), tenth), 0);
        assert_eq!(
            Decimal {
                mantissa: 3,
                exp: -1
            }
            .to_f64(),
            0.3
        );
    }
}
