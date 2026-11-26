//! The reads of a fact purge's plan, its dry run and `--match` (src/core/engine-sql/facts-purge-plan.ts): the
//! store's answer to each statement there. All of them read; none writes.
//!
//! Text matching follows the SQL: `strpos(lower(x), $n) > 0` is `pg_lower(x).contains(n)` (an empty needle
//! matches, a NULL column does not), `x::text` of a jsonb column is `jsonb_text`, and a segment text is
//! matched after UTF-8 decoding (page_body/purge_scan.rs).
//!
//! Not kept by this store, so answered in the TypeScript member: the raw staging parts
//! (`readStagingPartEdges` is empty), the derivation edges (`listDerivedRowsStep` is empty) and the
//! statement deadline (`setPurgeProbeTimeout` does nothing). Of the inventory probes, `links`,
//! `timeline_entries`, `raw_data` and `wanted_links` are answered here; the member answers or refuses
//! the rest.

use super::embedding::{cosine_distance, parse_vector, to_halfvec};
use super::purge_probe::{ProbeCell, table_rows};
use super::{fact_normalize, invalid, source_rows};
use crate::Store;
use crate::cli_reads::pg_text::{jsonb_text, pg_lower};
use crate::error::Result;
use crate::eval_capture::decide_proposals::purge_review_counts;
use crate::journal::RequestRecord;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::links::{LinkRecord, in_links, no_nul, out_links};
use crate::page_body::purge_scan::{generation_carries, page_is_segmented, stagings_holding_claim};
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id, versions_of};
use crate::raw_files::raw_records_of;
use crate::timeline::TimelineRecord;
use crate::wanted_links;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// `('queued','deferred','running','recovering')`: an unfinished request.
const UNFINISHED: [&str; 4] = ["queued", "deferred", "running", "recovering"];
/// `--match` lists at most this many facts, each cut to this many characters.
const MATCH_LIMIT: usize = 25;
const MATCH_CHARS: usize = 160;
/// `PAGE_SOURCE_PATHS_SQL`'s LIMIT.
const SOURCE_PATH_LIMIT: usize = 64;
/// `FACT_NEIGHBOURS_SQL`'s LIMIT.
const NEIGHBOURS: usize = 5;
/// `probeItemsSql`: `ORDER BY 1 LIMIT 20`.
const PROBE_ITEMS: usize = 20;

fn lower_has(text: Option<&str>, needles: &[&str]) -> bool {
    text.is_some_and(|t| {
        let lowered = pg_lower(t);
        needles.iter().any(|n| lowered.contains(n))
    })
}

fn source_pages(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageRecord>> {
    Ok(all_pages(read)?
        .into_iter()
        .filter(|p| p.source_id == source_id)
        .collect())
}

fn page_ids(op: &str, ids: &[i64]) -> Result<Vec<u64>> {
    ids.iter()
        .map(|&id| {
            u64::try_from(id).map_err(|_| invalid(format!("{op}: page id {id} is out of range")))
        })
        .collect()
}

/// `{ sourceId, slug }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LivePageArgs {
    pub source_id: String,
    pub slug: String,
}

/// `{ sourceId, pageIds }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcePageIdsArgs {
    pub source_id: String,
    pub page_ids: Vec<i64>,
}

/// `PurgeClaimNeedles` (plus `limit` for `listRequestsCarryingClaim`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimNeedleArgs {
    pub source_id: String,
    pub claim_lower: String,
    pub claim_json: String,
    pub reason: String,
    pub limit: Option<i64>,
}

/// `StagingClaimNeedles`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct StagingNeedleArgs {
    pub source_id: String,
    pub claim_lower: String,
    pub claim: String,
    pub cell_lower: String,
}

/// `{ sourceId, factIds }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewCountArgs {
    pub source_id: String,
    pub fact_ids: Vec<i64>,
}

/// `{ sourceId, text }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeMatchArgs {
    pub source_id: String,
    pub text: String,
}

/// `{ sourceId, stagingIds }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct HoldingStagingsArgs {
    pub source_id: String,
    pub staging_ids: Vec<String>,
}

/// `{ sourceId, store, limit }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedBodiesArgs {
    pub source_id: String,
    pub store: String,
    pub limit: i64,
}

/// `{ sourceId }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeSourceArgs {
    pub source_id: String,
}

/// `{ pageIds }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PageIdsArgs {
    pub page_ids: Vec<i64>,
}

/// `{ embedding, sourceId, model, claim }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct NeighbourArgs {
    pub embedding: String,
    pub source_id: String,
    pub model: String,
    pub claim: String,
}

/// One needle of a probe: as given (a `bytea` store matches these bytes), lowered, and its JSON-escaped form lowered.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeNeedle {
    pub text: String,
    pub lower: String,
    pub escaped: String,
}

/// `PurgeProbeShape` (purge-plan-statements.ts) of a probe this store answers, plus the row bound.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeProbeArgs {
    pub table: String,
    pub source_id: String,
    /// The probed columns without a table alias.
    pub columns: Vec<String>,
    pub needles: Vec<ProbeNeedle>,
    /// The table has a `source_id`: only the rows of `source_id` are searched (otherwise every row is).
    pub scoped: bool,
    /// A `bytea` store: matched byte for byte, case and all.
    pub binary: bool,
    /// `countPurgeProbe` counts at most `rows + 1`; absent for `listPurgeProbeItems`.
    pub rows: Option<i64>,
}

/// One row a probe found: its listed item (`None` when this store keeps no id to name it by).
struct ProbeHit {
    item: Option<String>,
}

impl PurgeProbeArgs {
    fn hit(&self, texts: &[(&str, Option<String>)]) -> Result<bool> {
        let cells: Vec<(&str, ProbeCell)> = texts
            .iter()
            .map(|(name, text)| (*name, ProbeCell::opt_text(text.as_deref())))
            .collect();
        self.hit_cells(&cells)
    }

    /// Whether a probed column carries a needle: text as `strpos(lower(col::text), needle) > 0` on the lowered
    /// needle or its lowered JSON-escaped form; bytes as `position(convert_to(needle, 'UTF8') in col) > 0`.
    fn hit_cells(&self, cells: &[(&str, ProbeCell)]) -> Result<bool> {
        for column in &self.columns {
            let Some((_, cell)) = cells.iter().find(|(name, _)| name == column) else {
                return Err(invalid(format!(
                    "purge probe: {} has no column {column}",
                    self.table
                )));
            };
            let found = match cell {
                ProbeCell::Null => false,
                ProbeCell::Text(text) => {
                    let lowered = pg_lower(text);
                    self.needles
                        .iter()
                        .any(|n| lowered.contains(&n.lower) || lowered.contains(&n.escaped))
                }
                ProbeCell::Bytes(bytes) => self.needles.iter().any(|n| {
                    let needle = n.text.as_bytes();
                    !needle.is_empty() && bytes.windows(needle.len()).any(|w| w == needle)
                }),
            };
            if found {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The rows of the probed table that match, stopping after `cap`.
    fn hits(&self, read: &dyn KvRead, cap: usize) -> Result<Vec<ProbeHit>> {
        let mut out = Vec::new();
        if self.needles.is_empty() || self.columns.is_empty() {
            return Ok(out);
        }
        match self.table.as_str() {
            "links" => {
                let mut seen = BTreeMap::<u64, LinkRecord>::new();
                for page in source_pages(read, &self.source_id)? {
                    for link in out_links(read, page.id)?
                        .into_iter()
                        .chain(in_links(read, page.id)?)
                    {
                        seen.entry(link.id).or_insert(link);
                    }
                }
                for link in seen.into_values() {
                    if out.len() >= cap {
                        break;
                    }
                    let (Some(from), Some(to)) = (
                        read_page_by_id(read, link.from_page_id)?,
                        read_page_by_id(read, link.to_page_id)?,
                    ) else {
                        continue;
                    };
                    if self.hit(&[("context", Some(link.context.clone()))])? {
                        out.push(ProbeHit {
                            item: Some(format!("link:{} {} -> {}", link.id, from.slug, to.slug)),
                        });
                    }
                }
            }
            "timeline_entries" => {
                for page in source_pages(read, &self.source_id)? {
                    let mut rows: Vec<TimelineRecord> = Vec::new();
                    let mut failure = None;
                    scan_prefix(read, &keys::timeline_prefix(page.id), false, &mut |_, v| {
                        match serde_json::from_slice::<TimelineRecord>(v) {
                            Ok(row) => rows.push(row),
                            Err(e) => failure = Some(crate::StoreError::from(e)),
                        }
                        failure.is_none()
                    })?;
                    if let Some(e) = failure {
                        return Err(e);
                    }
                    for row in rows {
                        if out.len() >= cap {
                            return Ok(out);
                        }
                        if self.hit(&[
                            ("summary", Some(row.summary.clone())),
                            ("detail", Some(row.detail.clone())),
                        ])? {
                            out.push(ProbeHit {
                                item: Some(format!(
                                    "timeline:{} {} {}",
                                    row.id, page.slug, row.date
                                )),
                            });
                        }
                    }
                }
            }
            "raw_data" => {
                for page in source_pages(read, &self.source_id)? {
                    for row in raw_records_of(read, page.id)? {
                        if out.len() >= cap {
                            return Ok(out);
                        }
                        if self.hit(&[("data", Some(jsonb_text(&row.data)))])? {
                            // A record written before the store kept `raw_data.id` cannot be named.
                            out.push(ProbeHit {
                                item: row.id.map(|id| {
                                    format!("raw_data:{id} {} {}", page.slug, row.source)
                                }),
                            });
                        }
                    }
                }
            }
            "wanted_links" => {
                for row in wanted_links::all_records(read)? {
                    if out.len() >= cap {
                        break;
                    }
                    if row.source_id == self.source_id
                        && self.hit(&[("context", Some(row.context.clone()))])?
                    {
                        out.push(ProbeHit { item: None });
                    }
                }
            }
            other => {
                let Some(rows) = table_rows(read, other, &self.source_id)? else {
                    return Err(invalid(format!(
                        "purge probe: this store does not probe {other}"
                    )));
                };
                for row in rows {
                    if out.len() >= cap {
                        break;
                    }
                    if self.scoped && row.source_id.as_deref() != Some(self.source_id.as_str()) {
                        continue;
                    }
                    if self.hit_cells(&row.cells)? {
                        // A whole-table probe only counts; it names no row.
                        out.push(ProbeHit { item: None });
                    }
                }
            }
        }
        Ok(out)
    }
}

impl Store {
    /// `hasLivePageSlug`: `LIVE_PAGE_SLUG_SQL`.
    pub fn has_live_page_slug(&self, q: &LivePageArgs) -> Result<bool> {
        no_nul(
            "hasLivePageSlug",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        Ok(read_page(&*read, &q.source_id, &q.slug)?.is_some_and(|p| p.deleted_at_us.is_none()))
    }

    /// `readPurgeTakePages`: `PURGE_TAKE_PAGES_SQL`, by page id.
    pub fn read_purge_take_pages(&self, q: &SourcePageIdsArgs) -> Result<Value> {
        const OP: &str = "readPurgeTakePages";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let mut rows = BTreeMap::new();
        for id in page_ids(OP, &q.page_ids)? {
            if let Some(page) = read_page_by_id(&*read, id)?
                && page.source_id == q.source_id
            {
                rows.insert(id, json!({ "slug": page.slug, "page_id": id, "revision": page.knowledge_revision }));
            }
        }
        Ok(Value::Array(rows.into_values().collect()))
    }

    /// `countPurgeCarryingVersions`: `PURGE_CARRYING_VERSIONS_SQL`.
    pub fn count_purge_carrying_versions(&self, q: &ClaimNeedleArgs) -> Result<i64> {
        const OP: &str = "countPurgeCarryingVersions";
        no_nul(
            OP,
            &[
                ("sourceId", &q.source_id),
                ("claimLower", &q.claim_lower),
                ("claimJson", &q.claim_json),
                ("reason", &q.reason),
            ],
        )?;
        let read = self.read()?;
        let claim = q.claim_lower.as_str();
        let mut n = 0;
        for page in source_pages(&*read, &q.source_id)? {
            for v in versions_of(&*read, page.id)? {
                let frontmatter = jsonb_text(&Value::Object(v.frontmatter.clone()));
                let inline = lower_has(v.compiled_truth.as_deref(), &[claim])
                    || lower_has(Some(v.timeline.as_deref().unwrap_or("")), &[claim])
                    || lower_has(Some(&v.title), &[claim])
                    || lower_has(Some(&frontmatter), &[&q.claim_json])
                    || lower_has(v.change_reason.as_deref(), &[claim, &q.reason]);
                let segmented = !inline
                    && v.body_storage.as_deref() == Some("segmented")
                    && match v.body_generation {
                        Some(g) => generation_carries(&*read, page.id, g, claim)?,
                        None => false,
                    };
                if inline || segmented {
                    n += 1;
                }
            }
        }
        Ok(n)
    }

    /// `listStagingsHoldingClaim`: `STAGINGS_HOLDING_CLAIM_SQL`, by staging id.
    pub fn list_stagings_holding_claim(&self, q: &StagingNeedleArgs) -> Result<Vec<String>> {
        no_nul(
            "listStagingsHoldingClaim",
            &[
                ("sourceId", &q.source_id),
                ("claimLower", &q.claim_lower),
                ("claim", &q.claim),
                ("cellLower", &q.cell_lower),
            ],
        )?;
        let read = self.read()?;
        let held = crate::journal::request_held_staging_ids(&*read)?;
        stagings_holding_claim(&*read, &q.source_id, &q.claim_lower, &q.cell_lower, &held)
    }

    /// `countPurgeReviewRows`: `PURGE_REVIEW_COUNTS_SQL`, as `{ q, rp, dp }`.
    pub fn count_purge_review_rows(&self, q: &ReviewCountArgs) -> Result<Value> {
        no_nul("countPurgeReviewRows", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let refs: HashSet<String> = q.fact_ids.iter().map(ToString::to_string).collect();
        let ids: HashSet<i64> = q.fact_ids.iter().copied().collect();
        let (queue, review, supersede) = purge_review_counts(&*read, &q.source_id, &refs, &ids)?;
        Ok(json!({ "q": queue, "rp": review, "dp": supersede }))
    }

    /// `matchPurgeCandidates`: `PURGE_MATCH_SQL`, by id, at most 25.
    pub fn match_purge_candidates(&self, q: &PurgeMatchArgs) -> Result<Value> {
        no_nul(
            "matchPurgeCandidates",
            &[("sourceId", &q.source_id), ("text", &q.text)],
        )?;
        let read = self.read()?;
        let needle = pg_lower(&q.text);
        let mut rows: Vec<_> = source_rows(&*read, &q.source_id)?
            .into_iter()
            .filter(|r| pg_lower(&r.fact).contains(&needle))
            .collect();
        rows.sort_by_key(|r| r.id);
        Ok(Value::Array(
            rows.into_iter()
                .take(MATCH_LIMIT)
                .map(|r| {
                    json!({
                        "id": r.id,
                        "entity_slug": r.entity_slug,
                        "visibility": r.visibility,
                        "expired": r.expired_at_us.is_some(),
                        "fact": r.fact.chars().take(MATCH_CHARS).collect::<String>(),
                    })
                })
                .collect(),
        ))
    }

    /// `listRequestsCarryingClaim`: `REQUESTS_CARRYING_SQL`, by sequence, up to `limit`.
    pub fn list_requests_carrying_claim(&self, q: &ClaimNeedleArgs) -> Result<Value> {
        const OP: &str = "listRequestsCarryingClaim";
        no_nul(
            OP,
            &[
                ("sourceId", &q.source_id),
                ("claimLower", &q.claim_lower),
                ("claimJson", &q.claim_json),
                ("reason", &q.reason),
            ],
        )?;
        let limit = usize::try_from(q.limit.unwrap_or(0))
            .map_err(|_| invalid(format!("{OP}: LIMIT must not be negative")))?;
        let read = self.read()?;
        let needles = [
            q.claim_lower.as_str(),
            q.claim_json.as_str(),
            q.reason.as_str(),
        ];
        let json_has = |v: Option<&Value>| {
            v.filter(|v| !v.is_null())
                .is_some_and(|v| lower_has(Some(&jsonb_text(v)), &needles))
        };
        let rows = requests(&*read, |r| {
            r.source_id == q.source_id
                && (json_has(Some(&r.intent))
                    || json_has(r.outcome.as_ref())
                    || json_has(r.extra.get("error_detail"))
                    || lower_has(r.error_message.as_deref(), &needles))
        })?;
        Ok(Value::Array(
            rows.into_iter().take(limit).map(|r| target(&r)).collect(),
        ))
    }

    /// `listRequestsHoldingStagings`: `REQUESTS_HOLDING_STAGINGS_SQL`, by sequence.
    pub fn list_requests_holding_stagings(&self, q: &HoldingStagingsArgs) -> Result<Value> {
        no_nul("listRequestsHoldingStagings", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let wanted: HashSet<&str> = q.staging_ids.iter().map(String::as_str).collect();
        let rows = requests(&*read, |r| {
            r.source_id == q.source_id
                && UNFINISHED.contains(&r.state.as_str())
                && r.intent
                    .pointer("/body_ref/staging_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| wanted.contains(id))
        })?;
        Ok(Value::Array(rows.iter().map(target).collect()))
    }

    /// `listSegmentedPurgeBodies`: `SEGMENTED_PAGE_BODIES_SQL` (live pages, by page id) or
    /// `SEGMENTED_VERSION_BODIES_SQL` (versions, by version id), up to `limit`.
    pub fn list_segmented_purge_bodies(&self, q: &SegmentedBodiesArgs) -> Result<Value> {
        const OP: &str = "listSegmentedPurgeBodies";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        let limit = usize::try_from(q.limit)
            .map_err(|_| invalid(format!("{OP}: LIMIT must not be negative")))?;
        let read = self.read()?;
        let pages = source_pages(&*read, &q.source_id)?;
        let mut rows: BTreeMap<u64, Value> = BTreeMap::new();
        match q.store.as_str() {
            "pages" => {
                for page in pages.iter().filter(|p| p.deleted_at_us.is_none()) {
                    if page_is_segmented(&*read, page.id)? {
                        rows.insert(page.id, json!({ "page_id": page.id, "slug": page.slug, "generation": null, "version_id": null }));
                    }
                }
            }
            "page_versions" => {
                for page in &pages {
                    for v in versions_of(&*read, page.id)? {
                        if v.body_storage.as_deref() == Some("segmented") {
                            rows.insert(v.id, json!({ "page_id": page.id, "slug": page.slug, "generation": v.body_generation, "version_id": v.id }));
                        }
                    }
                }
            }
            other => return Err(invalid(format!("{OP}: unknown store {other}"))),
        }
        Ok(Value::Array(rows.into_values().take(limit).collect()))
    }

    /// `countLegacyDerivedPages`: `LEGACY_DERIVED_PAGES_SQL`. This store keeps no derivation edges, so
    /// every live atom or dream-generated page of the source counts.
    pub fn count_legacy_derived_pages(&self, q: &PurgeSourceArgs) -> Result<i64> {
        no_nul("countLegacyDerivedPages", &[("sourceId", &q.source_id)])?;
        let read = self.read()?;
        let dream = |v: Option<&Value>| match v {
            Some(Value::String(s)) => s == "true",
            Some(Value::Bool(b)) => *b,
            _ => false,
        };
        let n = source_pages(&*read, &q.source_id)?
            .iter()
            .filter(|p| {
                p.deleted_at_us.is_none()
                    && (p.page_type == "atom" || dream(p.frontmatter.get("dream_generated")))
            })
            .count();
        Ok(n as i64)
    }

    /// `listPageSourcePaths`: `PAGE_SOURCE_PATHS_SQL` (DISTINCT, at most 64; here in byte order).
    pub fn list_page_source_paths(&self, q: &PageIdsArgs) -> Result<Vec<String>> {
        let ids = page_ids("listPageSourcePaths", &q.page_ids)?;
        let read = self.read()?;
        let mut paths = BTreeSet::new();
        for id in ids {
            if let Some(page) = read_page_by_id(&*read, id)? {
                paths.extend(page.source_path);
            }
            for v in versions_of(&*read, id)? {
                paths.extend(v.source_path);
            }
        }
        Ok(paths
            .into_iter()
            .filter(|p| !p.is_empty() && !p.starts_with('/') && !p.contains(".."))
            .take(SOURCE_PATH_LIMIT)
            .collect())
    }

    /// `listFactNeighbours`: `FACT_NEIGHBOURS_SQL`, nearest first (equal distances by id), at most 5.
    pub fn list_fact_neighbours(&self, q: &NeighbourArgs) -> Result<Value> {
        const OP: &str = "listFactNeighbours";
        no_nul(
            OP,
            &[
                ("embedding", &q.embedding),
                ("sourceId", &q.source_id),
                ("model", &q.model),
                ("claim", &q.claim),
            ],
        )?;
        let target = to_halfvec(&parse_vector(&q.embedding)?, None)?;
        let read = self.read()?;
        let claim = fact_normalize(&q.claim);
        let mut ranked: Vec<(f64, u64, bool)> = Vec::new();
        for row in source_rows(&*read, &q.source_id)? {
            let Some(vector) = row.embedding.as_deref() else {
                continue;
            };
            if row.embedding_model.as_deref() != Some(q.model.as_str()) {
                continue;
            }
            if vector.len() != target.len() {
                return Err(invalid(format!(
                    "{OP}: different halfvec dimensions {} and {}",
                    vector.len(),
                    target.len()
                )));
            }
            ranked.push((
                cosine_distance(vector, &target),
                row.id,
                fact_normalize(&row.fact).contains(&claim),
            ));
        }
        // Ascending, NaN after every number (Postgres orders NaN last); equal distances by id.
        ranked.sort_by(|(da, a, _), (db, b, _)| {
            da.is_nan()
                .cmp(&db.is_nan())
                .then(da.partial_cmp(db).unwrap_or(std::cmp::Ordering::Equal))
                .then(a.cmp(b))
        });
        Ok(Value::Array(
            ranked
                .into_iter()
                .take(NEIGHBOURS)
                .map(|(d, id, contains)| json!({ "id": id, "similarity": 1.0 - d, "contains_claim": contains }))
                .collect(),
        ))
    }

    /// `countPurgeProbe` of a table this store keeps: the matching rows, at most `rows + 1`.
    pub fn count_purge_probe(&self, q: &PurgeProbeArgs) -> Result<i64> {
        const OP: &str = "countPurgeProbe";
        no_nul(OP, &[("table", &q.table), ("sourceId", &q.source_id)])?;
        let rows = q
            .rows
            .ok_or_else(|| invalid(format!("{OP}: rows is required")))?;
        let cap = usize::try_from(rows)
            .map_err(|_| invalid(format!("{OP}: rows must not be negative")))?
            .saturating_add(1);
        let read = self.read()?;
        Ok(q.hits(&*read, cap)?.len() as i64)
    }

    /// `listPurgeProbeItems` of a named probe: the first 20 items in byte order, or `null` when a row
    /// matched that this store cannot name (a `raw_data` record written before the store kept its id).
    pub fn list_purge_probe_items(&self, q: &PurgeProbeArgs) -> Result<Value> {
        no_nul(
            "listPurgeProbeItems",
            &[("table", &q.table), ("sourceId", &q.source_id)],
        )?;
        let read = self.read()?;
        let mut items = Vec::new();
        for hit in q.hits(&*read, usize::MAX)? {
            match hit.item {
                Some(item) => items.push(item),
                None => return Ok(Value::Null),
            }
        }
        items.sort();
        items.truncate(PROBE_ITEMS);
        Ok(json!(items))
    }
}

/// The requests that pass `keep`, by sequence.
fn requests(
    read: &dyn KvRead,
    keep: impl Fn(&RequestRecord) -> bool,
) -> Result<Vec<RequestRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::REQUEST], false, &mut |_, v| {
        match serde_json::from_slice::<RequestRecord>(v) {
            Ok(r) if keep(&r) => out.push(r),
            Ok(_) => {}
            Err(e) => failure = Some(crate::StoreError::from(e)),
        }
        failure.is_none()
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    out.sort_by_key(|r| r.sequence);
    Ok(out)
}

fn target(r: &RequestRecord) -> Value {
    json!({ "id": r.id, "principal_kind": r.principal_kind, "principal_id": r.principal_id })
}
