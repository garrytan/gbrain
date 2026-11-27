//! Housekeeping: the statements of `src/core/engine-sql/persistence-housekeeping.ts` that the
//! consumer's housekeeping sends after a write (rust/docs/store/persistence.md, "Housekeeping").
//!
//! - The host's housekeeping turn: one `op_checkpoints` row per (op, host), key
//!   `d 0x02 <op> 0x00 <fingerprint>`, JSON `HousekeepingRow`. This engine has no
//!   `persistence_consumers` rows, so no live resident consumer ever blocks a claim.
//! - The receipt reads: the budget, the compaction listing, the true-up candidates and the
//!   compacted-reservation window. A candidate's effect bytes and unsettled flag come from its
//!   `persistence_effects` rows (`effects.rs`).
//! - The true-up's write (`TRUE_UP_RESERVATIONS_SQL`): the compare-and-set on the reservations, the
//!   counter release clamped at zero and the clamp count.
//! - The capacity forecast's inputs: the principal rows, then the topology-change rows
//!   (`topology::topology_capacity_days`). This engine has no relation size, so `tableBytes` is
//!   null.
//!
//! Lengths are `octet_length` of the Postgres text form (`timeline_queries::jsonb_text` for
//! jsonb). Times are microseconds; a day is 86,400 seconds, as `interval '1 day'` is on a UTC
//! session.

use super::effects::request_effects;
use super::{
    add_true_up_clamped, all_counters, all_requests, extra_bool, extra_i64, extra_is_null,
    read_counter, request_by_id, sql_like, uuid_param, write_counter,
};
use crate::config::read_config;
use crate::env::{Env, iso};
use crate::error::{Result, StoreError};
use crate::fence;
use crate::journal::{RequestRecord, write_request};
use crate::kv::{KvRead, KvWrite};
use crate::leases::LeaseToken;
use crate::timeline_queries::jsonb_text;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const DAY_US: f64 = 86_400_000_000.0;
/// The terminal states (`TERMINAL_STATES`).
const TERMINAL: &[&str] = &["committed", "conflict", "failed", "cancelled"];
/// The capacity forecast's window (`CAPACITY_WINDOW_DAYS`).
const WINDOW_DAYS: f64 = 7.0;
/// `ORDER BY sequence LIMIT 100` of the compaction listing.
const COMPACTION_BATCH: usize = 100;

fn terminal(r: &RequestRecord) -> bool {
    TERMINAL.contains(&r.state.as_str())
}

/// `recovery IS NULL AND NOT compacted AND state IN (<terminal>)`: the compactable receipts.
fn compactable(r: &RequestRecord) -> bool {
    terminal(r) && extra_is_null(r, "recovery") && !extra_bool(r, "compacted")
}

/// `jsonb ? key`: an object's key, an array's string element, or the string itself.
pub(super) fn jsonb_has(v: &Value, key: &str) -> bool {
    match v {
        Value::Object(o) => o.contains_key(key),
        Value::Array(a) => a.iter().any(|e| e.as_str() == Some(key)),
        Value::String(s) => s == key,
        _ => false,
    }
}

/// `octet_length(<jsonb column>::text)`, or `None` for SQL NULL.
fn jsonb_bytes(v: Option<&Value>) -> Option<i64> {
    v.filter(|v| !v.is_null())
        .map(|v| jsonb_text(v).len() as i64)
}

/// `COMPACTED_RECEIPT_BYTES_SQL(r, e)`: what a compacted receipt keeps, with the bytes of the
/// request's effect rows (`effect_bytes`).
fn compacted_bytes(r: &RequestRecord, effect_bytes: i64) -> i64 {
    let kept = jsonb_bytes(Some(&r.authority)).unwrap_or(0)
        + effect_bytes
        + jsonb_bytes(r.outcome.as_ref()).unwrap_or(0)
        + jsonb_bytes(r.extra.get("error_detail")).unwrap_or(0)
        + r.client_request_id.as_ref().map_or(0, |c| c.len() as i64)
        + 1024;
    extra_i64(r, "terminal_reservation").min(kept)
}

fn days_before(env: &dyn Env, days: f64) -> i64 {
    env.now_micros() - (days * DAY_US) as i64
}

// ---------------------------------------------------------------------------------------------
// The host's housekeeping turn.

/// One housekeeping `op_checkpoints` row: `completed_keys` and `updated_at`.
/// The resumable-op checkpoints of `op_checkpoint.rs` share the row shape and the key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct HousekeepingRow {
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    pub(crate) completed_keys: Value,
    pub(crate) updated_at_us: i64,
}

pub(crate) fn turn_key(op: &str, fingerprint: &str) -> Result<Vec<u8>> {
    if op.contains('\0') || fingerprint.contains('\0') {
        return Err(StoreError::invalid(
            "a housekeeping checkpoint key cannot contain NUL",
        ));
    }
    let mut key = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
    key.extend_from_slice(op.as_bytes());
    key.push(0);
    key.extend_from_slice(fingerprint.as_bytes());
    Ok(key)
}

/// `claimHousekeepingTurn(claim)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HousekeepingClaim {
    pub op: String,
    pub host_id: String,
    pub interval_ms: i64,
    pub lease_ms: i64,
    #[serde(default)]
    pub consumer_kinds: Vec<String>,
    #[serde(default)]
    pub consumer_live_ms: i64,
    /// The host fence (I-5, lane L5): a claim under an epoch that moved is refused `lease_lost`. None: unchanged.
    #[serde(default)]
    pub fence: Option<LeaseToken>,
}

/// `completeHousekeepingTurn(turn)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HousekeepingTurn {
    pub op: String,
    pub host_id: String,
    /// The host fence (I-5, lane L5): a completion under an epoch that moved is refused `lease_lost`.
    #[serde(default)]
    pub fence: Option<LeaseToken>,
}

/// The turn is free when no row exists, or when the row's stamp is older than the interval (after
/// a finished turn) or the lease (while one is held). Claiming leases it to the caller.
pub(crate) fn claim_housekeeping_turn_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    claim: &HousekeepingClaim,
) -> Result<bool> {
    uuid_param(&claim.host_id, "hostId")?;
    let key = turn_key(&claim.op, &claim.host_id)?;
    let now = env.now_micros();
    if let Some(row) = get_json::<HousekeepingRow>(&*tx, &key)? {
        let wait_ms = if row.completed_keys == json!(["done"]) {
            claim.interval_ms
        } else {
            claim.lease_ms
        };
        if row.updated_at_us > now - wait_ms.saturating_mul(1000) {
            return Ok(false);
        }
    }
    put_json(
        tx,
        &key,
        &HousekeepingRow {
            completed_keys: json!(["leased"]),
            updated_at_us: now,
        },
    )?;
    Ok(true)
}

/// Marks a leased turn done; any other row (or none) is left as it is.
pub(crate) fn complete_housekeeping_turn_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    turn: &HousekeepingTurn,
) -> Result<()> {
    let key = turn_key(&turn.op, &turn.host_id)?;
    let Some(row) = get_json::<HousekeepingRow>(&*tx, &key)? else {
        return Ok(());
    };
    if row.completed_keys != json!(["leased"]) {
        return Ok(());
    }
    put_json(
        tx,
        &key,
        &HousekeepingRow {
            completed_keys: json!(["done"]),
            updated_at_us: env.now_micros(),
        },
    )
}

// ---------------------------------------------------------------------------------------------
// Receipts.

/// `readReceiptBudget(retentionKey, floorDays)`: `{ retention, used, cutoff }`.
pub(crate) fn read_receipt_budget_in(
    read: &dyn KvRead,
    env: &dyn Env,
    retention_key: &str,
    floor_days: f64,
) -> Result<Value> {
    let retention = read_config(read, retention_key)?;
    let used = read_counter(read, "brain")?.map(|c| c.terminal_bytes.to_string());
    Ok(json!({
        "retention": retention,
        "used": used,
        "cutoff": iso(days_before(env, floor_days)),
    }))
}

/// `listReservationsAfter(after, limit)`: `{ id, sequence, compacted }` past `after`, in sequence
/// order.
pub(crate) fn list_reservations_after_in(
    read: &dyn KvRead,
    after: &str,
    limit: i64,
) -> Result<Vec<Value>> {
    let after: i64 = after
        .trim()
        .parse()
        .map_err(|_| StoreError::invalid("after is not a bigint"))?;
    if limit < 0 {
        return Err(StoreError::invalid("LIMIT must not be negative"));
    }
    let mut rows: Vec<RequestRecord> = all_requests(read)?
        .into_iter()
        .filter(|r| r.sequence as i128 > after as i128)
        .collect();
    rows.sort_by_key(|r| r.sequence);
    rows.truncate(limit as usize);
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "sequence": r.sequence.to_string(),
                "compacted": extra_bool(r, "compacted"),
            })
        })
        .collect())
}

/// A request's effect bytes (`EFFECT_BYTES_SQL` summed) and whether one of its effects is still
/// `queued` or `running`.
fn effect_bytes_unsettled(read: &dyn KvRead, request_id: &str) -> Result<(i64, bool)> {
    let effects = request_effects(read, request_id)?;
    Ok((
        effects.iter().map(|e| e.bytes()).sum(),
        effects
            .iter()
            .any(|e| e.state == "queued" || e.state == "running"),
    ))
}

/// `listTrueUpRequests(ids)`: the terminal requests among `ids`, in sequence order, with their
/// effect bytes and whether an effect is unsettled.
pub(crate) fn list_true_up_requests_in(read: &dyn KvRead, ids: &[String]) -> Result<Vec<Value>> {
    let mut wanted = Vec::with_capacity(ids.len());
    for id in ids {
        wanted.push(uuid_param(id, "id")?);
    }
    let mut rows: Vec<RequestRecord> = all_requests(read)?
        .into_iter()
        .filter(|r| terminal(r) && wanted.contains(&r.id.to_lowercase()))
        .collect();
    rows.sort_by_key(|r| r.sequence);
    rows.iter()
        .map(|r| {
            let row = r.to_row();
            let mut out = serde_json::Map::new();
            for column in [
                "id",
                "intent",
                "authority",
                "outcome",
                "error_message",
                "error_detail",
                "client_request_id",
                "terminal_reservation",
                "principal_kind",
                "principal_id",
                "compacted",
            ] {
                out.insert(
                    column.into(),
                    row.get(column).cloned().unwrap_or(Value::Null),
                );
            }
            let (bytes, unsettled) = effect_bytes_unsettled(read, &r.id)?;
            out.insert("effect_bytes".into(), json!(bytes.to_string()));
            out.insert("unfinished".into(), json!(unsettled));
            Ok(Value::Object(out))
        })
        .collect()
}

/// One request the true-up shrinks (`TrueUpReservation`): the reservation it read, what the
/// receipt keeps and the effect bytes it was sized with, as text.
#[derive(Debug, Clone, Deserialize)]
pub struct TrueUpReservation {
    pub id: String,
    pub old: i64,
    pub kept: i64,
    pub effects: String,
}

/// `trueUpReservations(rows)`: each request whose reservation is still `old`, whose effect bytes
/// are still `effects` and none of whose effects is unsettled keeps `kept`. The freed bytes,
/// summed per counter (the brain and the request's principal), leave the counters that exist,
/// clamped at zero; each clamped counter adds one to `persistence.true_up.clamped`. Returns the
/// bytes given back, as text.
pub(crate) fn true_up_reservations_in(
    tx: &mut dyn KvWrite,
    rows: &[TrueUpReservation],
) -> Result<String> {
    let mut checked = Vec::with_capacity(rows.len());
    for row in rows {
        let effects = row
            .effects
            .trim()
            .parse::<i64>()
            .map_err(|_| StoreError::invalid("effects is not a bigint"))?;
        checked.push((uuid_param(&row.id, "id")?, row, effects));
    }
    let mut freed_by_key: BTreeMap<String, i64> = BTreeMap::new();
    let mut freed = 0i64;
    for (id, row, effects) in checked {
        let Some(mut record) = request_by_id(&*tx, &id)? else {
            continue;
        };
        if extra_i64(&record, "terminal_reservation") != row.old {
            continue;
        }
        let (bytes, unsettled) = effect_bytes_unsettled(&*tx, &record.id)?;
        if unsettled || bytes != effects {
            continue;
        }
        let released = row.old - row.kept;
        record
            .extra
            .insert("terminal_reservation".into(), json!(row.kept));
        write_request(tx, &record)?;
        freed += released;
        for key in [
            "brain".to_string(),
            format!(
                "principal:{}:{}",
                record.principal_kind, record.principal_id
            ),
        ] {
            *freed_by_key.entry(key).or_insert(0) += released;
        }
    }
    let mut clamped = 0u64;
    for (key, released) in freed_by_key {
        let Some(mut counter) = read_counter(&*tx, &key)? else {
            continue;
        };
        if released > counter.terminal_bytes {
            clamped += 1;
        }
        counter.terminal_bytes -= released.min(counter.terminal_bytes);
        write_counter(tx, &key, &counter)?;
    }
    add_true_up_clamped(tx, clamped)?;
    Ok(freed.to_string())
}

/// `UNRESOLVED_CALLER_REFUSAL_SQL(r)` is true: a caller's write refused by the writer guard or by
/// source drift that no later request of the same page resolved. The `submit_job` terms of the
/// superseding test never match: the refusal needs a page operation.
fn unresolved_caller_refusal(r: &RequestRecord, all: &[RequestRecord]) -> bool {
    let code = r.error_code.as_deref();
    let guard = r.state == "failed"
        && (code == Some("writer_coordinator_required")
            || (code == Some("storage_error")
                && r.error_message
                    .as_deref()
                    .is_some_and(|m| sql_like(m, "Publication failed (P0001)%"))));
    let drift = r.state == "conflict" && code == Some("source_changed");
    if !(guard || drift) {
        return false;
    }
    if !["put_page", "add_timeline_entry", "remember"].contains(&r.operation.as_str()) {
        return false;
    }
    if r.operation == "put_page" && jsonb_has(&r.intent, "kind") {
        return false;
    }
    let superseded = all.iter().any(|c| {
        if c.source_id != r.source_id || c.slug != r.slug || c.sequence <= r.sequence {
            return false;
        }
        let state = c.state.as_str();
        (c.digest == r.digest
            && ["committed", "failed", "queued", "running", "recovering"].contains(&state))
            || (["committed", "queued", "running", "recovering"].contains(&state)
                && (["delete_page", "purge_page"].contains(&c.operation.as_str())
                    || r.operation == "put_page"))
            || (r.operation == "put_page"
                && state == "failed"
                && c.operation == "put_page"
                && !jsonb_has(&c.intent, "kind"))
    });
    !superseded
}

/// `listCompactableReceipts(retentionDays)`: compactable receipts completed more than
/// `retentionDays` ago that are not an unresolved caller refusal, oldest first, at most 100.
/// The open-sync-cursor and newest-sync-receipt exclusions never match here: this engine has no
/// managed-sync checkpoint rows and no worktree.
pub(crate) fn list_compactable_receipts_in(
    read: &dyn KvRead,
    env: &dyn Env,
    retention_days: f64,
) -> Result<Vec<Value>> {
    let before = days_before(env, retention_days);
    let all = all_requests(read)?;
    let mut rows: Vec<&RequestRecord> = all
        .iter()
        .filter(|r| {
            compactable(r)
                && r.completed_at_us.is_some_and(|t| t < before)
                && !unresolved_caller_refusal(r, &all)
        })
        .collect();
    rows.sort_by_key(|r| r.sequence);
    rows.truncate(COMPACTION_BATCH);
    Ok(rows.iter().map(|r| r.to_row()).collect())
}

// ---------------------------------------------------------------------------------------------
// The capacity forecast's inputs.

/// `to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD')`.
fn utc_day(micros: i64) -> String {
    iso(micros)[..10].to_string()
}

#[derive(Default)]
struct DaySums {
    ids: i64,
    gross: i64,
    net: i64,
    recent_ids: i64,
    recent_gross: i64,
    recent_net: i64,
}

fn epoch_days(env: &dyn Env, micros: i64) -> f64 {
    (env.now_micros() - micros) as f64 / DAY_US
}

/// `readCapacityForecastInputs({ light })`.
pub(crate) fn read_capacity_forecast_inputs_in(
    read: &dyn KvRead,
    env: &dyn Env,
    light: bool,
) -> Result<Value> {
    let counters: Vec<_> = all_counters(read)?
        .into_iter()
        .filter(|(key, _)| key == "brain" || key.starts_with("principal:"))
        .collect();
    let all = all_requests(read)?;
    let window_start = days_before(env, WINDOW_DAYS);
    let recent_start = days_before(env, 1.0);
    let mut days = Vec::new();
    for (key, _) in &counters {
        if key == "brain" {
            continue;
        }
        let mut parts = key.splitn(3, ':');
        let (_, kind, id) = (parts.next(), parts.next(), parts.next());
        let (Some(kind), Some(id)) = (kind.filter(|k| !k.is_empty()), id.filter(|i| !i.is_empty()))
        else {
            continue;
        };
        let mut by_day: std::collections::BTreeMap<String, DaySums> = Default::default();
        for r in all.iter().filter(|r| {
            r.principal_kind == kind && r.principal_id == id && r.created_at_us > window_start
        }) {
            let sums = by_day.entry(utc_day(r.created_at_us)).or_default();
            let gross = extra_i64(r, "terminal_reservation");
            let net = compacted_bytes(r, super::effects::effect_totals(read, &r.id)?.0);
            sums.ids += 1;
            sums.gross += gross;
            sums.net += net;
            if r.created_at_us > recent_start {
                sums.recent_ids += 1;
                sums.recent_gross += gross;
                sums.recent_net += net;
            }
        }
        for (day, s) in by_day {
            days.push(json!({
                "day": day,
                "ids": s.ids.to_string(),
                "gross": s.gross.to_string(),
                "net": s.net.to_string(),
                "recent_ids": s.recent_ids.to_string(),
                "recent_gross": s.recent_gross.to_string(),
                "recent_net": s.recent_net.to_string(),
                "scope": key,
            }));
        }
    }
    days.extend(super::topology::topology_capacity_days(
        read,
        window_start,
        recent_start,
    )?);
    let first = all.iter().min_by_key(|r| r.sequence);
    let oldest_compactable = all
        .iter()
        .filter(|r| compactable(r))
        .filter_map(|r| r.completed_at_us)
        .min();
    let history = json!({
        "age_days": first.map(|r| epoch_days(env, r.created_at_us)),
        "first_id": first.map(|r| r.id.clone()),
        "compaction_age_days": oldest_compactable.map(|t| epoch_days(env, t)),
    });
    let mut reclaim = Vec::new();
    if !light {
        let mut by_scope: std::collections::BTreeMap<String, (i64, i64)> = Default::default();
        for r in all.iter().filter(|r| compactable(r)) {
            let scope = format!("principal:{}:{}", r.principal_kind, r.principal_id);
            let reserved = extra_i64(r, "terminal_reservation");
            let entry = by_scope.entry(scope).or_default();
            entry.0 += reserved - compacted_bytes(r, super::effects::effect_totals(read, &r.id)?.0);
            let held = jsonb_bytes(Some(&r.intent)).unwrap_or(0)
                + jsonb_bytes(Some(&r.authority)).unwrap_or(0);
            if held > reserved {
                entry.1 += 1;
            }
        }
        for (scope, (bytes, under)) in by_scope {
            reclaim.push(
                json!({ "scope": scope, "bytes": bytes.to_string(), "under": under.to_string() }),
            );
        }
    }
    Ok(json!({
        "counters": counters
            .iter()
            .map(|(key, c)| json!({
                "key": key,
                "lifetime_ids": c.lifetime_ids.to_string(),
                "terminal_bytes": c.terminal_bytes.to_string(),
            }))
            .collect::<Vec<_>>(),
        "days": days,
        "history": history,
        "reclaim": reclaim,
        "tableBytes": Value::Null,
    }))
}

impl Store {
    /// `claimHousekeepingTurn(claim)`: true when the turn was free and is now leased.
    pub fn claim_housekeeping_turn(&self, claim: &HousekeepingClaim) -> Result<bool> {
        self.write(|tx| {
            fence::begin(self, tx, claim.fence.as_ref(), "claim_housekeeping_turn")?;
            claim_housekeeping_turn_in(tx, &*self.env, claim)
        })
    }

    /// `completeHousekeepingTurn(turn)`.
    pub fn complete_housekeeping_turn(&self, turn: &HousekeepingTurn) -> Result<()> {
        self.write(|tx| {
            fence::begin(self, tx, turn.fence.as_ref(), "complete_housekeeping_turn")?;
            complete_housekeeping_turn_in(tx, &*self.env, turn)
        })
    }

    /// `readReceiptBudget(retentionKey, floorDays)`.
    pub fn read_receipt_budget(&self, retention_key: &str, floor_days: f64) -> Result<Value> {
        read_receipt_budget_in(&*self.read()?, &*self.env, retention_key, floor_days)
    }

    /// `listReservationsAfter(after, limit)`.
    pub fn list_reservations_after(&self, after: &str, limit: i64) -> Result<Vec<Value>> {
        list_reservations_after_in(&*self.read()?, after, limit)
    }

    /// `listTrueUpRequests(ids)`.
    pub fn list_true_up_requests(&self, ids: &[String]) -> Result<Vec<Value>> {
        list_true_up_requests_in(&*self.read()?, ids)
    }

    /// `trueUpReservations(rows)`: the bytes given back, as text.
    pub fn true_up_reservations(&self, rows: &[TrueUpReservation]) -> Result<String> {
        self.write(|tx| true_up_reservations_in(tx, rows))
    }

    /// `listCompactableReceipts(retentionDays)`.
    pub fn list_compactable_receipts(&self, retention_days: f64) -> Result<Vec<Value>> {
        list_compactable_receipts_in(&*self.read()?, &*self.env, retention_days)
    }

    /// `readCapacityForecastInputs({ light })`.
    pub fn read_capacity_forecast_inputs(&self, light: bool) -> Result<Value> {
        read_capacity_forecast_inputs_in(&*self.read()?, &*self.env, light)
    }
}
