//! Wake: crons, cron runs, forget requests, terms acceptances, and the MCP request log rollup.
//! `wake_subscriptions` is not seeded: a watch needs its job and write-request rows, which the seed
//! does not copy (rust/docs/store/seed.md).

use super::decode::Row;
use super::{Column::Kept, Losses, Outcome, Relation, duplicate};
use crate::error::{Result, StoreError};
use crate::jobs::wake::{self, ForgetRecord, SeededForget};
use crate::kv::KvWrite;
use crate::telemetry::{self, RollupRecord};

/// In import order.
pub(super) const RELATIONS: &[(&str, &Relation)] = &[
    ("wake_crons", &CRONS),
    ("wake_cron_runs", &CRON_RUNS),
    ("wake_forgets", &FORGETS),
    ("wake_terms_acceptances", &TERMS),
    ("mcp_request_log_rollup", &ROLLUP),
];

fn need<T>(row: &Row, col: &str, value: Option<T>) -> Result<T> {
    value.ok_or_else(|| StoreError::invalid(format!("seed {}.{col}: is NULL", row.relation)))
}

fn outcome(stored: bool) -> Outcome {
    if stored {
        Outcome::Imported
    } else {
        Outcome::Skipped
    }
}

// ---- wake_crons ----------------------------------------------------------------------------

static CRONS: Relation = Relation {
    key: &["name"],
    columns: &[("name", Kept), ("created_at", Kept)],
    import: import_cron,
};

fn import_cron(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let stored = wake::seed_cron(tx, &row.req("name")?, row.req_ts("created_at")?)?;
    Ok(outcome(stored))
}

// ---- wake_cron_runs ------------------------------------------------------------------------

static CRON_RUNS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("name", Kept),
        ("status", Kept),
        ("finished_at", Kept),
    ],
    import: import_cron_run,
};

fn import_cron_run(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = need(row, "id", row.i64("id")?)?;
    let stored = wake::seed_cron_run(
        tx,
        &row.req("name")?,
        id,
        &row.req("status")?,
        row.req_ts("finished_at")?,
    )?;
    Ok(outcome(stored))
}

// ---- wake_forgets --------------------------------------------------------------------------

static FORGETS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("wake_user", Kept),
        ("state", Kept),
        ("attempts", Kept),
        ("next_attempt_at", Kept),
        ("lease_until", Kept),
        ("last_error", Kept),
        ("created_at", Kept),
        ("updated_at", Kept),
    ],
    import: import_forget,
};

fn import_forget(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let record = ForgetRecord {
        id: need(row, "id", row.i64("id")?)?,
        wake_user: row.req("wake_user")?,
        state: row.text_or("state", "pending"),
        attempts: row.i32("attempts")?.unwrap_or(0),
        next_attempt_at: row.req_ts("next_attempt_at")?,
        lease_until: row.ts("lease_until")?,
        last_error: row.text("last_error"),
        created_at: row.req_ts("created_at")?,
        updated_at: row.req_ts("updated_at")?,
    };
    match wake::seed_forget(tx, &record)? {
        SeededForget::Stored => Ok(Outcome::Imported),
        SeededForget::Present => Ok(Outcome::Skipped),
        SeededForget::PendingConflict => Err(duplicate("wake_forgets_pending_unique (wake_user)")),
    }
}

// ---- wake_terms_acceptances ----------------------------------------------------------------

static TERMS: Relation = Relation {
    key: &["principal_key", "terms_version"],
    columns: &[
        ("principal_key", Kept),
        ("terms_version", Kept),
        ("accepted_at", Kept),
    ],
    import: import_terms,
};

fn import_terms(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let stored = wake::seed_terms(
        tx,
        &row.req("principal_key")?,
        &row.req("terms_version")?,
        row.req_ts("accepted_at")?,
    )?;
    Ok(outcome(stored))
}

// ---- mcp_request_log_rollup ----------------------------------------------------------------

static ROLLUP: Relation = Relation {
    key: &["token_name"],
    columns: &[
        ("token_name", Kept),
        ("requests", Kept),
        ("last_used_at", Kept),
        ("pruned_through", Kept),
    ],
    import: import_rollup,
};

/// A NULL `token_name` is keyed `''`, as the prune's `COALESCE(token_name, '')` keys it.
fn import_rollup(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let record = RollupRecord {
        token_name: row.text_or("token_name", ""),
        requests: row.i64("requests")?.unwrap_or(0),
        last_used_us: row.ts("last_used_at")?,
        pruned_through_us: row.ts("pruned_through")?,
    };
    Ok(outcome(telemetry::seed_rollup(tx, &record)?))
}

#[cfg(test)]
mod tests;
