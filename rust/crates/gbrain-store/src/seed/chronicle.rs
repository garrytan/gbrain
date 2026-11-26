//! Chronicle: the `chronicle_page_state` ledger, copied row for row (`chronicle_ledger::seed_ledger_row`). Its
//! source and page are checked first, as `upsertChronicleRow` checks them, so a row whose source or page was not
//! seeded refuses `source_not_found` or `page_not_found`. `chronicle_judge_reservations` is not seeded: the judge's
//! 24-hour cap restarts at zero on a seeded store (rust/docs/store/seed.md).

use super::decode::Row;
use super::{Column::Kept, Losses, Outcome, Relation};
use crate::chronicle_ledger::{SeededLedgerRow, seed_ledger_row};
use crate::error::{Result, StoreError};
use crate::kv::KvWrite;

/// In import order (after `sources` and `pages`).
pub(super) const RELATIONS: &[(&str, &Relation)] = &[("chronicle_page_state", &LEDGER)];

static LEDGER: Relation = Relation {
    key: &["source_id", "page_id", "content_hash", "extractor_version"],
    columns: &[
        ("source_id", Kept),
        ("page_id", Kept),
        ("content_hash", Kept),
        ("extractor_version", Kept),
        ("slug", Kept),
        ("state", Kept),
        ("reason", Kept),
        ("trigger", Kept),
        ("principal_kind", Kept),
        ("principal_id", Kept),
        ("request_id", Kept),
        ("no_extract", Kept),
        ("attempts", Kept),
        ("next_attempt_at", Kept),
        ("cost_usd", Kept),
        ("unpriced", Kept),
        ("event_slugs", Kept),
        ("event_hashes", Kept),
        ("decided_at", Kept),
        ("updated_at", Kept),
        ("campaign_id", Kept),
        ("attempt_cap_usd", Kept),
        ("max_attempts", Kept),
        ("pricing_policy", Kept),
        ("campaign_max_usd", Kept),
        ("cost_attempts", Kept),
        ("judge_input_hash", Kept),
        ("judge_window_chars", Kept),
        ("judge_window_hash", Kept),
        ("judge_input_failures", Kept),
    ],
    import: import_ledger_row,
};

fn need<T>(row: &Row, col: &str, value: Option<T>) -> Result<T> {
    value.ok_or_else(|| StoreError::invalid(format!("seed {}.{col}: is NULL", row.relation)))
}

/// `next_attempt_at` is kept as ISO text at microsecond precision, as the store's own ledger writers keep it (`env::iso`).
fn iso_text(row: &Row, col: &str) -> Result<Option<String>> {
    Ok(row.ts(col)?.map(crate::env::iso))
}

fn import_ledger_row(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let cost_attempts = row
        .text_array("cost_attempts")?
        .unwrap_or_default()
        .iter()
        .map(|n| {
            n.parse::<i32>().map_err(|_| {
                StoreError::invalid(format!(
                    "seed {}.cost_attempts: {n:?} is not an integer",
                    row.relation
                ))
            })
        })
        .collect::<Result<Vec<i32>>>()?;
    let record = SeededLedgerRow {
        source_id: row.req("source_id")?,
        page_id: need(row, "page_id", row.i64("page_id")?)?,
        content_hash: row.req("content_hash")?,
        extractor_version: need(row, "extractor_version", row.i32("extractor_version")?)?,
        slug: row.req("slug")?,
        state: row.req("state")?,
        reason: row.text("reason"),
        trigger: row.req("trigger")?,
        principal_kind: row.text("principal_kind"),
        principal_id: row.text("principal_id"),
        request_id: row.text("request_id"),
        no_extract: row.bool("no_extract")?.unwrap_or(false),
        next_attempt_at: iso_text(row, "next_attempt_at")?,
        cost_usd: row.f64("cost_usd")?,
        unpriced: row.bool("unpriced")?.unwrap_or(false),
        attempts: row.i32("attempts")?.unwrap_or(0),
        decided_at: row.req_ts("decided_at")?,
        updated_at: row.req_ts("updated_at")?,
        event_slugs: row.text_array("event_slugs")?.unwrap_or_default(),
        event_hashes: row.text_array("event_hashes")?.unwrap_or_default(),
        cost_attempts,
        judge_input_hash: row.text("judge_input_hash"),
        judge_window_chars: row.i32("judge_window_chars")?,
        judge_window_hash: row.text("judge_window_hash"),
        judge_input_failures: row.i32("judge_input_failures")?.unwrap_or(0),
        campaign_id: row.text("campaign_id"),
        attempt_cap_usd: row.text("attempt_cap_usd"),
        max_attempts: row.i32("max_attempts")?,
        pricing_policy: row.text("pricing_policy"),
        campaign_max_usd: row.text("campaign_max_usd"),
    };
    Ok(if seed_ledger_row(tx, record)? {
        Outcome::Imported
    } else {
        Outcome::Skipped
    })
}

#[cfg(test)]
mod tests;
