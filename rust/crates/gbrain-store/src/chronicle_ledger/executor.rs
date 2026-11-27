//! The chronicle executor's statements (`src/core/engine-sql/chronicle-executor.ts`, the `chronicleStore()` engine
//! member): the claim, retry, outcome and campaign writes of `chronicle_page_state`, the phase's discovery and
//! candidate reads, and the event reads and timeline writes the event publication makes
//! (rust/docs/store/chronicle-ledger.md, "Executor").
//!
//! Each method answers what its SQL statement answers on PGLite. `next_attempt_at` is kept as the text the writer
//! stored (an ISO instant); a comparison with now parses it. A statement whose SQL has no `ORDER BY` answers in key
//! order here.

use super::{LedgerRecord, decode, page_prefix, row_key, row_prefix};
use crate::chronicle_state::ChronicleLedgerRow;
use crate::cli_reads::entities::arrow_text;
use crate::env::iso;
use crate::error::{PAGE_NOT_FOUND, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::persistence::projection_queue::parse_timestamptz;
use crate::timeline::{TimelineRecord, recompute_latest, remove_entry};
use crate::{Store, get_json, keys, put_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// `(source_id, page_id, content_hash, extractor_version)`, the row's primary key.
#[derive(Debug, Clone, Deserialize)]
pub struct ChronicleKeyTuple(pub String, pub i64, pub String, pub i32);

/// The stamp `queueCampaignRow` queues a row under.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleCampaignQueue {
    pub source_id: String,
    pub page_id: i64,
    pub content_hash: String,
    pub extractor_version: i32,
    pub slug: String,
    pub campaign_id: String,
    pub attempt_cap_usd: f64,
    pub max_attempts: i32,
    pub pricing_policy: String,
    pub max_usd: f64,
    pub default_max_attempts: i32,
}

/// The outcome columns `finish` writes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleFinish {
    pub state: String,
    pub reason: Option<String>,
    pub next_attempt_at: Option<String>,
    pub unpriced: Option<bool>,
    pub event_slugs: Option<Vec<String>>,
    pub event_hashes: Option<Vec<String>>,
    pub attempt: i32,
    pub judge_input_hash: Option<String>,
    pub judge_window_chars: Option<i32>,
    pub judge_window_hash: Option<String>,
    pub keep_judged: bool,
    pub failures: i32,
}

/// The arguments of `discoveryPages`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleDiscovery {
    pub source_id: String,
    pub activated_at: String,
    pub types: Vec<String>,
    pub slug_patterns: Vec<String>,
    pub extractor_version: i32,
    pub limit: i64,
}

/// The arguments of `candidates`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleCandidates {
    pub source_id: String,
    pub extractor_version: i32,
    pub enabled: bool,
    pub default_max_attempts: i32,
    pub retire_reasons: Vec<String>,
    pub limit: i64,
}

/// One stored row with its key.
struct Row {
    source_id: String,
    page_id: i64,
    version: i32,
    key: Vec<u8>,
    record: LedgerRecord,
}

/// The source, page id and extractor version a row key holds (`a 0x0E source \0 page_id BE8 hash \0 version BE4`).
fn key_parts(key: &[u8]) -> Option<(String, i64, i32)> {
    let rest = key.get(2..)?;
    let nul = rest.iter().position(|b| *b == 0)?;
    let source = String::from_utf8(rest[..nul].to_vec()).ok()?;
    let page = i64::from_be_bytes(rest.get(nul + 1..nul + 9)?.try_into().ok()?);
    let version =
        u32::from_be_bytes(rest.get(rest.len().checked_sub(4)?..)?.try_into().ok()?) as i32;
    Some((source, page, version))
}

fn rows_under(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<Row>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, prefix, false, &mut |k, v| {
        let parsed =
            key_parts(k).ok_or_else(|| StoreError::invalid("unreadable chronicle row key"));
        match parsed.and_then(|p| decode::<LedgerRecord>(v, "chronicle row").map(|r| (p, r))) {
            Ok(((source_id, page_id, version), record)) => {
                out.push(Row {
                    source_id,
                    page_id,
                    version,
                    key: k.to_vec(),
                    record,
                });
                true
            }
            Err(e) => {
                bad = Some(e);
                false
            }
        }
    })?;
    bad.map_or(Ok(out), Err)
}

fn all_rows(read: &dyn KvRead) -> Result<Vec<Row>> {
    rows_under(read, &row_prefix())
}

fn source_rows(read: &dyn KvRead, source_id: &str) -> Result<Vec<Row>> {
    let mut prefix = row_prefix().to_vec();
    prefix.extend_from_slice(source_id.as_bytes());
    prefix.push(0);
    rows_under(read, &prefix)
}

/// `next_attempt_at IS NULL OR next_attempt_at <= now()`.
fn due(next: &Option<String>, now: i64) -> Result<bool> {
    match next {
        None => Ok(true),
        Some(t) => Ok(parse_timestamptz(t, "next_attempt_at")? <= now),
    }
}

/// `next_attempt_at > now()` (false for NULL).
fn leased(next: &Option<String>, now: i64) -> Result<bool> {
    Ok(next.is_some() && !due(next, now)?)
}

/// `numeric` text as Postgres prints a JS number bound to `$n::numeric`.
fn numeric_text(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// The row as `SELECT * FROM chronicle_page_state` (or `RETURNING *`) returns it.
fn ledger_row(row: &Row) -> ChronicleLedgerRow {
    let r = &row.record;
    ChronicleLedgerRow {
        source_id: row.source_id.clone(),
        page_id: row.page_id,
        content_hash: r.content_hash.clone(),
        extractor_version: row.version,
        slug: r.slug.clone(),
        state: r.state.clone(),
        reason: r.reason.clone(),
        trigger: r.trigger.clone(),
        principal_kind: r.principal_kind.clone(),
        principal_id: r.principal_id.clone(),
        request_id: r.request_id.clone(),
        no_extract: r.no_extract,
        attempts: r.attempts,
        next_attempt_at: r.next_attempt_at.clone(),
        cost_usd: r.cost_usd,
        unpriced: r.unpriced,
        event_slugs: r.event_slugs.clone(),
        event_hashes: r.event_hashes.clone(),
        decided_at: iso(r.decided_at),
        updated_at: iso(r.updated_at),
        campaign_id: r.campaign_id.clone(),
        attempt_cap_usd: r.attempt_cap_usd.clone(),
        max_attempts: r.max_attempts,
        pricing_policy: r.pricing_policy.clone(),
        campaign_max_usd: r.campaign_max_usd.clone(),
        cost_attempts: r.cost_attempts.clone(),
        judge_input_hash: r.judge_input_hash.clone(),
        judge_window_chars: r.judge_window_chars,
        judge_window_hash: r.judge_window_hash.clone(),
        judge_input_failures: r.judge_input_failures,
    }
}

fn tuple_key(k: &ChronicleKeyTuple) -> Option<Vec<u8>> {
    if k.0.contains('\0') || k.2.contains('\0') {
        return None;
    }
    Some(row_key(&k.0, k.1, &k.2, k.3))
}

fn live(page: &PageRecord) -> bool {
    page.deleted_at_us.is_none()
}

fn frontmatter_text(fm: &Map<String, Value>, path: &[&str]) -> Option<String> {
    let mut v = fm.get(path[0])?;
    for p in &path[1..] {
        v = v.as_object()?.get(*p)?;
    }
    arrow_text(v)
}

/// The live page of `source_id` with id `page_id`.
fn live_page_by_id(read: &dyn KvRead, source_id: &str, page_id: i64) -> Result<Option<PageRecord>> {
    let Ok(id) = u64::try_from(page_id) else {
        return Ok(None);
    };
    Ok(read_page_by_id(read, id)?.filter(|p| live(p) && p.source_id == source_id))
}

impl Store {
    /// `queueCampaignRow(q)`: inserts the backfill row, or re-queues the row at the key unless a guard keeps it; true
    /// when a row was written.
    pub fn chronicle_queue_campaign_row(&self, q: &ChronicleCampaignQueue) -> Result<bool> {
        let k = ChronicleKeyTuple(
            q.source_id.clone(),
            q.page_id,
            q.content_hash.clone(),
            q.extractor_version,
        );
        let Some(key) = tuple_key(&k) else {
            return Ok(false);
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            if q.page_id < 0 || read_page_by_id(&*tx, q.page_id as u64)?.is_none() {
                return Err(StoreError::new(
                    PAGE_NOT_FOUND,
                    format!("queueCampaignRow: no page with id {}", q.page_id),
                ));
            }
            let old: Option<LedgerRecord> = get_json(&*tx, &key)?;
            if let Some(c) = &old {
                let in_flight = matches!(c.state.as_str(), "pending" | "failed");
                let open_backfill = c.trigger == "backfill"
                    && in_flight
                    && c.attempts < c.max_attempts.unwrap_or(q.default_max_attempts);
                let held = in_flight && c.attempts > 0 && leased(&c.next_attempt_at, now)?;
                let newer = c.state != "extracted"
                    || rows_under(&*tx, &page_prefix(&q.source_id, q.page_id))?
                        .iter()
                        .any(|n| {
                            n.record.content_hash != c.content_hash
                                && n.record.state == "extracted"
                                && n.record.updated_at > c.updated_at
                        });
                if open_backfill || held || !newer {
                    return Ok(false);
                }
            }
            let mut record = old.unwrap_or_else(|| LedgerRecord {
                content_hash: q.content_hash.clone(),
                slug: q.slug.clone(),
                state: "pending".into(),
                reason: None,
                trigger: "backfill".into(),
                principal_kind: None,
                principal_id: None,
                request_id: None,
                no_extract: false,
                next_attempt_at: None,
                cost_usd: None,
                unpriced: false,
                attempts: 0,
                decided_at: now,
                updated_at: now,
                event_slugs: Vec::new(),
                event_hashes: Vec::new(),
                cost_attempts: Vec::new(),
                judge_input_hash: None,
                judge_window_chars: None,
                judge_window_hash: None,
                judge_input_failures: 0,
                campaign_id: None,
                attempt_cap_usd: None,
                max_attempts: None,
                pricing_policy: None,
                campaign_max_usd: None,
            });
            record.slug = q.slug.clone();
            record.state = "pending".into();
            record.reason = None;
            record.trigger = "backfill".into();
            record.principal_kind = None;
            record.principal_id = None;
            record.request_id = None;
            record.no_extract = false;
            record.next_attempt_at = None;
            record.attempts = 0;
            record.cost_attempts = Vec::new();
            record.campaign_id = Some(q.campaign_id.clone());
            record.attempt_cap_usd = Some(numeric_text(q.attempt_cap_usd));
            record.max_attempts = Some(q.max_attempts);
            record.pricing_policy = Some(q.pricing_policy.clone());
            record.campaign_max_usd = Some(numeric_text(q.max_usd));
            record.decided_at = now;
            record.updated_at = now;
            put_json(tx, &key, &record)?;
            Ok(true)
        })
    }

    /// `campaignSpentUsd(campaignId)`: the cost of every row of the campaign, 0 when none.
    pub fn chronicle_campaign_spent_usd(&self, campaign_id: &str) -> Result<Value> {
        let read = self.read()?;
        let usd: f64 = all_rows(&*read)?
            .iter()
            .filter(|r| r.record.campaign_id.as_deref() == Some(campaign_id))
            .filter_map(|r| r.record.cost_usd)
            .sum();
        Ok(json!({ "usd": usd }))
    }

    /// `failExhaustedCampaignRows(defaultMaxAttempts)`: a pending campaign row with no attempts left and no live
    /// lease fails as `campaign_exhausted`.
    pub fn chronicle_fail_exhausted_campaign_rows(&self, default_max_attempts: i32) -> Result<()> {
        let now = self.env.now_micros();
        self.write(|tx| {
            for row in all_rows(&*tx)? {
                let r = &row.record;
                if r.campaign_id.is_some()
                    && r.state == "pending"
                    && r.attempts >= r.max_attempts.unwrap_or(default_max_attempts)
                    && due(&r.next_attempt_at, now)?
                {
                    let mut record = row.record.clone();
                    record.state = "failed".into();
                    record.reason = Some("campaign_exhausted".into());
                    record.next_attempt_at = None;
                    record.updated_at = now;
                    put_json(tx, &row.key, &record)?;
                }
            }
            Ok(())
        })
    }

    /// `discoveryPages(...)`: the live chronicle-shaped pages of the source changed since activation that have no row
    /// for their live content at the extractor version, by `updated_at` then id.
    pub fn chronicle_discovery_pages(&self, q: &ChronicleDiscovery) -> Result<Vec<Value>> {
        let since = parse_timestamptz(&q.activated_at, "activatedAt")?;
        let read = self.read()?;
        let rows = source_rows(&*read, &q.source_id)?;
        let mut shaped = Vec::new();
        for p in all_pages(&*read)? {
            let rescued = q
                .slug_patterns
                .iter()
                .map(|pat| crate::facts::like(&p.slug, pat, false))
                .collect::<Result<Vec<bool>>>()?;
            shaped.push((rescued.contains(&true), p));
        }
        let mut pages: Vec<PageRecord> = shaped
            .into_iter()
            .filter(|(_, p)| {
                p.source_id == q.source_id
                    && live(p)
                    && p.content_hash.is_some()
                    && p.updated_at_us >= since
            })
            .filter(|(_, p)| p.page_type != "event" && !p.slug.starts_with("life/"))
            .filter(|(rescued, p)| {
                q.types.contains(&p.page_type)
                    || *rescued
                    || all_rows_with_page(&rows, p.id)
                        .any(|r| r.record.state == "extracted" && !r.record.event_hashes.is_empty())
            })
            .map(|(_, p)| p)
            .filter(|p| {
                !all_rows_with_page(&rows, p.id).any(|r| {
                    Some(&r.record.content_hash) == p.content_hash.as_ref()
                        && r.version == q.extractor_version
                })
            })
            .collect();
        pages.sort_by_key(|p| (p.updated_at_us, p.id));
        let limit = usize::try_from(q.limit).unwrap_or(0);
        pages
            .into_iter()
            .take(limit)
            .map(|p| {
                let segmented = p.compiled_truth.is_null();
                let compiled = match p.compiled_truth.as_deref() {
                    Some(text) => Some(text.to_string()),
                    None => crate::page_body::truth_lead(&*read, p.id)?,
                };
                let body_bytes = if segmented {
                    crate::page_body::segmented_body_bytes(&*read, p.id)?
                } else {
                    None
                };
                Ok(json!({
                    "id": p.id,
                    "slug": p.slug,
                    "type": p.page_type,
                    "compiled_truth": compiled,
                    "body_storage": if segmented { "segmented" } else { "inline" },
                    "body_bytes": body_bytes,
                    "frontmatter": crate::jsonb::order_map(p.frontmatter.clone()),
                    "effective_date": p.effective_date_us.map(iso),
                    "effective_date_source": p.effective_date_source,
                    "content_hash": p.content_hash,
                    "updated_at": iso(p.updated_at_us),
                }))
            })
            .collect()
    }

    /// `candidates(...)`: the claimable rows of the source whose page is live at the row's content, retire-only rows
    /// first, then automatic, then backfill, oldest decision first.
    pub fn chronicle_candidates(&self, q: &ChronicleCandidates) -> Result<Vec<ChronicleLedgerRow>> {
        let now = self.env.now_micros();
        let read = self.read()?;
        let mut out = Vec::new();
        for row in source_rows(&*read, &q.source_id)? {
            let r = &row.record;
            if row.version != q.extractor_version || !due(&r.next_attempt_at, now)? {
                continue;
            }
            let Some(page) = live_page_by_id(&*read, &q.source_id, row.page_id)? else {
                continue;
            };
            if page.content_hash.as_deref() != Some(r.content_hash.as_str()) {
                continue;
            }
            let auto_ok = q.enabled || r.trigger == "backfill";
            let claimable =
                (r.state == "pending" && auto_ok && r.max_attempts.is_none_or(|m| r.attempts < m))
                    || (r.state == "failed"
                        && r.attempts < r.max_attempts.unwrap_or(q.default_max_attempts)
                        && auto_ok
                        && (r.next_attempt_at.is_some()
                            || matches!(
                                r.reason.as_deref(),
                                Some("judge_llm_unavailable" | "no_pricing")
                            )))
                    || (r.state == "skipped"
                        && r.next_attempt_at.is_some()
                        && r.reason
                            .as_ref()
                            .is_some_and(|x| q.retire_reasons.contains(x)));
            if claimable {
                out.push(row);
            }
        }
        out.sort_by(|a, b| {
            let ka = (
                a.record.state != "skipped",
                a.record.trigger != "auto",
                a.record.decided_at,
                a.page_id,
            );
            let kb = (
                b.record.state != "skipped",
                b.record.trigger != "auto",
                b.record.decided_at,
                b.page_id,
            );
            ka.cmp(&kb)
        });
        let limit = usize::try_from(q.limit).unwrap_or(0);
        Ok(out.iter().take(limit).map(ledger_row).collect())
    }

    /// `supersedeStaleRows()`: a pending or failed row whose page no longer holds its content is skipped as
    /// `superseded`.
    pub fn chronicle_supersede_stale_rows(&self) -> Result<()> {
        let now = self.env.now_micros();
        self.write(|tx| {
            for row in all_rows(&*tx)? {
                if !matches!(row.record.state.as_str(), "pending" | "failed") {
                    continue;
                }
                let holds = u64::try_from(row.page_id)
                    .ok()
                    .map(|id| read_page_by_id(&*tx, id))
                    .transpose()?
                    .flatten()
                    .is_some_and(|p| {
                        live(&p)
                            && p.content_hash.as_deref() == Some(row.record.content_hash.as_str())
                    });
                if !holds {
                    let mut record = row.record.clone();
                    record.state = "skipped".into();
                    record.reason = Some("superseded".into());
                    record.next_attempt_at = None;
                    record.updated_at = now;
                    put_json(tx, &row.key, &record)?;
                }
            }
            Ok(())
        })
    }

    /// `claim(key, leaseMs, state, defaultMaxAttempts)`: leases the row when it is in `state`, due, and (for a
    /// campaign row) has an attempt left, consuming that attempt; the leased row, or none.
    pub fn chronicle_claim(
        &self,
        k: &ChronicleKeyTuple,
        lease_ms: i64,
        state: &str,
        default_max_attempts: i32,
    ) -> Result<Option<ChronicleLedgerRow>> {
        let Some(key) = tuple_key(k) else {
            return Ok(None);
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut r) = get_json::<LedgerRecord>(&*tx, &key)? else {
                return Ok(None);
            };
            let campaign_try =
                r.campaign_id.is_some() && matches!(r.state.as_str(), "pending" | "failed");
            if r.state != state
                || !due(&r.next_attempt_at, now)?
                || (campaign_try && r.attempts >= r.max_attempts.unwrap_or(default_max_attempts))
            {
                return Ok(None);
            }
            r.next_attempt_at = Some(iso(now + lease_ms * 1000));
            if campaign_try {
                r.attempts += 1;
            }
            put_json(tx, &key, &r)?;
            Ok(Some(ledger_row(&Row {
                source_id: k.0.clone(),
                page_id: k.1,
                version: k.3,
                key: key.clone(),
                record: r,
            })))
        })
    }

    /// `setNextAttempt(key, at)`: sets the row's next attempt (null clears it).
    pub fn chronicle_set_next_attempt(
        &self,
        k: &ChronicleKeyTuple,
        at: Option<String>,
    ) -> Result<()> {
        let at = at
            .map(|t| parse_timestamptz(&t, "next_attempt_at").map(iso))
            .transpose()?;
        self.update_row(k, |r| {
            r.next_attempt_at = at.clone();
            true
        })
    }

    /// `addAttemptCost(key, costUsd, attempt)`: adds the attempt's cost once per attempt number.
    pub fn chronicle_add_attempt_cost(
        &self,
        k: &ChronicleKeyTuple,
        cost_usd: f64,
        attempt: i32,
    ) -> Result<()> {
        self.update_row(k, |r| {
            if r.cost_attempts.contains(&attempt) {
                return false;
            }
            r.cost_usd = Some(r.cost_usd.unwrap_or(0.0) + cost_usd);
            r.cost_attempts.push(attempt);
            true
        })
    }

    /// `finish(key, f)`: records the outcome while the row is still at attempt `f.attempt`.
    pub fn chronicle_finish(&self, k: &ChronicleKeyTuple, f: &ChronicleFinish) -> Result<()> {
        let next = f
            .next_attempt_at
            .as_ref()
            .map(|t| parse_timestamptz(t, "next_attempt_at").map(iso))
            .transpose()?;
        let now = self.env.now_micros();
        self.update_row(k, |r| {
            if r.attempts != f.attempt {
                return false;
            }
            r.state = f.state.clone();
            r.reason = f.reason.clone();
            r.next_attempt_at = next.clone();
            if let Some(u) = f.unpriced {
                r.unpriced = u;
            }
            if let Some(s) = &f.event_slugs {
                r.event_slugs = s.clone();
            }
            if let Some(h) = &f.event_hashes {
                r.event_hashes = h.clone();
            }
            if !f.keep_judged {
                r.judge_input_hash = f.judge_input_hash.clone();
                r.judge_window_chars = f.judge_window_chars;
                r.judge_window_hash = f.judge_window_hash.clone();
            }
            r.judge_input_failures += f.failures;
            r.updated_at = now;
            true
        })
    }

    fn update_row(
        &self,
        k: &ChronicleKeyTuple,
        change: impl Fn(&mut LedgerRecord) -> bool,
    ) -> Result<()> {
        let Some(key) = tuple_key(k) else {
            return Ok(());
        };
        self.write(|tx| {
            if let Some(mut r) = get_json::<LedgerRecord>(&*tx, &key)?
                && change(&mut r)
            {
                put_json(tx, &key, &r)?;
            }
            Ok(())
        })
    }

    /// `latestJudged(...)`: the newest judged or retired row of the page at another content, with whether one of
    /// its events was retired by `retired_by`; none when there is no such row.
    pub fn chronicle_latest_judged(
        &self,
        source_id: &str,
        page_id: i64,
        extractor_version: i32,
        content_hash: &str,
        retire_reasons: &[String],
        retired_by: &str,
    ) -> Result<Value> {
        let read = self.read()?;
        if source_id.contains('\0') {
            return Ok(Value::Null);
        }
        let mut rows: Vec<Row> = rows_under(&*read, &page_prefix(source_id, page_id))?
            .into_iter()
            .filter(|r| r.version == extractor_version && r.record.content_hash != content_hash)
            .filter(|r| {
                r.record.state == "extracted"
                    || (r.record.state == "skipped"
                        && r.record
                            .reason
                            .as_ref()
                            .is_some_and(|x| retire_reasons.contains(x)))
            })
            .collect();
        rows.sort_by(|a, b| {
            (b.record.decided_at, b.record.updated_at)
                .cmp(&(a.record.decided_at, a.record.updated_at))
        });
        let Some(row) = rows.first() else {
            return Ok(Value::Null);
        };
        let mut retired = false;
        for slug in &row.record.event_slugs {
            if let Some(p) = read_page(&*read, source_id, slug)?
                && p.deleted_at_us.is_some()
                && frontmatter_text(&p.frontmatter, &["retired_by"]).as_deref() == Some(retired_by)
            {
                retired = true;
                break;
            }
        }
        Ok(
            json!({ "state": row.record.state, "judge_input_hash": row.record.judge_input_hash, "retired": retired }),
        )
    }

    /// `inputFailures(...)`: the failures counted against one judge input, and whether one of its rows was refused;
    /// both null when no row has the input.
    pub fn chronicle_input_failures(
        &self,
        source_id: &str,
        page_id: i64,
        extractor_version: i32,
        input_hash: &str,
    ) -> Result<Value> {
        let read = self.read()?;
        if source_id.contains('\0') {
            return Ok(json!({ "attempts": null, "refused": null }));
        }
        let rows: Vec<Row> = rows_under(&*read, &page_prefix(source_id, page_id))?
            .into_iter()
            .filter(|r| {
                r.version == extractor_version
                    && r.record.judge_input_hash.as_deref() == Some(input_hash)
            })
            .collect();
        if rows.is_empty() {
            return Ok(json!({ "attempts": null, "refused": null }));
        }
        let attempts: i64 = rows
            .iter()
            .map(|r| i64::from(r.record.judge_input_failures))
            .sum();
        let refused = rows.iter().any(|r| {
            r.record.state == "skipped" && r.record.reason.as_deref() == Some("judge_refused")
        });
        Ok(json!({ "attempts": attempts, "refused": refused }))
    }

    /// `liveEventSlugs(sourceId, depthSlug)`: the live chronicle event pages of one depth page.
    pub fn chronicle_live_event_slugs(
        &self,
        source_id: &str,
        depth_slug: &str,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut slugs: Vec<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && live(p) && p.page_type == "event")
            .filter(|p| {
                frontmatter_text(&p.frontmatter, &["event", "depth"]).as_deref() == Some(depth_slug)
            })
            .filter(|p| {
                frontmatter_text(&p.frontmatter, &["captured_via"])
                    .is_some_and(|v| v.starts_with("life-chronicle:"))
            })
            .map(|p| p.slug)
            .collect();
        slugs.sort();
        Ok(slugs
            .into_iter()
            .map(|slug| json!({ "slug": slug }))
            .collect())
    }

    /// `eventProducers(sourceId, pageId, slugs)`: the rows of the page whose events overlap `slugs`.
    pub fn chronicle_event_producers(
        &self,
        source_id: &str,
        page_id: i64,
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        if source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        Ok(rows_under(&*read, &page_prefix(source_id, page_id))?
            .into_iter()
            .filter(|r| r.record.event_slugs.iter().any(|s| wanted.contains(s.as_str())))
            .map(|r| {
                json!({ "event_slugs": r.record.event_slugs, "judge_window_chars": r.record.judge_window_chars,
                    "judge_window_hash": r.record.judge_window_hash })
            })
            .collect())
    }

    /// `addAttempt(key)`: counts one more attempt; `[{ attempts }]`, or nothing when the row is missing.
    pub fn chronicle_add_attempt(&self, k: &ChronicleKeyTuple) -> Result<Vec<Value>> {
        let Some(key) = tuple_key(k) else {
            return Ok(Vec::new());
        };
        self.write(|tx| {
            let Some(mut r) = get_json::<LedgerRecord>(&*tx, &key)? else {
                return Ok(Vec::new());
            };
            r.attempts += 1;
            put_json(tx, &key, &r)?;
            Ok(vec![json!({ "attempts": r.attempts })])
        })
    }

    /// `liveEventHashes(sourceId, slugs)`: the content hash of each live page among `slugs`.
    pub fn chronicle_live_event_hashes(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for slug in slugs.iter().collect::<BTreeSet<_>>() {
            if let Some(p) = read_page(&*read, source_id, slug)?
                && live(&p)
            {
                out.push(json!({ "slug": p.slug, "content_hash": p.content_hash }));
            }
        }
        Ok(out)
    }

    /// `livePageId(sourceId, slug)`: the id of the live page, or none.
    pub fn chronicle_live_page_id(&self, source_id: &str, slug: &str) -> Result<Value> {
        let read = self.read()?;
        Ok(read_page(&*read, source_id, slug)?
            .filter(live)
            .map_or(Value::Null, |p| json!({ "id": p.id })))
    }

    /// `deleteEventTimeline(sourceId, slug)`: removes the timeline rows the event page (live or not) projected.
    pub fn chronicle_delete_event_timeline(&self, source_id: &str, slug: &str) -> Result<()> {
        self.write(|tx| {
            let Some(page) = read_page(&*tx, source_id, slug)? else {
                return Ok(());
            };
            let entries = event_entries(&*tx, page.id)?;
            let mut touched = BTreeSet::new();
            for entry in &entries {
                remove_entry(tx, entry)?;
                touched.insert(entry.page_id);
            }
            for page_id in touched {
                recompute_latest(tx, page_id)?;
            }
            Ok(())
        })
    }

    /// `eventTimelineEntry(eventPageId, date)`: the id of the timeline row the event page projected on `date`.
    pub fn chronicle_event_timeline_entry(&self, event_page_id: i64, date: &str) -> Result<Value> {
        let Ok(id) = u64::try_from(event_page_id) else {
            return Ok(Value::Null);
        };
        let read = self.read()?;
        let day = date.get(..10).unwrap_or(date);
        Ok(event_entries(&*read, id)?
            .into_iter()
            .filter(|e| e.date == day)
            .map(|e| e.id)
            .min()
            .map_or(Value::Null, |id| json!({ "id": id })))
    }

    /// `eventDiscriminators(sourceId, slugs)`: the `when`, `where` and `kind` of each page among `slugs`, deleted or
    /// not.
    pub fn chronicle_event_discriminators(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for slug in slugs.iter().collect::<BTreeSet<_>>() {
            if let Some(p) = read_page(&*read, source_id, slug)? {
                out.push(json!({
                    "slug": p.slug,
                    "when": frontmatter_text(&p.frontmatter, &["event", "when"]),
                    "where": frontmatter_text(&p.frontmatter, &["event", "where"]),
                    "kind": frontmatter_text(&p.frontmatter, &["event", "kind"]),
                }));
            }
        }
        Ok(out)
    }
}

fn all_rows_with_page(rows: &[Row], page_id: u64) -> impl Iterator<Item = &Row> {
    rows.iter()
        .filter(move |r| u64::try_from(r.page_id).ok() == Some(page_id))
}

/// Every timeline entry whose event page is `event_page_id`, in key order.
fn event_entries(read: &dyn KvRead, event_page_id: u64) -> Result<Vec<TimelineRecord>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        &[keys::TIMELINE],
        false,
        &mut |_, v| match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(e) => {
                if e.event_page_id == Some(event_page_id) {
                    out.push(e);
                }
                true
            }
            Err(e) => {
                bad = Some(StoreError::from(e));
                false
            }
        },
    )?;
    bad.map_or(Ok(out), Err)
}
