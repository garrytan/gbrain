//! The write gate's verdict receipts and its holding table: `write_gate_receipts` and
//! `write_gate_holds` (src/core/write-gate-schema.ts, src/core/write-gate-store.ts).
//!
//! A receipt records a flag or quarantine verdict on a persisted row (a page, fact, take, timeline
//! entry or hold). A hold keeps a quarantined fact or take out of its table until the owner
//! releases or drops it. Keys:
//! - `t 0x02 id` (8 bytes, big-endian) -> [`ReceiptRecord`].
//! - `t 0x03 target_table \0 target_id \0 content_hash \0 detector_version` -> receipt id: the
//!   table's unique index, which an upsert of the same verdict refreshes.
//! - `t 0x04 id` -> [`HoldRecord`].
//! - `t 0x05 source \0 slug \0 fingerprint \0 detector_version` -> hold id: the dedupe index, which
//!   re-opens a hold when the same content arrives again.
//!
//! Ids come from the `write_gate_receipts` and `write_gate_holds` counters and start at 1. Neither
//! table has a foreign key in Postgres, so a source or page delete leaves these rows. A page purge's
//! sweep removes the holds of its slug and the receipts that name it (`write_gate/purge.rs`); a
//! source delete (`sources::delete_source_record`) removes the source's holds with their receipts
//! through [`remove_source_holds`], as `removedSourceScrubCtes` does.

use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::facts::purge_probe::{EachRow, ProbeCell, ProbeRow, each_json};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{next_id, read_page};
use crate::timeline_queries::jsonb_field_text;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

mod purge;

const RECEIPT: u8 = 0x02;
const RECEIPT_TARGET: u8 = 0x03;
const HOLD: u8 = 0x04;
const HOLD_DEDUPE: u8 = 0x05;

/// The table's `target_table` CHECK.
const TARGET_TABLES: [&str; 5] = [
    "pages",
    "facts",
    "takes",
    "timeline_entries",
    "write_gate_holds",
];
/// The table's `verdict` CHECK.
const VERDICTS: [&str; 2] = ["flag", "quarantine"];
/// The hold table's `kind` CHECK.
const KINDS: [&str; 2] = ["fact", "take"];
/// The two decided values of the hold table's `status` CHECK.
const DECIDED: [&str; 2] = ["released", "dropped"];

const MICROS_PER_DAY: i64 = 86_400_000_000;

/// The verdict fields of a receipt (`WriteGateReceiptFields`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptFields {
    pub content_hash: String,
    pub tier: String,
    pub detector_version: i64,
    pub verdict: String,
    pub reason_families: Vec<String>,
    pub reasons: Vec<String>,
    pub detector_error: bool,
    pub request_id: Option<String>,
}

/// A receipt on a persisted row (`WriteGateReceiptInput`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptInput {
    pub target_table: String,
    pub target_id: String,
    pub source_id: Option<String>,
    pub content_hash: String,
    pub tier: String,
    pub detector_version: i64,
    pub verdict: String,
    pub reason_families: Vec<String>,
    pub reasons: Vec<String>,
    pub detector_error: bool,
    pub request_id: Option<String>,
}

impl ReceiptInput {
    fn fields(&self) -> ReceiptFields {
        ReceiptFields {
            content_hash: self.content_hash.clone(),
            tier: self.tier.clone(),
            detector_version: self.detector_version,
            verdict: self.verdict.clone(),
            reason_families: self.reason_families.clone(),
            reasons: self.reasons.clone(),
            detector_error: self.detector_error,
            request_id: self.request_id.clone(),
        }
    }
}

/// A held fact or take (`WriteGateHoldRowInput`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HoldInput {
    pub kind: String,
    pub source_id: String,
    pub slug: String,
    pub fingerprint: String,
    pub detector_version: i64,
    pub tier: String,
    pub reason_families: Vec<String>,
    pub reasons: Vec<String>,
    pub detector_error: bool,
    pub payload: Value,
    pub write_origin: Option<Value>,
    pub request_id: Option<String>,
}

/// Hold listing filters (`WriteGateHoldListOpts`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HoldListOpts {
    pub status: String,
    pub kind: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub source_id: Option<String>,
    pub before_id: Option<i64>,
    pub limit: i64,
}

/// What is stored for a receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReceiptRecord {
    id: u64,
    target_table: String,
    target_id: String,
    source_id: Option<String>,
    content_hash: String,
    tier: String,
    detector_version: i32,
    verdict: String,
    reason_families: Vec<String>,
    reasons: Vec<String>,
    detector_error: bool,
    request_id: Option<String>,
    created_at_us: i64,
    last_seen_at_us: i64,
}

/// What is stored for a hold.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct HoldRecord {
    id: u64,
    kind: String,
    source_id: String,
    slug: String,
    fingerprint: String,
    detector_version: i32,
    tier: String,
    reason_families: Vec<String>,
    reasons: Vec<String>,
    detector_error: bool,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    payload: Value,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    write_origin: Option<Value>,
    request_id: Option<String>,
    status: String,
    seen_count: i64,
    created_at_us: i64,
    last_seen_at_us: i64,
    decided_at_us: Option<i64>,
    decided_by: Option<String>,
}

impl HoldRecord {
    fn to_row(&self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind,
            "source_id": self.source_id,
            "slug": self.slug,
            "tier": self.tier,
            "detector_version": self.detector_version,
            "detector_error": self.detector_error,
            "reason_families": self.reason_families,
            "reasons": self.reasons,
            "payload": crate::jsonb::order(self.payload.clone()),
            "write_origin": self.write_origin.clone().map(crate::jsonb::order),
            "request_id": self.request_id,
            "status": self.status,
            "seen_count": self.seen_count,
            "created_at": iso(self.created_at_us),
            "last_seen_at": iso(self.last_seen_at_us),
            "decided_at": self.decided_at_us.map(iso),
            "decided_by": self.decided_by,
        })
    }
}

fn tagged(kind: u8, parts: &[&str]) -> Vec<u8> {
    let mut key = keys::text(keys::TRUST, parts);
    key.insert(1, kind);
    key
}

fn by_id(kind: u8, id: u64) -> Vec<u8> {
    let mut key = vec![keys::TRUST, kind];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn read_id(read: &dyn KvRead, key: &[u8]) -> Result<Option<u64>> {
    match read.get(key)? {
        None => Ok(None),
        Some(bytes) => keys::be8(&bytes).map(Some).ok_or_else(|| {
            StoreError::new(crate::error::STORE_CORRUPT, "bad write gate index entry")
        }),
    }
}

fn one_of(op: &str, name: &str, value: &str, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(StoreError::invalid(format!(
            "{op}: {name} must be one of {}, not \"{value}\"",
            allowed.join(", ")
        )))
    }
}

/// An `integer` column: Postgres refuses a value outside its range.
fn int4(op: &str, name: &str, value: i64) -> Result<i32> {
    i32::try_from(value)
        .map_err(|_| StoreError::invalid(format!("{op}: {name} {value} is out of integer range")))
}

fn no_nul_list(op: &str, name: &str, values: &[String]) -> Result<()> {
    for v in values {
        no_nul(op, &[(name, v.as_str())])?;
    }
    Ok(())
}

/// Postgres `jsonb` refuses the `\u0000` escape anywhere in the document.
fn json_no_nul(op: &str, name: &str, value: &Value) -> Result<()> {
    let bad = match value {
        Value::String(s) => s.contains('\0'),
        Value::Array(items) => {
            for item in items {
                json_no_nul(op, name, item)?;
            }
            false
        }
        Value::Object(map) => {
            for (k, v) in map {
                if k.contains('\0') {
                    return Err(StoreError::invalid(format!(
                        "{op}: {name} must not contain a NUL character"
                    )));
                }
                json_no_nul(op, name, v)?;
            }
            false
        }
        _ => false,
    };
    if bad {
        return Err(StoreError::invalid(format!(
            "{op}: {name} must not contain a NUL character"
        )));
    }
    Ok(())
}

fn check_fields(op: &str, f: &ReceiptFields) -> Result<i32> {
    no_nul(
        op,
        &[
            ("content_hash", f.content_hash.as_str()),
            ("tier", f.tier.as_str()),
            ("verdict", f.verdict.as_str()),
            ("request_id", f.request_id.as_deref().unwrap_or("")),
        ],
    )?;
    no_nul_list(op, "reason_families", &f.reason_families)?;
    no_nul_list(op, "reasons", &f.reasons)?;
    one_of(op, "verdict", &f.verdict, &VERDICTS)?;
    int4(op, "detector_version", f.detector_version)
}

/// The `INSERT .. ON CONFLICT (target_table, target_id, content_hash, detector_version) DO UPDATE`
/// of a receipt. Returns its id.
fn upsert_receipt(
    tx: &mut dyn KvWrite,
    now: i64,
    target_table: &str,
    target_id: &str,
    source_id: Option<&str>,
    f: &ReceiptFields,
    detector_version: i32,
) -> Result<u64> {
    let version = detector_version.to_string();
    let index = tagged(
        RECEIPT_TARGET,
        &[target_table, target_id, &f.content_hash, &version],
    );
    if let Some(id) = read_id(tx, &index)? {
        let key = by_id(RECEIPT, id);
        let mut record: ReceiptRecord = get_json(tx, &key)?.ok_or_else(|| {
            StoreError::new(
                crate::error::STORE_CORRUPT,
                "write gate receipt index without its row",
            )
        })?;
        record.last_seen_at_us = now;
        record.verdict.clone_from(&f.verdict);
        record.tier.clone_from(&f.tier);
        record.reason_families.clone_from(&f.reason_families);
        record.reasons.clone_from(&f.reasons);
        record.detector_error = f.detector_error;
        if f.request_id.is_some() {
            record.request_id.clone_from(&f.request_id);
        }
        put_json(tx, &key, &record)?;
        return Ok(id);
    }
    let id = next_id(tx, "write_gate_receipts")?;
    let record = ReceiptRecord {
        id,
        target_table: target_table.to_string(),
        target_id: target_id.to_string(),
        source_id: source_id.map(str::to_string),
        content_hash: f.content_hash.clone(),
        tier: f.tier.clone(),
        detector_version,
        verdict: f.verdict.clone(),
        reason_families: f.reason_families.clone(),
        reasons: f.reasons.clone(),
        detector_error: f.detector_error,
        request_id: f.request_id.clone(),
        created_at_us: now,
        last_seen_at_us: now,
    };
    put_json(tx, &by_id(RECEIPT, id), &record)?;
    tx.put(&index, &id.to_be_bytes())?;
    Ok(id)
}

fn delete_receipt(tx: &mut dyn KvWrite, record: &ReceiptRecord) -> Result<()> {
    let version = record.detector_version.to_string();
    tx.delete(&tagged(
        RECEIPT_TARGET,
        &[
            &record.target_table,
            &record.target_id,
            &record.content_hash,
            &version,
        ],
    ))?;
    tx.delete(&by_id(RECEIPT, record.id))
}

/// `deletePurgeWriteGateHolds` (a fact purge): deletes the holds of `source_id` whose
/// `COALESCE(payload->>'fact', payload->>'claim', '')` has fingerprint `fact_hash`, with their
/// dedupe entries; the ids deleted, as text, in id order.
pub(crate) fn purge_holds(
    tx: &mut dyn KvWrite,
    source_id: &str,
    fact_hash: &str,
) -> Result<Vec<String>> {
    let mut deleted = Vec::new();
    for h in all_holds(tx)? {
        if h.source_id != source_id {
            continue;
        }
        let field = |name: &str| h.payload.get(name).and_then(jsonb_field_text);
        let text = field("fact").or_else(|| field("claim")).unwrap_or_default();
        if crate::facts::fact_fingerprint(&text) != fact_hash {
            continue;
        }
        let version = h.detector_version.to_string();
        let index = tagged(
            HOLD_DEDUPE,
            &[&h.source_id, &h.slug, &h.fingerprint, &version],
        );
        if read_id(tx, &index)? == Some(h.id) {
            tx.delete(&index)?;
        }
        tx.delete(&by_id(HOLD, h.id))?;
        deleted.push(h.id);
    }
    deleted.sort_unstable();
    Ok(deleted.into_iter().map(|id| id.to_string()).collect())
}

/// `deletePurgeWriteGateReceipts` (a fact purge): deletes the receipts on a purged fact, take or
/// hold (`target_id` in the matching id list); how many.
pub(crate) fn purge_receipts(
    tx: &mut dyn KvWrite,
    facts: &std::collections::HashSet<String>,
    takes: &std::collections::HashSet<String>,
    holds: &std::collections::HashSet<String>,
) -> Result<u64> {
    let mut deleted = 0;
    for r in all_receipts(tx)? {
        let ids = match r.target_table.as_str() {
            "facts" => facts,
            "takes" => takes,
            "write_gate_holds" => holds,
            _ => continue,
        };
        if ids.contains(&r.target_id) {
            delete_receipt(tx, &r)?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

fn all_receipts(read: &dyn KvRead) -> Result<Vec<ReceiptRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::TRUST, RECEIPT], false, &mut |_, v| {
        match serde_json::from_slice::<ReceiptRecord>(v) {
            Ok(r) => out.push(r),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// The receipts of one target, through the unique index.
/// `ACTIVATION_REASON_FAMILIES` (src/core/eligibility/sql.ts): the write-gate reason families that
/// make an unconfirmed row ineligible for proactive injection.
const ACTIVATION_REASON_FAMILIES: [&str; 4] = [
    "standing_instruction",
    "override",
    "exfiltration",
    "credential",
];

/// `activationSuppressedSql`: a row whose tier is at or below `agent_written`
/// (`ACTIVATION_TIER_CEILING`) and that holds a `flag` receipt in an activation reason family.
/// Owner confirmation raises the tier, which lifts the suppression without touching the receipt.
pub(crate) fn activation_suppressed(
    read: &dyn KvRead,
    target_table: &str,
    target_id: u64,
    tier: crate::trust::TrustTier,
) -> Result<bool> {
    if tier.rank() > crate::trust::TrustTier::AgentWritten.rank() {
        return Ok(false);
    }
    Ok(receipts_of(read, target_table, &target_id.to_string())?
        .iter()
        .any(|r| {
            r.verdict == "flag"
                && r.reason_families
                    .iter()
                    .any(|f| ACTIVATION_REASON_FAMILIES.contains(&f.as_str()))
        }))
}

/// Whether target (`target_table`, `target_id`) holds a `flag` receipt naming `family` in its
/// reason families (`r.verdict = 'flag' AND family = ANY(r.reason_families)`).
pub(crate) fn flagged_for(
    read: &dyn KvRead,
    target_table: &str,
    target_id: u64,
    family: &str,
) -> Result<bool> {
    Ok(receipts_of(read, target_table, &target_id.to_string())?
        .iter()
        .any(|r| r.verdict == "flag" && r.reason_families.iter().any(|f| f == family)))
}

fn receipts_of(
    read: &dyn KvRead,
    target_table: &str,
    target_id: &str,
) -> Result<Vec<ReceiptRecord>> {
    let mut prefix = tagged(RECEIPT_TARGET, &[target_table, target_id]);
    prefix.push(0);
    let mut ids = Vec::new();
    let mut failure = None;
    scan_prefix(read, &prefix, false, &mut |_, v| {
        match keys::be8(v) {
            Some(id) => ids.push(id),
            None => {
                failure = Some(StoreError::new(
                    crate::error::STORE_CORRUPT,
                    "bad write gate index entry",
                ));
            }
        }
        failure.is_none()
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    let mut out = Vec::new();
    for id in ids {
        if let Some(r) = get_json::<ReceiptRecord>(read, &by_id(RECEIPT, id))? {
            out.push(r);
        }
    }
    Ok(out)
}

fn all_holds(read: &dyn KvRead) -> Result<Vec<HoldRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::TRUST, HOLD], false, &mut |_, v| {
        match serde_json::from_slice::<HoldRecord>(v) {
            Ok(r) => out.push(r),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// A page purge receipt's probe of the write-gate holds (`countPurgeStoreProbe` on `write_gate_holds`): how many holds of
/// `source_id` name `slug`, in any status.
/// The slugs of the holds of `source_id` (a hold keeps no page id here, so it reaches a page by slug alone).
pub(crate) fn source_hold_slugs(read: &dyn KvRead, source_id: &str) -> Result<Vec<String>> {
    Ok(all_holds(read)?
        .into_iter()
        .filter(|h| h.source_id == source_id)
        .map(|h| h.slug)
        .collect())
}

pub(crate) fn count_for_slug(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<usize> {
    Ok(all_holds(read)?
        .iter()
        .filter(|h| h.source_id == source_id && h.slug == slug)
        .count())
}

/// The `scrub_write_gate_holds` and `scrub_write_gate_receipts` steps of a source delete
/// (`removedSourceScrubCtes`): every hold of `source_id`, whatever its status, with its dedupe
/// entry and the receipts whose target is that hold (`target_table = 'write_gate_holds'`).
pub(crate) fn remove_source_holds(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for hold in all_holds(&*tx)?
        .into_iter()
        .filter(|h| h.source_id == source_id)
    {
        let id = hold.id.to_string();
        for receipt in receipts_of(&*tx, "write_gate_holds", &id)? {
            delete_receipt(tx, &receipt)?;
        }
        let version = hold.detector_version.to_string();
        tx.delete(&tagged(
            HOLD_DEDUPE,
            &[&hold.source_id, &hold.slug, &hold.fingerprint, &version],
        ))?;
        tx.delete(&by_id(HOLD, hold.id))?;
    }
    Ok(())
}

/// The fingerprints of the holds with `kind = 'fact'` and `status = 'held'` on page (`source_id`,
/// `slug`), as the fence overlay (`engine-sql/cli-reads-ops.ts` `readFenceOverlayRows`) matches a
/// fence row's fingerprint against them.
pub(crate) fn held_fact_fingerprints(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
) -> Result<std::collections::HashSet<String>> {
    Ok(all_holds(read)?
        .into_iter()
        .filter(|h| {
            h.kind == "fact" && h.status == "held" && h.source_id == source_id && h.slug == slug
        })
        .map(|h| h.fingerprint)
        .collect())
}

/// A released fact hold, as `listUnpreviewedTrustFacts` (src/core/engine-sql/facts-doctor.ts) joins
/// it: the hold id, its source and slug, `payload->>'row_num'` and `request_id::text`.
pub(crate) struct ReleasedFactHold {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub row_num: Option<String>,
    pub request_id: Option<String>,
}

/// Every hold with `kind = 'fact'` and `status = 'released'`, in id order.
pub(crate) fn released_fact_holds(read: &dyn KvRead) -> Result<Vec<ReleasedFactHold>> {
    let mut out: Vec<ReleasedFactHold> = all_holds(read)?
        .into_iter()
        .filter(|h| h.kind == "fact" && h.status == "released")
        .map(|h| ReleasedFactHold {
            id: h.id,
            row_num: h.payload.get("row_num").and_then(jsonb_field_text),
            source_id: h.source_id,
            slug: h.slug,
            request_id: h.request_id,
        })
        .collect();
    out.sort_by_key(|h| h.id);
    Ok(out)
}

/// A hold id in `target_id` text form (`h.id::text = r.target_id`): only the canonical decimal
/// spelling matches.
fn hold_id_text(target_id: &str) -> Option<u64> {
    let id: u64 = target_id.parse().ok()?;
    (id.to_string() == target_id).then_some(id)
}

impl Store {
    /// `upsertWriteGateReceipt`: records a flag or quarantine receipt on a row, or refreshes the
    /// one with the same target, content hash and detector version. Returns its id.
    pub fn upsert_write_gate_receipt(&self, input: ReceiptInput) -> Result<u64> {
        let op = "upsertWriteGateReceipt";
        let fields = input.fields();
        no_nul(
            op,
            &[
                ("target_table", input.target_table.as_str()),
                ("target_id", input.target_id.as_str()),
                ("source_id", input.source_id.as_deref().unwrap_or("")),
            ],
        )?;
        one_of(op, "target_table", &input.target_table, &TARGET_TABLES)?;
        let version = check_fields(op, &fields)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            upsert_receipt(
                tx,
                now,
                &input.target_table,
                &input.target_id,
                input.source_id.as_deref(),
                &fields,
                version,
            )
        })
    }

    /// `upsertPageWriteGateReceipt`: [`Store::upsert_write_gate_receipt`] on the live page
    /// `(source_id, slug)`; `None` when no live page has that slug.
    pub fn upsert_page_write_gate_receipt(
        &self,
        source_id: &str,
        slug: &str,
        fields: ReceiptFields,
    ) -> Result<Option<u64>> {
        let op = "upsertPageWriteGateReceipt";
        no_nul(op, &[("sourceId", source_id), ("slug", slug)])?;
        let version = check_fields(op, &fields)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(page) = read_page(tx, source_id, slug)? else {
                return Ok(None);
            };
            if page.deleted_at_us.is_some() {
                return Ok(None);
            }
            let id = page.id.to_string();
            upsert_receipt(
                tx,
                now,
                "pages",
                &id,
                Some(&page.source_id),
                &fields,
                version,
            )
            .map(Some)
        })
    }

    /// `deleteStalePageWriteGateReceipts`: removes the receipts of page `(source_id, slug)`, live
    /// or soft-deleted, whose content hash is not `content_hash` (all of them when `None`).
    pub fn delete_stale_page_write_gate_receipts(
        &self,
        source_id: &str,
        slug: &str,
        content_hash: Option<&str>,
    ) -> Result<()> {
        let op = "deleteStalePageWriteGateReceipts";
        no_nul(
            op,
            &[
                ("sourceId", source_id),
                ("slug", slug),
                ("contentHash", content_hash.unwrap_or("")),
            ],
        )?;
        self.write(|tx| {
            let Some(page) = read_page(tx, source_id, slug)? else {
                return Ok(());
            };
            let id = page.id.to_string();
            for r in receipts_of(tx, "pages", &id)? {
                if content_hash != Some(r.content_hash.as_str()) {
                    delete_receipt(tx, &r)?;
                }
            }
            Ok(())
        })
    }

    /// `listWriteGateReceiptsFor`: one row's receipts, newest `last_seen_at` first, then higher
    /// id first, at most `limit`.
    pub fn list_write_gate_receipts_for(
        &self,
        target_table: &str,
        target_id: &str,
        limit: i64,
    ) -> Result<Vec<Value>> {
        let op = "listWriteGateReceiptsFor";
        no_nul(
            op,
            &[("targetTable", target_table), ("targetId", target_id)],
        )?;
        if limit < 0 {
            return Err(StoreError::invalid(format!(
                "{op}: limit must not be negative, not {limit}"
            )));
        }
        let read = self.read()?;
        let mut rows = receipts_of(&*read, target_table, target_id)?;
        rows.sort_by_key(|r| std::cmp::Reverse((r.last_seen_at_us, r.id)));
        rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(rows
            .iter()
            .map(|r| {
                json!({
                    "id": r.id,
                    "verdict": r.verdict,
                    "reason_families": r.reason_families,
                    "detector_version": r.detector_version,
                    "tier": r.tier,
                    "created_at": iso(r.created_at_us),
                    "last_seen_at": iso(r.last_seen_at_us),
                })
            })
            .collect())
    }

    /// `deleteStaleWriteGateReceipts`: deletes receipts whose `last_seen_at` is more than
    /// `older_than_days` days before now, except the receipts of a hold still held. Returns how
    /// many it deleted.
    pub fn delete_stale_write_gate_receipts(&self, older_than_days: i64) -> Result<u64> {
        let op = "deleteStaleWriteGateReceipts";
        let days = int4(op, "olderThanDays", older_than_days)?;
        // A retention this long is past the timestamp range SQL accepts; wrapping here would put
        // the cutoff in the future and delete fresh receipts.
        let cutoff = i64::from(days)
            .checked_mul(MICROS_PER_DAY)
            .and_then(|span| self.env.now_micros().checked_sub(span))
            .ok_or_else(|| {
                StoreError::invalid(format!(
                    "{op}: olderThanDays {days} is out of timestamp range"
                ))
            })?;
        self.write(|tx| {
            let mut deleted = 0;
            for r in all_receipts(tx)? {
                if r.last_seen_at_us >= cutoff {
                    continue;
                }
                if r.target_table == "write_gate_holds"
                    && let Some(id) = hold_id_text(&r.target_id)
                    && let Some(hold) = get_json::<HoldRecord>(tx, &by_id(HOLD, id))?
                    && hold.status == "held"
                {
                    continue;
                }
                delete_receipt(tx, &r)?;
                deleted += 1;
            }
            Ok(deleted)
        })
    }

    /// `upsertWriteGateHold`: holds a quarantined fact or take. The same source, slug, fingerprint
    /// and detector version re-opens the existing hold (status held, decision cleared, seen count
    /// up; kind, detector_error and created_at kept). Returns its id.
    pub fn upsert_write_gate_hold(&self, input: HoldInput) -> Result<u64> {
        let op = "upsertWriteGateHold";
        no_nul(
            op,
            &[
                ("kind", input.kind.as_str()),
                ("source_id", input.source_id.as_str()),
                ("slug", input.slug.as_str()),
                ("fingerprint", input.fingerprint.as_str()),
                ("tier", input.tier.as_str()),
                ("request_id", input.request_id.as_deref().unwrap_or("")),
            ],
        )?;
        no_nul_list(op, "reason_families", &input.reason_families)?;
        no_nul_list(op, "reasons", &input.reasons)?;
        json_no_nul(op, "payload", &input.payload)?;
        if let Some(origin) = &input.write_origin {
            json_no_nul(op, "write_origin", origin)?;
        }
        one_of(op, "kind", &input.kind, &KINDS)?;
        let version = int4(op, "detector_version", input.detector_version)?;
        let now = self.env.now_micros();
        let version_text = version.to_string();
        self.write(|tx| {
            let index = tagged(
                HOLD_DEDUPE,
                &[
                    &input.source_id,
                    &input.slug,
                    &input.fingerprint,
                    &version_text,
                ],
            );
            if let Some(id) = read_id(tx, &index)? {
                let key = by_id(HOLD, id);
                let mut h: HoldRecord = get_json(tx, &key)?.ok_or_else(|| {
                    StoreError::new(
                        crate::error::STORE_CORRUPT,
                        "write gate hold index without its row",
                    )
                })?;
                h.status = "held".to_string();
                h.decided_at_us = None;
                h.decided_by = None;
                h.last_seen_at_us = now;
                h.seen_count += 1;
                h.tier.clone_from(&input.tier);
                h.reason_families.clone_from(&input.reason_families);
                h.reasons.clone_from(&input.reasons);
                h.payload.clone_from(&input.payload);
                h.write_origin.clone_from(&input.write_origin);
                if input.request_id.is_some() {
                    h.request_id.clone_from(&input.request_id);
                }
                put_json(tx, &key, &h)?;
                return Ok(id);
            }
            let id = next_id(tx, "write_gate_holds")?;
            let h = HoldRecord {
                id,
                kind: input.kind.clone(),
                source_id: input.source_id.clone(),
                slug: input.slug.clone(),
                fingerprint: input.fingerprint.clone(),
                detector_version: version,
                tier: input.tier.clone(),
                reason_families: input.reason_families.clone(),
                reasons: input.reasons.clone(),
                detector_error: input.detector_error,
                payload: input.payload.clone(),
                write_origin: input.write_origin.clone(),
                request_id: input.request_id.clone(),
                status: "held".to_string(),
                seen_count: 1,
                created_at_us: now,
                last_seen_at_us: now,
                decided_at_us: None,
                decided_by: None,
            };
            put_json(tx, &by_id(HOLD, id), &h)?;
            tx.put(&index, &id.to_be_bytes())?;
            Ok(id)
        })
    }

    /// `listWriteGateHoldRows`: holds matching the filters, highest id first, at most `limit`.
    /// `status` `all` matches every status; `source_ids`, when non-empty, wins over `source_id`.
    pub fn list_write_gate_hold_rows(&self, opts: &HoldListOpts) -> Result<Vec<Value>> {
        let op = "listWriteGateHoldRows";
        no_nul(
            op,
            &[
                ("status", opts.status.as_str()),
                ("kind", opts.kind.as_deref().unwrap_or("")),
                ("sourceId", opts.source_id.as_deref().unwrap_or("")),
            ],
        )?;
        if let Some(ids) = &opts.source_ids {
            no_nul_list(op, "sourceIds", ids)?;
        }
        if opts.limit < 0 {
            return Err(StoreError::invalid(format!(
                "{op}: limit must not be negative, not {}",
                opts.limit
            )));
        }
        let sources: Option<Vec<&str>> = match (&opts.source_ids, &opts.source_id) {
            (Some(ids), _) if !ids.is_empty() => Some(ids.iter().map(String::as_str).collect()),
            (_, Some(id)) if !id.is_empty() => Some(vec![id.as_str()]),
            _ => None,
        };
        let read = self.read()?;
        let mut rows: Vec<HoldRecord> = all_holds(&*read)?
            .into_iter()
            .filter(|h| opts.status == "all" || h.status == opts.status)
            .filter(|h| opts.kind.as_ref().is_none_or(|k| &h.kind == k))
            .filter(|h| {
                sources
                    .as_ref()
                    .is_none_or(|s| s.contains(&h.source_id.as_str()))
            })
            .filter(|h| {
                opts.before_id
                    .is_none_or(|b| i64::try_from(h.id).is_ok_and(|id| id < b))
            })
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.id));
        rows.truncate(usize::try_from(opts.limit).unwrap_or(usize::MAX));
        Ok(rows.iter().map(HoldRecord::to_row).collect())
    }

    /// `getWriteGateHoldRow`: one hold by id, any status.
    pub fn get_write_gate_hold_row(&self, id: i64) -> Result<Option<Value>> {
        let Ok(id) = u64::try_from(id) else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(get_json::<HoldRecord>(&*read, &by_id(HOLD, id))?.map(|h| h.to_row()))
    }

    /// `decideWriteGateHold`: marks a held row released or dropped by `decided_by`; false when it
    /// does not exist or was already decided.
    pub fn decide_write_gate_hold(&self, id: i64, status: &str, decided_by: &str) -> Result<bool> {
        let op = "decideWriteGateHold";
        no_nul(op, &[("status", status), ("decidedBy", decided_by)])?;
        one_of(op, "status", status, &DECIDED)?;
        let Ok(id) = u64::try_from(id) else {
            return Ok(false);
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            let key = by_id(HOLD, id);
            let Some(mut h) = get_json::<HoldRecord>(tx, &key)? else {
                return Ok(false);
            };
            if h.status != "held" {
                return Ok(false);
            }
            h.status = status.to_string();
            h.decided_at_us = Some(now);
            h.decided_by = Some(decided_by.to_string());
            put_json(tx, &key, &h)?;
            Ok(true)
        })
    }
}

/// The `write_gate_holds` rows as the table probe of a fact purge's receipt reads them (`facts/purge_probe.rs`), every source's, in
/// id order.
pub(crate) fn probe_holds(read: &dyn KvRead, f: EachRow) -> Result<()> {
    each_json::<HoldRecord>(read, &[keys::TRUST, HOLD], &mut |_, h| {
        f(ProbeRow {
            source_id: Some(h.source_id.clone()),
            cells: vec![
                ("kind", ProbeCell::text(&h.kind)),
                ("source_id", ProbeCell::text(&h.source_id)),
                ("slug", ProbeCell::text(&h.slug)),
                ("fingerprint", ProbeCell::text(&h.fingerprint)),
                ("payload", ProbeCell::jsonb(&h.payload)),
                (
                    "write_origin",
                    ProbeCell::opt_jsonb(h.write_origin.as_ref()),
                ),
                ("tier", ProbeCell::text(&h.tier)),
                ("reason_families", ProbeCell::text_array(&h.reason_families)),
                ("reasons", ProbeCell::text_array(&h.reasons)),
                ("request_id", ProbeCell::opt_text(h.request_id.as_deref())),
                ("status", ProbeCell::text(&h.status)),
                ("decided_by", ProbeCell::opt_text(h.decided_by.as_deref())),
            ],
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::INVALID_ARGUMENT;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;
    use serde_json::json;

    fn fields(hash: &str, verdict: &str) -> ReceiptFields {
        ReceiptFields {
            content_hash: hash.into(),
            tier: "agent_written".into(),
            detector_version: 1,
            verdict: verdict.into(),
            reason_families: vec!["standing_instruction".into()],
            reasons: vec!["a reason".into()],
            detector_error: false,
            request_id: None,
        }
    }

    fn receipt(table: &str, id: &str, f: ReceiptFields) -> ReceiptInput {
        ReceiptInput {
            target_table: table.into(),
            target_id: id.into(),
            source_id: Some("default".into()),
            content_hash: f.content_hash,
            tier: f.tier,
            detector_version: f.detector_version,
            verdict: f.verdict,
            reason_families: f.reason_families,
            reasons: f.reasons,
            detector_error: f.detector_error,
            request_id: f.request_id,
        }
    }

    fn hold(fingerprint: &str) -> HoldInput {
        HoldInput {
            kind: "fact".into(),
            source_id: "default".into(),
            slug: "people/alice-example".into(),
            fingerprint: fingerprint.into(),
            detector_version: 1,
            tier: "agent_written".into(),
            reason_families: vec!["prompt_injection".into()],
            reasons: vec!["r".into()],
            detector_error: false,
            payload: json!({"fact": "x"}),
            write_origin: None,
            request_id: Some("req-1".into()),
        }
    }

    fn opts(status: &str) -> HoldListOpts {
        HoldListOpts {
            status: status.into(),
            kind: None,
            source_ids: None,
            source_id: None,
            before_id: None,
            limit: 100,
        }
    }

    fn ids(rows: &[Value]) -> Vec<u64> {
        rows.iter().map(|r| r["id"].as_u64().unwrap()).collect()
    }

    fn page(s: &Store, slug: &str) -> String {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        s.put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        let p = crate::pages::read_page(&*s.read().unwrap(), "default", slug)
            .unwrap()
            .unwrap();
        p.id.to_string()
    }

    #[test]
    fn a_source_delete_drops_its_holds_their_dedupe_entries_and_receipts_only() {
        let s = store();
        let doomed = s.upsert_write_gate_hold(hold("fp-1")).unwrap();
        let other = s
            .upsert_write_gate_hold(HoldInput {
                source_id: "kept".into(),
                ..hold("fp-1")
            })
            .unwrap();
        let id = doomed.to_string();
        let kept_id = other.to_string();
        s.upsert_write_gate_receipt(receipt("write_gate_holds", &id, fields("h1", "flag")))
            .unwrap();
        s.upsert_write_gate_receipt(receipt("write_gate_holds", &kept_id, fields("h1", "flag")))
            .unwrap();
        s.upsert_write_gate_receipt(receipt("facts", &id, fields("h1", "flag")))
            .unwrap();

        s.write(|tx| remove_source_holds(tx, "default")).unwrap();

        assert_eq!(
            ids(&s.list_write_gate_hold_rows(&opts("held")).unwrap()),
            vec![other]
        );
        let read = s.read().unwrap();
        assert!(
            receipts_of(&*read, "write_gate_holds", &id)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            receipts_of(&*read, "write_gate_holds", &kept_id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(receipts_of(&*read, "facts", &id).unwrap().len(), 1);
        drop(read);
        // The dedupe entry went with the hold: the same key opens a new hold.
        assert_ne!(s.upsert_write_gate_hold(hold("fp-1")).unwrap(), doomed);
    }

    #[test]
    fn a_receipt_with_the_same_key_is_refreshed_and_listed_first() {
        let s = store();
        let a = s
            .upsert_write_gate_receipt(receipt("facts", "7", fields("h1", "flag")))
            .unwrap();
        let b = s
            .upsert_write_gate_receipt(receipt("facts", "7", fields("h2", "flag")))
            .unwrap();
        let mut f = fields("h1", "quarantine");
        f.request_id = Some("req".into());
        let again = s
            .upsert_write_gate_receipt(receipt("facts", "7", f))
            .unwrap();
        assert_eq!(again, a);
        assert_ne!(a, b);
        let rows = s.list_write_gate_receipts_for("facts", "7", 10).unwrap();
        assert_eq!(ids(&rows), vec![a, b]);
        assert_eq!(rows[0]["verdict"], "quarantine");
        assert_eq!(
            ids(&s.list_write_gate_receipts_for("facts", "7", 1).unwrap()),
            vec![a]
        );
        assert!(
            s.list_write_gate_receipts_for("takes", "7", 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn page_receipts_need_a_live_page_and_stale_ones_are_cleared() {
        let s = store();
        let id = page(&s, "notes/a");
        let h1 = s
            .upsert_page_write_gate_receipt("default", "notes/a", fields("h1", "flag"))
            .unwrap()
            .unwrap();
        let h2 = s
            .upsert_page_write_gate_receipt("default", "notes/a", fields("h2", "flag"))
            .unwrap()
            .unwrap();
        assert_eq!(
            s.upsert_page_write_gate_receipt("default", "notes/none", fields("h1", "flag"))
                .unwrap(),
            None
        );
        s.delete_stale_page_write_gate_receipts("default", "notes/a", Some("h2"))
            .unwrap();
        let rows = s.list_write_gate_receipts_for("pages", &id, 10).unwrap();
        assert_eq!(ids(&rows), vec![h2]);
        assert_ne!(h1, h2);
        s.soft_delete_page("notes/a", Some("default")).unwrap();
        assert_eq!(
            s.upsert_page_write_gate_receipt("default", "notes/a", fields("h3", "flag"))
                .unwrap(),
            None
        );
        s.delete_stale_page_write_gate_receipts("default", "notes/a", None)
            .unwrap();
        assert!(
            s.list_write_gate_receipts_for("pages", &id, 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn pruning_keeps_the_receipts_of_held_holds() {
        let s = store();
        let held = s.upsert_write_gate_hold(hold("fp-1")).unwrap();
        let dropped = s.upsert_write_gate_hold(hold("fp-2")).unwrap();
        assert!(
            s.decide_write_gate_hold(dropped as i64, "dropped", "owner")
                .unwrap()
        );
        for (table, id) in [
            ("facts", "1".to_string()),
            ("write_gate_holds", held.to_string()),
            ("write_gate_holds", dropped.to_string()),
        ] {
            s.upsert_write_gate_receipt(receipt(table, &id, fields("h", "flag")))
                .unwrap();
        }
        assert_eq!(s.delete_stale_write_gate_receipts(36500).unwrap(), 0);
        assert_eq!(s.delete_stale_write_gate_receipts(-1).unwrap(), 2);
        let left = s
            .list_write_gate_receipts_for("write_gate_holds", &held.to_string(), 10)
            .unwrap();
        assert_eq!(left.len(), 1);
        // The kept receipt is still found by its key: refreshing it keeps its id.
        let again = s
            .upsert_write_gate_receipt(receipt(
                "write_gate_holds",
                &held.to_string(),
                fields("h", "flag"),
            ))
            .unwrap();
        assert_eq!(ids(&left), vec![again]);
        assert_eq!(s.delete_stale_write_gate_receipts(-1).unwrap(), 0);
    }

    #[test]
    fn a_retention_past_the_timestamp_range_refuses_and_keeps_every_receipt() {
        let s = store();
        s.upsert_write_gate_receipt(receipt("facts", "1", fields("h", "flag")))
            .unwrap();
        let err = s
            .delete_stale_write_gate_receipts(i64::from(i32::MAX))
            .unwrap_err();
        assert_eq!(err.code, crate::error::INVALID_ARGUMENT);
        assert_eq!(
            s.list_write_gate_receipts_for("facts", "1", 10)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_hold_with_the_same_key_reopens_and_keeps_its_kind() {
        let s = store();
        let a = s.upsert_write_gate_hold(hold("fp-1")).unwrap();
        assert!(
            s.decide_write_gate_hold(a as i64, "released", "owner")
                .unwrap()
        );
        assert!(
            !s.decide_write_gate_hold(a as i64, "dropped", "owner")
                .unwrap()
        );
        assert!(!s.decide_write_gate_hold(999, "dropped", "owner").unwrap());
        let released = s.get_write_gate_hold_row(a as i64).unwrap().unwrap();
        assert_eq!(released["status"], "released");
        assert_eq!(released["decided_by"], "owner");
        assert!(released["decided_at"].is_string());
        let mut again = hold("fp-1");
        again.kind = "take".into();
        again.tier = "external_untrusted".into();
        again.request_id = None;
        assert_eq!(s.upsert_write_gate_hold(again).unwrap(), a);
        let row = s.get_write_gate_hold_row(a as i64).unwrap().unwrap();
        assert_eq!(row["status"], "held");
        assert_eq!(row["kind"], "fact");
        assert_eq!(row["tier"], "external_untrusted");
        assert_eq!(row["request_id"], "req-1");
        assert_eq!(row["seen_count"], 2);
        assert!(row["decided_at"].is_null() && row["decided_by"].is_null());
        assert!(s.get_write_gate_hold_row(999).unwrap().is_none());
    }

    #[test]
    fn hold_listing_filters_and_orders_by_id_descending() {
        let s = store();
        let a = s.upsert_write_gate_hold(hold("fp-1")).unwrap();
        let mut take = hold("fp-2");
        take.kind = "take".into();
        let b = s.upsert_write_gate_hold(take).unwrap();
        let mut work = hold("fp-3");
        work.source_id = "work".into();
        let c = s.upsert_write_gate_hold(work).unwrap();
        s.decide_write_gate_hold(b as i64, "dropped", "agent")
            .unwrap();
        assert_eq!(
            ids(&s.list_write_gate_hold_rows(&opts("all")).unwrap()),
            vec![c, b, a]
        );
        assert_eq!(
            ids(&s.list_write_gate_hold_rows(&opts("held")).unwrap()),
            vec![c, a]
        );
        let mut o = opts("all");
        o.kind = Some("take".into());
        assert_eq!(ids(&s.list_write_gate_hold_rows(&o).unwrap()), vec![b]);
        let mut o = opts("all");
        o.source_ids = Some(vec!["default".into()]);
        o.source_id = Some("work".into());
        assert_eq!(ids(&s.list_write_gate_hold_rows(&o).unwrap()), vec![b, a]);
        let mut o = opts("all");
        o.source_id = Some("work".into());
        assert_eq!(ids(&s.list_write_gate_hold_rows(&o).unwrap()), vec![c]);
        let mut o = opts("all");
        o.before_id = Some(c as i64);
        o.limit = 1;
        assert_eq!(ids(&s.list_write_gate_hold_rows(&o).unwrap()), vec![b]);
    }

    #[test]
    fn values_the_table_checks_refuse_are_invalid_arguments() {
        let s = store();
        let e = s
            .upsert_write_gate_receipt(receipt("facts", "1", fields("h", "allow")))
            .unwrap_err();
        assert_eq!(e.code, INVALID_ARGUMENT);
        let e = s
            .upsert_write_gate_receipt(receipt("chunks", "1", fields("h", "flag")))
            .unwrap_err();
        assert_eq!(e.code, INVALID_ARGUMENT);
        let mut bad = hold("fp");
        bad.kind = "page".into();
        assert_eq!(
            s.upsert_write_gate_hold(bad).unwrap_err().code,
            INVALID_ARGUMENT
        );
        assert_eq!(
            s.decide_write_gate_hold(1, "held", "owner")
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
        let mut o = opts("all");
        o.limit = -1;
        assert_eq!(
            s.list_write_gate_hold_rows(&o).unwrap_err().code,
            INVALID_ARGUMENT
        );
    }
}
