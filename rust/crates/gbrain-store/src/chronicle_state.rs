//! The write-time reads of the chronicle ledger: the members of `src/core/engine-sql/chronicle-ledger.ts` that
//! `src/core/chronicle/ledger.ts` needs beside `upsertChronicleRow` (rust/docs/store/chronicle-ledger.md).
//!
//! Members: readChronicleRow, hasPendingAutoChronicleRow, hasExtractedEvents, countRecentChronicleReservations.
//!
//! The records are the ones `chronicle_ledger.rs` writes: `a 0x0E source \0 page_id BE8 hash \0 version BE4` for a row
//! of `chronicle_page_state` and `a 0x0F id BE8` for a judge reservation. This module reads them through its own view,
//! so a column that no served writer sets (the events, the campaign stamp, the judge window) reads as its column
//! default.
//!
//! A hard page delete removes the page's rows and a source delete the source's rows (`ON DELETE CASCADE` of
//! `pages.id` and `sources.id`; `cascade.rs`). Reservations have no page or source reference and stay.

use crate::chronicle_ledger::ChronicleRowInput;
use crate::env::iso;
use crate::error::{PAGE_NOT_FOUND, Result, SOURCE_NOT_FOUND, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::PageRecord;
use crate::pages::read_page_by_id;
use crate::sources::read_source;
use crate::{Store, get_json, keys};
use serde::{Deserialize, Serialize};

const DAY_US: i64 = 24 * 3_600_000_000;

fn row_prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_CHRONICLE_ROW]
}

fn reservation_prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_CHRONICLE_RESERVATION]
}

/// `a 0x0E source \0`: every row of one source.
fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut k = row_prefix().to_vec();
    k.extend_from_slice(source_id.as_bytes());
    k.push(0);
    k
}

/// `a 0x0E source \0 page_id BE8`: every row of one page.
fn page_prefix(source_id: &str, page_id: i64) -> Vec<u8> {
    let mut k = source_prefix(source_id);
    k.extend_from_slice(&(page_id as u64).to_be_bytes());
    k
}

fn row_key(source_id: &str, page_id: i64, content_hash: &str, version: i32) -> Vec<u8> {
    let mut k = page_prefix(source_id, page_id);
    k.extend_from_slice(content_hash.as_bytes());
    k.push(0);
    k.extend_from_slice(&(version as u32).to_be_bytes());
    k
}

/// A `chronicle_ledger.rs` row as this module reads it; the times are microseconds. A field the writer does not
/// store reads as its column default.
#[derive(Debug, Clone, Deserialize)]
struct RowView {
    content_hash: String,
    slug: String,
    state: String,
    reason: Option<String>,
    trigger: String,
    principal_kind: Option<String>,
    principal_id: Option<String>,
    request_id: Option<String>,
    no_extract: bool,
    next_attempt_at: Option<String>,
    cost_usd: Option<f64>,
    unpriced: bool,
    attempts: i32,
    decided_at: i64,
    updated_at: i64,
    #[serde(default)]
    event_slugs: Vec<String>,
    #[serde(default)]
    event_hashes: Vec<String>,
    #[serde(default)]
    cost_attempts: Vec<i32>,
    #[serde(default)]
    campaign_id: Option<String>,
    #[serde(default)]
    attempt_cap_usd: Option<String>,
    #[serde(default)]
    max_attempts: Option<i32>,
    #[serde(default)]
    pricing_policy: Option<String>,
    #[serde(default)]
    campaign_max_usd: Option<String>,
    #[serde(default)]
    judge_input_hash: Option<String>,
    #[serde(default)]
    judge_window_chars: Option<i32>,
    #[serde(default)]
    judge_window_hash: Option<String>,
    #[serde(default)]
    judge_input_failures: i32,
}

#[derive(Debug, Clone, Deserialize)]
struct ReservationView {
    reserved_at: i64,
}

/// The key of `readChronicleRow`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleRowKey {
    pub source_id: String,
    pub page_id: i64,
    pub content_hash: String,
    pub extractor_version: i32,
}

/// One row as `SELECT * FROM chronicle_page_state` returns it; `decided_at` and `updated_at` are ISO text and
/// `next_attempt_at` is the text the writer stored.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChronicleLedgerRow {
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
    pub attempts: i32,
    pub next_attempt_at: Option<String>,
    pub cost_usd: Option<f64>,
    pub unpriced: bool,
    pub event_slugs: Vec<String>,
    pub event_hashes: Vec<String>,
    pub decided_at: String,
    pub updated_at: String,
    pub campaign_id: Option<String>,
    pub attempt_cap_usd: Option<String>,
    pub max_attempts: Option<i32>,
    pub pricing_policy: Option<String>,
    pub campaign_max_usd: Option<String>,
    pub cost_attempts: Vec<i32>,
    pub judge_input_hash: Option<String>,
    pub judge_window_chars: Option<i32>,
    pub judge_window_hash: Option<String>,
    pub judge_input_failures: i32,
}

fn decode<T: for<'de> Deserialize<'de>>(v: &[u8], what: &str) -> Result<T> {
    serde_json::from_slice(v).map_err(|e| StoreError::invalid(format!("unreadable {what}: {e}")))
}

/// Every record under `prefix`, with its key, in key order.
fn scan<T: for<'de> Deserialize<'de>>(
    read: &dyn KvRead,
    prefix: &[u8],
    what: &str,
) -> Result<Vec<(Vec<u8>, T)>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        prefix,
        false,
        &mut |k, v| match decode::<T>(v, what) {
            Ok(r) => {
                out.push((k.to_vec(), r));
                true
            }
            Err(e) => {
                bad = Some(e);
                false
            }
        },
    )?;
    match bad {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

/// The page's rows with their keys, any content and extractor version. A NUL in the source id matches no row.
fn page_rows(read: &dyn KvRead, source_id: &str, page_id: i64) -> Result<Vec<(Vec<u8>, RowView)>> {
    if source_id.contains('\0') {
        return Ok(Vec::new());
    }
    scan(read, &page_prefix(source_id, page_id), "chronicle row")
}

/// The extractor version of a row key: its last four bytes.
fn version_of(key: &[u8]) -> Option<i32> {
    let tail = key.get(key.len().checked_sub(4)?..)?;
    keys::be4(tail).map(|v| v as i32)
}

pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    remove_prefix(tx, &page_prefix(&page.source_id, page.id as i64))
}

pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    remove_prefix(tx, &source_prefix(source_id))
}

fn remove_prefix(tx: &mut dyn KvWrite, prefix: &[u8]) -> Result<()> {
    let mut found = Vec::new();
    scan_prefix(&*tx, prefix, false, &mut |k, _| {
        found.push(k.to_vec());
        true
    })?;
    for k in found {
        tx.delete(&k)?;
    }
    Ok(())
}

impl Store {
    /// `upsertChronicleRow(w)` as the SQL engines run it: the row's source and page must exist (the foreign keys of
    /// `chronicle_page_state.source_id` and `.page_id`, checked in that order), else it refuses `source_not_found` or
    /// `page_not_found` and writes nothing. A soft-deleted page keeps its row in `pages`, so it passes. The check and
    /// the upsert run under one writer: a bound store's own transaction, else a transaction opened here.
    pub fn upsert_chronicle_row(&self, w: &ChronicleRowInput) -> Result<bool> {
        if self.transaction_open() {
            return self.checked_upsert(w);
        }
        let bound = self.begin_transaction(false)?;
        match bound.checked_upsert(w) {
            Ok(written) => {
                bound.commit_transaction()?;
                Ok(written)
            }
            Err(e) => {
                bound.rollback_transaction()?;
                Err(e)
            }
        }
    }

    fn checked_upsert(&self, w: &ChronicleRowInput) -> Result<bool> {
        {
            let read = self.read()?;
            if w.source_id.contains('\0') || read_source(&*read, &w.source_id)?.is_none() {
                return Err(StoreError::new(
                    SOURCE_NOT_FOUND,
                    format!("upsertChronicleRow: no source {:?}", w.source_id),
                ));
            }
            if w.page_id < 0 || read_page_by_id(&*read, w.page_id as u64)?.is_none() {
                return Err(StoreError::new(
                    PAGE_NOT_FOUND,
                    format!("upsertChronicleRow: no page with id {}", w.page_id),
                ));
            }
        }
        self.upsert_chronicle_row_unchecked(w)
    }

    /// The same checked upsert under its older binding name (`upsertChronicleRowChecked`, which the engine member calls).
    pub fn upsert_chronicle_row_checked(&self, w: &ChronicleRowInput) -> Result<bool> {
        self.upsert_chronicle_row(w)
    }

    /// `readChronicleRow(key)`: the row at `(sourceId, pageId, contentHash, extractorVersion)`, or none.
    pub fn read_chronicle_row(&self, k: &ChronicleRowKey) -> Result<Option<ChronicleLedgerRow>> {
        if k.source_id.contains('\0') || k.content_hash.contains('\0') {
            return Ok(None);
        }
        let read = self.read()?;
        let key = row_key(
            &k.source_id,
            k.page_id,
            &k.content_hash,
            k.extractor_version,
        );
        let Some(r) = get_json::<RowView>(&*read, &key)? else {
            return Ok(None);
        };
        Ok(Some(ChronicleLedgerRow {
            source_id: k.source_id.clone(),
            page_id: k.page_id,
            content_hash: r.content_hash,
            extractor_version: k.extractor_version,
            slug: r.slug,
            state: r.state,
            reason: r.reason,
            trigger: r.trigger,
            principal_kind: r.principal_kind,
            principal_id: r.principal_id,
            request_id: r.request_id,
            no_extract: r.no_extract,
            attempts: r.attempts,
            next_attempt_at: r.next_attempt_at,
            cost_usd: r.cost_usd,
            unpriced: r.unpriced,
            event_slugs: r.event_slugs,
            event_hashes: r.event_hashes,
            decided_at: iso(r.decided_at),
            updated_at: iso(r.updated_at),
            campaign_id: r.campaign_id,
            attempt_cap_usd: r.attempt_cap_usd,
            max_attempts: r.max_attempts,
            pricing_policy: r.pricing_policy,
            campaign_max_usd: r.campaign_max_usd,
            cost_attempts: r.cost_attempts,
            judge_input_hash: r.judge_input_hash,
            judge_window_chars: r.judge_window_chars,
            judge_window_hash: r.judge_window_hash,
            judge_input_failures: r.judge_input_failures,
        }))
    }

    /// `hasPendingAutoChronicleRow(sourceId, pageId, extractorVersion)`: an automatic row of the page at that
    /// extractor version is pending and not marked no-extract (the decision add_link carries to its revision).
    pub fn has_pending_auto_chronicle_row(
        &self,
        source_id: &str,
        page_id: i64,
        extractor_version: i32,
    ) -> Result<bool> {
        let read = self.read()?;
        Ok(page_rows(&*read, source_id, page_id)?.iter().any(|(k, r)| {
            version_of(k) == Some(extractor_version)
                && r.state == "pending"
                && r.trigger == "auto"
                && !r.no_extract
        }))
    }

    /// `hasExtractedEvents(sourceId, pageId)`: an extracted row of the page lists at least one event hash.
    pub fn has_extracted_events(&self, source_id: &str, page_id: i64) -> Result<bool> {
        let read = self.read()?;
        Ok(page_rows(&*read, source_id, page_id)?
            .iter()
            .any(|(_, r)| r.state == "extracted" && !r.event_hashes.is_empty()))
    }

    /// `readPageTruthLead(pageId)`: the `truth_lead` of the page (`SELECT truth_lead FROM pages WHERE id=$1`), none
    /// for an inline page, an unpublished shell or a missing page. A negative id matches no page.
    pub fn read_page_truth_lead(&self, page_id: i64) -> Result<Option<String>> {
        if page_id < 0 {
            return Ok(None);
        }
        crate::page_body::truth_lead(&*self.read()?, page_id as u64)
    }

    /// `countRecentChronicleReservations()`: the judge reservations taken in the last 24 hours.
    pub fn count_recent_chronicle_reservations(&self) -> Result<i64> {
        let read = self.read()?;
        let since = self.env.now_micros() - DAY_US;
        Ok(
            scan::<ReservationView>(&*read, &reservation_prefix(), "chronicle reservation")?
                .iter()
                .filter(|(_, r)| r.reserved_at > since)
                .count() as i64,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chronicle_ledger::{ChronicleJudgeKey, ChronicleRowInput};
    use crate::pages::{PageInput, PutPageOptions, read_page};
    use crate::put_json;
    use serde_json::{Value, json};

    fn page_id(store: &Store, slug: &str) -> i64 {
        let input = PageInput {
            page_type: "conversation".into(),
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
            .id as i64
    }

    fn input(
        page: i64,
        hash: &str,
        state: &str,
        trigger: &str,
        no_extract: bool,
    ) -> ChronicleRowInput {
        serde_json::from_value(json!({
            "sourceId": "default", "pageId": page, "contentHash": hash, "extractorVersion": 2, "slug": "a",
            "state": state, "trigger": trigger, "requestId": "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
            "noExtract": no_extract, "nextAttemptAt": "2026-11-20T12:00:00.000Z",
        }))
        .unwrap()
    }

    fn key(page: i64, hash: &str) -> ChronicleRowKey {
        ChronicleRowKey {
            source_id: "default".into(),
            page_id: page,
            content_hash: hash.into(),
            extractor_version: 2,
        }
    }

    /// Sets a stored row's state and events, as the extraction runner would.
    fn extract(store: &Store, page: i64, hash: &str, events: &[&str]) {
        let k = row_key("default", page, hash, 2);
        store
            .write(|tx| {
                let mut r: Value = get_json(&*tx, &k)?.unwrap();
                r["state"] = json!("extracted");
                r["event_hashes"] = json!(events);
                put_json(tx, &k, &r)
            })
            .unwrap();
    }

    #[test]
    fn a_row_reads_back_with_its_columns_and_defaults() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        assert!(
            store
                .upsert_chronicle_row(&input(id, "h1", "pending", "auto", false))
                .unwrap()
        );
        let row = store.read_chronicle_row(&key(id, "h1")).unwrap().unwrap();
        assert_eq!(
            (row.source_id.as_str(), row.page_id, row.extractor_version),
            ("default", id, 2)
        );
        assert_eq!(
            (row.state.as_str(), row.trigger.as_str(), row.slug.as_str()),
            ("pending", "auto", "a")
        );
        assert_eq!(
            row.request_id.as_deref(),
            Some("6f9619ff-8b86-4d01-b42d-00cf4fc964ff")
        );
        assert_eq!(
            row.next_attempt_at.as_deref(),
            Some("2026-11-20T12:00:00.000Z")
        );
        assert_eq!(
            (
                row.attempts,
                row.unpriced,
                row.cost_usd,
                row.judge_input_failures
            ),
            (0, false, None, 0)
        );
        assert!(row.event_hashes.is_empty() && row.campaign_id.is_none());
        assert_eq!(row.decided_at, row.updated_at);
        assert_eq!(store.read_chronicle_row(&key(id, "h2")).unwrap(), None);
        assert_eq!(store.read_chronicle_row(&key(id, "h\0")).unwrap(), None);
    }

    #[test]
    fn the_pending_read_matches_only_an_automatic_extractable_row_at_the_version() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        assert!(
            !store
                .has_pending_auto_chronicle_row("default", id, 2)
                .unwrap()
        );
        store
            .upsert_chronicle_row(&input(id, "h1", "pending", "auto", true))
            .unwrap();
        assert!(
            !store
                .has_pending_auto_chronicle_row("default", id, 2)
                .unwrap(),
            "no-extract"
        );
        store
            .upsert_chronicle_row(&input(id, "h2", "pending", "backfill", false))
            .unwrap();
        assert!(
            !store
                .has_pending_auto_chronicle_row("default", id, 2)
                .unwrap(),
            "backfill"
        );
        store
            .upsert_chronicle_row(&input(id, "h3", "skipped", "auto", false))
            .unwrap();
        assert!(
            !store
                .has_pending_auto_chronicle_row("default", id, 2)
                .unwrap(),
            "skipped"
        );
        store
            .upsert_chronicle_row(&input(id, "h4", "pending", "auto", false))
            .unwrap();
        assert!(
            store
                .has_pending_auto_chronicle_row("default", id, 2)
                .unwrap()
        );
        assert!(
            !store
                .has_pending_auto_chronicle_row("default", id, 3)
                .unwrap()
        );
        assert!(
            !store
                .has_pending_auto_chronicle_row("other", id, 2)
                .unwrap()
        );
        assert!(
            !store
                .has_pending_auto_chronicle_row("default\0", id, 2)
                .unwrap()
        );
    }

    #[test]
    fn extracted_events_need_an_extracted_row_with_an_event() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        store
            .upsert_chronicle_row(&input(id, "A", "pending", "auto", false))
            .unwrap();
        assert!(!store.has_extracted_events("default", id).unwrap());
        extract(&store, id, "A", &[]);
        assert!(
            !store.has_extracted_events("default", id).unwrap(),
            "no events"
        );
        extract(&store, id, "A", &["e1"]);
        assert!(store.has_extracted_events("default", id).unwrap());
        assert!(!store.has_extracted_events("other", id).unwrap());
    }

    #[test]
    fn the_daily_count_reads_the_reservations_of_the_last_day() {
        let store = crate::test_support::store();
        assert_eq!(store.count_recent_chronicle_reservations().unwrap(), 0);
        let k: ChronicleJudgeKey = serde_json::from_value(
            json!({ "sourceId": "default", "pageId": 1, "contentHash": "h" }),
        )
        .unwrap();
        assert!(store.reserve_chronicle_judge_slot(5, &k).unwrap());
        assert!(store.reserve_chronicle_judge_slot(5, &k).unwrap());
        assert_eq!(store.count_recent_chronicle_reservations().unwrap(), 2);
    }

    #[test]
    fn a_hard_page_delete_and_a_source_delete_drop_the_rows() {
        let store = crate::test_support::store();
        let a = page_id(&store, "a");
        let b = page_id(&store, "b");
        store
            .upsert_chronicle_row(&input(a, "h", "pending", "auto", false))
            .unwrap();
        store
            .upsert_chronicle_row(&input(b, "h", "pending", "auto", false))
            .unwrap();
        store.delete_page("a", None).unwrap();
        assert_eq!(store.read_chronicle_row(&key(a, "h")).unwrap(), None);
        assert!(store.read_chronicle_row(&key(b, "h")).unwrap().is_some());
        store.write(|tx| remove_source_rows(tx, "default")).unwrap();
        assert_eq!(store.read_chronicle_row(&key(b, "h")).unwrap(), None);
    }

    /// A stored extracted row carrying the events, the cost attempts, the judge window and a campaign stamp.
    fn seed_extracted(store: &Store, page: i64, hash: &str, updated_at: i64) {
        let k = row_key("default", page, hash, 2);
        let r = json!({
            "content_hash": hash, "slug": "a", "state": "extracted", "reason": null, "trigger": "backfill",
            "principal_kind": null, "principal_id": null, "request_id": null, "no_extract": false,
            "next_attempt_at": null, "cost_usd": 0.25, "unpriced": false, "attempts": 1,
            "decided_at": updated_at, "updated_at": updated_at,
            "event_slugs": ["life/events/2026-11-20-abcd1234"], "event_hashes": ["e1"], "cost_attempts": [1],
            "judge_input_hash": "jih", "judge_window_chars": 4000, "judge_window_hash": "jwh", "judge_input_failures": 2,
            "campaign_id": "campaign-a", "attempt_cap_usd": "0.5", "max_attempts": 3, "pricing_policy": "priced",
            "campaign_max_usd": "5",
        });
        store.write(|tx| put_json(tx, &k, &r)).unwrap();
    }

    fn raw(store: &Store, page: i64, hash: &str) -> Option<Vec<u8>> {
        store
            .read()
            .unwrap()
            .get(&row_key("default", page, hash, 2))
            .unwrap()
    }

    #[test]
    fn an_upsert_that_wins_keeps_the_events_and_judge_columns_and_clears_the_campaign_stamp() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        seed_extracted(&store, id, "h1", 100);
        // A newer extracted generation of the page lets the decision replace the old one.
        seed_extracted(&store, id, "h2", 200);
        assert!(
            store
                .upsert_chronicle_row_checked(&input(id, "h1", "pending", "backfill", false))
                .unwrap()
        );
        let row: Value = serde_json::from_slice(&raw(&store, id, "h1").unwrap()).unwrap();
        let kept = [
            "event_slugs",
            "event_hashes",
            "cost_attempts",
            "judge_input_hash",
            "judge_window_chars",
            "judge_window_hash",
            "judge_input_failures",
        ];
        assert_eq!(
            kept.iter().map(|f| row[*f].clone()).collect::<Vec<_>>(),
            vec![
                json!(["life/events/2026-11-20-abcd1234"]),
                json!(["e1"]),
                json!([1]),
                json!("jih"),
                json!(4000),
                json!("jwh"),
                json!(2),
            ]
        );
        let cleared = [
            "campaign_id",
            "attempt_cap_usd",
            "max_attempts",
            "pricing_policy",
            "campaign_max_usd",
        ];
        assert!(cleared.iter().all(|f| row[*f].is_null()), "{row}");
        assert_eq!(row["state"], json!("pending"));
        let read = store.read_chronicle_row(&key(id, "h1")).unwrap().unwrap();
        assert_eq!(
            (
                read.event_hashes,
                read.judge_input_failures,
                read.campaign_id
            ),
            (vec!["e1".to_string()], 2, None)
        );
    }

    #[test]
    fn an_upsert_the_guard_blocks_leaves_the_record_byte_same() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        seed_extracted(&store, id, "h1", 100);
        let before = raw(&store, id, "h1").unwrap();
        // No newer extracted generation: the extracted row stays.
        assert!(
            !store
                .upsert_chronicle_row_checked(&input(id, "h1", "pending", "auto", false))
                .unwrap()
        );
        assert_eq!(raw(&store, id, "h1").unwrap(), before);
    }

    #[test]
    fn a_missing_source_or_page_refuses_by_name_and_writes_nothing() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        let mut other = input(id, "h", "pending", "auto", false);
        other.source_id = "no-such-source".into();
        let err = store.upsert_chronicle_row_checked(&other).unwrap_err();
        assert_eq!(err.code, SOURCE_NOT_FOUND);
        let err = store
            .upsert_chronicle_row_checked(&input(id + 1000, "h", "pending", "auto", false))
            .unwrap_err();
        assert_eq!(err.code, PAGE_NOT_FOUND);
        assert_eq!(raw(&store, id + 1000, "h"), None);
        let mut written = 0;
        scan_prefix(
            &*store.read().unwrap(),
            &row_prefix(),
            false,
            &mut |_, _| {
                written += 1;
                true
            },
        )
        .unwrap();
        assert_eq!(written, 0);
        // A soft-deleted page keeps its pages row, so its decision is recorded.
        store.soft_delete_page("a", None).unwrap();
        assert!(
            store
                .upsert_chronicle_row_checked(&input(id, "h", "pending", "auto", false))
                .unwrap()
        );
    }

    #[test]
    fn a_checked_upsert_inside_a_bound_transaction_runs_as_one_of_its_statements() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        let bound = store.begin_transaction(false).unwrap();
        assert!(
            bound
                .upsert_chronicle_row_checked(&input(id, "h", "pending", "auto", false))
                .unwrap()
        );
        bound.rollback_transaction().unwrap();
        assert_eq!(store.read_chronicle_row(&key(id, "h")).unwrap(), None);
    }
}
