//! Jobs: `mcp_spend_log` (one row per settled or recorded paid call) and the decisions built on it, as the members of
//! `src/core/engine-sql/spend-log.ts` run them (rust/docs/store/spend-log.md).
//!
//! Members: reserveClientSpend, reserveGroupSpend, readGroupSpendTotals, settleSpendWithLog, insertSpendLog,
//! sumClientSpendSince, readAgentClientSpend. The client reads live in `oauth_clients.rs`, the reservation rows in
//! `spend.rs`.
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tags 0x28 and 0x29 (this file only):
//! - `m 0x28 id -> LogRecord`: one ledger row (sequence `mcp_spend_log`).
//! - `m 0x29 kind owner \0 created_at id -> spend`: the ledger by owner (`c` client id, `b` budget key) in time order,
//!   the scaled amount as 8 bytes. A sum from an instant on is a reverse scan that stops at the instant.
//!
//! Each admission is one store write: the owner's configured cap, the sweep of overdue holds, the sums, the decision
//! and the insert commit together, or (a refusal that is an outcome, not an error, still commits the sweep it ran, as
//! Postgres does until the caller's transaction rolls back; an error rolls everything back). The arithmetic is f64 in
//! the order the TypeScript caller had it, over amounts that are exact in four decimals.
//!
//! Time: `now` is read once per call from the store's clock; an overdue hold is `expires_at < now`, a live one
//! `expires_at >= now`, and "today" is the UTC day `now` falls in.

use super::oauth_clients::{all_clients, load_client};
use super::spend::{
    ParsedInsert, Settle, cents, expire_res, insert_res, numeric_4, open_holds, settle_res,
    uuid_bytes,
};
use super::*;
use crate::env::parse_iso;

const LOG_REC: u8 = 0x28;
const LOG_OWN: u8 = 0x29;

const MICROS_PER_DAY: i64 = 86_400_000_000;

fn log_key(id: i64) -> Vec<u8> {
    let mut k = prefix(LOG_REC);
    k.extend_from_slice(&signed_key(id));
    k
}

fn own_prefix(kind: u8, owner: &str) -> Vec<u8> {
    let mut k = prefix(LOG_OWN);
    k.push(kind);
    k.extend_from_slice(owner.as_bytes());
    k.push(0);
    k
}

fn own_key(kind: u8, owner: &str, created_at: i64, id: i64) -> Vec<u8> {
    let mut k = own_prefix(kind, owner);
    k.extend_from_slice(&signed_key(created_at));
    k.extend_from_slice(&signed_key(id));
    k
}

/// The `created_at` an owner-index key holds (the 8 bytes before the trailing id).
fn own_key_time(key: &[u8]) -> Option<i64> {
    let bytes: [u8; 8] = key
        .get(key.len().checked_sub(16)?..key.len() - 8)?
        .try_into()
        .ok()?;
    Some((u64::from_be_bytes(bytes) ^ (1 << 63)) as i64)
}

/// One `mcp_spend_log` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LogRecord {
    id: i64,
    client_id: Option<String>,
    pub budget_key: Option<String>,
    token_name: Option<String>,
    operation: String,
    /// `NUMERIC(12,4)`, scaled.
    spend: i64,
    provider: Option<String>,
    model: Option<String>,
    created_at: i64,
}

impl LogRecord {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "client_id": self.client_id,
            "budget_key": self.budget_key.clone(),
            "token_name": self.token_name,
            "operation": self.operation,
            "spend_cents": cents(self.spend),
            "provider": self.provider,
            "model": self.model,
            "created_at": iso(self.created_at),
        })
    }
}

/// Append one ledger row, with its owner-index entries.
fn append_log(tx: &mut dyn KvWrite, now: i64, mut row: LogRecord) -> Result<()> {
    // A NUL byte is not valid text in Postgres, and the owner index uses it as the owner separator.
    for owner in [&row.client_id, &row.budget_key].into_iter().flatten() {
        if owner.contains('\0') {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                "mcp_spend_log owner: a NUL byte is not valid text",
            ));
        }
    }
    row.id = next_seq(tx, "mcp_spend_log")?;
    row.created_at = now;
    let amount = row.spend.to_be_bytes();
    if let Some(client) = &row.client_id {
        tx.put(&own_key(b'c', client, now, row.id), &amount)?;
    }
    if let Some(budget) = &row.budget_key {
        tx.put(&own_key(b'b', budget, now, row.id), &amount)?;
    }
    put_json(tx, &log_key(row.id), &row)
}

/// The ledger sum of one owner from `since` on (all of it for None), scaled.
fn sum_log(read: &dyn KvRead, kind: u8, owner: &str, since: Option<i64>) -> Result<i64> {
    let mut total = 0_i64;
    scan_prefix(read, &own_prefix(kind, owner), true, &mut |k, v| {
        if since.is_some_and(|s| own_key_time(k).is_some_and(|at| at < s)) {
            return false;
        }
        if let Ok(bytes) = <[u8; 8]>::try_from(v) {
            total += i64::from_be_bytes(bytes);
        }
        true
    })?;
    Ok(total)
}

fn iso_arg(text: &str, what: &str) -> Result<i64> {
    parse_iso(text)
        .ok_or_else(|| StoreError::invalid(format!("{what}: \"{text}\" is not an ISO time")))
}

/// `reserveClientSpend(spec)`.
#[derive(Debug, Clone, Deserialize)]
pub struct ClientReserve {
    pub reservation_id: String,
    pub client_id: String,
    pub estimated_cents: f64,
    #[serde(default)]
    pub cap_cents: Option<f64>,
    pub estimate_known: bool,
    pub model: String,
    pub provider: String,
    #[serde(default)]
    pub job_id: Option<i64>,
    /// ISO text.
    pub expires_at: String,
    /// ISO text: committed spend counts from here.
    pub day_start: String,
}

/// `reserveGroupSpend(spec)`.
#[derive(Debug, Clone, Deserialize)]
pub struct GroupReserve {
    pub reservation_id: String,
    pub budget_key: String,
    pub estimated_cents: f64,
    #[serde(default)]
    pub cap_cents: Option<f64>,
    pub estimate_known: bool,
    pub model: String,
    pub provider: String,
    #[serde(default)]
    pub job_id: Option<i64>,
    pub expires_at: String,
}

/// `insertSpendLog(row)`.
#[derive(Debug, Clone, Deserialize)]
pub struct LogInsert {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub token_name: Option<String>,
    pub operation: String,
    pub spend_cents: f64,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// `Some` when a total is not a finite non-negative number.
fn bad_total(total: f64) -> bool {
    !total.is_finite() || total < 0.0
}

/// The overdue and live sums (scaled) of a group's open holds at `now`.
fn group_holds(read: &dyn KvRead, budget_key: &str, now: i64) -> Result<(i64, i64)> {
    let (mut overdue, mut live) = (0_i64, 0_i64);
    for r in open_holds(read, b'b', budget_key)? {
        if r.status == "expired" || (r.status == "pending" && r.expires_at < now) {
            overdue += r.estimated;
        } else if r.status == "pending" {
            live += r.estimated;
        }
    }
    Ok((overdue, live))
}

impl Store {
    /// `reserveClientSpend(spec)`: `{ outcome: 'reserved' }`, `{ outcome: 'refused', committed_cents, pending_cents,
    /// cap_cents }`, `{ outcome: 'invalid_cap', cap_cents }` or `{ outcome: 'invalid_total', label }`. One write: an
    /// error (a job that does not exist, a repeated reservation id, an amount that overflows) leaves nothing changed,
    /// the sweep included.
    pub fn reserve_client_spend(&self, spec: &ClientReserve) -> Result<Value> {
        let insert = SpendInsert {
            reservation_id: spec.reservation_id.clone(),
            client_id: Some(spec.client_id.clone()),
            budget_key: None,
            job_id: spec.job_id,
            estimated_cents: spec.estimated_cents,
            model: spec.model.clone(),
            provider: spec.provider.clone(),
            expires_at: spec.expires_at.clone(),
            estimate_known: spec.estimate_known,
            usage_unknown_reason: (!spec.estimate_known)
                .then(|| "pricing_or_bound_unknown".to_string()),
        };
        let parsed = ParsedInsert::new(&insert)?;
        let day_start = iso_arg(&spec.day_start, "day_start")?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let configured = load_client(tx, &spec.client_id)?
                .and_then(|c| c.budget)
                .map(|hundredths| hundredths as f64);
            let cap = match (spec.cap_cents, configured) {
                (None, c) => c,
                (Some(a), None) => Some(a),
                (Some(a), Some(c)) => Some(a.min(c)),
            };
            if let Some(cap) = cap
                && bad_total(cap)
            {
                return Ok(json!({ "outcome": "invalid_cap", "cap_cents": cap }));
            }
            expire_res(
                tx,
                now,
                &ExpireScope {
                    client_id: Some(spec.client_id.clone()),
                    budget_key: None,
                },
            )?;
            let committed = cents(sum_log(tx, b'c', &spec.client_id, Some(day_start))?);
            let holds = open_holds(tx, b'c', &spec.client_id)?;
            let pending = cents(holds.iter().map(|r| r.estimated).sum());
            let unknown = holds.iter().filter(|r| !r.estimate_known).count();
            if bad_total(committed) {
                return Ok(json!({ "outcome": "invalid_total", "label": "committed spend" }));
            }
            if bad_total(pending) {
                return Ok(json!({ "outcome": "invalid_total", "label": "pending spend" }));
            }
            let projected = committed + pending + spec.estimated_cents;
            if let Some(cap) = cap
                && (!spec.estimate_known || unknown > 0 || projected > cap)
            {
                return Ok(json!({
                    "outcome": "refused", "committed_cents": committed, "pending_cents": pending,
                    "cap_cents": cap,
                }));
            }
            insert_res(tx, now, &insert, &parsed)?;
            Ok(json!({ "outcome": "reserved" }))
        })
    }

    /// `reserveGroupSpend(spec)`: `{ outcome: 'reserved', estimated_cents }`, `{ outcome: 'refused', kind,
    /// committed_cents, overdue_cents, live_cents }` or `{ outcome: 'invalid_total', label }`. One write, like the
    /// client admission.
    pub fn reserve_group_spend(&self, spec: &GroupReserve) -> Result<Value> {
        let probe = |estimated_cents: f64| SpendInsert {
            reservation_id: spec.reservation_id.clone(),
            client_id: None,
            budget_key: Some(spec.budget_key.clone()),
            job_id: spec.job_id,
            estimated_cents,
            model: spec.model.clone(),
            provider: spec.provider.clone(),
            expires_at: spec.expires_at.clone(),
            estimate_known: spec.estimate_known,
            usage_unknown_reason: (!spec.estimate_known)
                .then(|| "pricing_or_bound_unknown".to_string()),
        };
        // The id, the time and the ask are checked before the write opens, as the other members do.
        ParsedInsert::new(&probe(spec.estimated_cents))?;
        self.write(|tx| {
            let now = self.env.now_micros();
            expire_res(
                tx,
                now,
                &ExpireScope {
                    client_id: None,
                    budget_key: Some(spec.budget_key.clone()),
                },
            )?;
            let mut estimated = spec.estimated_cents;
            if let Some(cap) = spec.cap_cents {
                let committed = cents(sum_log(tx, b'b', &spec.budget_key, None)?);
                let (overdue, live) = group_holds(tx, &spec.budget_key, now)?;
                let (overdue, live) = (cents(overdue), cents(live));
                for (label, total) in [
                    ("committed spend", committed),
                    ("overdue spend", overdue),
                    ("pending spend", live),
                ] {
                    if bad_total(total) {
                        return Ok(json!({ "outcome": "invalid_total", "label": label }));
                    }
                }
                let remaining = cap - committed - overdue;
                let known_free = estimated == 0.0 && spec.estimate_known;
                let refused = |kind: &str| {
                    json!({
                        "outcome": "refused", "kind": kind, "committed_cents": committed,
                        "overdue_cents": overdue, "live_cents": live,
                    })
                };
                if remaining < 0.0 || (remaining == 0.0 && !known_free) {
                    return Ok(refused("exhausted"));
                }
                estimated = estimated.min(remaining);
                if live > 0.0 && live + estimated > remaining {
                    return Ok(refused("pressure"));
                }
            }
            let insert = probe(estimated);
            let parsed = ParsedInsert::new(&insert)?;
            insert_res(tx, now, &insert, &parsed)?;
            Ok(json!({ "outcome": "reserved", "estimated_cents": estimated }))
        })
    }

    /// `readGroupSpendTotals(budgetKey)`: `{ committed_cents, overdue_cents, live_cents }`.
    pub fn read_group_spend_totals(&self, budget_key: &str) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let committed = sum_log(&*read, b'b', budget_key, None)?;
        let (overdue, live) = group_holds(&*read, budget_key, now)?;
        Ok(json!({
            "committed_cents": cents(committed), "overdue_cents": cents(overdue),
            "live_cents": cents(live),
        }))
    }

    /// `settleSpendWithLog(id, actualCents, operation, tokenName)`: `{ outcome: 'settled' | 'already_settled' |
    /// 'missing' }`. A settled hold and its ledger row are one write.
    pub fn settle_spend_with_log(
        &self,
        reservation_id: &str,
        actual_cents: f64,
        operation: &str,
        token_name: Option<&str>,
    ) -> Result<Value> {
        let id = uuid_bytes(reservation_id)?;
        let actual = numeric_4(actual_cents, "actual_cents")?;
        self.write(|tx| {
            let now = self.env.now_micros();
            Ok(match settle_res(tx, now, &id, actual)? {
                Settle::Missing => json!({ "outcome": "missing" }),
                Settle::Already => json!({ "outcome": "already_settled" }),
                Settle::Done(held) => {
                    append_log(
                        tx,
                        now,
                        LogRecord {
                            id: 0,
                            client_id: held.client_id.clone(),
                            budget_key: held.budget_key.clone(),
                            token_name: token_name.map(str::to_string),
                            operation: operation.to_string(),
                            spend: actual,
                            provider: Some(held.provider.clone()),
                            model: Some(held.model.clone()),
                            created_at: now,
                        },
                    )?;
                    json!({ "outcome": "settled" })
                }
            })
        })
    }

    /// `insertSpendLog(row)`, stamped with the store clock. `constraint_violation` for an amount that overflows
    /// `NUMERIC(12,4)`.
    pub fn insert_spend_log(&self, row: &LogInsert) -> Result<()> {
        let spend = numeric_4(row.spend_cents, "spend_cents")?;
        self.write(|tx| {
            append_log(
                tx,
                self.env.now_micros(),
                LogRecord {
                    id: 0,
                    client_id: row.client_id.clone(),
                    budget_key: None,
                    token_name: row.token_name.clone(),
                    operation: row.operation.clone(),
                    spend,
                    provider: row.provider.clone(),
                    model: row.model.clone(),
                    created_at: 0,
                },
            )
        })
    }

    /// `sumClientSpendSince(clientId, since)`: the client's ledger sum from `since` (ISO text) on, in cents.
    pub fn sum_client_spend_since(&self, client_id: &str, since: &str) -> Result<f64> {
        let since = iso_arg(since, "since")?;
        let read = self.read()?;
        Ok(cents(sum_log(&*read, b'c', client_id, Some(since))?))
    }

    /// The ledger rows as `SELECT *` returns them, by id. Not an engine member: the diagnostic the tests read state with.
    pub fn spend_log_rows(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        let mut bad = None;
        scan_prefix(&*read, &prefix(LOG_REC), false, &mut |_, v| {
            match serde_json::from_slice::<LogRecord>(v) {
                Ok(r) => rows.push(r.to_json()),
                Err(e) => {
                    bad = Some(StoreError::invalid(format!("unreadable ledger row: {e}")));
                    return false;
                }
            }
            true
        })?;
        bad.map_or(Ok(rows), Err)
    }

    /// `readAgentClientSpend()`: per live client with the `agent` scope or a tool binding, `{ client_id, client_name,
    /// cap_usd_per_day, spent_cents_today, pending_cents, unknown_count, inflight_count }`, by client name then client id
    /// (bytewise; Postgres orders names by its collation).
    pub fn read_agent_client_spend(&self) -> Result<Value> {
        let read = self.read()?;
        let day_start = self.env.now_micros().div_euclid(MICROS_PER_DAY) * MICROS_PER_DAY;
        let mut inflight: HashMap<String, i64> = HashMap::new();
        for status in NON_TERMINAL {
            for job in rows_with_status(&*read, status)? {
                if job.name == "subagent"
                    && let Some(owner) =
                        job.data.get("__owner_client_id").and_then(jsonb_field_text)
                {
                    *inflight.entry(owner).or_default() += 1;
                }
            }
        }
        let mut clients: Vec<_> = all_clients(&*read)?
            .into_iter()
            .filter(|c| c.is_agent())
            .collect();
        clients.sort_by(|a, b| {
            (a.client_name.as_bytes(), a.client_id.as_bytes())
                .cmp(&(b.client_name.as_bytes(), b.client_id.as_bytes()))
        });
        let mut out = Vec::new();
        for c in clients {
            let holds = open_holds(&*read, b'c', &c.client_id)?;
            out.push(json!({
                "client_id": c.client_id,
                "client_name": c.client_name,
                "cap_usd_per_day": c.budget.map(|b| b as f64 / 100.0),
                "spent_cents_today": cents(sum_log(&*read, b'c', &c.client_id, Some(day_start))?),
                "pending_cents": cents(holds.iter().map(|r| r.estimated).sum()),
                "unknown_count": holds.iter().filter(|r| !r.estimate_known).count(),
                "inflight_count": inflight.get(&c.client_id).copied().unwrap_or(0),
            }));
        }
        Ok(Value::Array(out))
    }
}
