//! Retrieval feedback: the `retrieval_events`, `retrieval_event_pages`, `retrieval_event_links`,
//! `retrieval_feedback` and `retrieval_weights` tables of the PGLite engine, as the members of
//! `src/core/engine-sql/retrieval-feedback.ts` run them (rust/docs/store/retrieval-feedback.md).
//!
//! Members: insertRetrievalEvents, readRetrievalEvent, applyRetrievalRatings, readFeedbackStatus.
//!
//! Keys (every record starts with `keys::TELEMETRY`, `a`, then the table's sub-tag; the text parts are the table's
//! primary key joined by NUL, and none may hold a NUL byte, so a key is unique and an event's rows share a prefix):
//! - `a 0x04 id` -> `EventRecord`.
//! - `a 0x05 event \0 source \0 slug` -> `EventPageRecord`.
//! - `a 0x06 event \0 source \0 edge_key \0 to_slug` -> `true`.
//! - `a 0x07 event \0 signal \0 kind \0 source \0 key` -> `FeedbackRecord`.
//! - `a 0x08 source \0 kind \0 key` -> `WeightRecord`.
//!
//! The tables carry no page id. A hard page delete scrubs the rows naming its slug, as `scrubPurgedSlugs` does on the
//! SQL engines ([`scrub_purged_slugs`]), and removing a source drops its weights (`retrieval_weights` references
//! `sources(id)` with `ON DELETE CASCADE`, [`remove_source_rows`]). The retention prune and the weight reset stay raw
//! SQL. Weights are `REAL`: they are kept as `f32`; the arithmetic runs in `f64`, as Postgres widens `real` and
//! `numeric` operands to `double precision`, and each result is rounded to `f32` where the SQL casts it or a `REAL`
//! column stores it. They reach TypeScript as the shortest decimal that reads back as the `f32`.

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::{Store, get_json, keys, pages, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const OP_INSERT: &str = "insertRetrievalEvents";
const OP_APPLY: &str = "applyRetrievalRatings";
const OPS: [&str; 5] = ["query", "search", "think", "synthesize", "recall"];
const NEUTRAL: f64 = 0.5;
const WEEK_US: i64 = 7 * 86_400_000_000;

fn key(sub: u8, parts: &[&str]) -> Vec<u8> {
    let mut k = vec![keys::TELEMETRY];
    k.extend(keys::text(sub, parts));
    k
}

/// The prefix every row of `event` shares under `sub`.
fn event_prefix(sub: u8, event: &str) -> Vec<u8> {
    let mut k = key(sub, &[event]);
    k.push(0);
    k
}

fn table_prefix(sub: u8) -> [u8; 2] {
    [keys::TELEMETRY, sub]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EventRecord {
    client_id: String,
    op: String,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EventPageRecord {
    content_hash: Option<String>,
    rank: i32,
    cited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FeedbackRecord {
    client_id: String,
    rating: i32,
    weight_before: f32,
    weight_after: f32,
    applied_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WeightRecord {
    weight: f32,
    content_hash: Option<String>,
    updates: i32,
    updated_at: i64,
}

/// One page a retrieval event returned.
#[derive(Debug, Clone, Deserialize)]
pub struct EventPageInput {
    pub source_id: String,
    pub slug: String,
    pub content_hash: Option<String>,
    pub rank: i32,
    pub cited: bool,
}

/// One link a retrieval event used.
#[derive(Debug, Clone, Deserialize)]
pub struct EventLinkInput {
    pub source_id: String,
    pub edge_key: String,
    pub to_slug: String,
}

/// One element of `insertRetrievalEvents(events)`.
#[derive(Debug, Clone, Deserialize)]
pub struct RetrievalEventInput {
    pub id: String,
    pub client_id: String,
    pub op: String,
    #[serde(default)]
    pub pages: Vec<EventPageInput>,
    #[serde(default)]
    pub links: Vec<EventLinkInput>,
}

/// One rating of `applyRetrievalRatings`.
#[derive(Debug, Clone, Deserialize)]
pub struct RatingTargetInput {
    pub kind: String,
    pub source_id: String,
    pub key: String,
    pub rating: i32,
    pub content_hash: Option<String>,
}

/// `applyRetrievalRatings(args)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RatingBatchInput {
    pub event_id: String,
    pub client_id: String,
    pub signal: String,
    /// Bound as `$6::real`: rounded to `f32`, then widened in the arithmetic.
    pub alpha: f32,
    pub targets: Vec<RatingTargetInput>,
}

fn violation(table: &str, what: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("new row for relation \"{table}\" violates {what}"),
    )
}

/// A float as the shortest decimal that reads back as the same `f32` (what Postgres prints for a `REAL`).
fn real_json(x: f32) -> Value {
    json!(format!("{x}").parse::<f64>().unwrap_or(f64::from(x)))
}

/// `EXISTS (SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2)`: a soft-deleted page counts.
fn page_row_exists(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<bool> {
    Ok(pages::read_page(read, source_id, slug)?.is_some())
}

/// Both ends of an edge key (`from|type|to`) are page rows: the text before the first `|` and after the last.
fn edge_ends_exist(read: &dyn KvRead, source_id: &str, edge_key: &str) -> Result<bool> {
    let first = edge_key.split('|').next().unwrap_or(edge_key);
    let last = edge_key.rsplit('|').next().unwrap_or(edge_key);
    Ok(page_row_exists(read, source_id, first)? && page_row_exists(read, source_id, last)?)
}

/// `LEAST(1, GREATEST(0, x))`.
fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

/// The weight an edited page's learned weight reads at: half its deviation from neutral
/// (`0.5 + (w.weight - 0.5) / 2`, in `double precision`).
fn decayed(weight: f32) -> f64 {
    NEUTRAL + (f64::from(weight) - NEUTRAL) / 2.0
}

fn scan_records<T: for<'de> Deserialize<'de>>(
    read: &dyn KvRead,
    prefix: &[u8],
) -> Result<Vec<(Vec<u8>, T)>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(read, prefix, false, &mut |k, v| {
        match serde_json::from_slice::<T>(v) {
            Ok(r) => rows.push((k.to_vec(), r)),
            Err(e) => {
                bad = Some(StoreError::invalid(format!(
                    "unreadable retrieval feedback record: {e}"
                )));
                return false;
            }
        }
        true
    })?;
    bad.map_or(Ok(rows), Err)
}

impl Store {
    /// `insertRetrievalEvents(events)`: the event rows first (a repeated id keeps its row), then the pages whose page
    /// row exists, then the links whose target and both edge ends exist; a repeated page or link keeps its row.
    pub fn insert_retrieval_events(&self, events: &[RetrievalEventInput]) -> Result<()> {
        for e in events {
            let mut texts: Vec<(&str, &str)> = vec![("id", &e.id), ("client_id", &e.client_id)];
            for p in &e.pages {
                texts.push(("source_id", &p.source_id));
                texts.push(("slug", &p.slug));
            }
            for l in &e.links {
                texts.push(("source_id", &l.source_id));
                texts.push(("edge_key", &l.edge_key));
                texts.push(("to_slug", &l.to_slug));
            }
            no_nul(OP_INSERT, &texts)?;
            if !OPS.contains(&e.op.as_str()) {
                return Err(violation("retrieval_events", "check constraint"));
            }
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            for e in events {
                if get_json::<EventRecord>(&*tx, &key(keys::TELEMETRY_RETRIEVAL_EVENT, &[&e.id]))?
                    .is_none()
                {
                    let record = EventRecord {
                        client_id: e.client_id.clone(),
                        op: e.op.clone(),
                        created_at: now,
                    };
                    put_json(tx, &key(keys::TELEMETRY_RETRIEVAL_EVENT, &[&e.id]), &record)?;
                }
            }
            for e in events {
                for p in &e.pages {
                    let k = key(
                        keys::TELEMETRY_RETRIEVAL_EVENT_PAGE,
                        &[&e.id, &p.source_id, &p.slug],
                    );
                    if !page_row_exists(&*tx, &p.source_id, &p.slug)? || tx.get(&k)?.is_some() {
                        continue;
                    }
                    let record = EventPageRecord {
                        content_hash: p.content_hash.clone(),
                        rank: p.rank,
                        cited: p.cited,
                    };
                    put_json(tx, &k, &record)?;
                }
            }
            for e in events {
                for l in &e.links {
                    if page_row_exists(&*tx, &l.source_id, &l.to_slug)?
                        && edge_ends_exist(&*tx, &l.source_id, &l.edge_key)?
                    {
                        let k = key(
                            keys::TELEMETRY_RETRIEVAL_EVENT_LINK,
                            &[&e.id, &l.source_id, &l.edge_key, &l.to_slug],
                        );
                        put_json(tx, &k, &true)?;
                    }
                }
            }
            Ok(())
        })
    }

    /// `readRetrievalEvent(id)`: the event with its pages by rank (ties by source and slug) and its links by source,
    /// edge key and target in byte order; None when the event is gone.
    pub fn read_retrieval_event(&self, id: &str) -> Result<Option<Value>> {
        no_nul("readRetrievalEvent", &[("id", id)])?;
        let read = self.read()?;
        let Some(event) =
            get_json::<EventRecord>(&*read, &key(keys::TELEMETRY_RETRIEVAL_EVENT, &[id]))?
        else {
            return Ok(None);
        };
        let page_prefix = event_prefix(keys::TELEMETRY_RETRIEVAL_EVENT_PAGE, id);
        let mut pages: Vec<(i32, String, String, EventPageRecord)> =
            scan_records::<EventPageRecord>(&*read, &page_prefix)?
                .into_iter()
                .map(|(k, r)| {
                    let rest = String::from_utf8_lossy(&k[page_prefix.len()..]).into_owned();
                    let (source, slug) = rest.split_once('\0').unwrap_or((&rest, ""));
                    (r.rank, source.to_string(), slug.to_string(), r)
                })
                .collect();
        pages.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
                .then_with(|| a.2.as_bytes().cmp(b.2.as_bytes()))
        });
        let link_prefix = event_prefix(keys::TELEMETRY_RETRIEVAL_EVENT_LINK, id);
        let links: Vec<Value> = scan_records::<bool>(&*read, &link_prefix)?
            .into_iter()
            .map(|(k, _)| {
                let rest = String::from_utf8_lossy(&k[link_prefix.len()..]).into_owned();
                let mut parts = rest.splitn(3, '\0');
                json!({
                    "source_id": parts.next().unwrap_or(""),
                    "edge_key": parts.next().unwrap_or(""),
                    "to_slug": parts.next().unwrap_or(""),
                })
            })
            .collect();
        Ok(Some(json!({
            "id": id,
            "client_id": event.client_id,
            "op": event.op,
            "created_at": iso(event.created_at),
            "pages": pages.iter().map(|(rank, source, slug, r)| json!({
                "source_id": source,
                "slug": slug,
                "content_hash": r.content_hash,
                "rank": rank,
                "cited": r.cited,
            })).collect::<Vec<_>>(),
            "links": links,
        })))
    }

    /// `applyRetrievalRatings(args)`: each rating whose page (or both link ends) exists is stored once per
    /// `(event, signal, element)`; only a newly stored rating moves the element's weight. Every target reads back with
    /// the weights its stored row holds, `newly_applied` set for the ratings this call stored. A rating of a missing
    /// event is a foreign key violation, a rating outside 1 to 5 a check violation.
    pub fn apply_retrieval_ratings(&self, batch: &RatingBatchInput) -> Result<Value> {
        let mut texts: Vec<(&str, &str)> = vec![
            ("eventId", &batch.event_id),
            ("clientId", &batch.client_id),
            ("signal", &batch.signal),
        ];
        for t in &batch.targets {
            texts.push(("kind", &t.kind));
            texts.push(("source_id", &t.source_id));
            texts.push(("key", &t.key));
        }
        no_nul(OP_APPLY, &texts)?;
        let alpha = f64::from(batch.alpha);
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut newly: BTreeMap<(String, String, String), f32> = BTreeMap::new();
            for t in &batch.targets {
                let exists = match t.kind.as_str() {
                    "page" => page_row_exists(&*tx, &t.source_id, &t.key)?,
                    _ => edge_ends_exist(&*tx, &t.source_id, &t.key)?,
                };
                if !exists {
                    continue;
                }
                let weight_key = key(
                    keys::TELEMETRY_RETRIEVAL_WEIGHT,
                    &[&t.source_id, &t.kind, &t.key],
                );
                let current = get_json::<WeightRecord>(&*tx, &weight_key)?;
                // `cur.w_eff` and `calc.w1` (`... ::real`), in double precision.
                let w_eff = match &current {
                    None => NEUTRAL,
                    Some(w) if t.kind == "page" && w.content_hash != t.content_hash => {
                        decayed(w.weight)
                    }
                    Some(w) => f64::from(w.weight),
                };
                let target = f64::from(t.rating.wrapping_sub(1)) / 4.0;
                let w1 = clamp01(w_eff + alpha * (target - w_eff)) as f32;
                let feedback_key = key(
                    keys::TELEMETRY_FEEDBACK,
                    &[&batch.event_id, &batch.signal, &t.kind, &t.source_id, &t.key],
                );
                if tx.get(&feedback_key)?.is_some() {
                    continue;
                }
                if !["explicit", "cited"].contains(&batch.signal.as_str())
                    || !["page", "link"].contains(&t.kind.as_str())
                    || !(1..=5).contains(&t.rating)
                {
                    return Err(violation("retrieval_feedback", "check constraint"));
                }
                if get_json::<EventRecord>(
                    &*tx,
                    &key(keys::TELEMETRY_RETRIEVAL_EVENT, &[&batch.event_id]),
                )?
                .is_none()
                {
                    return Err(StoreError::new(
                        CONSTRAINT_VIOLATION,
                        "insert or update on table \"retrieval_feedback\" violates foreign key constraint",
                    ));
                }
                let record = FeedbackRecord {
                    client_id: batch.client_id.clone(),
                    rating: t.rating,
                    weight_before: w_eff as f32,
                    weight_after: w1,
                    applied_at: now,
                };
                put_json(tx, &feedback_key, &record)?;
                let stored = match current {
                    None => WeightRecord {
                        weight: w1,
                        content_hash: t.content_hash.clone(),
                        updates: 1,
                        updated_at: now,
                    },
                    Some(w) => {
                        let base = if t.kind == "page" && w.content_hash != t.content_hash {
                            decayed(w.weight)
                        } else {
                            f64::from(w.weight)
                        };
                        // `base + $6::real * (rating - 1) / 4.0 - $6::real * base`, left to right.
                        let moved = base + alpha * f64::from(t.rating - 1) / 4.0 - alpha * base;
                        WeightRecord {
                            weight: clamp01(moved) as f32,
                            content_hash: t.content_hash.clone(),
                            updates: w.updates.saturating_add(1),
                            updated_at: now,
                        }
                    }
                };
                put_json(tx, &weight_key, &stored)?;
                newly.insert(
                    (t.kind.clone(), t.source_id.clone(), t.key.clone()),
                    stored.weight,
                );
            }
            let mut rows: BTreeMap<(String, String, String), Value> = BTreeMap::new();
            for t in &batch.targets {
                let feedback_key = key(
                    keys::TELEMETRY_FEEDBACK,
                    &[&batch.event_id, &batch.signal, &t.kind, &t.source_id, &t.key],
                );
                let Some(f) = get_json::<FeedbackRecord>(&*tx, &feedback_key)? else {
                    continue;
                };
                let id = (t.kind.clone(), t.source_id.clone(), t.key.clone());
                let was_new = newly.get(&id).copied();
                rows.insert(
                    id,
                    json!({
                        "kind": t.kind,
                        "source_id": t.source_id,
                        "key": t.key,
                        "rating": f.rating,
                        "weight_before": real_json(f.weight_before),
                        "weight_after": real_json(was_new.unwrap_or(f.weight_after)),
                        "newly_applied": was_new.is_some(),
                    }),
                );
            }
            Ok(Value::Array(rows.into_values().collect()))
        })
    }

    /// `readFeedbackStatus()`: the counts, the last rating time and the top client's share of the week's explicit
    /// ratings, and the ten lowest and highest page weights (ties by source and key in byte order).
    pub fn read_feedback_status(&self) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let events =
            scan_records::<EventRecord>(&*read, &table_prefix(keys::TELEMETRY_RETRIEVAL_EVENT))?
                .len();
        let feedback =
            scan_records::<FeedbackRecord>(&*read, &table_prefix(keys::TELEMETRY_FEEDBACK))?;
        let weights =
            scan_records::<WeightRecord>(&*read, &table_prefix(keys::TELEMETRY_RETRIEVAL_WEIGHT))?;
        let prefix_len = table_prefix(keys::TELEMETRY_FEEDBACK).len();
        let mut explicit = 0;
        let mut cited = 0;
        let mut per_client: BTreeMap<&str, i64> = BTreeMap::new();
        let mut low_ratings: BTreeMap<(String, String), i64> = BTreeMap::new();
        for (k, f) in &feedback {
            let rest = String::from_utf8_lossy(&k[prefix_len..]).into_owned();
            let parts: Vec<&str> = rest.splitn(5, '\0').collect();
            let (signal, kind, source, element) = (parts[1], parts[2], parts[3], parts[4]);
            if signal == "explicit" {
                explicit += 1;
                if f.applied_at > now.saturating_sub(WEEK_US) {
                    *per_client.entry(&f.client_id).or_insert(0) += 1;
                }
            } else {
                cited += 1;
            }
            if kind == "page" && f.rating <= 2 {
                *low_ratings
                    .entry((source.to_string(), element.to_string()))
                    .or_insert(0) += 1;
            }
        }
        let total: i64 = per_client.values().sum();
        let top_share = per_client
            .values()
            .max()
            .filter(|_| total > 0)
            .map(|m| *m as f64 / total as f64);
        let last = feedback.iter().map(|(_, f)| f.applied_at).max();
        let mut pages: Vec<(String, String, f32)> = Vec::new();
        let mut off_neutral = 0;
        for (k, w) in &weights {
            let rest = String::from_utf8_lossy(&k[prefix_len..]).into_owned();
            let parts: Vec<&str> = rest.splitn(3, '\0').collect();
            if (f64::from(w.weight) - 0.5).abs() > 0.01 {
                off_neutral += 1;
            }
            if parts[1] == "page" {
                pages.push((parts[0].to_string(), parts[2].to_string(), w.weight));
            }
        }
        let by_key = |a: &(String, String, f32), b: &(String, String, f32)| {
            a.0.as_bytes()
                .cmp(b.0.as_bytes())
                .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
        };
        let mut lowest: Vec<_> = pages
            .iter()
            .filter(|p| f64::from(p.2) < 0.5)
            .cloned()
            .collect();
        lowest.sort_by(|a, b| a.2.total_cmp(&b.2).then_with(|| by_key(a, b)));
        let mut highest: Vec<_> = pages
            .iter()
            .filter(|p| f64::from(p.2) > 0.5)
            .cloned()
            .collect();
        highest.sort_by(|a, b| b.2.total_cmp(&a.2).then_with(|| by_key(a, b)));
        Ok(json!({
            "counts": {
                "events": events,
                "ratings_explicit": explicit,
                "ratings_cited": cited,
                "weights_total": weights.len(),
                "weights_off_neutral": off_neutral,
                "last_rating_at": last.map(iso),
                "top_client_share_7d": top_share,
            },
            "lowest": lowest.iter().take(10).map(|(s, k, w)| json!({
                "source_id": s,
                "slug": k,
                "weight": real_json(*w),
                "low_ratings": low_ratings.get(&(s.clone(), k.clone())).copied().unwrap_or(0),
            })).collect::<Vec<_>>(),
            "highest": highest.iter().take(10).map(|(s, k, w)| json!({
                "source_id": s,
                "slug": k,
                "weight": real_json(*w),
            })).collect::<Vec<_>>(),
        }))
    }
}

/// `starts_with(key, slug || '|') OR right(key, length(slug) + 1) = '|' || slug`: an edge key names `slug` at either end.
fn edge_names(key: &str, slugs: &[String]) -> bool {
    slugs
        .iter()
        .any(|s| key.starts_with(&format!("{s}|")) || key.ends_with(&format!("|{s}")))
}

/// The retrieval rows of a hard-deleted page's slugs go with it (`scrubPurgedSlugs`, src/core/feedback/store.ts):
/// of `source_id`, the event pages naming a slug, the event links whose target or an edge end is one, and the ratings
/// and weights of a page key or an edge naming one.
pub(crate) fn scrub_purged_slugs(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
    slugs: &[String],
) -> Result<()> {
    let mut doomed: Vec<Vec<u8>> = Vec::new();
    for (sub, keep) in [
        (keys::TELEMETRY_RETRIEVAL_EVENT_PAGE, 3usize),
        (keys::TELEMETRY_RETRIEVAL_EVENT_LINK, 4),
        (keys::TELEMETRY_FEEDBACK, 5),
        (keys::TELEMETRY_RETRIEVAL_WEIGHT, 3),
    ] {
        let prefix = table_prefix(sub);
        scan_prefix(&*tx, &prefix, false, &mut |k, _| {
            let rest = String::from_utf8_lossy(&k[prefix.len()..]).into_owned();
            let parts: Vec<&str> = rest.splitn(keep, '\0').collect();
            let gone = match sub {
                // event \0 source \0 slug
                keys::TELEMETRY_RETRIEVAL_EVENT_PAGE => {
                    parts.get(1) == Some(&source_id)
                        && parts.get(2).is_some_and(|s| slugs.iter().any(|x| x == s))
                }
                // event \0 source \0 edge_key \0 to_slug
                keys::TELEMETRY_RETRIEVAL_EVENT_LINK => {
                    parts.get(1) == Some(&source_id)
                        && (parts.get(3).is_some_and(|s| slugs.iter().any(|x| x == s))
                            || parts.get(2).is_some_and(|e| edge_names(e, slugs)))
                }
                // event \0 signal \0 kind \0 source \0 key
                keys::TELEMETRY_FEEDBACK => {
                    parts.get(3) == Some(&source_id)
                        && match (parts.get(2), parts.get(4)) {
                            (Some(&"page"), Some(key)) => slugs.iter().any(|x| x == key),
                            (Some(&"link"), Some(key)) => edge_names(key, slugs),
                            _ => false,
                        }
                }
                // source \0 kind \0 key
                _ => {
                    parts.first() == Some(&source_id)
                        && match (parts.get(1), parts.get(2)) {
                            (Some(&"page"), Some(key)) => slugs.iter().any(|x| x == key),
                            (Some(&"link"), Some(key)) => edge_names(key, slugs),
                            _ => false,
                        }
                }
            };
            if gone {
                doomed.push(k.to_vec());
            }
            true
        })?;
    }
    for k in doomed {
        tx.delete(&k)?;
    }
    Ok(())
}

/// The rows of a removed source (`removedSourceScrubCtes`, src/core/engine-sql/sources.ts): its event pages, event
/// links and ratings, and its weights (`retrieval_weights` references `sources(id)` with `ON DELETE CASCADE`). The
/// events themselves have no source and stay.
pub(crate) fn remove_source_rows(tx: &mut dyn crate::kv::KvWrite, source_id: &str) -> Result<()> {
    let mut doomed: Vec<Vec<u8>> = Vec::new();
    for (sub, at) in [
        (keys::TELEMETRY_RETRIEVAL_EVENT_PAGE, 1usize),
        (keys::TELEMETRY_RETRIEVAL_EVENT_LINK, 1),
        (keys::TELEMETRY_FEEDBACK, 3),
        (keys::TELEMETRY_RETRIEVAL_WEIGHT, 0),
    ] {
        let prefix = table_prefix(sub);
        scan_prefix(&*tx, &prefix, false, &mut |k, _| {
            let rest = &k[prefix.len()..];
            if rest.split(|b| *b == 0).nth(at) == Some(source_id.as_bytes()) {
                doomed.push(k.to_vec());
            }
            true
        })?;
    }
    for k in doomed {
        tx.delete(&k)?;
    }
    Ok(())
}
