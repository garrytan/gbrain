//! The page embedding ledger on the paid path (PGLite's `page_embedding_budget`, migration v246).
//!
//! Members: readPageEmbeddingBudget, recordPageEmbeddingHold, openPageEmbeddingHold,
//! reservePageEmbedding, settlePageEmbeddingReservation (src/core/engine-sql/page-embedding-budget.ts
//! is the SQL copy; src/core/page-embedding-budget.ts owns the policy).
//!
//! Key: `B 'b' <page id>` -> the page's ledger record (JSON, [`BudgetRecord`]), in the embedding
//! family (`keys::EMBEDDING_STATE`, rust/docs/store/embeddings.md). The record goes with the page
//! when the page is deleted for good (`embeddings::remove_page_rows`), as PGLite's `ON DELETE
//! CASCADE` drops the row.
//!
//! The grant runs in one store write, which is exclusive, so it needs no row lock: insert the
//! record, refuse a held page, hold a junk page, then take the newest stale chunks whose cost fits
//! what the cap leaves and reserve their cost. The arithmetic is PGLite's, in the same order, so
//! every arm books the same floats. A reservation older than an hour is counted as spent, never
//! released. A reservation window is `reserved_at` in microseconds, as text; a settle books only
//! while the window it reserved in is still open.
//!
//! Money is stored bit-exact ([`exact_f64`]): PGLite and Postgres keep a DOUBLE PRECISION, which
//! holds Infinity, -Infinity and NaN, and a settle can book them. A JSON number cannot, so the record
//! writes each amount as its IEEE 754 bits and still reads a record that holds plain numbers.

use crate::error::{CONSTRAINT_VIOLATION, PAGE_NOT_FOUND, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::pages::read_page_by_id;
use crate::{Result, Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

const PAGE_BUDGET: u8 = b'b';
/// PGLite's stale reservation age (`updated_at < now() - interval '1 hour'`).
const STALE_RESERVATION_US: i64 = 3_600_000_000;
/// The settle's epsilon (`RESERVED_EPSILON_USD`, src/core/page-spend.ts).
const RESERVED_EPSILON_USD: f64 = 1e-9;
/// `reserved_at + interval '1 millisecond'`: a new window is later than the one it replaces.
const WINDOW_STEP_US: i64 = 1_000;

pub(crate) fn budget_key(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::EMBEDDING_STATE, PAGE_BUDGET];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// One ledger row: PGLite's columns, `reserved_at` and `updated_at` in microseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct BudgetRecord {
    state: String,
    reason: Option<String>,
    embedding_signature: Option<String>,
    #[serde(with = "exact_f64")]
    spent_usd: f64,
    #[serde(with = "exact_f64")]
    reserved_usd: f64,
    reserved_at: Option<i64>,
    unpriced_calls: i64,
    cap_usd: Option<f64>,
    updated_at: i64,
}

impl BudgetRecord {
    fn new(now: i64) -> Self {
        BudgetRecord {
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
        self.reserved_at.map(|us| us.to_string())
    }
}

/// One stale chunk and its estimated cost.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReserveChunk {
    pub chunk_index: i64,
    pub cost_usd: f64,
}

/// The caller's junk verdict: `reason` names why the page is junk, `null` when it is not.
#[derive(Debug, Clone, Deserialize)]
pub struct JunkVerdict {
    pub reason: Option<String>,
}

/// `reservePageEmbedding`'s input. An unlimited cap crosses the addon as `null`
/// (`configuredCapUsd`) or as `approvedCapInfinite`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReserveInput {
    pub approved: bool,
    pub approved_cap_usd: Option<f64>,
    #[serde(default)]
    pub approved_cap_infinite: bool,
    pub configured_cap_usd: Option<f64>,
    pub signature: Option<String>,
    pub chunks: Vec<ReserveChunk>,
    pub junk: Option<JunkVerdict>,
}

/// `settlePageEmbeddingReservation`'s input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleInput {
    pub window: Option<String>,
    #[serde(deserialize_with = "exact_f64::deserialize")]
    pub reserved_usd: f64,
    #[serde(deserialize_with = "exact_f64::deserialize")]
    pub booked_usd: f64,
    pub unpriced_calls: i64,
}

/// PostgreSQL's `->>` on one object key: a string as itself, JSON null as NULL, any other value as
/// its JSON text, and NULL when the key or the object is missing.
fn text_field(frontmatter: &Map<String, Value>, outer: &str, inner: &str) -> Option<String> {
    match frontmatter.get(outer)?.as_object()?.get(inner)? {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

fn require_page(read: &dyn KvRead, page_id: u64, member: &str) -> Result<()> {
    if read_page_by_id(read, page_id)?.is_none() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            format!(
                "{member}: page {page_id} does not exist (page_embedding_budget.page_id references pages)"
            ),
        ));
    }
    Ok(())
}

/// No cap is `f64::INFINITY`, as in PGLite's TypeScript.
fn cap_or_infinite(cap: Option<f64>) -> f64 {
    cap.unwrap_or(f64::INFINITY)
}

fn finite_or_null(value: f64) -> Value {
    if value.is_finite() {
        json!(value)
    } else {
        Value::Null
    }
}

impl Store {
    /// `readPageEmbeddingBudget(pageId)`: the page's hold marker
    /// (`transcript_archive.embedding_hold`, else `call_import.embedding_hold`) and its ledger row,
    /// a tombstone included. Every field is null for a missing page, and every ledger field for a
    /// page with no row.
    pub fn read_page_embedding_budget(&self, page_id: u64) -> Result<Value> {
        let read = self.read()?;
        let page = read_page_by_id(&*read, page_id)?;
        let marker = page.as_ref().and_then(|page| {
            text_field(&page.frontmatter, "transcript_archive", "embedding_hold")
                .or_else(|| text_field(&page.frontmatter, "call_import", "embedding_hold"))
        });
        let row: Option<BudgetRecord> = match page {
            Some(_) => get_json(&*read, &budget_key(page_id))?,
            None => None,
        };
        Ok(json!({
            "marker": marker,
            "state": row.as_ref().map(|r| r.state.clone()),
            "reason": row.as_ref().and_then(|r| r.reason.clone()),
            "embedding_signature": row.as_ref().and_then(|r| r.embedding_signature.clone()),
            "spent_usd": row.as_ref().map(|r| exact_f64::to_value(r.spent_usd)),
            "reserved_usd": row.as_ref().map(|r| exact_f64::to_value(r.reserved_usd)),
            "cap_usd": row.as_ref().and_then(|r| r.cap_usd),
            "unpriced_calls": row.as_ref().map(|r| r.unpriced_calls),
            "reservation_window": row.as_ref().and_then(BudgetRecord::window),
        }))
    }

    /// `recordPageEmbeddingHold(pageId, reason)`: a held row for a page with no row yet; a page
    /// with a row keeps it (`ON CONFLICT DO NOTHING`).
    pub fn record_page_embedding_hold(&self, page_id: u64, reason: &str) -> Result<()> {
        let now = self.env.now_micros();
        self.write(|tx| {
            require_page(&*tx, page_id, "recordPageEmbeddingHold")?;
            let key = budget_key(page_id);
            if tx.get(&key)?.is_some() {
                return Ok(());
            }
            let mut record = BudgetRecord::new(now);
            record.state = "held".into();
            record.reason = Some(reason.to_string());
            put_json(tx, &key, &record)
        })
    }

    /// `holdPageEmbedding(pageId, reason)`: sets the page's ledger row to `held` with `reason`, adding
    /// the row when the page has none (`INSERT ... ON CONFLICT (page_id) DO UPDATE SET state =
    /// 'held', reason = EXCLUDED.reason, updated_at = now()`). A row that exists keeps its spend
    /// columns (signature, spent, reserved, reservation window, unpriced calls, cap); a new row
    /// has the defaults of [`BudgetRecord::new`]. Unlike `recordPageEmbeddingHold` it replaces the
    /// state and reason of a row that exists. An unknown page id refuses `page_not_found` and a
    /// reason with a NUL byte refuses `invalid_argument`; neither stores anything.
    pub fn hold_page_embedding(&self, page_id: u64, reason: &str) -> Result<()> {
        if reason.contains('\0') {
            return Err(StoreError::invalid(
                "holdPageEmbedding: a reason may not hold a NUL byte",
            ));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            if read_page_by_id(&*tx, page_id)?.is_none() {
                return Err(StoreError::new(
                    PAGE_NOT_FOUND,
                    format!("holdPageEmbedding: no page with id {page_id}"),
                ));
            }
            let key = budget_key(page_id);
            let mut record =
                get_json::<BudgetRecord>(&*tx, &key)?.unwrap_or_else(|| BudgetRecord::new(now));
            record.state = "held".into();
            record.reason = Some(reason.to_string());
            record.updated_at = now;
            put_json(tx, &key, &record)
        })
    }

    /// `openPageEmbeddingHold(pageId)`: opens the page's row; a page with no row is a no-op.
    pub fn open_page_embedding_hold(&self, page_id: u64) -> Result<()> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let key = budget_key(page_id);
            let Some(mut record) = get_json::<BudgetRecord>(&*tx, &key)? else {
                return Ok(());
            };
            record.state = "open".into();
            record.reason = None;
            record.updated_at = now;
            put_json(tx, &key, &record)
        })
    }

    /// `reservePageEmbedding(pageId, input)`: one grant on the page's ledger row (module docs).
    /// Resolves `{ kind: 'held', reason }`, `{ kind: 'needs_junk' }` or `{ kind: 'grant',
    /// chunkIndexes, reservedUsd, deferred, capUsd, window }` (`capUsd` null when unlimited).
    pub fn reserve_page_embedding(&self, page_id: u64, input: &ReserveInput) -> Result<Value> {
        let now = self.env.now_micros();
        self.write(|tx| {
            require_page(&*tx, page_id, "reservePageEmbedding")?;
            let key = budget_key(page_id);
            let mut row = match get_json::<BudgetRecord>(&*tx, &key)? {
                Some(row) => row,
                None => {
                    let row = BudgetRecord::new(now);
                    put_json(tx, &key, &row)?;
                    row
                }
            };
            if row.state == "held" && !input.approved {
                let reason = row
                    .reason
                    .clone()
                    .unwrap_or_else(|| "awaiting_approval".into());
                return Ok(json!({ "kind": "held", "reason": reason }));
            }
            if !input.approved && row.state == "open" {
                let Some(junk) = &input.junk else {
                    return Ok(json!({ "kind": "needs_junk" }));
                };
                if let Some(reason) = &junk.reason {
                    row.state = "held".into();
                    row.reason = Some(reason.clone());
                    row.updated_at = now;
                    put_json(tx, &key, &row)?;
                    return Ok(json!({ "kind": "held", "reason": reason }));
                }
            }
            let stale = row.reserved_usd > 0.0 && row.updated_at < now - STALE_RESERVATION_US;
            let same_ledger = match (&row.embedding_signature, &input.signature) {
                (Some(stored), Some(wanted)) => stored == wanted,
                _ => true,
            };
            let spent = if same_ledger {
                row.spent_usd + if stale { row.reserved_usd } else { 0.0 }
            } else {
                0.0
            };
            let mut reserved = if same_ledger && !stale {
                row.reserved_usd
            } else {
                0.0
            };
            let stored = match row.cap_usd {
                Some(cap) => cap,
                None => cap_or_infinite(input.configured_cap_usd),
            };
            let cap_usd = if input.approved {
                let approved = if input.approved_cap_infinite {
                    f64::INFINITY
                } else {
                    input.approved_cap_usd.unwrap_or(0.0)
                };
                stored.max(spent + reserved + approved)
            } else {
                stored
            };
            let remaining = (cap_usd - spent - reserved).max(0.0);
            let mut chunks = input.chunks.clone();
            chunks.sort_by_key(|a| std::cmp::Reverse(a.chunk_index));
            let mut chunk_indexes = Vec::new();
            let mut reserved_usd = 0.0;
            for chunk in &chunks {
                if reserved_usd + chunk.cost_usd > remaining {
                    break;
                }
                reserved_usd += chunk.cost_usd;
                chunk_indexes.push(chunk.chunk_index);
            }
            let deferred = input.chunks.len() - chunk_indexes.len();
            let open_window = reserved > 0.0;
            reserved += reserved_usd;
            row.state = if deferred > 0 { "capped" } else { "open" }.into();
            row.reason = (deferred > 0).then(|| "cap_reached".to_string());
            if let Some(signature) = &input.signature {
                row.embedding_signature = Some(signature.clone());
            }
            row.spent_usd = spent;
            row.reserved_usd = reserved;
            row.reserved_at = if reserved <= 0.0 {
                None
            } else if open_window {
                row.reserved_at
            } else {
                Some(match row.reserved_at {
                    Some(at) => now.max(at + WINDOW_STEP_US),
                    None => now,
                })
            };
            if input.approved && cap_usd.is_finite() {
                row.cap_usd = Some(cap_usd);
            }
            row.updated_at = now;
            put_json(tx, &key, &row)?;
            Ok(json!({
                "kind": "grant",
                "chunkIndexes": chunk_indexes,
                "reservedUsd": reserved_usd,
                "deferred": deferred,
                "capUsd": finite_or_null(cap_usd),
                "window": row.window(),
            }))
        })
    }

    /// `settlePageEmbeddingReservation(pageId, { window, reservedUsd, bookedUsd, unpricedCalls })`:
    /// books `bookedUsd` and drops `reservedUsd` from the hold, only while `window` is the row's
    /// open reservation window. Any other window, or a page with no row, is a no-op.
    pub fn settle_page_embedding_reservation(
        &self,
        page_id: u64,
        settle: &SettleInput,
    ) -> Result<()> {
        let Some(window) = settle.window.as_deref() else {
            return Ok(());
        };
        if settle.reserved_usd == 0.0 && settle.booked_usd == 0.0 {
            return Ok(());
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let key = budget_key(page_id);
            let Some(mut row) = get_json::<BudgetRecord>(&*tx, &key)? else {
                return Ok(());
            };
            if row.window().as_deref() != Some(window) {
                return Ok(());
            }
            if row.reserved_usd - settle.reserved_usd <= RESERVED_EPSILON_USD {
                row.reserved_usd = 0.0;
                row.reserved_at = None;
            } else {
                row.reserved_usd -= settle.reserved_usd;
            }
            // `spent_usd + Math.max(0, bookedUsd)`: JavaScript's max keeps NaN, Rust's drops it.
            row.spent_usd += if settle.booked_usd.is_nan() {
                f64::NAN
            } else {
                settle.booked_usd.max(0.0)
            };
            row.unpriced_calls += settle.unpriced_calls;
            row.updated_at = now;
            put_json(tx, &key, &row)
        })
    }
}

/// The page's ledger `(state, reason)`, if it has a row: what `readPageSizeRows` reports
/// (`cli_reads/sources.rs`; the SQL engines left-join the same row).
pub(crate) fn read_state_reason(
    read: &dyn KvRead,
    page_id: u64,
) -> Result<Option<(String, Option<String>)>> {
    Ok(get_json::<BudgetRecord>(read, &budget_key(page_id))?.map(|r| (r.state, r.reason)))
}

/// The page's ledger `(state, reason, updated_at)` in microseconds, if it has a row (`readBudgetHoldAge`).
pub(crate) fn read_state_reason_updated(
    read: &dyn KvRead,
    page_id: u64,
) -> Result<Option<(String, Option<String>, i64)>> {
    Ok(get_json::<BudgetRecord>(read, &budget_key(page_id))?
        .map(|r| (r.state, r.reason, r.updated_at)))
}

/// Deletes the page's ledger record (`embeddings::remove_page_rows`).
pub(crate) fn remove_page_budget(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    tx.delete(&budget_key(page_id))
}

/// An f64 that keeps every value, Infinity, -Infinity and NaN included, bit for bit.
///
/// Stored as the IEEE 754 bits in hex (`"0x7ff0000000000000"`); a stored plain JSON number (records
/// written before this encoding) still reads. Across the addon a finite value is a number and a
/// non-finite one is the string `"Infinity"`, `"-Infinity"` or `"NaN"`, as JavaScript spells it
/// (`src/core/rust-engine/store-members/page-embedding-budget.ts`).
pub(crate) mod exact_f64 {
    use serde::de::{Deserializer, Error};
    use serde::{Deserialize, Serializer};
    use serde_json::{Value, json};

    pub fn serialize<S: Serializer>(value: &f64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{:016x}", value.to_bits()))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        match Value::deserialize(d)? {
            Value::Number(n) => n
                .as_f64()
                .ok_or_else(|| D::Error::custom("an amount is not a number")),
            Value::String(s) => {
                parse(&s).ok_or_else(|| D::Error::custom(format!("an amount is not a number: {s}")))
            }
            other => Err(D::Error::custom(format!(
                "an amount is not a number: {other}"
            ))),
        }
    }

    /// The stored bits, or JavaScript's name of a non-finite number.
    pub fn parse(s: &str) -> Option<f64> {
        match s {
            "Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            "NaN" => Some(f64::NAN),
            _ => {
                let hex = s.strip_prefix("0x")?;
                (hex.len() == 16)
                    .then(|| u64::from_str_radix(hex, 16).ok().map(f64::from_bits))
                    .flatten()
            }
        }
    }

    /// The value as the addon returns it: a number, or the name of a non-finite one.
    pub fn to_value(value: f64) -> Value {
        if value.is_finite() {
            json!(value)
        } else if value.is_nan() {
            json!("NaN")
        } else if value > 0.0 {
            json!("Infinity")
        } else {
            json!("-Infinity")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::INVALID_ARGUMENT;
    use crate::pages::{PageInput, PutPageOptions, read_page};

    fn page_id(store: &Store, slug: &str) -> u64 {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        read_page(&*store.read().unwrap(), "default", slug)
            .unwrap()
            .unwrap()
            .id
    }

    fn row(store: &Store, id: u64) -> Option<BudgetRecord> {
        get_json(&*store.read().unwrap(), &budget_key(id)).unwrap()
    }

    fn reserve_input() -> ReserveInput {
        ReserveInput {
            approved: false,
            approved_cap_usd: None,
            approved_cap_infinite: false,
            configured_cap_usd: Some(2.0),
            signature: Some("model-a:1536".into()),
            chunks: vec![ReserveChunk {
                chunk_index: 0,
                cost_usd: 0.5,
            }],
            junk: Some(JunkVerdict { reason: None }),
        }
    }

    #[test]
    fn a_hold_adds_a_row_for_a_page_with_none() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        assert!(row(&store, id).is_none());
        store.hold_page_embedding(id, "awaiting_approval").unwrap();
        let held = row(&store, id).unwrap();
        assert_eq!(held.state, "held");
        assert_eq!(held.reason.as_deref(), Some("awaiting_approval"));
        assert_eq!(held.spent_usd, 0.0);
        assert_eq!(held.reserved_usd, 0.0);
        assert_eq!(held.embedding_signature, None);
        assert_eq!(
            read_state_reason(&*store.read().unwrap(), id).unwrap(),
            Some(("held".into(), Some("awaiting_approval".into())))
        );
    }

    #[test]
    fn a_hold_replaces_the_reason_of_a_held_row_and_re_holds_an_open_one() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        store.record_page_embedding_hold(id, "call_import").unwrap();
        // The record writer keeps the row it has (ON CONFLICT DO NOTHING); the hold replaces it.
        store.hold_page_embedding(id, "archive_backfill").unwrap();
        let held = row(&store, id).unwrap();
        assert_eq!(held.state, "held");
        assert_eq!(held.reason.as_deref(), Some("archive_backfill"));
        store.open_page_embedding_hold(id).unwrap();
        assert_eq!(row(&store, id).unwrap().state, "open");
        store.hold_page_embedding(id, "archive_open_day").unwrap();
        let again = row(&store, id).unwrap();
        assert_eq!(again.state, "held");
        assert_eq!(again.reason.as_deref(), Some("archive_open_day"));
    }

    #[test]
    fn a_hold_keeps_the_spend_columns() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        store.reserve_page_embedding(id, &reserve_input()).unwrap();
        let before = row(&store, id).unwrap();
        assert_eq!(before.reserved_usd, 0.5);
        assert!(before.reserved_at.is_some());
        store.hold_page_embedding(id, "awaiting_approval").unwrap();
        let after = row(&store, id).unwrap();
        assert_eq!(after.state, "held");
        assert_eq!(after.reason.as_deref(), Some("awaiting_approval"));
        assert_eq!(after.embedding_signature.as_deref(), Some("model-a:1536"));
        assert_eq!(after.reserved_usd, 0.5);
        assert_eq!(after.spent_usd, before.spent_usd);
        assert_eq!(after.reserved_at, before.reserved_at);
        assert_eq!(after.unpriced_calls, before.unpriced_calls);
        assert_eq!(after.cap_usd, before.cap_usd);
    }

    #[test]
    fn an_unknown_page_refuses_page_not_found_and_stores_nothing() {
        let store = crate::test_support::store();
        let err = store.hold_page_embedding(999, "x").unwrap_err();
        assert_eq!(err.code, PAGE_NOT_FOUND);
        assert!(row(&store, 999).is_none());
    }

    #[test]
    fn a_reason_with_a_nul_byte_refuses_and_stores_nothing() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        let err = store.hold_page_embedding(id, "bad\0reason").unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        assert!(row(&store, id).is_none());
        store.hold_page_embedding(id, "fine").unwrap();
        let err = store.hold_page_embedding(id, "bad\0reason").unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        assert_eq!(row(&store, id).unwrap().reason.as_deref(), Some("fine"));
    }

    #[test]
    fn a_hard_delete_drops_the_row() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        store.hold_page_embedding(id, "awaiting_approval").unwrap();
        store.delete_page("a", None).unwrap();
        assert!(row(&store, id).is_none());
    }

    #[test]
    fn every_f64_round_trips_bit_exact() {
        let quiet_nan_payload = f64::from_bits(0x7ff8_0000_0000_0001);
        for v in [
            0.0,
            -0.0,
            0.1,
            1e-300,
            f64::MAX,
            f64::MIN_POSITIVE,
            5e-324,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NAN,
            quiet_nan_payload,
        ] {
            let mut row = BudgetRecord::new(1);
            row.spent_usd = v;
            row.reserved_usd = v;
            let back: BudgetRecord =
                serde_json::from_slice(&serde_json::to_vec(&row).unwrap()).unwrap();
            assert_eq!(back.spent_usd.to_bits(), v.to_bits(), "{v}");
            assert_eq!(back.reserved_usd.to_bits(), v.to_bits(), "{v}");
        }
    }

    #[test]
    fn a_record_with_plain_numbers_still_reads() {
        let old = br#"{"state":"open","reason":null,"embedding_signature":"m:1","spent_usd":0.875,"reserved_usd":0.25,"reserved_at":7,"unpriced_calls":1,"cap_usd":2.0,"updated_at":9}"#;
        let row: BudgetRecord = serde_json::from_slice(old).unwrap();
        assert_eq!(row.spent_usd, 0.875);
        assert_eq!(row.reserved_usd, 0.25);
    }

    #[test]
    fn the_addon_spells_non_finite_numbers_as_javascript_does() {
        assert_eq!(exact_f64::to_value(f64::INFINITY), "Infinity");
        assert_eq!(exact_f64::to_value(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(exact_f64::to_value(f64::NAN), "NaN");
        assert_eq!(exact_f64::to_value(0.5), 0.5);
        assert!(exact_f64::parse("NaN").unwrap().is_nan());
        assert_eq!(exact_f64::parse("0x7ff0000000000000"), Some(f64::INFINITY));
        assert_eq!(exact_f64::parse("bogus"), None);
    }
}
