//! The daily budget ledger: the `budget_ledger` and `budget_reservations` tables (migration v012)
//! and the statements of `src/core/engine-sql/budget-ledger-writes.ts` and the day read
//! (`readBudgetLedgerDay`, `budget/daily-ledger.ts readDay`). rust/docs/store/repair-fences.md.
//!
//! - A ledger day: `a 0x09 <scope> 0x00 <resolver> 0x00 <YYYY-MM-DD>`, value [`LedgerRow`].
//! - A reservation: `a 0x0A <reservation_id>`, value [`ReservationRow`].
//!
//! Amounts are `NUMERIC(12,4)`: they are kept as whole ten-thousandths of a dollar and printed as
//! `numeric::text` prints them (four decimals). An input with more decimals rounds half away from
//! zero, as a `::numeric(12,4)` assignment does. Each write is one store write, so a reserve, settle,
//! release or reclaim moves the reservation and its day together or not at all.

use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::telemetry::parse_timestamp;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// One ledger day's totals, in ten-thousandths of a dollar.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LedgerRow {
    reserved: i64,
    committed: i64,
    cap: Option<i64>,
    created_at_us: i64,
    updated_at_us: i64,
}

/// One reservation.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReservationRow {
    scope: String,
    resolver_id: String,
    local_date: String,
    estimate: i64,
    reserved_at_us: i64,
    expires_at_us: i64,
    status: String,
}

fn text<'a>(value: &'a str, what: &str) -> Result<&'a str> {
    if value.contains('\0') {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("a budget ledger {what} cannot contain NUL"),
        ));
    }
    Ok(value)
}

/// `$n::date`: a `YYYY-MM-DD` day, as the ledger keys it.
fn day(value: &str) -> Result<&str> {
    let b = value.as_bytes();
    let digits = |r: std::ops::Range<usize>| r.into_iter().all(|i| b[i].is_ascii_digit());
    if b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && digits(0..4)
        && digits(5..7)
        && digits(8..10)
    {
        let (m, d) = (&value[5..7], &value[8..10]);
        if ("01"..="12").contains(&m) && ("01"..="31").contains(&d) {
            return Ok(value);
        }
    }
    Err(StoreError::new(
        INVALID_ARGUMENT,
        format!("invalid input syntax for type date: \"{value}\""),
    ))
}

fn ledger_key(scope: &str, resolver: &str, local_date: &str) -> Result<Vec<u8>> {
    let mut key = vec![keys::TELEMETRY, keys::TELEMETRY_BUDGET_LEDGER];
    key.extend_from_slice(text(scope, "scope")?.as_bytes());
    key.push(0);
    key.extend_from_slice(text(resolver, "resolver")?.as_bytes());
    key.push(0);
    key.extend_from_slice(day(local_date)?.as_bytes());
    Ok(key)
}

fn reservation_key(id: &str) -> Result<Vec<u8>> {
    let mut key = vec![keys::TELEMETRY, keys::TELEMETRY_BUDGET_RESERVATION];
    key.extend_from_slice(text(id, "reservation id")?.as_bytes());
    Ok(key)
}

/// A `::numeric` amount as ten-thousandths, rounded half away from zero at four decimals.
fn amount(value: &str) -> Result<i64> {
    let bad = || {
        StoreError::new(
            INVALID_ARGUMENT,
            format!("invalid input syntax for type numeric: \"{value}\""),
        )
    };
    let t = value.trim();
    let (neg, t) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let (int, frac) = t.split_once('.').unwrap_or((t, ""));
    if (int.is_empty() && frac.is_empty())
        || !int.bytes().all(|c| c.is_ascii_digit())
        || !frac.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(bad());
    }
    let whole: i64 = if int.is_empty() {
        0
    } else {
        int.parse().map_err(|_| bad())?
    };
    let mut digits: Vec<u8> = frac.bytes().map(|c| c - b'0').collect();
    let round_up = digits.len() > 4 && digits[4] >= 5;
    digits.resize(4, 0);
    let mut units = digits.iter().fold(0i64, |acc, d| acc * 10 + i64::from(*d));
    if round_up {
        units += 1;
    }
    let total = whole
        .checked_mul(10_000)
        .and_then(|w| w.checked_add(units))
        .ok_or_else(bad)?;
    // NUMERIC(12,4): at most 8 digits before the point.
    if total >= 100_000_000 * 10_000 {
        return Err(StoreError::new(INVALID_ARGUMENT, "numeric field overflow"));
    }
    Ok(if neg { -total } else { total })
}

/// `numeric(12,4)::text`.
fn amount_text(units: i64) -> String {
    let sign = if units < 0 { "-" } else { "" };
    let abs = units.unsigned_abs();
    format!("{sign}{}.{:04}", abs / 10_000, abs % 10_000)
}

fn read_ledger(
    read: &dyn KvRead,
    scope: &str,
    resolver: &str,
    local_date: &str,
) -> Result<Option<LedgerRow>> {
    get_json(read, &ledger_key(scope, resolver, local_date)?)
}

fn reservations(read: &dyn KvRead) -> Result<Vec<(String, ReservationRow)>> {
    let prefix = [keys::TELEMETRY, keys::TELEMETRY_BUDGET_RESERVATION];
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        match (
            std::str::from_utf8(&k[prefix.len()..]),
            serde_json::from_slice::<ReservationRow>(v),
        ) {
            (Ok(id), Ok(row)) => out.push((id.to_string(), row)),
            (_, Err(e)) => bad = Some(e.to_string()),
            (Err(e), _) => bad = Some(e.to_string()),
        }
        bad.is_none()
    })?;
    if let Some(e) = bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            format!("unreadable budget reservation: {e}"),
        ));
    }
    Ok(out)
}

/// `reclaimBudgetReservations(key, now)`: the ledger's `held` and `dispatched` reservations whose
/// `expires_at <= now` become `released` and `settled_uncertain`; each day's `reserved_usd` falls by
/// their estimates and its `committed_usd` rises by the settled ones'. Counts per status.
fn reclaim_in(
    tx: &mut dyn KvWrite,
    now: i64,
    scope: &str,
    resolver: &str,
    at: i64,
) -> Result<Value> {
    let mut per_day: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let (mut released, mut uncertain) = (0i64, 0i64);
    for (id, mut row) in reservations(&*tx)? {
        if row.scope != scope
            || row.resolver_id != resolver
            || row.expires_at_us > at
            || !matches!(row.status.as_str(), "held" | "dispatched")
        {
            continue;
        }
        let entry = per_day.entry(row.local_date.clone()).or_default();
        entry.0 += row.estimate;
        if row.status == "held" {
            row.status = "released".into();
            released += 1;
        } else {
            row.status = "settled_uncertain".into();
            entry.1 += row.estimate;
            uncertain += 1;
        }
        put_json(tx, &reservation_key(&id)?, &row)?;
    }
    for (local_date, (freed, charged)) in per_day {
        if let Some(mut day) = read_ledger(&*tx, scope, resolver, &local_date)? {
            day.reserved -= freed;
            day.committed += charged;
            day.updated_at_us = now;
            put_json(tx, &ledger_key(scope, resolver, &local_date)?, &day)?;
        }
    }
    Ok(json!({ "released": released, "uncertain": uncertain }))
}

/// `reserveBudgetReservation(key, spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetReservationSpec {
    pub day: String,
    pub estimate: String,
    pub cap: String,
    pub id: String,
    pub at: String,
    pub expires_at: String,
}

/// `reserveBudgetReservation(key, spec)`: the day's row gains the estimate (and takes the new cap)
/// when the estimate is within the cap and the day's reserved plus committed plus the estimate stays
/// within it; a new day starts with the estimate reserved. Then the reservation is stored `held`.
/// False when the cap refuses; a reservation id already stored refuses as the primary key does.
fn reserve_in(
    tx: &mut dyn KvWrite,
    now: i64,
    scope: &str,
    resolver: &str,
    spec: &BudgetReservationSpec,
) -> Result<bool> {
    let estimate = amount(&spec.estimate)?;
    let cap = amount(&spec.cap)?;
    let local_date = day(&spec.day)?.to_string();
    let reserved_at = parse_timestamp("reserveBudgetReservation", &spec.at)?;
    let expires_at = parse_timestamp("reserveBudgetReservation", &spec.expires_at)?;
    if estimate > cap {
        return Ok(false);
    }
    let day_row = match read_ledger(&*tx, scope, resolver, &local_date)? {
        Some(mut row) => {
            if row.reserved + row.committed + estimate > cap {
                return Ok(false);
            }
            row.reserved += estimate;
            row.cap = Some(cap);
            row.updated_at_us = now;
            row
        }
        None => LedgerRow {
            reserved: estimate,
            committed: 0,
            cap: Some(cap),
            created_at_us: now,
            updated_at_us: now,
        },
    };
    let rkey = reservation_key(&spec.id)?;
    if tx.get(&rkey)?.is_some() {
        return Err(StoreError::new(
            crate::error::CONSTRAINT_VIOLATION,
            "duplicate key value violates unique constraint \"budget_reservations_pkey\"",
        ));
    }
    put_json(tx, &ledger_key(scope, resolver, &local_date)?, &day_row)?;
    put_json(
        tx,
        &rkey,
        &ReservationRow {
            scope: scope.into(),
            resolver_id: resolver.into(),
            local_date,
            estimate,
            reserved_at_us: reserved_at,
            expires_at_us: expires_at,
            status: "held".into(),
        },
    )?;
    Ok(true)
}

fn owned(tx: &dyn KvRead, scope: &str, resolver: &str, id: &str) -> Result<Option<ReservationRow>> {
    Ok(get_json::<ReservationRow>(tx, &reservation_key(id)?)?
        .filter(|r| r.scope == scope && r.resolver_id == resolver))
}

/// `dispatchBudgetReservation(key, id, now)`: a `held` reservation whose `expires_at > now` becomes
/// `dispatched`. True when it did.
fn dispatch_in(
    tx: &mut dyn KvWrite,
    scope: &str,
    resolver: &str,
    id: &str,
    at: i64,
) -> Result<bool> {
    let Some(mut row) = owned(&*tx, scope, resolver, id)? else {
        return Ok(false);
    };
    if row.status != "held" || row.expires_at_us <= at {
        return Ok(false);
    }
    row.status = "dispatched".into();
    put_json(tx, &reservation_key(id)?, &row)?;
    Ok(true)
}

/// `settleBudgetReservation(key, id, actual)`: a reservation in `held`, `dispatched`, `released` or
/// `settled_uncertain` becomes `overrun` when `actual` exceeds its estimate, else `settled`; its day
/// frees the estimate it still held and commits `actual` (less the estimate a reclaim already
/// charged). The row is `{ prior, estimate, day, current }` with `current` the status before this
/// settle; a reservation that cannot settle answers only `current`, an unknown one all nulls.
fn settle_in(
    tx: &mut dyn KvWrite,
    now: i64,
    scope: &str,
    resolver: &str,
    id: &str,
    actual: &str,
) -> Result<Value> {
    let actual = amount(actual)?;
    let Some(mut row) = owned(&*tx, scope, resolver, id)? else {
        return Ok(json!({ "prior": null, "estimate": null, "day": null, "current": null }));
    };
    let prior = row.status.clone();
    if !matches!(
        prior.as_str(),
        "held" | "dispatched" | "released" | "settled_uncertain"
    ) {
        return Ok(json!({ "prior": null, "estimate": null, "day": null, "current": prior }));
    }
    row.status = if actual > row.estimate {
        "overrun"
    } else {
        "settled"
    }
    .into();
    put_json(tx, &reservation_key(id)?, &row)?;
    if let Some(mut day_row) = read_ledger(&*tx, scope, resolver, &row.local_date)? {
        if matches!(prior.as_str(), "held" | "dispatched") {
            day_row.reserved -= row.estimate;
        }
        day_row.committed += actual
            - if prior == "settled_uncertain" {
                row.estimate
            } else {
                0
            };
        day_row.updated_at_us = now;
        put_json(tx, &ledger_key(scope, resolver, &row.local_date)?, &day_row)?;
    }
    Ok(
        json!({ "prior": prior, "estimate": amount_text(row.estimate), "day": row.local_date, "current": prior }),
    )
}

/// `releaseBudgetReservation(key, id)`: a `held` reservation becomes `released` and its day frees
/// the estimate. True when the day row moved.
fn release_in(
    tx: &mut dyn KvWrite,
    now: i64,
    scope: &str,
    resolver: &str,
    id: &str,
) -> Result<bool> {
    let Some(mut row) = owned(&*tx, scope, resolver, id)? else {
        return Ok(false);
    };
    if row.status != "held" {
        return Ok(false);
    }
    row.status = "released".into();
    put_json(tx, &reservation_key(id)?, &row)?;
    let Some(mut day_row) = read_ledger(&*tx, scope, resolver, &row.local_date)? else {
        return Ok(false);
    };
    day_row.reserved -= row.estimate;
    day_row.updated_at_us = now;
    put_json(tx, &ledger_key(scope, resolver, &row.local_date)?, &day_row)?;
    Ok(true)
}

impl Store {
    /// `reclaimBudgetReservations(key, nowIso)`: `{ released, uncertain }`.
    pub fn reclaim_budget_reservations(
        &self,
        scope: &str,
        resolver: &str,
        now_iso: &str,
    ) -> Result<Value> {
        let at = parse_timestamp("reclaimBudgetReservations", now_iso)?;
        self.write(|tx| reclaim_in(tx, self.env.now_micros(), scope, resolver, at))
    }

    /// `reserveBudgetReservation(key, spec)`: true when held.
    pub fn reserve_budget_reservation(
        &self,
        scope: &str,
        resolver: &str,
        spec: &BudgetReservationSpec,
    ) -> Result<bool> {
        self.write(|tx| reserve_in(tx, self.env.now_micros(), scope, resolver, spec))
    }

    /// `dispatchBudgetReservation(key, id, nowIso)`: true when dispatched.
    pub fn dispatch_budget_reservation(
        &self,
        scope: &str,
        resolver: &str,
        id: &str,
        now_iso: &str,
    ) -> Result<bool> {
        let at = parse_timestamp("dispatchBudgetReservation", now_iso)?;
        self.write(|tx| dispatch_in(tx, scope, resolver, id, at))
    }

    /// `settleBudgetReservation(key, id, actual)`: the row the protocol reads.
    pub fn settle_budget_reservation(
        &self,
        scope: &str,
        resolver: &str,
        id: &str,
        actual: &str,
    ) -> Result<Value> {
        self.write(|tx| settle_in(tx, self.env.now_micros(), scope, resolver, id, actual))
    }

    /// `releaseBudgetReservation(key, id)`: true when the day row moved.
    pub fn release_budget_reservation(
        &self,
        scope: &str,
        resolver: &str,
        id: &str,
    ) -> Result<bool> {
        self.write(|tx| release_in(tx, self.env.now_micros(), scope, resolver, id))
    }

    /// The day read (`readBudgetLedgerDay`, `daily-ledger.ts readDay`): `{ reserved, committed, cap }`
    /// as `numeric::text` (cap null when unset), or null when the day has no row.
    pub fn read_budget_ledger_day(
        &self,
        scope: &str,
        resolver: &str,
        local_date: &str,
    ) -> Result<Value> {
        let read = self.read()?;
        Ok(match read_ledger(&*read, scope, resolver, local_date)? {
            Some(row) => json!({
                "reserved": amount_text(row.reserved),
                "committed": amount_text(row.committed),
                "cap": row.cap.map(amount_text),
            }),
            None => Value::Null,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_round_at_four_decimals_and_print_as_numeric_text() {
        assert_eq!(amount("0.4000").unwrap(), 4000);
        assert_eq!(amount("1").unwrap(), 10_000);
        assert_eq!(amount("0.00005").unwrap(), 1);
        assert_eq!(amount("0.00004").unwrap(), 0);
        assert!(amount("x").is_err());
        assert_eq!(amount_text(5500), "0.5500");
        assert_eq!(amount_text(125_000), "12.5000");
        assert_eq!(amount_text(-1), "-0.0001");
    }
}
