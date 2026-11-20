//! The chronicle statements that `chronicle_backfill` and the advisor's chronicle collector run beside the members of
//! `chronicle_ledger.rs`: the members of `src/core/engine-sql/chronicle-reads.ts` (rust/docs/store/chronicle-reads.md).
//!
//! Members: readChronicleBackfillBatch, queueChronicleCampaignRow, readChronicleCampaignSpentUsd,
//! listChronicleCoverageGapPages.
//!
//! The ledger rows are the `a 0x0E source \0 page_id BE8 hash \0 version BE4` records of `chronicle_ledger.rs`. The
//! campaign writer edits a row as a JSON object, so a column it does not set (the cost, the events, the judge window)
//! keeps its value, as the SQL `ON CONFLICT DO UPDATE` keeps it.

use crate::cli_reads::entities::arrow_text;
use crate::env::{iso, parse_iso};
use crate::error::{PAGE_NOT_FOUND, Result, SOURCE_NOT_FOUND, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::sources::read_source;
use crate::timeline::{TimelineRecord, parse_date};
use crate::{Store, get_json, keys, put_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

const OP_QUEUE: &str = "queueChronicleCampaignRow";
const OP_BATCH: &str = "readChronicleBackfillBatch";
const DAY_US: i64 = 24 * 3_600_000_000;
const COVERAGE_TYPES: [&str; 3] = ["meeting", "conversation", "calendar-event"];

fn row_prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_CHRONICLE_ROW]
}

/// `a 0x0E source \0 page_id BE8`: every row of one page.
fn page_prefix(source_id: &str, page_id: i64) -> Vec<u8> {
    let mut k = row_prefix().to_vec();
    k.extend_from_slice(source_id.as_bytes());
    k.push(0);
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

/// The page id and extractor version of a row key.
fn key_page_and_version(key: &[u8]) -> Option<(i64, i32)> {
    let rest = key.get(2..)?;
    let nul = rest.iter().position(|b| *b == 0)?;
    let page = keys::be8(rest.get(nul + 1..nul + 9)?)? as i64;
    let version = keys::be4(key.get(key.len().checked_sub(4)?..)?)? as i32;
    Some((page, version))
}

/// A ledger row as the backfill batch and the campaign writer read it; the times are microseconds.
#[derive(Debug, Clone, Deserialize)]
struct RowView {
    content_hash: String,
    state: String,
    trigger: String,
    attempts: i32,
    next_attempt_at: Option<String>,
    cost_usd: Option<f64>,
    updated_at: i64,
    #[serde(default)]
    max_attempts: Option<i32>,
    #[serde(default)]
    campaign_id: Option<String>,
}

fn decode<T: for<'de> Deserialize<'de>>(v: &[u8]) -> Result<T> {
    serde_json::from_slice(v)
        .map_err(|e| StoreError::invalid(format!("unreadable chronicle row: {e}")))
}

fn rows_under(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<(Vec<u8>, RowView)>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        prefix,
        false,
        &mut |k, v| match decode::<RowView>(v) {
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
    bad.map_or(Ok(out), Err)
}

/// The query of `readChronicleBackfillBatch`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleBackfillBatchQuery {
    pub types: Vec<String>,
    pub slug_patterns: Vec<String>,
    pub extractor_version: i32,
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
    pub after_id: i64,
    /// The batch size the SQL text spells (`LIMIT 500`).
    pub page_batch: usize,
    /// The backfill attempt limit the SQL text spells (`c.attempts < 5`).
    pub max_attempts: i32,
}

/// The row of `queueChronicleCampaignRow`. The two amounts are the text the SQL engines bind to `::numeric`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleCampaignRowInput {
    pub source_id: String,
    pub page_id: i64,
    pub content_hash: String,
    pub extractor_version: i32,
    pub slug: String,
    pub campaign_id: String,
    pub attempt_cap_usd: String,
    pub max_attempts: i32,
    pub pricing_policy: String,
    pub max_usd: String,
    pub default_max_attempts: i32,
}

fn no_nul(op: &str, fields: &[(&str, &str)]) -> Result<()> {
    match fields.iter().find(|(_, v)| v.contains('\0')) {
        Some((name, _)) => Err(StoreError::invalid(format!(
            "{op}: {name} contains a NUL character"
        ))),
        None => Ok(()),
    }
}

/// `coalesce(p.compiled_truth, p.truth_lead)`.
fn body_or_lead(read: &dyn KvRead, page: &PageRecord) -> Result<Option<String>> {
    match page.compiled_truth.as_deref() {
        Some(text) => Ok(Some(text.to_string())),
        None => crate::page_body::truth_lead(read, page.id),
    }
}

impl Store {
    /// `readChronicleBackfillBatch(q)`: the live pages after `afterId` whose type is one of `types` or whose slug
    /// matches one of `slugPatterns` (`LIKE`), in the scope and updated on or after `since`, in id order, at most
    /// `pageBatch`. `done` is true when a row of the page id at its content hash and the extractor version is
    /// extracted, or is a pending or failed backfill row with fewer than `maxAttempts` attempts.
    pub fn read_chronicle_backfill_batch(&self, q: &ChronicleBackfillBatchQuery) -> Result<Value> {
        let since_us = match q.since.as_deref() {
            Some(text) => Some(
                parse_iso(&format!("{}T00:00:00Z", parse_date(text)?)).ok_or_else(|| {
                    StoreError::invalid(format!("{OP_BATCH}: since is not a date"))
                })?,
            ),
            None => None,
        };
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && p.id as i64 > q.after_id)
            .collect();
        pages.sort_by_key(|p| p.id);
        let rows = ledger_by_page(&*read)?;
        let mut out = Vec::new();
        for page in pages {
            if out.len() >= q.page_batch {
                break;
            }
            let mut shaped = q.types.contains(&page.page_type);
            if !shaped {
                for pattern in &q.slug_patterns {
                    if crate::facts::like(&page.slug, pattern, false)? {
                        shaped = true;
                        break;
                    }
                }
            }
            if !shaped {
                continue;
            }
            let in_scope = match (&q.source_ids, &q.source_id) {
                (Some(ids), _) if !ids.is_empty() => ids.contains(&page.source_id),
                (_, Some(id)) => *id == page.source_id,
                _ => true,
            };
            if !in_scope || since_us.is_some_and(|s| page.updated_at_us < s) {
                continue;
            }
            let done = page.content_hash.as_deref().is_some_and(|hash| {
                rows.get(&(page.id as i64)).is_some_and(|list| {
                    list.iter().any(|(version, r)| {
                        *version == q.extractor_version
                            && r.content_hash == hash
                            && (r.state == "extracted"
                                || (matches!(r.state.as_str(), "pending" | "failed")
                                    && r.trigger == "backfill"
                                    && r.attempts < q.max_attempts))
                    })
                })
            });
            out.push(json!({
                "id": page.id,
                "source_id": page.source_id,
                "slug": page.slug,
                "type": page.page_type,
                "compiled_truth": body_or_lead(&*read, &page)?,
                "frontmatter": Value::Object(page.frontmatter.clone()),
                "effective_date": page.effective_date_us.map(iso),
                "effective_date_source": page.effective_date_source,
                "content_hash": page.content_hash,
                "done": done,
            }));
        }
        Ok(Value::Array(out))
    }

    /// `queueChronicleCampaignRow(w)`: inserts a pending backfill row stamped with the campaign, or restarts the row at
    /// the same key as this campaign's (zero attempts, no lease, no principal) and stamps it now. Returns false when a
    /// guard leaves the old row alone: a backfill row that is pending or failed with attempts left, a pending or
    /// failed row whose lease has not ended, or extracted content no newer generation of the page replaced. A missing
    /// source or page refuses `source_not_found` or `page_not_found` and writes nothing, as the SQL foreign keys do.
    pub fn queue_chronicle_campaign_row(&self, w: &ChronicleCampaignRowInput) -> Result<bool> {
        no_nul(
            OP_QUEUE,
            &[
                ("sourceId", &w.source_id),
                ("contentHash", &w.content_hash),
                ("slug", &w.slug),
                ("campaignId", &w.campaign_id),
                ("pricingPolicy", &w.pricing_policy),
            ],
        )?;
        let now = self.env.now_micros();
        self.write(|tx| {
            // The foreign keys of `chronicle_page_state.source_id` and `.page_id`, checked in that order, as
            // `upsertChronicleRow` checks them (chronicle_state.rs). A soft-deleted page keeps its row, so it passes.
            if read_source(&*tx, &w.source_id)?.is_none() {
                return Err(StoreError::new(
                    SOURCE_NOT_FOUND,
                    format!("{OP_QUEUE}: no source {:?}", w.source_id),
                ));
            }
            if w.page_id < 0 || read_page_by_id(&*tx, w.page_id as u64)?.is_none() {
                return Err(StoreError::new(
                    PAGE_NOT_FOUND,
                    format!("{OP_QUEUE}: no page with id {}", w.page_id),
                ));
            }
            let key = row_key(
                &w.source_id,
                w.page_id,
                &w.content_hash,
                w.extractor_version,
            );
            let old: Option<Map<String, Value>> = get_json(&*tx, &key)?;
            let mut record = match old {
                None => {
                    let mut m = Map::new();
                    m.insert("content_hash".into(), json!(w.content_hash));
                    m.insert("cost_usd".into(), Value::Null);
                    m.insert("unpriced".into(), json!(false));
                    m
                }
                Some(m) => {
                    let c: RowView =
                        serde_json::from_value(Value::Object(m.clone())).map_err(|e| {
                            StoreError::invalid(format!("unreadable chronicle row: {e}"))
                        })?;
                    let open = matches!(c.state.as_str(), "pending" | "failed");
                    if c.trigger == "backfill"
                        && open
                        && c.attempts < c.max_attempts.unwrap_or(w.default_max_attempts)
                    {
                        return Ok(false);
                    }
                    if open
                        && c.attempts > 0
                        && let Some(text) = &c.next_attempt_at
                    {
                        let lease = parse_iso(text).ok_or_else(|| {
                            StoreError::invalid(format!(
                                "{OP_QUEUE}: unreadable next_attempt_at {text:?}"
                            ))
                        })?;
                        if lease > now {
                            return Ok(false);
                        }
                    }
                    if c.state == "extracted" {
                        let newer = rows_under(&*tx, &page_prefix(&w.source_id, w.page_id))?
                            .iter()
                            .any(|(_, n)| {
                                n.content_hash != c.content_hash
                                    && n.state == "extracted"
                                    && n.updated_at > c.updated_at
                            });
                        if !newer {
                            return Ok(false);
                        }
                    }
                    m
                }
            };
            for (column, value) in [
                ("slug", json!(w.slug)),
                ("state", json!("pending")),
                ("reason", Value::Null),
                ("trigger", json!("backfill")),
                ("principal_kind", Value::Null),
                ("principal_id", Value::Null),
                ("request_id", Value::Null),
                ("no_extract", json!(false)),
                ("next_attempt_at", Value::Null),
                ("attempts", json!(0)),
                ("cost_attempts", json!([])),
                ("campaign_id", json!(w.campaign_id)),
                ("attempt_cap_usd", json!(w.attempt_cap_usd)),
                ("max_attempts", json!(w.max_attempts)),
                ("pricing_policy", json!(w.pricing_policy)),
                ("campaign_max_usd", json!(w.max_usd)),
                ("decided_at", json!(now)),
                ("updated_at", json!(now)),
            ] {
                record.insert(column.into(), value);
            }
            put_json(tx, &key, &Value::Object(record))?;
            Ok(true)
        })
    }

    /// `readChronicleCampaignSpentUsd(campaignId)`: the sum of `cost_usd` over the campaign's rows, 0 for none.
    pub fn read_chronicle_campaign_spent_usd(&self, campaign_id: &str) -> Result<f64> {
        let read = self.read()?;
        Ok(rows_under(&*read, &row_prefix())?
            .iter()
            .filter(|(_, r)| r.campaign_id.as_deref() == Some(campaign_id))
            .filter_map(|(_, r)| r.cost_usd)
            // `COALESCE(sum(...), 0)` is +0; an empty `Iterator::sum` of f64 is -0.
            .fold(0.0, |total, usd| total + usd))
    }

    /// `listChronicleCoverageGapPages()`: the live meeting, conversation and calendar-event pages updated in the last
    /// 30 days that hold no timeline entry linked to an event page, in id order, with `frontmatter->>'date'` and
    /// `frontmatter->>'start'`.
    pub fn list_chronicle_coverage_gap_pages(&self) -> Result<Value> {
        let read = self.read()?;
        let cutoff = self.env.now_micros() - 30 * DAY_US;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.deleted_at_us.is_none()
                    && COVERAGE_TYPES.contains(&p.page_type.as_str())
                    && p.updated_at_us > cutoff
            })
            .collect();
        pages.sort_by_key(|p| p.id);
        let mut out = Vec::new();
        for page in pages {
            if has_event_entry(&*read, page.id)? {
                continue;
            }
            let fm = |k: &str| page.frontmatter.get(k).and_then(arrow_text);
            out.push(json!({
                "type": page.page_type,
                "effective_date": page.effective_date_us.map(iso),
                "effective_date_source": page.effective_date_source,
                "fm_date": fm("date"),
                "fm_start": fm("start"),
            }));
        }
        Ok(Value::Array(out))
    }
}

/// Every ledger row with its extractor version, by page id (`c.page_id = p.id` matches any source).
fn ledger_by_page(read: &dyn KvRead) -> Result<HashMap<i64, Vec<(i32, RowView)>>> {
    let mut by_page: HashMap<i64, Vec<(i32, RowView)>> = HashMap::new();
    for (key, row) in rows_under(read, &row_prefix())? {
        let (page, version) = key_page_and_version(&key)
            .ok_or_else(|| StoreError::invalid("unreadable chronicle row key"))?;
        by_page.entry(page).or_default().push((version, row));
    }
    Ok(by_page)
}

/// A timeline entry of the page with an event page.
fn has_event_entry(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    let mut found = false;
    let mut failure = None;
    scan_prefix(read, &keys::timeline_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(entry) => found = entry.event_page_id.is_some(),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none() && !found
    })?;
    failure.map_or(Ok(found), Err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chronicle_ledger::ChronicleRowInput;
    use crate::pages::{PageInput, PutPageOptions, read_page};

    fn put(store: &Store, slug: &str, page_type: &str, frontmatter: Value) -> (i64, String) {
        let input = PageInput {
            page_type: page_type.into(),
            title: slug.into(),
            compiled_truth: format!("body of {slug}"),
            frontmatter: frontmatter.as_object().cloned(),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        let page = read_page(&*store.read().unwrap(), "default", slug)
            .unwrap()
            .unwrap();
        (page.id as i64, page.content_hash.unwrap())
    }

    fn decide(store: &Store, page: i64, hash: &str, state: &str, trigger: &str) {
        let row: ChronicleRowInput = serde_json::from_value(json!({
            "sourceId": "default", "pageId": page, "contentHash": hash, "extractorVersion": 2, "slug": "s",
            "state": state, "trigger": trigger,
        }))
        .unwrap();
        assert!(store.upsert_chronicle_row(&row).unwrap());
    }

    /// Sets columns of a stored row, as the extraction runner would.
    fn patch(store: &Store, page: i64, hash: &str, columns: Value) {
        let k = row_key("default", page, hash, 2);
        store
            .write(|tx| {
                let mut r: Value = get_json(&*tx, &k)?.unwrap();
                for (c, v) in columns.as_object().unwrap() {
                    r[c] = v.clone();
                }
                put_json(tx, &k, &r)
            })
            .unwrap();
    }

    fn campaign(page: i64, hash: &str, id: &str) -> ChronicleCampaignRowInput {
        serde_json::from_value(json!({
            "sourceId": "default", "pageId": page, "contentHash": hash, "extractorVersion": 2, "slug": "q",
            "campaignId": id, "attemptCapUsd": "0.25", "maxAttempts": 3, "pricingPolicy": "enforced",
            "maxUsd": "12.5", "defaultMaxAttempts": 5,
        }))
        .unwrap()
    }

    fn row(store: &Store, page: i64, hash: &str) -> Value {
        get_json(&*store.read().unwrap(), &row_key("default", page, hash, 2))
            .unwrap()
            .unwrap()
    }

    fn batch(store: &Store, extra: Value) -> Vec<Value> {
        let mut q = json!({
            "types": ["meeting"], "slugPatterns": ["cal/%"], "extractorVersion": 2, "afterId": 0,
            "pageBatch": 500, "maxAttempts": 5,
        });
        for (k, v) in extra.as_object().unwrap() {
            q[k] = v.clone();
        }
        let q: ChronicleBackfillBatchQuery = serde_json::from_value(q).unwrap();
        match store.read_chronicle_backfill_batch(&q).unwrap() {
            Value::Array(rows) => rows,
            other => panic!("not an array: {other}"),
        }
    }

    fn slugs(rows: &[Value]) -> Vec<&str> {
        rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
    }

    #[test]
    fn the_batch_takes_typed_and_rescued_pages_in_scope_after_the_cursor() {
        let store = crate::test_support::store();
        let (m1, _) = put(&store, "meetings/a", "meeting", json!({}));
        put(&store, "notes/b", "note", json!({}));
        put(&store, "cal/c", "note", json!({}));
        put(&store, "calendar/d", "note", json!({}));
        assert_eq!(slugs(&batch(&store, json!({}))), ["meetings/a", "cal/c"]);
        assert_eq!(slugs(&batch(&store, json!({ "afterId": m1 }))), ["cal/c"]);
        assert_eq!(
            slugs(&batch(&store, json!({ "pageBatch": 1 }))),
            ["meetings/a"]
        );
        assert!(batch(&store, json!({ "sourceId": "other" })).is_empty());
        assert_eq!(
            batch(
                &store,
                json!({ "sourceIds": ["default"], "sourceId": "other" })
            )
            .len(),
            2
        );
        assert!(batch(&store, json!({ "since": "2999-01-01" })).is_empty());
        assert_eq!(batch(&store, json!({ "since": "2000-01-01" })).len(), 2);
        let first = &batch(&store, json!({}))[0];
        assert_eq!(first["compiled_truth"], json!("body of meetings/a"));
        assert_eq!(first["done"], json!(false));
        store.soft_delete_page("cal/c", None).unwrap();
        assert_eq!(slugs(&batch(&store, json!({}))), ["meetings/a"]);
    }

    #[test]
    fn done_is_extracted_content_or_an_open_backfill_with_attempts_left() {
        let store = crate::test_support::store();
        let (id, hash) = put(&store, "meetings/a", "meeting", json!({}));
        let done = |s: &Store| batch(s, json!({}))[0]["done"].clone();
        decide(&store, id, &hash, "pending", "auto");
        assert_eq!(done(&store), json!(false));
        decide(&store, id, &hash, "pending", "backfill");
        assert_eq!(done(&store), json!(true));
        patch(&store, id, &hash, json!({ "attempts": 5 }));
        assert_eq!(done(&store), json!(false));
        assert_eq!(
            batch(&store, json!({ "extractorVersion": 3 }))[0]["done"],
            json!(false)
        );
        decide(&store, id, "other", "extracted", "auto");
        assert_eq!(done(&store), json!(false));
        patch(&store, id, &hash, json!({ "state": "extracted" }));
        assert_eq!(done(&store), json!(true));
    }

    #[test]
    fn the_campaign_queue_stamps_a_row_and_keeps_its_other_columns() {
        let store = crate::test_support::store();
        let (id, hash) = put(&store, "meetings/a", "meeting", json!({}));
        assert!(
            store
                .queue_chronicle_campaign_row(&campaign(id, &hash, "c1"))
                .unwrap()
        );
        let r = row(&store, id, &hash);
        assert_eq!(
            (
                &r["state"],
                &r["trigger"],
                &r["campaign_id"],
                &r["attempt_cap_usd"]
            ),
            (
                &json!("pending"),
                &json!("backfill"),
                &json!("c1"),
                &json!("0.25")
            )
        );
        assert_eq!(
            (&r["max_attempts"], &r["campaign_max_usd"], &r["attempts"]),
            (&json!(3), &json!("12.5"), &json!(0))
        );
        // A queued row with attempts left refuses; once its stamped attempts are used, the next campaign takes it.
        assert!(
            !store
                .queue_chronicle_campaign_row(&campaign(id, &hash, "c2"))
                .unwrap()
        );
        patch(
            &store,
            id,
            &hash,
            json!({ "attempts": 3, "state": "failed", "cost_usd": 0.5, "event_hashes": ["e"] }),
        );
        assert!(
            store
                .queue_chronicle_campaign_row(&campaign(id, &hash, "c2"))
                .unwrap()
        );
        let r = row(&store, id, &hash);
        assert_eq!(
            (
                &r["campaign_id"],
                &r["attempts"],
                &r["cost_usd"],
                &r["event_hashes"]
            ),
            (&json!("c2"), &json!(0), &json!(0.5), &json!(["e"]))
        );
        assert_eq!(store.read_chronicle_campaign_spent_usd("c2").unwrap(), 0.5);
        let none = store.read_chronicle_campaign_spent_usd("c1").unwrap();
        assert!(none == 0.0 && none.is_sign_positive());
    }

    #[test]
    fn the_campaign_queue_refuses_a_held_lease_and_current_extracted_content() {
        let store = crate::test_support::store();
        let (id, hash) = put(&store, "meetings/a", "meeting", json!({}));
        decide(&store, id, &hash, "pending", "auto");
        patch(
            &store,
            id,
            &hash,
            json!({ "attempts": 1, "next_attempt_at": "2999-01-01T00:00:00.000Z" }),
        );
        assert!(
            !store
                .queue_chronicle_campaign_row(&campaign(id, &hash, "c"))
                .unwrap()
        );
        patch(
            &store,
            id,
            &hash,
            json!({ "next_attempt_at": "2000-01-01T00:00:00.000Z" }),
        );
        assert!(
            store
                .queue_chronicle_campaign_row(&campaign(id, &hash, "c"))
                .unwrap()
        );
        decide(&store, id, "h2", "extracted", "auto");
        assert!(
            !store
                .queue_chronicle_campaign_row(&campaign(id, "h2", "c"))
                .unwrap()
        );
        decide(&store, id, "h3", "extracted", "auto");
        assert!(
            store
                .queue_chronicle_campaign_row(&campaign(id, "h2", "c"))
                .unwrap()
        );
        assert!(
            store
                .queue_chronicle_campaign_row(&campaign(id, "h\0", "c"))
                .is_err()
        );
        let mut other = campaign(id, "h4", "c");
        other.source_id = "nope".into();
        let e = store.queue_chronicle_campaign_row(&other).unwrap_err();
        assert_eq!(e.code, SOURCE_NOT_FOUND);
        let e = store
            .queue_chronicle_campaign_row(&campaign(id + 1000, "h4", "c"))
            .unwrap_err();
        assert_eq!(e.code, PAGE_NOT_FOUND);
        let gone: Option<Value> = get_json(
            &*store.read().unwrap(),
            &row_key("default", id + 1000, "h4", 2),
        )
        .unwrap();
        assert!(gone.is_none());
    }

    #[test]
    fn the_coverage_gap_lists_recent_chronicle_pages_with_no_event_entry() {
        let store = crate::test_support::store();
        let (a, _) = put(
            &store,
            "meetings/a",
            "meeting",
            json!({ "date": "2026-01-02" }),
        );
        put(
            &store,
            "conversations/b",
            "conversation",
            json!({ "start": 7 }),
        );
        put(&store, "notes/c", "note", json!({}));
        put(&store, "cal/d", "calendar-event", json!({}));
        let types = |s: &Store| -> Vec<Value> {
            match s.list_chronicle_coverage_gap_pages().unwrap() {
                Value::Array(rows) => rows,
                other => panic!("not an array: {other}"),
            }
        };
        let rows = types(&store);
        assert_eq!(rows.len(), 3);
        assert_eq!(
            (&rows[0]["type"], &rows[0]["fm_date"], &rows[0]["fm_start"]),
            (&json!("meeting"), &json!("2026-01-02"), &Value::Null)
        );
        assert_eq!(rows[1]["fm_start"], json!("7"));
        let entry = |event: Option<u64>| {
            json!({ "id": 1, "page_id": a, "date": "2026-01-02", "source": "", "summary": "s", "detail": "",
                "event_page_id": event, "created_at_us": 0 })
        };
        let key = keys::timeline(a as u64, "2026-01-02", 1);
        store.write(|tx| put_json(tx, &key, &entry(None))).unwrap();
        assert_eq!(types(&store).len(), 3);
        store
            .write(|tx| put_json(tx, &key, &entry(Some(9))))
            .unwrap();
        let rows = types(&store);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["type"], json!("conversation"));
    }
}
