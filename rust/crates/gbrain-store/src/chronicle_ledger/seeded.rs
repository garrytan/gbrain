//! The shadow seed's copy of `chronicle_page_state` (rust/docs/store/seed.md): a primary row is stored as it is, every
//! column kept, not run through `upsertChronicleRow`'s decision rewrite (its guards and its `now()` stamps). The
//! row's foreign keys are checked first, as `upsertChronicleRow` checks them: the source, then the page, else
//! `source_not_found` or `page_not_found`, and nothing is written.

use super::{LedgerRecord, row_key};
use crate::error::Result;
use crate::kv::KvWrite;
use crate::{get_json, put_json};

/// One `chronicle_page_state` row of the primary, every column as the store keeps it.
#[derive(Debug, Clone)]
pub(crate) struct SeededLedgerRow {
    pub source_id: String,
    pub page_id: i64,
    pub content_hash: String,
    pub extractor_version: i32,
    pub slug: String,
    pub state: String,
    pub reason: Option<String>,
    pub trigger: String,
    pub principal_kind: Option<String>,
    pub principal_id: Option<String>,
    pub request_id: Option<String>,
    pub no_extract: bool,
    pub next_attempt_at: Option<String>,
    pub cost_usd: Option<f64>,
    pub unpriced: bool,
    pub attempts: i32,
    pub decided_at: i64,
    pub updated_at: i64,
    pub event_slugs: Vec<String>,
    pub event_hashes: Vec<String>,
    pub cost_attempts: Vec<i32>,
    pub judge_input_hash: Option<String>,
    pub judge_window_chars: Option<i32>,
    pub judge_window_hash: Option<String>,
    pub judge_input_failures: i32,
    pub campaign_id: Option<String>,
    pub attempt_cap_usd: Option<String>,
    pub max_attempts: Option<i32>,
    pub pricing_policy: Option<String>,
    pub campaign_max_usd: Option<String>,
}

/// Stores `row` at its key, after the source and page checks. `false` (and nothing written) when the same row is
/// stored already; a different row at the key is replaced, as the follow's replace stores a changed row.
pub(crate) fn seed_ledger_row(tx: &mut dyn KvWrite, row: SeededLedgerRow) -> Result<bool> {
    crate::seed::require_source(&*tx, &row.source_id)?;
    let page_id = u64::try_from(row.page_id).map_err(|_| {
        crate::error::StoreError::new(
            crate::error::PAGE_NOT_FOUND,
            format!("page {} is not seeded; seed pages first", row.page_id),
        )
    })?;
    crate::seed::require_page(&*tx, page_id)?;
    let key = row_key(
        &row.source_id,
        row.page_id,
        &row.content_hash,
        row.extractor_version,
    );
    let record = LedgerRecord {
        content_hash: row.content_hash,
        slug: row.slug,
        state: row.state,
        reason: row.reason,
        trigger: row.trigger,
        principal_kind: row.principal_kind,
        principal_id: row.principal_id,
        request_id: row.request_id,
        no_extract: row.no_extract,
        next_attempt_at: row.next_attempt_at,
        cost_usd: row.cost_usd,
        unpriced: row.unpriced,
        attempts: row.attempts,
        decided_at: row.decided_at,
        updated_at: row.updated_at,
        event_slugs: row.event_slugs,
        event_hashes: row.event_hashes,
        cost_attempts: row.cost_attempts,
        judge_input_hash: row.judge_input_hash,
        judge_window_chars: row.judge_window_chars,
        judge_window_hash: row.judge_window_hash,
        judge_input_failures: row.judge_input_failures,
        campaign_id: row.campaign_id,
        attempt_cap_usd: row.attempt_cap_usd,
        max_attempts: row.max_attempts,
        pricing_policy: row.pricing_policy,
        campaign_max_usd: row.campaign_max_usd,
    };
    if let Some(stored) = get_json::<LedgerRecord>(&*tx, &key)?
        && serde_json::to_value(&stored)? == serde_json::to_value(&record)?
    {
        return Ok(false);
    }
    put_json(tx, &key, &record)?;
    Ok(true)
}

/// Removes the row at `(source_id, page_id, content_hash, extractor_version)`: `false` when none is stored.
pub(crate) fn remove_ledger_row(
    tx: &mut dyn KvWrite,
    source_id: &str,
    page_id: i64,
    content_hash: &str,
    extractor_version: i32,
) -> Result<bool> {
    let key = row_key(source_id, page_id, content_hash, extractor_version);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}
