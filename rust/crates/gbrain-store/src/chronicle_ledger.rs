//! The chronicle ledger: the `chronicle_page_state` and `chronicle_judge_reservations` tables of the PGLite engine, as
//! the members of `src/core/engine-sql/collate-store-reads.ts` run them (rust/docs/store/chronicle-ledger.md).
//!
//! Members: upsertChronicleRow, reserveChronicleJudgeSlot, pruneChronicleReservations, readChronicleLedger, and the
//! `chronicleStore()` executor statements (`executor.rs`).
//!
//! Keys (every record starts with `keys::TELEMETRY`, `a`):
//! - `a 0x0E source \0 page_id BE8 hash \0 version BE4 -> LedgerRecord`: one row of `chronicle_page_state`, its
//!   primary key in byte order.
//! - `a 0x0F id BE8 -> ReservationRecord`: one judge reservation, its id the `BIGSERIAL`.
//! - `a 0x10 -> last id` (JSON integer): the reservation id sequence.
//!
//! The campaign, claim, retry and outcome writers of the ledger (`campaign.ts`, `execute.ts`) are the executor
//! statements of `executor.rs`. The shadow seed copies `chronicle_page_state` rows as they are (`seeded.rs`).

use crate::error::{Result, StoreError};

mod executor;
mod seeded;
use crate::kv::scan_prefix;
use crate::{Store, get_json, keys, put_json};
pub use executor::{
    ChronicleCampaignQueue, ChronicleCandidates, ChronicleDiscovery, ChronicleFinish,
    ChronicleKeyTuple,
};
pub(crate) use seeded::{SeededLedgerRow, remove_ledger_row, seed_ledger_row};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const OP_UPSERT: &str = "upsertChronicleRow";
const OP_RESERVE: &str = "reserveChronicleJudgeSlot";
const HOUR_US: i64 = 3_600_000_000;
const DAY_US: i64 = 24 * HOUR_US;

fn row_prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_CHRONICLE_ROW]
}

fn reservation_prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_CHRONICLE_RESERVATION]
}

fn sequence_key() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_CHRONICLE_SEQUENCE]
}

/// `a 0x0E source \0 page_id BE8 `: every row of one page.
fn page_prefix(source_id: &str, page_id: i64) -> Vec<u8> {
    let mut k = row_prefix().to_vec();
    k.extend_from_slice(source_id.as_bytes());
    k.push(0);
    k.extend_from_slice(&(page_id as u64).to_be_bytes());
    k
}

fn row_key(source_id: &str, page_id: i64, content_hash: &str, version: i32) -> Vec<u8> {
    let mut k = page_prefix(source_id, page_id);
    k.extend_from_slice(content_hash.as_bytes());
    k.push(0);
    k.extend_from_slice(&(version as u32).to_be_bytes());
    k
}

/// The backfill batch's `done` (`engine-sql/chronicle-reads.ts`, `chronicle_reads.rs`): the page's row at its
/// content hash and extractor version is extracted, or is a pending or failed backfill row with attempts left.
pub(crate) fn backfill_done(
    read: &dyn crate::kv::KvRead,
    source_id: &str,
    page_id: i64,
    content_hash: &str,
    version: i32,
    max_attempts: i32,
) -> Result<bool> {
    let Some(r) =
        get_json::<LedgerRecord>(read, &row_key(source_id, page_id, content_hash, version))?
    else {
        return Ok(false);
    };
    Ok(r.state == "extracted"
        || (matches!(r.state.as_str(), "pending" | "failed")
            && r.trigger == "backfill"
            && r.attempts < max_attempts))
}

/// One `chronicle_page_state` row; the times are microseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LedgerRecord {
    content_hash: String,
    slug: String,
    state: String,
    reason: Option<String>,
    trigger: String,
    principal_kind: Option<String>,
    principal_id: Option<String>,
    request_id: Option<String>,
    no_extract: bool,
    next_attempt_at: Option<String>,
    cost_usd: Option<f64>,
    unpriced: bool,
    attempts: i32,
    decided_at: i64,
    updated_at: i64,
    #[serde(default)]
    event_slugs: Vec<String>,
    #[serde(default)]
    event_hashes: Vec<String>,
    #[serde(default)]
    cost_attempts: Vec<i32>,
    #[serde(default)]
    judge_input_hash: Option<String>,
    #[serde(default)]
    judge_window_chars: Option<i32>,
    #[serde(default)]
    judge_window_hash: Option<String>,
    #[serde(default)]
    judge_input_failures: i32,
    #[serde(default)]
    campaign_id: Option<String>,
    #[serde(default)]
    attempt_cap_usd: Option<String>,
    #[serde(default)]
    max_attempts: Option<i32>,
    #[serde(default)]
    pricing_policy: Option<String>,
    #[serde(default)]
    campaign_max_usd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReservationRecord {
    source_id: String,
    page_id: i64,
    content_hash: String,
    reserved_at: i64,
}

/// The row of `upsertChronicleRow`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleRowInput {
    pub source_id: String,
    pub page_id: i64,
    pub content_hash: String,
    pub extractor_version: i32,
    pub slug: String,
    pub state: String,
    #[serde(default)]
    pub reason: Option<String>,
    pub trigger: String,
    #[serde(default)]
    pub principal_kind: Option<String>,
    #[serde(default)]
    pub principal_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub no_extract: bool,
    #[serde(default)]
    pub next_attempt_at: Option<String>,
}

/// The page of `reserveChronicleJudgeSlot`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleJudgeKey {
    pub source_id: String,
    pub page_id: i64,
    pub content_hash: String,
}

fn no_nul(op: &str, fields: &[(&str, Option<&str>)]) -> Result<()> {
    for (name, v) in fields {
        if v.is_some_and(|t| t.contains('\0')) {
            return Err(StoreError::invalid(format!(
                "{op}: {name} contains a NUL character"
            )));
        }
    }
    Ok(())
}

fn decode<T: for<'de> Deserialize<'de>>(v: &[u8], what: &str) -> Result<T> {
    serde_json::from_slice(v).map_err(|e| StoreError::invalid(format!("unreadable {what}: {e}")))
}

fn scan<T: for<'de> Deserialize<'de>>(
    read: &dyn crate::kv::KvRead,
    prefix: &[u8],
    what: &str,
) -> Result<Vec<T>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        prefix,
        false,
        &mut |_, v| match decode::<T>(v, what) {
            Ok(r) => {
                out.push(r);
                true
            }
            Err(e) => {
                bad = Some(e);
                false
            }
        },
    )?;
    match bad {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

impl Store {
    /// The upsert of `upsertChronicleRow(w)` without its foreign-key checks (`Store::upsert_chronicle_row`, in
    /// chronicle_state.rs, checks the row's source and page first): inserts the row, or replaces the decision columns of
    /// the row at the same key and stamps it now. Returns false when a guard leaves the old row alone: an automatic
    /// decision never overwrites a pending or failed backfill row, and an extracted row yields only to a different
    /// generation of the page that was extracted after it.
    pub(crate) fn upsert_chronicle_row_unchecked(&self, w: &ChronicleRowInput) -> Result<bool> {
        no_nul(
            OP_UPSERT,
            &[
                ("sourceId", Some(&w.source_id)),
                ("contentHash", Some(&w.content_hash)),
                ("slug", Some(&w.slug)),
                ("reason", w.reason.as_deref()),
                ("principalKind", w.principal_kind.as_deref()),
                ("principalId", w.principal_id.as_deref()),
            ],
        )?;
        if !matches!(
            w.state.as_str(),
            "pending" | "skipped" | "extracted" | "failed"
        ) {
            return Err(StoreError::invalid(format!(
                "{OP_UPSERT}: state must be pending, skipped, extracted or failed"
            )));
        }
        if !matches!(w.trigger.as_str(), "auto" | "backfill") {
            return Err(StoreError::invalid(format!(
                "{OP_UPSERT}: trigger must be auto or backfill"
            )));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let key = row_key(
                &w.source_id,
                w.page_id,
                &w.content_hash,
                w.extractor_version,
            );
            let old: Option<LedgerRecord> = get_json(&*tx, &key)?;
            let record = match old {
                None => LedgerRecord {
                    content_hash: w.content_hash.clone(),
                    slug: w.slug.clone(),
                    state: w.state.clone(),
                    reason: w.reason.clone(),
                    trigger: w.trigger.clone(),
                    principal_kind: w.principal_kind.clone(),
                    principal_id: w.principal_id.clone(),
                    request_id: w.request_id.clone(),
                    no_extract: w.no_extract,
                    next_attempt_at: w.next_attempt_at.clone(),
                    cost_usd: None,
                    unpriced: false,
                    attempts: 0,
                    decided_at: now,
                    updated_at: now,
                    event_slugs: Vec::new(),
                    event_hashes: Vec::new(),
                    cost_attempts: Vec::new(),
                    judge_input_hash: None,
                    judge_window_chars: None,
                    judge_window_hash: None,
                    judge_input_failures: 0,
                    campaign_id: None,
                    attempt_cap_usd: None,
                    max_attempts: None,
                    pricing_policy: None,
                    campaign_max_usd: None,
                },
                Some(mut c) => {
                    let guarded = w.trigger == "auto"
                        && c.trigger == "backfill"
                        && matches!(c.state.as_str(), "pending" | "failed");
                    if guarded {
                        return Ok(false);
                    }
                    if c.state == "extracted" {
                        let siblings: Vec<LedgerRecord> =
                            scan(&*tx, &page_prefix(&w.source_id, w.page_id), "chronicle row")?;
                        let newer = siblings.iter().any(|n| {
                            n.content_hash != c.content_hash
                                && n.state == "extracted"
                                && n.updated_at > c.updated_at
                        });
                        if !newer {
                            return Ok(false);
                        }
                    }
                    c.slug = w.slug.clone();
                    c.state = w.state.clone();
                    c.reason = w.reason.clone();
                    c.trigger = w.trigger.clone();
                    c.principal_kind = w.principal_kind.clone();
                    c.principal_id = w.principal_id.clone();
                    c.request_id = w.request_id.clone();
                    c.no_extract = w.no_extract;
                    c.next_attempt_at = w.next_attempt_at.clone();
                    c.decided_at = now;
                    c.updated_at = now;
                    c.campaign_id = None;
                    c.attempt_cap_usd = None;
                    c.max_attempts = None;
                    c.pricing_policy = None;
                    c.campaign_max_usd = None;
                    c
                }
            };
            put_json(tx, &key, &record)?;
            Ok(true)
        })
    }

    /// `reserveChronicleJudgeSlot(limit, key)`: takes one reservation stamped now when fewer than `limit` were taken
    /// in the last 24 hours; false otherwise. The write transaction is the advisory lock of the SQL statements.
    pub fn reserve_chronicle_judge_slot(
        &self,
        limit: i64,
        key: &ChronicleJudgeKey,
    ) -> Result<bool> {
        no_nul(
            OP_RESERVE,
            &[
                ("sourceId", Some(&key.source_id)),
                ("contentHash", Some(&key.content_hash)),
            ],
        )?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let taken =
                scan::<ReservationRecord>(&*tx, &reservation_prefix(), "chronicle reservation")?
                    .iter()
                    .filter(|r| r.reserved_at > now - DAY_US)
                    .count() as i64;
            if taken >= limit {
                return Ok(false);
            }
            let last = get_json::<i64>(&*tx, &sequence_key())?.unwrap_or(0) + 1;
            let mut k = reservation_prefix().to_vec();
            k.extend_from_slice(&(last as u64).to_be_bytes());
            put_json(
                tx,
                &k,
                &ReservationRecord {
                    source_id: key.source_id.clone(),
                    page_id: key.page_id,
                    content_hash: key.content_hash.clone(),
                    reserved_at: now,
                },
            )?;
            put_json(tx, &sequence_key(), &last)?;
            Ok(true)
        })
    }

    /// `pruneChronicleReservations()`: deletes the reservations taken more than 48 hours ago (`reserved_at < now() -
    /// interval '48 hours'`) in one write transaction and answers how many it deleted; the sequence keeps its value.
    pub fn prune_chronicle_reservations(&self) -> Result<i64> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut old: Vec<Vec<u8>> = Vec::new();
            let mut bad = None;
            scan_prefix(
                &*tx,
                &reservation_prefix(),
                false,
                &mut |k, v| match decode::<ReservationRecord>(v, "chronicle reservation") {
                    Ok(r) => {
                        if r.reserved_at < now - 2 * DAY_US {
                            old.push(k.to_vec());
                        }
                        true
                    }
                    Err(e) => {
                        bad = Some(e);
                        false
                    }
                },
            )?;
            if let Some(e) = bad {
                return Err(e);
            }
            for k in &old {
                tx.delete(k)?;
            }
            Ok(old.len() as i64)
        })
    }

    /// `hasChronicleSkipDecision(sourceId, pageId, contentHash, extractorVersion, reason)`: the ledger row of that page
    /// revision is `skipped` with that reason (`engine-sql/chronicle-events.ts` hasChronicleSkipDecision).
    pub fn has_chronicle_skip_decision(
        &self,
        source_id: &str,
        page_id: i64,
        content_hash: &str,
        extractor_version: i32,
        reason: &str,
    ) -> Result<bool> {
        let read = self.read()?;
        let row: Option<LedgerRecord> = get_json(
            &*read,
            &row_key(source_id, page_id, content_hash, extractor_version),
        )?;
        Ok(row.is_some_and(|r| r.state == "skipped" && r.reason.as_deref() == Some(reason)))
    }

    /// `readChronicleLedger()`: `{ counts, reasons, calls, principals }` over the automatic rows, as
    /// `src/core/chronicle/ledger-stats.ts` reads them: counts (the last 7 days, except pending), skip and failure
    /// reasons by count then byte of reason, the 24-hour reservations, and the five busiest principals by calls then
    /// byte of principal.
    pub fn read_chronicle_ledger(&self) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let week = now - 7 * DAY_US;
        let day = now - DAY_US;
        let rows: Vec<(Vec<u8>, LedgerRecord)> = {
            let mut out = Vec::new();
            let mut bad = None;
            scan_prefix(
                &*read,
                &row_prefix(),
                false,
                &mut |k, v| match decode::<LedgerRecord>(v, "chronicle row") {
                    Ok(r) => {
                        out.push((k.to_vec(), r));
                        true
                    }
                    Err(e) => {
                        bad = Some(e);
                        false
                    }
                },
            )?;
            if let Some(e) = bad {
                return Err(e);
            }
            out
        };
        let auto: Vec<&LedgerRecord> = rows
            .iter()
            .map(|(_, r)| r)
            .filter(|r| r.trigger == "auto")
            .collect();
        let recent = |r: &&LedgerRecord| r.updated_at > week;
        let count_state = |state: &str| {
            auto.iter()
                .filter(|r| r.state == state && recent(r))
                .count()
        };
        let priced: Vec<f64> = auto
            .iter()
            .filter(|r| !r.unpriced && recent(r))
            .filter_map(|r| r.cost_usd)
            .collect();
        let settled = |r: &&&LedgerRecord| matches!(r.state.as_str(), "extracted" | "failed");
        let counts = json!({
            "pending": auto.iter().filter(|r| r.state == "pending").count(),
            "extracted": count_state("extracted"),
            "failed": count_state("failed"),
            "skipped": count_state("skipped"),
            "known_usd": if priced.is_empty() { Value::Null } else { json!(priced.iter().sum::<f64>()) },
            "unpriced": auto.iter().filter(|r| r.unpriced && recent(r)).filter(settled).count(),
            "incomplete": auto
                .iter()
                .filter(|r| !r.unpriced && r.cost_usd.is_none() && r.attempts > 0 && recent(r))
                .filter(settled)
                .count(),
        });

        let mut tallies: BTreeMap<(String, String), i64> = BTreeMap::new();
        for r in auto
            .iter()
            .filter(|r| matches!(r.state.as_str(), "skipped" | "failed") && recent(r))
        {
            if let Some(reason) = &r.reason {
                *tallies
                    .entry((r.state.clone(), reason.clone()))
                    .or_insert(0) += 1;
            }
        }
        let mut reasons: Vec<((String, String), i64)> = tallies.into_iter().collect();
        reasons.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| a.0.1.cmp(&b.0.1))
                .then_with(|| a.0.0.cmp(&b.0.0))
        });

        let reservations: Vec<ReservationRecord> =
            scan(&*read, &reservation_prefix(), "chronicle reservation")?
                .into_iter()
                .filter(|r: &ReservationRecord| r.reserved_at > day)
                .collect();
        let mut calls: BTreeMap<String, i64> = BTreeMap::new();
        for r in &reservations {
            let mut page = page_prefix(&r.source_id, r.page_id);
            page.extend_from_slice(r.content_hash.as_bytes());
            page.push(0);
            let mut joined = false;
            for (_, l) in rows.iter().filter(|(k, l)| {
                k.starts_with(&page) && l.trigger == "auto" && l.content_hash == r.content_hash
            }) {
                joined = true;
                *calls.entry(principal(l)).or_insert(0) += 1;
            }
            if !joined {
                *calls.entry("unattributed".to_string()).or_insert(0) += 1;
            }
        }
        let mut principals: Vec<(String, i64)> = calls.into_iter().collect();
        principals.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        principals.truncate(5);

        Ok(json!({
            "counts": counts,
            "reasons": reasons
                .into_iter()
                .map(|((state, reason), n)| json!({ "state": state, "reason": reason, "n": n }))
                .collect::<Vec<_>>(),
            "calls": reservations.len(),
            "principals": principals
                .into_iter()
                .map(|(principal, calls)| json!({ "principal": principal, "calls": calls }))
                .collect::<Vec<_>>(),
        }))
    }
}

/// `coalesce(principal_kind, 'unattributed') || coalesce(':' || principal_id, '')`.
fn principal(l: &LedgerRecord) -> String {
    format!(
        "{}{}",
        l.principal_kind.as_deref().unwrap_or("unattributed"),
        l.principal_id
            .as_deref()
            .map(|id| format!(":{id}"))
            .unwrap_or_default()
    )
}
