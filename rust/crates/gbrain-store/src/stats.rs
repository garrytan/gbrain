//! Brain statistics, health and the ingest log: the reads behind `getStats`, `getHealth`,
//! `listEnrichCandidates` and `findAnomalies`, and the `ingest_log` table of the PGLite engine.
//!
//! Members: getStats, getHealth, logIngest, getIngestLog, listEnrichCandidates, findAnomalies.
//!
//! Keys: an ingest log row lives at `n <created_at> <id>`, both 8 bytes big-endian. `created_at`
//! is the row's microsecond timestamp with the sign bit flipped (so the byte order is the
//! numeric order), `id` the `M next_ingest_log_id` counter. One reverse scan reads
//! `ORDER BY created_at DESC` (ties: the newer id first). The value is the JSON of
//! `IngestRecord`. A page delete or a source delete leaves the log alone, as in PGLite (the
//! table has no foreign key). No other record of this family is stored: the other members read
//! pages, chunks, links, tags, timeline entries, sources and config through their families.
//!
//! Scope: the TypeScript members compute the source scope the way each PGLite member does and
//! pass it as `scope` (`null` = every source; an empty list matches nothing).
//!
//! Embeddings: a chunk counts as embedded when it has a stored vector (`EmbedState::has_vector`,
//! PGLite's `embedding IS NOT NULL`). `getStats` counts every chunk of a page in the scope;
//! `getHealth` counts only the chunks of live pages without `embed_skip`. The salience weight of
//! the `'salience'` enrich order comes from the salience family. See rust/docs/store/stats.md.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::chunks::read_chunks;
use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::{in_links, no_nul, out_links};
use crate::pages::{PageRecord, all_pages, next_id};
use crate::sources::all_sources;
use crate::timeline::TimelineOptions;
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

const NEXT_INGEST_LOG_ID: &str = "next_ingest_log_id";
/// `MIN_ENTITY_PAGES_FOR_COVERAGE` is applied by the TypeScript member; `most_connected` keeps
/// this many pages (`LIMIT 5` in `engine-sql/health.ts`).
const MOST_CONNECTED: usize = 5;
const DAY_US: i64 = 86_400_000_000;

/// What is stored for an ingest log row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct IngestRecord {
    id: u64,
    source_id: String,
    source_type: String,
    source_ref: String,
    pages_updated: Value,
    summary: String,
    created_at_us: i64,
}

impl IngestRecord {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "source_id": self.source_id,
            "source_type": self.source_type,
            "source_ref": self.source_ref,
            "pages_updated": self.pages_updated,
            "summary": self.summary,
            "created_at": iso(self.created_at_us),
        })
    }
}

fn ingest_key(created_at_us: i64, id: u64) -> Vec<u8> {
    let mut key = vec![keys::INGEST_LOG];
    key.extend_from_slice(&((created_at_us as u64) ^ (1 << 63)).to_be_bytes());
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// Input of `logIngest`. `pages_updated_json` is the text PGLite binds for the `jsonb` column
/// (`JSON.stringify(entry.pages_updated)`); `None` is SQL NULL.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct IngestInput {
    pub source_id: Option<String>,
    pub source_type: Option<String>,
    pub source_ref: Option<String>,
    pub pages_updated_json: Option<String>,
    pub summary: Option<String>,
}

/// Options of `getIngestLog`; the member resolves `limit` (`opts.limit || 50`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IngestLogOptions {
    /// A JS number: rounded half away from zero, as Postgres casts a bound numeric to bigint.
    pub limit: Option<f64>,
    pub source_ids: Option<Vec<String>>,
}

/// A source scope: `None` reads every source; an empty list matches nothing.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ScopeInput {
    pub scope: Option<Vec<String>>,
}

/// One per-source entity type list (`EntityTypeFilter.per_source`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct EntitySourceTypes {
    pub source_id: String,
    pub types: Vec<String>,
}

/// `EntityTypeFilter` of `schema-pack/entity-types.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct EntityTypeFilter {
    pub types: Vec<String>,
    pub per_source: Vec<EntitySourceTypes>,
}

/// Input of `getHealth`: the scope and the resolved entity type filter.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HealthInput {
    pub scope: Option<Vec<String>>,
    pub entity_types: EntityTypeFilter,
}

/// Input of `listEnrichCandidates`, already clamped by the member.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EnrichInput {
    pub types: Vec<String>,
    pub thin_threshold: f64,
    pub order: String,
    /// A JS number, rounded as Postgres casts it to bigint.
    pub limit: f64,
    /// Pages whose `frontmatter->>'enriched_at'` is greater than this text are skipped.
    pub enriched_after: Option<String>,
    pub scope: Option<Vec<String>>,
}

/// Input of `findAnomalies`: the scope and the window bounds the member computed, in
/// microseconds since the epoch. The bounds are JS numbers (whole, below 2^53), so they cross the
/// addon as floats.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AnomalyInput {
    pub scope: Option<Vec<String>>,
    pub baseline_start_us: f64,
    pub since_us: f64,
    pub since_end_us: f64,
}

fn in_scope(scope: &Option<HashSet<String>>, page: &PageRecord) -> bool {
    scope.as_ref().is_none_or(|s| s.contains(&page.source_id))
}

fn scope_set(scope: &Option<Vec<String>>) -> Option<HashSet<String>> {
    scope.as_ref().map(|ids| ids.iter().cloned().collect())
}

fn live(page: &PageRecord) -> bool {
    page.deleted_at_us.is_none()
}

/// `QUARANTINE_FILTER_FRAGMENT`: the frontmatter has a `quarantine` key.
fn quarantined(page: &PageRecord) -> bool {
    page.frontmatter.contains_key("quarantine")
}

/// `frontmatter ->> key`: SQL NULL for a missing key or a JSON null, the text of a string, the
/// JSON text of anything else.
fn frontmatter_text(page: &PageRecord, key: &str) -> Option<String> {
    match page.frontmatter.get(key)? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        other => Some(other.to_string()),
    }
}

/// Postgres refuses a `jsonb` string holding `\u0000`.
fn json_has_nul(value: &Value) -> bool {
    match value {
        Value::String(s) => s.contains('\0'),
        Value::Array(items) => items.iter().any(json_has_nul),
        Value::Object(map) => map.iter().any(|(k, v)| k.contains('\0') || json_has_nul(v)),
        _ => false,
    }
}

/// `jsonb` keeps one value per key (the last) and orders keys by length, then bytes.
fn jsonb_normalize(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(jsonb_normalize).collect()),
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map
                .into_iter()
                .map(|(k, v)| (k, jsonb_normalize(v)))
                .collect();
            entries.sort_by(|(a, _), (b, _)| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
            Value::Object(entries.into_iter().collect::<Map<String, Value>>())
        }
        other => other,
    }
}

fn not_null(column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"ingest_log\" violates not-null constraint"
        ),
    )
}

/// Every page by id, soft-deleted pages included.
fn pages_by_id(read: &dyn KvRead) -> Result<HashMap<u64, PageRecord>> {
    Ok(all_pages(read)?.into_iter().map(|p| (p.id, p)).collect())
}

/// `pages_by_type`: live pages per type, the largest count first (ties in type byte order).
fn pages_by_type(pages: &[&PageRecord]) -> Map<String, Value> {
    let mut counts: BTreeMap<&str, u64> = BTreeMap::new();
    for page in pages {
        *counts.entry(page.page_type.as_str()).or_default() += 1;
    }
    let mut rows: Vec<(&str, u64)> = counts.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    rows.into_iter()
        .map(|(t, n)| (t.to_string(), json!(n)))
        .collect()
}

/// The links counted by `link_count`: all of them unscoped; scoped, both endpoints exist and are
/// in scope (soft-deleted endpoints count, as the `EXISTS` of PGLite does).
fn count_links(
    read: &dyn KvRead,
    pages: &HashMap<u64, PageRecord>,
    scope: &Option<HashSet<String>>,
) -> Result<u64> {
    let mut count = 0;
    for page in pages.values() {
        for link in out_links(read, page.id)? {
            let counted = match scope {
                None => true,
                Some(_) => {
                    in_scope(scope, page)
                        && pages
                            .get(&link.to_page_id)
                            .is_some_and(|t| in_scope(scope, t))
                }
            };
            if counted {
                count += 1;
            }
        }
    }
    Ok(count)
}

impl Store {
    /// The number of timeline entries of one page (soft-deleted pages included).
    fn timeline_count(&self, page: &PageRecord, limit: i64) -> Result<usize> {
        Ok(self
            .get_timeline(
                &page.slug,
                &TimelineOptions {
                    limit: Some(limit),
                    source_id: Some(page.source_id.clone()),
                    ..TimelineOptions::default()
                },
            )?
            .len())
    }

    /// `getStats`: page, chunk, embedding, link, tag and timeline counts, and live pages per
    /// type. Returns `BrainStats`.
    pub fn get_stats(&self, input: &ScopeInput) -> Result<Value> {
        let scope = scope_set(&input.scope);
        let read = self.read()?;
        let pages = pages_by_id(&*read)?;
        let scoped: Vec<&PageRecord> = pages.values().filter(|p| in_scope(&scope, p)).collect();
        let live_pages: Vec<&PageRecord> = scoped.iter().copied().filter(|p| live(p)).collect();
        let mut chunk_count = 0usize;
        let mut embedded_count = 0usize;
        let mut tags: BTreeSet<&str> = BTreeSet::new();
        let mut timeline_entry_count = 0usize;
        for page in &scoped {
            let chunks = read_chunks(&*read, page.id)?;
            chunk_count += chunks.len();
            embedded_count += chunks.iter().filter(|c| c.embed.has_vector()).count();
            tags.extend(page.tags.iter().map(String::as_str));
            timeline_entry_count += self.timeline_count(page, i64::MAX)?;
        }
        Ok(json!({
            "page_count": live_pages.len(),
            "chunk_count": chunk_count,
            "embedded_count": embedded_count,
            "link_count": count_links(&*read, &pages, &scope)?,
            "tag_count": tags.len(),
            "timeline_entry_count": timeline_entry_count,
            "pages_by_type": pages_by_type(&live_pages),
        }))
    }

    /// The store half of `getHealth` (`engine-sql/health.ts`): the counters of statement 1, the
    /// live unquarantined pages of statement 2 before the orphan policy (which the member
    /// applies), and statement 3 (`most_connected`).
    pub fn get_health(&self, input: &HealthInput) -> Result<Value> {
        let scope = scope_set(&input.scope);
        let per_source: HashMap<&str, &Vec<String>> = input
            .entity_types
            .per_source
            .iter()
            .map(|b| (b.source_id.as_str(), &b.types))
            .collect();
        let is_entity = |page: &PageRecord| {
            per_source
                .get(page.source_id.as_str())
                .copied()
                .unwrap_or(&input.entity_types.types)
                .contains(&page.page_type)
        };
        let read = self.read()?;
        let pages = pages_by_id(&*read)?;
        let live_in_scope = |id: u64| {
            pages
                .get(&id)
                .is_some_and(|p| live(p) && in_scope(&scope, p))
        };

        let mut page_count = 0u64;
        let mut eligible = 0u64;
        let mut embedded = 0u64;
        let mut dead_links = 0u64;
        let mut entity_page_count = 0u64;
        let mut entity_linked = 0u64;
        let mut entity_with_timeline = 0u64;
        let mut linkable = Vec::new();
        let mut connected: Vec<(u64, &str, u64)> = Vec::new();

        let mut ordered: Vec<&PageRecord> = pages.values().collect();
        ordered.sort_by_key(|p| p.id);
        for page in ordered {
            let outs = out_links(&*read, page.id)?;
            if scope.is_none() || in_scope(&scope, page) {
                dead_links += outs
                    .iter()
                    .filter(|l| !pages.contains_key(&l.to_page_id))
                    .count() as u64;
            }
            if !in_scope(&scope, page) || !live(page) {
                continue;
            }
            page_count += 1;
            if !page.frontmatter.contains_key("embed_skip") {
                let chunks = read_chunks(&*read, page.id)?;
                eligible += chunks.len() as u64;
                embedded += chunks.iter().filter(|c| c.embed.has_vector()).count() as u64;
            }
            if quarantined(page) {
                continue;
            }
            let ins = in_links(&*read, page.id)?;
            let inbound_live = ins.iter().filter(|l| live_in_scope(l.from_page_id));
            let outbound_live = outs.iter().filter(|l| live_in_scope(l.to_page_id)).count();
            let has_inbound = inbound_live.clone().next().is_some();
            let has_timeline = self.timeline_count(page, 1)? > 0;
            linkable.push(json!({
                "slug": page.slug,
                "type": page.page_type,
                "islanded": !has_inbound && outbound_live == 0,
                "has_timeline": has_timeline,
            }));
            if is_entity(page) {
                entity_page_count += 1;
                if has_inbound {
                    entity_linked += 1;
                }
                if has_timeline {
                    entity_with_timeline += 1;
                }
                let degree = outbound_live as u64
                    + inbound_live
                        .filter(|l| l.from_page_id != l.to_page_id)
                        .count() as u64;
                connected.push((page.id, page.slug.as_str(), degree));
            }
        }
        connected.sort_by(|a, b| {
            b.2.cmp(&a.2)
                .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
                .then_with(|| a.0.cmp(&b.0))
        });
        connected.truncate(MOST_CONNECTED);
        Ok(json!({
            "page_count": page_count,
            "eligible_chunks": eligible,
            "embedded_chunks": embedded,
            "missing_embeddings": eligible - embedded,
            "dead_links": dead_links,
            "link_count": count_links(&*read, &pages, &scope)?,
            "entity_page_count": entity_page_count,
            "entity_linked": entity_linked,
            "entity_with_timeline": entity_with_timeline,
            "linkable": linkable,
            "most_connected": connected
                .iter()
                .map(|(_, slug, n)| json!({ "slug": slug, "link_count": n }))
                .collect::<Vec<_>>(),
        }))
    }

    /// `logIngest`: appends one row. A NULL column fails as Postgres's NOT NULL check does, in
    /// column order.
    pub fn log_ingest(&self, input: &IngestInput) -> Result<()> {
        let source_id = input
            .source_id
            .clone()
            .unwrap_or_else(|| crate::sources::DEFAULT_SOURCE.to_string());
        let source_type = input
            .source_type
            .clone()
            .ok_or_else(|| not_null("source_type"))?;
        let source_ref = input
            .source_ref
            .clone()
            .ok_or_else(|| not_null("source_ref"))?;
        let pages_json = input
            .pages_updated_json
            .as_deref()
            .ok_or_else(|| not_null("pages_updated"))?;
        let summary = input.summary.clone().ok_or_else(|| not_null("summary"))?;
        no_nul(
            "logIngest",
            &[
                ("source_id", &source_id),
                ("source_type", &source_type),
                ("source_ref", &source_ref),
                ("summary", &summary),
            ],
        )?;
        let pages_updated: Value = serde_json::from_str(pages_json).map_err(|e| {
            StoreError::new(INVALID_ARGUMENT, format!("logIngest: pages_updated: {e}"))
        })?;
        if json_has_nul(&pages_updated) {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                "logIngest: pages_updated must not contain a NUL character",
            ));
        }
        let pages_updated = jsonb_normalize(pages_updated);
        let created_at_us = self.env.now_micros();
        self.write(|tx| {
            let id = next_id(tx, NEXT_INGEST_LOG_ID)?;
            let record = IngestRecord {
                id,
                source_id,
                source_type,
                source_ref,
                pages_updated,
                summary,
                created_at_us,
            };
            put_json(tx, &ingest_key(created_at_us, id), &record)
        })
    }

    /// `getIngestLog`: newest first, at most `limit` rows, only `source_ids` when not empty.
    pub fn get_ingest_log(&self, options: &IngestLogOptions) -> Result<Vec<Value>> {
        let limit = match options.limit.map(f64::round) {
            None => 50,
            Some(n) if n < 0.0 => {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    "LIMIT must not be negative",
                ));
            }
            // A float to usize cast saturates; NaN never arrives (the member sends `limit || 50`).
            Some(n) => n as usize,
        };
        let wanted: Option<HashSet<&str>> = options
            .source_ids
            .as_ref()
            .filter(|ids| !ids.is_empty())
            .map(|ids| ids.iter().map(String::as_str).collect());
        let read = self.read()?;
        let mut rows = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::INGEST_LOG], true, &mut |_, v| {
            match serde_json::from_slice::<IngestRecord>(v) {
                Ok(record) => {
                    if wanted
                        .as_ref()
                        .is_none_or(|w| w.contains(record.source_id.as_str()))
                    {
                        rows.push(record.to_json());
                    }
                }
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none() && rows.len() < limit
        })?;
        failure.map_or(Ok(rows), Err)
    }

    /// `listEnrichCandidates` (`engine-sql/salience.ts`): thin live pages of the given types.
    pub fn list_enrich_candidates(&self, input: &EnrichInput) -> Result<Vec<Value>> {
        if input.types.is_empty() {
            return Ok(Vec::new());
        }
        let scope = scope_set(&input.scope);
        let limit = input.limit.round().clamp(1.0, 5000.0) as usize;
        let read = self.read()?;
        let mut rows = Vec::new();
        for page in all_pages(&*read)? {
            if !live(&page) || !in_scope(&scope, &page) || !input.types.contains(&page.page_type) {
                continue;
            }
            // `char_length(p.compiled_truth)` is NULL for a segmented page, so PGLite's
            // `body_len < threshold` never holds for one.
            if page.compiled_truth.is_null() {
                continue;
            }
            let body_len = page.compiled_truth.chars().count() + page.timeline.chars().count();
            if (body_len as f64) >= input.thin_threshold {
                continue;
            }
            if let Some(after) = &input.enriched_after
                && frontmatter_text(&page, "enriched_at")
                    .is_some_and(|at| at.as_bytes() > after.as_bytes())
            {
                continue;
            }
            if frontmatter_text(&page, "dream_generated").as_deref() == Some("true") {
                continue;
            }
            let inbound = in_links(&*read, page.id)?
                .iter()
                .filter(|l| l.link_source.as_deref() != Some("mentions") && l.link_type != "amends")
                .count();
            let weight = if input.order == "salience" {
                crate::salience::emotional_weight(&*read, page.id)?
            } else {
                0.0
            };
            rows.push((page, body_len, inbound, weight));
        }
        let tie = |a: &PageRecord, b: &PageRecord| {
            a.source_id
                .as_bytes()
                .cmp(b.source_id.as_bytes())
                .then_with(|| a.slug.as_bytes().cmp(b.slug.as_bytes()))
        };
        match input.order.as_str() {
            "updated" => rows.sort_by(|a, b| {
                b.0.updated_at_us
                    .cmp(&a.0.updated_at_us)
                    .then_with(|| tie(&a.0, &b.0))
            }),
            "salience" => rows.sort_by(|a, b| {
                b.3.total_cmp(&a.3)
                    .then_with(|| b.2.cmp(&a.2))
                    .then_with(|| tie(&a.0, &b.0))
            }),
            _ => rows.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| tie(&a.0, &b.0))),
        }
        rows.truncate(limit);
        Ok(rows
            .into_iter()
            .map(|(page, body_len, inbound, _)| {
                json!({
                    "slug": page.slug,
                    "source_id": page.source_id,
                    "title": page.title,
                    "type": page.page_type,
                    "body_len": body_len,
                    "inbound_count": inbound,
                })
            })
            .collect())
    }

    /// The store half of `findAnomalies` (`engine-sql/salience.ts`): per tag and per type, the
    /// distinct pages touched on each UTC day of `[baseline_start, since)`, and the pages touched
    /// in `[since, since_end)` with their slugs. Readable pages only: live, unquarantined, in a
    /// source that exists and is not archived.
    pub fn find_anomalies(&self, input: &AnomalyInput) -> Result<Value> {
        let scope = scope_set(&input.scope);
        let read = self.read()?;
        let open_sources: HashSet<String> = all_sources(&*read)?
            .into_iter()
            .filter(|s| !s.archived)
            .map(|s| s.id)
            .collect();
        // Whole numbers below 2^53, so the casts are exact.
        let (baseline_start, since, since_end) = (
            input.baseline_start_us as i64,
            input.since_us as i64,
            input.since_end_us as i64,
        );
        type Days = BTreeMap<i64, BTreeSet<u64>>;
        let mut baseline: [BTreeMap<String, Days>; 2] = [BTreeMap::new(), BTreeMap::new()];
        type Today = BTreeMap<String, (BTreeSet<u64>, BTreeSet<String>)>;
        let mut today: [Today; 2] = [BTreeMap::new(), BTreeMap::new()];
        for page in all_pages(&*read)? {
            if !live(&page)
                || quarantined(&page)
                || !open_sources.contains(&page.source_id)
                || !in_scope(&scope, &page)
            {
                continue;
            }
            let at = page.updated_at_us;
            let cohorts = [page.tags.clone(), vec![page.page_type.clone()]];
            if at >= baseline_start && at < since {
                let day = at.div_euclid(DAY_US);
                for (kind, values) in cohorts.iter().enumerate() {
                    for value in values {
                        baseline[kind]
                            .entry(value.clone())
                            .or_default()
                            .entry(day)
                            .or_default()
                            .insert(page.id);
                    }
                }
            } else if at >= since && at < since_end {
                for (kind, values) in cohorts.iter().enumerate() {
                    for value in values {
                        let entry = today[kind].entry(value.clone()).or_default();
                        entry.0.insert(page.id);
                        entry.1.insert(page.slug.clone());
                    }
                }
            }
        }
        let kinds = ["tag", "type"];
        let mut baseline_rows = Map::new();
        let mut today_rows = Vec::new();
        for (kind, name) in kinds.iter().enumerate() {
            let cohorts: Map<String, Value> = baseline[kind]
                .iter()
                .map(|(value, days)| {
                    let counts: Map<String, Value> = days
                        .iter()
                        .map(|(day, ids)| (iso(day * DAY_US)[..10].to_string(), json!(ids.len())))
                        .collect();
                    (value.clone(), Value::Object(counts))
                })
                .collect();
            baseline_rows.insert((*name).to_string(), Value::Object(cohorts));
            for (value, (ids, slugs)) in &today[kind] {
                today_rows.push(json!({
                    "cohort_kind": name,
                    "cohort_value": value,
                    "count": ids.len(),
                    "page_slugs": slugs,
                }));
            }
        }
        Ok(json!({ "baseline": baseline_rows, "today": today_rows }))
    }
}

#[cfg(test)]
mod segmented_tests {
    use super::*;
    use crate::pages::{PageInput, PageText, PutPageOptions, read_page, write_page};

    #[test]
    fn a_segmented_page_is_never_an_enrich_candidate() {
        let store = crate::test_support::store();
        for slug in ["inline", "shell"] {
            let input = PageInput {
                page_type: "person".into(),
                title: slug.into(),
                compiled_truth: "short".into(),
                ..PageInput::default()
            };
            store
                .put_page(slug, &input, &PutPageOptions::default())
                .unwrap();
        }
        // PGLite's `createSegmentedPageShell` leaves both body columns NULL.
        store
            .write(|tx| {
                let mut page = read_page(&*tx, "default", "shell")?.unwrap();
                page.compiled_truth = PageText::null();
                page.timeline = PageText::null();
                write_page(tx, &page)
            })
            .unwrap();
        let input = EnrichInput {
            types: vec!["person".into()],
            thin_threshold: 100.0,
            order: "inbound-links".into(),
            limit: 50.0,
            ..EnrichInput::default()
        };
        let rows = store.list_enrich_candidates(&input).unwrap();
        let slugs: Vec<&str> = rows.iter().map(|r| r["slug"].as_str().unwrap()).collect();
        assert_eq!(slugs, ["inline"]);
    }
}
