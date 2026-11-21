//! The `decision_receipts` table of the decide store: one row per decision, written in batches,
//! read only as aggregates, pruned by age.
//!
//! Keys (see the parent module for the family's sub-tags):
//! - `Z 0x13 <id u64 BE>` -> `ReceiptRecord` (JSON): one row; ids come from `M decide_receipt_id`
//!   and count up from 1, so id order is insertion order (the order Postgres reads a heap in).
//! - `Z 0x14 <created_at u64 BE><id u64 BE>` -> empty: the time index. Windows read it from the
//!   window's start; the prune reads it up to the cutoff.
//!
//! `REAL` columns are kept as the bit pattern of the `f32` Postgres would store, and read back
//! as the number Postgres prints for it (`f32` text, parsed as `f64`), which is what the
//! TypeScript engines hand their callers.

use super::{int4, prune_spend_before};
use crate::error::{Result, StoreError};
use crate::eval_capture::not_null;
use crate::kv::{KvRead, prefix_end};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

const RECEIPT: u8 = 0x13;
const RECEIPT_BY_TIME: u8 = 0x14;
const RECEIPT_ID: &str = "decide_receipt_id";
const HOUR_US: i64 = 3_600_000_000;
const DAY_US: i64 = 24 * HOUR_US;
/// `timestamptz` starts at 4713 BC; a window that reaches before it (or past the end) is
/// Postgres's "timestamp out of range".
const MIN_TIMESTAMP_US: i64 = -210_866_803_200_000_000;
/// `timestamptz` ends at 294276 AD, about this many microseconds after the epoch.
const MAX_TIMESTAMP_US: i64 = 9_223_371_331_200_000_000;
/// Spend rows outlive receipts: they are pruned no sooner than this many days.
const MIN_SPEND_RETENTION_DAYS: i64 = 31;
/// The outcomes a replay reads back.
const REPLAY_OUTCOMES: [&str; 7] = [
    "kept",
    "pruned",
    "margin_hold",
    "pass",
    "reject",
    "quarantine",
    "insufficient_context",
];

fn receipt_key(id: u64) -> Vec<u8> {
    let mut out = vec![keys::EVAL_CAPTURE, RECEIPT];
    out.extend_from_slice(&id.to_be_bytes());
    out
}

fn time_key(created_at_us: i64, id: u64) -> Vec<u8> {
    let mut out = vec![keys::EVAL_CAPTURE, RECEIPT_BY_TIME];
    out.extend_from_slice(&(created_at_us.max(0) as u64).to_be_bytes());
    out.extend_from_slice(&id.to_be_bytes());
    out
}

/// One `decision_receipts` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReceiptRecord {
    id: u64,
    created_at_us: i64,
    decision_id: String,
    source_id: Option<String>,
    slot: String,
    mode: String,
    provider: String,
    model_alias: Option<String>,
    model_resolved: Option<String>,
    question_kind: Option<String>,
    state_hash: Option<String>,
    question_hash: Option<String>,
    /// `REAL`, as `f32::to_bits`.
    answer_value: Option<u32>,
    answer_choice: Option<String>,
    confidence: Option<u32>,
    threshold: Option<u32>,
    outcome: String,
    subject_ref: Option<String>,
    call_site: String,
    lane: String,
    policy_fingerprint: Option<String>,
    calibration_ref: Option<String>,
    latency_ms: Option<i32>,
    input_tokens: Option<i32>,
    error_reason: Option<String>,
    protected: bool,
    min_keep: Option<i32>,
    rank: Option<i32>,
    k_used: Option<i32>,
    remote: bool,
    run_meta: Option<String>,
}

/// A `REAL` value as Postgres prints it, which is what a caller reads.
pub(super) fn real_value(bits: u32) -> f64 {
    f32::from_bits(bits)
        .to_string()
        .parse::<f64>()
        .expect("an f32 prints as a number")
}

/// `bits` widened to `f64` the way `AVG(real)` adds it.
fn real_widened(bits: u32) -> f64 {
    f64::from(f32::from_bits(bits))
}

/// A `REAL` column: the `f32` Postgres makes of the number's text. Null is the caller's to
/// judge; a string, or a number `real` cannot hold (too large, or so small it rounds to zero),
/// is `invalid_argument`.
pub(super) fn real4(value: &Option<Value>, member: &str, column: &str) -> Result<Option<u32>> {
    let refused =
        || StoreError::invalid(format!("{member}: {column} is out of range for type real"));
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => {
            let parsed: f32 = n.to_string().parse().map_err(|_| refused())?;
            let was_zero = n.as_f64() == Some(0.0);
            if !parsed.is_finite() || (parsed == 0.0 && !was_zero) {
                return Err(refused());
            }
            Ok(Some(parsed.to_bits()))
        }
        Some(other) => Err(StoreError::invalid(format!(
            "{member}: {column} must be a number, got {other}"
        ))),
    }
}

pub(super) fn opt_int4(value: &Option<Value>, member: &str, column: &str) -> Result<Option<i32>> {
    match value {
        None => Ok(None),
        Some(v) => int4(v, member, column),
    }
}

/// One row of `insertDecideReceipts`. Every column is optional here so a missing one fails as
/// Postgres fails it (see `DecideSpendInput`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DecideReceiptInput {
    pub decision_id: Option<String>,
    pub source_id: Option<String>,
    pub slot: Option<String>,
    pub mode: Option<String>,
    pub provider: Option<String>,
    pub model_alias: Option<String>,
    pub model_resolved: Option<String>,
    pub question_kind: Option<String>,
    pub state_hash: Option<String>,
    pub question_hash: Option<String>,
    pub answer_value: Option<Value>,
    pub answer_choice: Option<String>,
    pub confidence: Option<Value>,
    pub threshold: Option<Value>,
    pub outcome: Option<String>,
    pub subject_ref: Option<String>,
    pub call_site: Option<String>,
    pub lane: Option<String>,
    pub policy_fingerprint: Option<String>,
    pub calibration_ref: Option<String>,
    pub latency_ms: Option<Value>,
    pub input_tokens: Option<Value>,
    pub error_reason: Option<String>,
    pub protected: Option<bool>,
    pub min_keep: Option<Value>,
    pub rank: Option<Value>,
    pub k_used: Option<Value>,
    pub remote: Option<bool>,
    pub run_meta: Option<String>,
}

impl DecideReceiptInput {
    /// The row to keep (its id is set when it is written), or the refusal Postgres would give.
    fn validate(&self, created_at_us: i64) -> Result<ReceiptRecord> {
        const TABLE: &str = "decision_receipts";
        const MEMBER: &str = "insertDecideReceipts";
        let mut texts: Vec<(&str, &str)> = Vec::new();
        for (name, value) in [
            ("decision_id", &self.decision_id),
            ("source_id", &self.source_id),
            ("slot", &self.slot),
            ("mode", &self.mode),
            ("provider", &self.provider),
            ("model_alias", &self.model_alias),
            ("model_resolved", &self.model_resolved),
            ("question_kind", &self.question_kind),
            ("state_hash", &self.state_hash),
            ("question_hash", &self.question_hash),
            ("answer_choice", &self.answer_choice),
            ("outcome", &self.outcome),
            ("subject_ref", &self.subject_ref),
            ("call_site", &self.call_site),
            ("lane", &self.lane),
            ("policy_fingerprint", &self.policy_fingerprint),
            ("calibration_ref", &self.calibration_ref),
            ("error_reason", &self.error_reason),
            ("run_meta", &self.run_meta),
        ] {
            if let Some(text) = value.as_deref() {
                texts.push((name, text));
            }
        }
        no_nul(MEMBER, &texts)?;
        let answer_value = real4(&self.answer_value, MEMBER, "answer_value")?;
        let confidence = real4(&self.confidence, MEMBER, "confidence")?;
        let threshold = real4(&self.threshold, MEMBER, "threshold")?;
        let latency_ms = opt_int4(&self.latency_ms, MEMBER, "latency_ms")?;
        let input_tokens = opt_int4(&self.input_tokens, MEMBER, "input_tokens")?;
        let min_keep = opt_int4(&self.min_keep, MEMBER, "min_keep")?;
        let rank = opt_int4(&self.rank, MEMBER, "rank")?;
        let k_used = opt_int4(&self.k_used, MEMBER, "k_used")?;
        let required = |value: &Option<String>, column: &str| -> Result<String> {
            value.clone().ok_or_else(|| not_null(TABLE, column))
        };
        Ok(ReceiptRecord {
            id: 0,
            created_at_us,
            decision_id: required(&self.decision_id, "decision_id")?,
            source_id: self.source_id.clone(),
            slot: required(&self.slot, "slot")?,
            mode: required(&self.mode, "mode")?,
            provider: required(&self.provider, "provider")?,
            model_alias: self.model_alias.clone(),
            model_resolved: self.model_resolved.clone(),
            question_kind: self.question_kind.clone(),
            state_hash: self.state_hash.clone(),
            question_hash: self.question_hash.clone(),
            answer_value,
            answer_choice: self.answer_choice.clone(),
            confidence,
            threshold,
            outcome: required(&self.outcome, "outcome")?,
            subject_ref: self.subject_ref.clone(),
            call_site: required(&self.call_site, "call_site")?,
            lane: required(&self.lane, "lane")?,
            policy_fingerprint: self.policy_fingerprint.clone(),
            calibration_ref: self.calibration_ref.clone(),
            latency_ms,
            input_tokens,
            error_reason: self.error_reason.clone(),
            protected: self.protected.ok_or_else(|| not_null(TABLE, "protected"))?,
            min_keep,
            rank,
            k_used,
            remote: self.remote.ok_or_else(|| not_null(TABLE, "remote"))?,
            run_meta: self.run_meta.clone(),
        })
    }
}

/// A whole number of hours or days: `$1::int` in the SQL, so a fraction or a number outside
/// `int4` is refused before any row is read.
fn whole(value: f64, member: &str, what: &str) -> Result<i64> {
    if !value.is_finite()
        || value.fract() != 0.0
        || value < f64::from(i32::MIN)
        || value > f64::from(i32::MAX)
    {
        return Err(StoreError::invalid(format!(
            "{member}: {what} must be an integer in the int4 range, got {value}"
        )));
    }
    // Whole and in range, so the cast is exact.
    Ok(value as i64)
}

/// `now() - (n * interval)`, or the refusal for a time before the first `timestamptz`.
fn ago(now: i64, n: i64, unit_us: i64, member: &str) -> Result<i64> {
    let at = i128::from(now) - i128::from(n) * i128::from(unit_us);
    if at < i128::from(MIN_TIMESTAMP_US) || at > i128::from(MAX_TIMESTAMP_US) {
        return Err(StoreError::invalid(format!(
            "{member}: timestamp out of range"
        )));
    }
    Ok(at as i64)
}

/// The receipts created at or after `since_us`, in insertion (id) order.
fn receipts_since(read: &dyn KvRead, since_us: i64) -> Result<Vec<ReceiptRecord>> {
    let prefix = [keys::EVAL_CAPTURE, RECEIPT_BY_TIME];
    let mut start = prefix.to_vec();
    start.extend_from_slice(&(since_us.max(0) as u64).to_be_bytes());
    let end = prefix_end(&prefix).expect("the prefix is not all 0xFF");
    let mut ids: Vec<u64> = Vec::new();
    read.scan(&start, &end, false, &mut |k, _| {
        if let Some(id) = k.get(10..18).and_then(keys::be8) {
            ids.push(id);
        }
        true
    })?;
    ids.sort_unstable();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(bytes) = read.get(&receipt_key(id))? {
            out.push(serde_json::from_slice(&bytes)?);
        }
    }
    Ok(out)
}

/// `COALESCE(SUM(input_tokens), 0)::int`: a sum past `int4` is Postgres's "integer out of range".
fn sum_as_int(sum: i64, member: &str) -> Result<i64> {
    if i32::try_from(sum).is_err() {
        return Err(StoreError::invalid(format!(
            "{member}: integer out of range"
        )));
    }
    Ok(sum)
}

/// `percentile_cont(p)` over the sorted values: the value at fractional row `p * (n - 1)`,
/// interpolated linearly between its neighbours; null when there are no values.
fn percentile_cont(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let row = p * (sorted.len() - 1) as f64;
    let (first, second) = (row.floor() as usize, row.ceil() as usize);
    if first == second {
        return Some(sorted[first]);
    }
    let proportion = row - first as f64;
    Some(sorted[first] + proportion * (sorted[second] - sorted[first]))
}

impl Store {
    /// `insertDecideReceipts(rows)`: records the rows, all stamped now, in order. Every row is
    /// checked before any is written (`constraint_violation` for a null in a `NOT NULL`
    /// column, `invalid_argument` for a NUL byte, a number outside `int4` or `real`).
    pub fn insert_decide_receipts(&self, rows: &[DecideReceiptInput]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let now = self.env.now_micros();
        let records = rows
            .iter()
            .map(|r| r.validate(now))
            .collect::<Result<Vec<_>>>()?;
        self.write(|tx| {
            for mut record in records.iter().cloned() {
                record.id = next_id(tx, RECEIPT_ID)?;
                put_json(tx, &receipt_key(record.id), &record)?;
                tx.put(&time_key(record.created_at_us, record.id), &[])?;
            }
            Ok(())
        })
    }

    /// `pruneDecideReceipts(retentionDays)`: deletes the receipts older than the window and the
    /// spend rows older than `max(days, 31)` days (a day is 24 hours), in one write. Resolves
    /// the number of receipts deleted.
    pub fn prune_decide_receipts(&self, retention_days: f64) -> Result<u64> {
        const MEMBER: &str = "pruneDecideReceipts";
        let days = whole(retention_days, MEMBER, "retentionDays")?;
        let now = self.env.now_micros();
        let receipt_cutoff = ago(now, days, DAY_US, MEMBER)?;
        let spend_cutoff = ago(now, days.max(MIN_SPEND_RETENTION_DAYS), DAY_US, MEMBER)?;
        self.write(|tx| {
            let prefix = [keys::EVAL_CAPTURE, RECEIPT_BY_TIME];
            let mut end = prefix.to_vec();
            end.extend_from_slice(&(receipt_cutoff.max(0) as u64).to_be_bytes());
            let mut doomed: Vec<(Vec<u8>, u64)> = Vec::new();
            tx.scan(&prefix, &end, false, &mut |k, _| {
                if let Some(id) = k.get(10..18).and_then(keys::be8) {
                    doomed.push((k.to_vec(), id));
                }
                true
            })?;
            for (index_key, id) in &doomed {
                tx.delete(&receipt_key(*id))?;
                tx.delete(index_key)?;
            }
            prune_spend_before(tx, spend_cutoff)?;
            Ok(doomed.len() as u64)
        })
    }

    /// `listDecideReceiptStats({ slot?, sinceHours })`: per (slot, mode, outcome, error_reason)
    /// over the window: count, mean answer value, 50th and 95th percentile latency and token
    /// total. Groups come in that order, byte order, a null error reason last.
    pub fn list_decide_receipt_stats(&self, slot: Option<&str>, since_hours: f64) -> Result<Value> {
        const MEMBER: &str = "listDecideReceiptStats";
        let hours = whole(since_hours, MEMBER, "sinceHours")?;
        if let Some(slot) = slot {
            no_nul(MEMBER, &[("slot", slot)])?;
        }
        let since = ago(self.env.now_micros(), hours, HOUR_US, MEMBER)?;
        let read = self.read()?;
        type Key = (String, String, String, bool, String);
        #[derive(Default)]
        struct Group {
            error_reason: Option<String>,
            n: i64,
            values: Vec<u32>,
            latencies: Vec<f64>,
            tokens: i64,
        }
        let mut groups: BTreeMap<Key, Group> = BTreeMap::new();
        for r in receipts_since(&*read, since)? {
            if slot.is_some_and(|s| r.slot != s) {
                continue;
            }
            let key = (
                r.slot.clone(),
                r.mode.clone(),
                r.outcome.clone(),
                r.error_reason.is_none(),
                r.error_reason.clone().unwrap_or_default(),
            );
            let group = groups.entry(key).or_default();
            group.error_reason = r.error_reason.clone();
            group.n += 1;
            group.values.extend(r.answer_value);
            group.latencies.extend(r.latency_ms.map(f64::from));
            group.tokens += i64::from(r.input_tokens.unwrap_or(0));
        }
        let mut out = Vec::with_capacity(groups.len());
        for ((slot, mode, outcome, _, _), mut g) in groups {
            g.latencies.sort_by(f64::total_cmp);
            let avg = (!g.values.is_empty()).then(|| {
                g.values.iter().map(|b| real_widened(*b)).sum::<f64>() / g.values.len() as f64
            });
            out.push(json!({
                "slot": slot,
                "mode": mode,
                "outcome": outcome,
                "error_reason": g.error_reason,
                "n": g.n,
                "avg_value": avg,
                "p50_latency": percentile_cont(&g.latencies, 0.5),
                "p95_latency": percentile_cont(&g.latencies, 0.95),
                "input_tokens": sum_as_int(g.tokens, MEMBER)?,
            }));
        }
        Ok(Value::Array(out))
    }

    /// `decideSlotUsage(sinceHours)`: per slot over the window: distinct decisions, rows, token
    /// total, and the rows that errored, were skipped or were refused at the egress gate.
    pub fn decide_slot_usage(&self, since_hours: f64) -> Result<Value> {
        const MEMBER: &str = "decideSlotUsage";
        let hours = whole(since_hours, MEMBER, "sinceHours")?;
        let since = ago(self.env.now_micros(), hours, HOUR_US, MEMBER)?;
        let read = self.read()?;
        #[derive(Default)]
        struct Usage {
            decisions: HashSet<String>,
            rows: i64,
            tokens: i64,
            errors: i64,
            skipped: i64,
            egress: i64,
        }
        let mut by_slot: BTreeMap<String, Usage> = BTreeMap::new();
        for r in receipts_since(&*read, since)? {
            let usage = by_slot.entry(r.slot.clone()).or_default();
            usage.decisions.insert(r.decision_id.clone());
            usage.rows += 1;
            usage.tokens += i64::from(r.input_tokens.unwrap_or(0));
            usage.errors += i64::from(r.outcome == "error");
            usage.skipped += i64::from(r.outcome == "skipped");
            let egress = r.error_reason.as_deref().is_some_and(|e| {
                e.starts_with("egress") || e == "denied_source" || e == "missing_provenance"
            });
            usage.egress += i64::from(egress);
        }
        let mut out = Vec::with_capacity(by_slot.len());
        for (slot, u) in by_slot {
            out.push(json!({
                "slot": slot,
                "decisions": u.decisions.len(),
                "rows": u.rows,
                "input_tokens": sum_as_int(u.tokens, MEMBER)?,
                "errors": u.errors,
                "skipped": u.skipped,
                "egress": u.egress,
            }));
        }
        Ok(Value::Array(out))
    }

    /// `decideConflictNoEntityCounts(sinceHours)`: the conflict receipts in the window, and how
    /// many of them were skipped for `no_entity`. Resolves `{ receipts, skipped }`.
    pub fn decide_conflict_no_entity_counts(&self, since_hours: f64) -> Result<Value> {
        const MEMBER: &str = "decideConflictNoEntityCounts";
        let hours = whole(since_hours, MEMBER, "sinceHours")?;
        let since = ago(self.env.now_micros(), hours, HOUR_US, MEMBER)?;
        let read = self.read()?;
        let (mut receipts, mut skipped) = (0_i64, 0_i64);
        for r in receipts_since(&*read, since)? {
            if r.slot != "conflict" {
                continue;
            }
            receipts += 1;
            if r.outcome == "skipped" && r.error_reason.as_deref() == Some("no_entity") {
                skipped += 1;
            }
        }
        Ok(json!({ "receipts": receipts, "skipped": skipped }))
    }

    /// `listDecideReplayReceipts(slot, sinceHours)`: the receipts of `slot` in the window whose
    /// outcome a replay reads, ordered by decision id (byte order), then rank (a null rank last),
    /// then insertion order.
    pub fn list_decide_replay_receipts(&self, slot: &str, since_hours: f64) -> Result<Value> {
        const MEMBER: &str = "listDecideReplayReceipts";
        let hours = whole(since_hours, MEMBER, "sinceHours")?;
        no_nul(MEMBER, &[("slot", slot)])?;
        let since = ago(self.env.now_micros(), hours, HOUR_US, MEMBER)?;
        let read = self.read()?;
        let mut rows: Vec<ReceiptRecord> = receipts_since(&*read, since)?
            .into_iter()
            .filter(|r| r.slot == slot && REPLAY_OUTCOMES.contains(&r.outcome.as_str()))
            .collect();
        rows.sort_by(|a, b| {
            a.decision_id
                .cmp(&b.decision_id)
                .then(a.rank.is_none().cmp(&b.rank.is_none()))
                .then(a.rank.cmp(&b.rank))
                .then(a.id.cmp(&b.id))
        });
        Ok(Value::Array(
            rows.iter()
                .map(|r| {
                    json!({
                        "decision_id": r.decision_id,
                        "answer_value": r.answer_value.map(real_value),
                        "protected": r.protected,
                        "rank": r.rank,
                        "min_keep": r.min_keep,
                        "outcome": r.outcome,
                    })
                })
                .collect(),
        ))
    }

    /// `listDecideResolvedModels(sinceHours)`: per (slot, provider, model) over the window, the
    /// receipt count and the time of the latest one (ISO), latest first, ties in byte order.
    pub fn list_decide_resolved_models(&self, since_hours: f64) -> Result<Value> {
        const MEMBER: &str = "listDecideResolvedModels";
        let hours = whole(since_hours, MEMBER, "sinceHours")?;
        let since = ago(self.env.now_micros(), hours, HOUR_US, MEMBER)?;
        let read = self.read()?;
        let mut groups: BTreeMap<(String, String, String), (i64, i64)> = BTreeMap::new();
        for r in receipts_since(&*read, since)? {
            let Some(model) = r.model_resolved.clone() else {
                continue;
            };
            let entry = groups
                .entry((r.slot.clone(), r.provider.clone(), model))
                .or_insert((0, r.created_at_us));
            entry.0 += 1;
            entry.1 = entry.1.max(r.created_at_us);
        }
        let mut rows: Vec<_> = groups.into_iter().collect();
        // The map is in (slot, provider, model) byte order; a stable sort keeps it for ties.
        rows.sort_by_key(|(_, (_, last))| std::cmp::Reverse(*last));
        Ok(Value::Array(
            rows.into_iter()
                .map(|((slot, provider, model), (n, last))| {
                    json!({
                        "slot": slot,
                        "provider": provider,
                        "model_resolved": model,
                        "n": n,
                        "last_at": crate::env::iso(last),
                    })
                })
                .collect(),
        ))
    }

    /// `listDecideMixedModelDecisions(sinceHours)`: per slot, the receipts in the window marked
    /// `mixed_model`, in byte order of the slot.
    pub fn list_decide_mixed_model_decisions(&self, since_hours: f64) -> Result<Value> {
        const MEMBER: &str = "listDecideMixedModelDecisions";
        let hours = whole(since_hours, MEMBER, "sinceHours")?;
        let since = ago(self.env.now_micros(), hours, HOUR_US, MEMBER)?;
        let read = self.read()?;
        let mut by_slot: BTreeMap<String, i64> = BTreeMap::new();
        for r in receipts_since(&*read, since)? {
            if r.error_reason.as_deref() == Some("mixed_model") {
                *by_slot.entry(r.slot.clone()).or_insert(0) += 1;
            }
        }
        Ok(Value::Array(
            by_slot
                .into_iter()
                .map(|(slot, n)| json!({ "slot": slot, "n": n }))
                .collect(),
        ))
    }
}
