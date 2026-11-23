//! Spend caps: the MCP spend log and its open reservations.

use super::decode::Row;
use super::{Column::Kept, Losses, Outcome, Relation};
use crate::error::Result;
use crate::jobs::{SeedLog, SeedReservation, seed_log, seed_reservation};
use crate::kv::KvWrite;

/// In import order.
pub(super) const RELATIONS: &[(&str, &Relation)] = &[
    ("mcp_spend_log", &SPEND_LOG),
    ("mcp_spend_reservations", &SPEND_RESERVATIONS),
];

// ---- mcp_spend_log -------------------------------------------------------------------------

static SPEND_LOG: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("client_id", Kept),
        ("budget_key", Kept),
        ("token_name", Kept),
        ("operation", Kept),
        ("spend_cents", Kept),
        ("provider", Kept),
        ("model", Kept),
        ("created_at", Kept),
    ],
    import: import_spend_log,
};

/// The row keeps its id and time; the owner index is written and the `mcp_spend_log` sequence raised.
fn import_spend_log(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = i64::try_from(row.req_id("id")?)
        .map_err(|_| crate::error::StoreError::invalid("seed mcp_spend_log.id: out of range"))?;
    let stored = seed_log(
        tx,
        SeedLog {
            id,
            client_id: row.text("client_id"),
            budget_key: row.text("budget_key"),
            token_name: row.text("token_name"),
            operation: row.req("operation")?,
            spend_cents: row.f64("spend_cents")?.unwrap_or(0.0),
            provider: row.text("provider"),
            model: row.text("model"),
            created_at: row.req_ts("created_at")?,
        },
    )?;
    Ok(if stored {
        Outcome::Imported
    } else {
        Outcome::Skipped
    })
}

// ---- mcp_spend_reservations ----------------------------------------------------------------

static SPEND_RESERVATIONS: Relation = Relation {
    key: &["reservation_id"],
    columns: &[
        ("reservation_id", Kept),
        ("client_id", Kept),
        ("budget_key", Kept),
        // Stored as NULL (`spend_hold_job_dropped`): `minion_jobs` is not seeded.
        ("job_id", Kept),
        ("estimated_cents", Kept),
        ("actual_cents", Kept),
        ("model", Kept),
        ("provider", Kept),
        ("status", Kept),
        ("created_at", Kept),
        ("settled_at", Kept),
        ("expires_at", Kept),
        ("estimate_known", Kept),
        ("usage_unknown_reason", Kept),
    ],
    import: import_spend_reservation,
};

/// A hold that names a job is stored with no job and counted as `spend_hold_job_dropped`: the job
/// is not in the store, and a job id with no job would break the foreign key's meaning.
fn import_spend_reservation(
    tx: &mut dyn KvWrite,
    row: &Row,
    losses: &mut Losses,
) -> Result<Outcome> {
    let stored = seed_reservation(
        tx,
        SeedReservation {
            reservation_id: row.req("reservation_id")?,
            client_id: row.text("client_id"),
            budget_key: row.text("budget_key"),
            estimated_cents: row.f64("estimated_cents")?.unwrap_or(0.0),
            actual_cents: row.f64("actual_cents")?,
            model: row.req("model")?,
            provider: row.req("provider")?,
            status: row.req("status")?,
            created_at: row.req_ts("created_at")?,
            settled_at: row.ts("settled_at")?,
            expires_at: row.req_ts("expires_at")?,
            estimate_known: row.bool("estimate_known")?.unwrap_or(true),
            usage_unknown_reason: row.text("usage_unknown_reason"),
        },
    )?;
    if !stored {
        return Ok(Outcome::Skipped);
    }
    if row.value("job_id").is_some() {
        losses.add("spend_hold_job_dropped");
    }
    Ok(Outcome::Imported)
}

#[cfg(test)]
mod tests;
