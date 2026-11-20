//! The per-page spend ledgers and the reads around them (`src/core/engine-sql/page-spend.ts`,
//! rust/docs/store/page_spend.md): `page_embedding_budget` (one row per page) and
//! `page_derivation_spend` (one row per page and family), the frontmatter hold marker, the
//! held-page list (`gbrain embed --held`), the size-state rows and the vectorless chunk indexes.
//!
//! Keys, under this family's tag: `b 0x09 <page id> 0x00` is the page's embedding budget row and
//! `b 0x09 <page id> 0x01 <family>` a derivation spend row (`SpendRecord`). Both go with the page
//! (`ON DELETE CASCADE`, `remove_page_rows`). Times are microseconds; a reservation window is
//! `reserved_at` in whole microseconds as text, as `RESERVATION_WINDOW_SQL` reads it.
//!
//! A reservation runs inside the caller's store transaction: the lock is the transaction's single
//! writer, which stands in for PGLite's `FOR UPDATE`.

use super::{PAGE_SPEND, kind_key, page_u64, read_body_state, segmented_embedding::visible_chunks};
use crate::error::CONSTRAINT_VIOLATION;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, read_page_by_id};
use crate::timeline_queries::jsonb_field_text;
use crate::{Result, Store, StoreError, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `PAGE_INLINE_MAX_BYTES` (src/core/page-size-policy.ts).
const PAGE_INLINE_MAX_BYTES: i64 = 1024 * 1024;
/// `RESERVED_EPSILON_USD` (engine-sql/page-spend.ts).
const RESERVED_EPSILON_USD: f64 = 1e-9;
/// A reservation older than this is stale (`updated_at < now() - interval '1 hour'`).
const STALE_US: i64 = 3_600_000_000;
const BUDGET: u8 = 0x00;
const DERIVATION: u8 = 0x01;
/// The holds that apply at any page size (`budgetRowAppliesFilter`).
const ANY_SIZE_REASONS: [&str; 3] = ["archive_backfill", "archive_open_day", "call_import"];
const STATES: [&str; 3] = ["open", "held", "capped"];
const FAMILIES: [&str; 2] = ["facts", "synopsis"];

/// `PageSpendLedger`: the embedding budget of a page, or one derivation family's spend on it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSpendLedger {
    pub table: String,
    pub page_id: i64,
    #[serde(default)]
    pub family: Option<String>,
}

/// One ledger row. A derivation row keeps only the spend columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SpendRecord {
    state: String,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    embedding_signature: Option<String>,
    spent_usd: f64,
    reserved_usd: f64,
    #[serde(default)]
    reserved_at: Option<i64>,
    #[serde(default)]
    unpriced_calls: i64,
    #[serde(default)]
    cap_usd: Option<f64>,
    updated_at: i64,
}

impl SpendRecord {
    fn new(now: i64) -> Self {
        Self {
            state: "open".into(),
            reason: None,
            embedding_signature: None,
            spent_usd: 0.0,
            reserved_usd: 0.0,
            reserved_at: None,
            unpriced_calls: 0,
            cap_usd: None,
            updated_at: now,
        }
    }

    fn window(&self) -> Option<String> {
        self.reserved_at.map(|at| at.to_string())
    }
}

/// `PageSpendLedgerRow`: a derivation row reads null for state, reason, signature and cap.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageSpendLedgerRow {
    pub state: Option<String>,
    pub reason: Option<String>,
    pub embedding_signature: Option<String>,
    pub spent_usd: f64,
    pub reserved_usd: f64,
    pub cap_usd: Option<f64>,
    pub stale_reservation: bool,
}

/// The plan part of a reservation write: the budget row's state, reason and cap.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSpendPlan {
    pub state: String,
    pub reason: Option<String>,
    pub cap_usd: Option<f64>,
}

/// `PageSpendReservationWrite`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSpendReservationWrite {
    pub spent: f64,
    pub reserved: f64,
    pub keep_window: bool,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub plan: Option<PageSpendPlan>,
}

/// The settle arguments of `settlePageSpendReservation`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSpendSettle {
    pub window: String,
    pub reserved_usd: f64,
    pub booked_usd: f64,
    #[serde(default)]
    pub unpriced: i64,
}

/// `readPageEmbeddingHolds(pageId)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageEmbeddingHolds {
    pub marker: Option<String>,
    pub state: Option<String>,
    pub reason: Option<String>,
}

/// `BudgetLimitedPagesOpts`; a null limit lists every row.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BudgetLimitedPagesOpts {
    pub state: Option<String>,
    pub source_id: Option<String>,
    pub limit: Option<i64>,
}

/// `PageBudgetReport`: one held or capped page with its waiting chunks.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageBudgetReport {
    pub slug: String,
    pub source_id: String,
    pub state: String,
    pub reason: Option<String>,
    pub spent_usd: f64,
    pub cap_usd: Option<f64>,
    pub pending_chunks: i64,
    pub pending_chars: i64,
}

/// `PageSizeStateRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageSizeStateRow {
    pub slug: String,
    pub bytes: i64,
    pub segmented: bool,
    pub frontmatter: Map<String, Value>,
    pub state: Option<String>,
    pub reason: Option<String>,
}

pub(super) fn spend_prefix(page_id: u64) -> Vec<u8> {
    let mut key = kind_key(PAGE_SPEND);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn budget_key(page_id: u64) -> Vec<u8> {
    let mut key = spend_prefix(page_id);
    key.push(BUDGET);
    key
}

fn derivation_key(page_id: u64, family: &str) -> Vec<u8> {
    let mut key = spend_prefix(page_id);
    key.push(DERIVATION);
    key.extend_from_slice(family.as_bytes());
    key
}

fn violation(message: impl Into<String>) -> StoreError {
    StoreError::new(CONSTRAINT_VIOLATION, message)
}

/// The ledger's key, after the CHECKs on its table and family.
fn ledger_key(ledger: &PageSpendLedger) -> Result<(Option<u64>, Vec<u8>, bool)> {
    let id = page_u64(ledger.page_id);
    let page = id.unwrap_or(0);
    match ledger.table.as_str() {
        "page_embedding_budget" => Ok((id, budget_key(page), true)),
        "page_derivation_spend" => {
            let family = ledger.family.as_deref().unwrap_or("");
            if !FAMILIES.contains(&family) {
                return Err(violation(format!(
                    "page_derivation_spend: family \"{family}\" violates check constraint"
                )));
            }
            Ok((id, derivation_key(page, family), false))
        }
        other => Err(StoreError::invalid(format!("unknown spend ledger {other}"))),
    }
}

/// The page a new ledger row references (`REFERENCES pages(id)`).
fn require_page(read: &dyn KvRead, id: Option<u64>, table: &str) -> Result<u64> {
    match id {
        Some(id) if read_page_by_id(read, id)?.is_some() => Ok(id),
        _ => Err(violation(format!(
            "insert on {table} violates foreign key constraint on page_id"
        ))),
    }
}

fn check_spend(spent: f64, reserved: f64, cap: Option<f64>) -> Result<()> {
    if spent < 0.0 || reserved < 0.0 || cap.is_some_and(|c| c < 0.0) {
        return Err(violation(
            "page spend ledger: a negative amount violates check constraint",
        ));
    }
    Ok(())
}

/// `RESERVED_AT_SQL`: the open window's (`keep`), a new one later than the last, or none.
fn next_reserved_at(row: &SpendRecord, total: f64, keep: bool, now: i64) -> Option<i64> {
    if total <= 0.0 {
        None
    } else if keep {
        row.reserved_at
    } else {
        Some(row.reserved_at.map_or(now, |at| now.max(at + 1_000)))
    }
}

/// `frontmatter -> outer ->> 'embedding_hold'`.
fn hold_marker(frontmatter: &Map<String, Value>, outer: &str) -> Option<String> {
    frontmatter
        .get(outer)
        .and_then(Value::as_object)
        .and_then(|o| o.get("embedding_hold"))
        .and_then(jsonb_field_text)
}

/// The page's body bytes: `body_bytes` of a segmented page (0 when NULL), else its body columns'.
fn body_bytes(read: &dyn KvRead, page: &PageRecord) -> Result<(i64, bool)> {
    match read_body_state(read, page.id)? {
        Some(state) if state.body_storage == "segmented" => {
            Ok((state.body_bytes.unwrap_or(0), true))
        }
        _ => Ok((
            i64::try_from(page.compiled_truth.len() + page.timeline.len()).unwrap_or(i64::MAX),
            false,
        )),
    }
}

/// `budgetRowAppliesFilter`: the row is held or capped and still applies (a large body, or a
/// reason that holds a page of any size).
fn row_applies(read: &dyn KvRead, page: &PageRecord, row: &SpendRecord) -> Result<bool> {
    if row.state == "open" {
        return Ok(false);
    }
    if row
        .reason
        .as_deref()
        .is_some_and(|r| ANY_SIZE_REASONS.contains(&r))
    {
        return Ok(true);
    }
    Ok(body_bytes(read, page)?.0 > PAGE_INLINE_MAX_BYTES)
}

/// `pageBudgetLimitedFilter`: the page has a held or capped budget row that still applies. The
/// stale-chunk reads and the content-drift sweep leave such a page out of the embed queue.
pub(crate) fn page_budget_limited(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    match get_json::<SpendRecord>(read, &budget_key(page.id))? {
        Some(row) => row_applies(read, page, &row),
        None => Ok(false),
    }
}

impl Store {
    /// `listVectorlessChunkIndexes(pageId, column)`: the page's visible rows with no vector.
    pub fn list_vectorless_chunk_indexes(&self, page_id: i64) -> Result<Vec<i64>> {
        let Some(id) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        if read_page_by_id(&*read, id)?.is_none() {
            return Ok(Vec::new());
        }
        Ok(visible_chunks(&*read, id)?
            .into_iter()
            .filter(|c| !c.embed.has_vector())
            .map(|c| i64::from(c.chunk_index))
            .collect())
    }

    /// `readPageEmbeddingHolds(pageId)`: the frontmatter marker and the budget row's state and
    /// reason; None for a missing page.
    pub fn read_page_embedding_holds(&self, page_id: i64) -> Result<Option<PageEmbeddingHolds>> {
        let Some(id) = page_u64(page_id) else {
            return Ok(None);
        };
        let read = self.read()?;
        let Some(page) = read_page_by_id(&*read, id)? else {
            return Ok(None);
        };
        let row: Option<SpendRecord> = get_json(&*read, &budget_key(id))?;
        Ok(Some(PageEmbeddingHolds {
            marker: hold_marker(&page.frontmatter, "transcript_archive")
                .or_else(|| hold_marker(&page.frontmatter, "call_import")),
            state: row.as_ref().map(|r| r.state.clone()),
            reason: row.and_then(|r| r.reason),
        }))
    }

    /// `writePageEmbeddingHold(pageId, reason, mode)`: `replace` holds over any row; `if_absent`
    /// writes a held row only when the page has none.
    pub fn write_page_embedding_hold(&self, page_id: i64, reason: &str, mode: &str) -> Result<()> {
        if mode != "replace" && mode != "if_absent" {
            return Err(StoreError::invalid(format!(
                "writePageEmbeddingHold: unknown mode {mode}"
            )));
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let id = require_page(&*tx, page_u64(page_id), "page_embedding_budget")?;
            let key = budget_key(id);
            let existing: Option<SpendRecord> = get_json(&*tx, &key)?;
            if existing.is_some() && mode == "if_absent" {
                return Ok(());
            }
            let mut row = existing.unwrap_or_else(|| SpendRecord::new(now));
            row.state = "held".into();
            row.reason = Some(reason.to_string());
            row.updated_at = now;
            put_json(tx, &key, &row)
        })
    }

    /// `openPageEmbeddingHold(pageId)`: the page's budget row goes open with no reason.
    pub fn open_page_embedding_hold(&self, page_id: i64) -> Result<()> {
        let Some(id) = page_u64(page_id) else {
            return Ok(());
        };
        self.write(|tx| {
            let key = budget_key(id);
            let Some(mut row) = get_json::<SpendRecord>(&*tx, &key)? else {
                return Ok(());
            };
            row.state = "open".into();
            row.reason = None;
            row.updated_at = self.env.now_micros();
            put_json(tx, &key, &row)
        })
    }

    /// `lockPageSpendLedger(ledger)`: inserts the row when absent and reads it.
    pub fn lock_page_spend_ledger(
        &self,
        ledger: &PageSpendLedger,
    ) -> Result<Option<PageSpendLedgerRow>> {
        let (id, key, embedding) = ledger_key(ledger)?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let row = match get_json::<SpendRecord>(&*tx, &key)? {
                Some(row) => row,
                None => {
                    require_page(&*tx, id, &ledger.table)?;
                    let row = SpendRecord::new(now);
                    put_json(tx, &key, &row)?;
                    row
                }
            };
            let stale = row.reserved_usd > 0.0 && row.updated_at < now - STALE_US;
            Ok(Some(PageSpendLedgerRow {
                state: embedding.then(|| row.state.clone()),
                reason: if embedding { row.reason.clone() } else { None },
                embedding_signature: if embedding {
                    row.embedding_signature.clone()
                } else {
                    None
                },
                spent_usd: row.spent_usd,
                reserved_usd: row.reserved_usd,
                cap_usd: if embedding { row.cap_usd } else { None },
                stale_reservation: stale,
            }))
        })
    }

    /// `writePageSpendReservation(ledger, write)`: writes one folded reservation; returns its
    /// window, or None when nothing is reserved or the row is gone.
    pub fn write_page_spend_reservation(
        &self,
        ledger: &PageSpendLedger,
        write: &PageSpendReservationWrite,
    ) -> Result<Option<String>> {
        let (_, key, embedding) = ledger_key(ledger)?;
        if let Some(plan) = write.plan.as_ref().filter(|_| embedding)
            && !STATES.contains(&plan.state.as_str())
        {
            return Err(violation(format!(
                "page_embedding_budget: state \"{}\" violates check constraint",
                plan.state
            )));
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let Some(mut row) = get_json::<SpendRecord>(&*tx, &key)? else {
                return Ok(None);
            };
            let mut cap = row.cap_usd;
            if embedding {
                if let Some(signature) = &write.signature {
                    row.embedding_signature = Some(signature.clone());
                }
                if let Some(plan) = &write.plan {
                    row.state = plan.state.clone();
                    row.reason = plan.reason.clone();
                    cap = plan.cap_usd;
                }
            }
            check_spend(write.spent, write.reserved, cap)?;
            row.reserved_at = next_reserved_at(&row, write.reserved, write.keep_window, now);
            row.spent_usd = write.spent;
            row.reserved_usd = write.reserved;
            row.cap_usd = cap;
            row.updated_at = now;
            put_json(tx, &key, &row)?;
            Ok(row.window())
        })
    }

    /// `settlePageSpendReservation(ledger, window, ...)`: books and drops one grant's hold, only
    /// while the window it reserved in is still open.
    pub fn settle_page_spend_reservation(
        &self,
        ledger: &PageSpendLedger,
        settle: &PageSpendSettle,
    ) -> Result<()> {
        let (_, key, embedding) = ledger_key(ledger)?;
        self.write(|tx| {
            let Some(mut row) = get_json::<SpendRecord>(&*tx, &key)? else {
                return Ok(());
            };
            if row.window().as_deref() != Some(settle.window.as_str()) {
                return Ok(());
            }
            if row.reserved_usd - settle.reserved_usd <= RESERVED_EPSILON_USD {
                row.reserved_usd = 0.0;
                row.reserved_at = None;
            } else {
                row.reserved_usd -= settle.reserved_usd;
            }
            row.spent_usd += settle.booked_usd.max(0.0);
            if embedding {
                row.unpriced_calls += settle.unpriced;
            }
            check_spend(row.spent_usd, row.reserved_usd, row.cap_usd)?;
            row.updated_at = self.env.now_micros();
            put_json(tx, &key, &row)
        })
    }

    /// `listBudgetLimitedPageRows(column, opts)`: held and capped pages whose row still applies,
    /// newest row first, with their chunks still waiting for a vector.
    pub fn list_budget_limited_page_rows(
        &self,
        opts: &BudgetLimitedPagesOpts,
    ) -> Result<Vec<PageBudgetReport>> {
        let read = self.read()?;
        let mut rows: Vec<(i64, u64, SpendRecord)> = Vec::new();
        let mut failure = None;
        let prefix = kind_key(PAGE_SPEND);
        scan_prefix(&*read, &prefix, false, &mut |k, v| {
            if k.len() != prefix.len() + 9 || k[k.len() - 1] != BUDGET {
                return true;
            }
            let id = u64::from_be_bytes(
                k[prefix.len()..prefix.len() + 8]
                    .try_into()
                    .unwrap_or_default(),
            );
            match serde_json::from_slice::<SpendRecord>(v) {
                Ok(row) => rows.push((row.updated_at, id, row)),
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let limit = match opts.limit {
            Some(n) => usize::try_from(n.max(0)).unwrap_or(usize::MAX),
            None => usize::MAX,
        };
        let mut out = Vec::new();
        for (_, id, row) in rows {
            if out.len() >= limit {
                break;
            }
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            if page.deleted_at_us.is_some()
                || page.frontmatter.contains_key("embed_skip")
                || row.state == "open"
            {
                continue;
            }
            if opts.state.as_deref().is_some_and(|s| s != row.state) {
                continue;
            }
            if opts
                .source_id
                .as_deref()
                .is_some_and(|s| !s.is_empty() && s != page.source_id)
            {
                continue;
            }
            if !row_applies(&*read, &page, &row)? {
                continue;
            }
            let segmented = body_bytes(&*read, &page)?.1;
            let pending: Vec<_> = visible_chunks(&*read, id)?
                .into_iter()
                .filter(|c| {
                    if segmented {
                        !c.embed.has_vector()
                    } else {
                        c.embed.embedded_at_us.is_none()
                    }
                })
                .collect();
            out.push(PageBudgetReport {
                slug: page.slug,
                source_id: page.source_id,
                state: row.state,
                reason: row.reason,
                spent_usd: row.spent_usd,
                cap_usd: row.cap_usd,
                pending_chunks: i64::try_from(pending.len()).unwrap_or(i64::MAX),
                pending_chars: pending
                    .iter()
                    .map(|c| i64::try_from(c.chunk_text.chars().count()).unwrap_or(i64::MAX))
                    .sum(),
            });
        }
        Ok(out)
    }

    /// `readPageSizeStateRows(sourceId, slugs)`: the source's live pages a size state may apply
    /// to (embed_skip, over the inline threshold, segmented or with a budget row), by slug.
    pub fn read_page_size_state_rows(
        &self,
        source_id: &str,
        slugs: Option<&[String]>,
    ) -> Result<Vec<PageSizeStateRow>> {
        if source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &keys::page(source_id, ""), false, &mut |_, v| {
            match serde_json::from_slice::<PageRecord>(v) {
                Ok(page) => pages.push(page),
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        let wanted: Option<std::collections::HashSet<&str>> =
            slugs.map(|s| s.iter().map(String::as_str).collect());
        let mut out = Vec::new();
        for page in pages {
            if page.deleted_at_us.is_some()
                || wanted
                    .as_ref()
                    .is_some_and(|w| !w.contains(page.slug.as_str()))
            {
                continue;
            }
            let (bytes, segmented) = body_bytes(&*read, &page)?;
            let row: Option<SpendRecord> = get_json(&*read, &budget_key(page.id))?;
            if !(page.frontmatter.contains_key("embed_skip")
                || bytes > PAGE_INLINE_MAX_BYTES
                || segmented
                || row.is_some())
            {
                continue;
            }
            out.push(PageSizeStateRow {
                slug: page.slug,
                bytes,
                segmented,
                frontmatter: page.frontmatter,
                state: row.as_ref().map(|r| r.state.clone()),
                reason: row.and_then(|r| r.reason),
            });
        }
        Ok(out)
    }
}

/// The page-delete cascade of both ledgers.
pub(super) fn delete_page_spend(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    super::delete_prefix(tx, &spend_prefix(page_id))
}
