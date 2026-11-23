//! The fence census reads and writes served from the store (SQL in `src/core/engine-sql/fence-census.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-fence.md`).
//!
//! - The census state is `op_checkpoints` rows in the housekeeping key space (`persistence/housekeeping.rs`:
//!   `d 0x02 <op> 0x00 <fingerprint>`, `HousekeepingRow`), where `completed_keys` is `[record]` (a jsonb value: keys by
//!   length then bytes), as `write_doctor_last_known` keeps its rows.
//! - The page scans read every page record and filter and order in memory (the store has no `(source, id)` or
//!   `(source, updated_at)` index); a scan of a large source pays one pass per batch.
//! - Text and time: every order is bytewise, and a timestamp is ISO text with microseconds (`2026-11-19T17:23:15.100000Z`),
//!   which the page-scan reads accept back as the `after` and `lower` bounds.

use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::scan_prefix;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::persistence::{HousekeepingRow, parse_timestamptz, turn_key};
use crate::sources::{all_sources, read_source};
use crate::stats::jsonb_normalize;
use crate::{get_json, put_json};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// `listFenceCensusSources({sourceIds})`: `null` means every source.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CensusSourcesSpec {
    pub source_ids: Option<Vec<String>>,
}

/// `readFencePassHorizon({graceMs})`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassHorizonSpec {
    pub grace_ms: i64,
}

/// The `after` bound of an `updated` page scan: the last `(updated_at, id)` read.
#[derive(Debug, Clone, Deserialize)]
pub struct CensusPageAfter {
    pub at: String,
    pub id: i64,
}

/// `listFenceCensusPages`: by id (`afterId`), or by `(updated_at, id)` from `lower` (after `after` when given).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CensusPagesSpec {
    pub source_id: String,
    pub mode: String,
    pub after_id: Option<i64>,
    pub lower: Option<String>,
    pub after: Option<CensusPageAfter>,
    pub limit: i64,
}

/// `listLiveFencePageIds({pageIds})`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageIdsSpec {
    pub page_ids: Vec<i64>,
}

/// `readFenceCheckpointRecord({op, fingerprint})`.
#[derive(Debug, Clone, Deserialize)]
pub struct CheckpointRef {
    pub op: String,
    pub fingerprint: String,
}

/// `writeFenceScanRecord({op, fingerprint, record})`.
#[derive(Debug, Clone, Deserialize)]
pub struct ScanRecordWrite {
    pub op: String,
    pub fingerprint: String,
    pub record: Value,
}

/// `upsertFenceCandidatePart(...)`: one judged `part` (`page` or `file`) of a candidate.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidatePartWrite {
    pub op: String,
    pub fingerprint: String,
    pub source_id: String,
    pub incarnation: String,
    pub key: String,
    pub part: String,
    pub finding: Value,
}

/// `clearFenceCandidateParts({op, fingerprints, part})`.
#[derive(Debug, Clone, Deserialize)]
pub struct CandidatePartsClear {
    pub op: String,
    pub fingerprints: Vec<String>,
    pub part: String,
}

/// `listFenceCandidateRecords({op, sourceIds})`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateRecordsSpec {
    pub op: String,
    pub source_ids: Option<Vec<String>>,
}

/// `countSegmentedFencePages({sourceIds, walkedSourceIds})`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentedPagesSpec {
    pub source_ids: Vec<String>,
    pub walked_source_ids: Vec<String>,
}

fn part_name(part: &str) -> Result<&'static str> {
    match part {
        "page" => Ok("page"),
        "file" => Ok("file"),
        other => Err(StoreError::invalid(format!(
            "a fence candidate part is page or file, not {other:?}"
        ))),
    }
}

/// The record a census row holds: `completed_keys[0]`.
fn first_record(row: &HousekeepingRow) -> Value {
    row.completed_keys.get(0).cloned().unwrap_or(Value::Null)
}

fn fence_marker(text: Option<&str>) -> bool {
    text.is_some_and(|t| t.contains("gbrain:facts:") || t.contains("gbrain:takes:"))
}

/// One page as the census judges it (`PAGE_COLUMNS`): the bodies only for a live markdown page that mentions a marker.
fn census_page_row(page: &PageRecord) -> Value {
    let live = page.deleted_at_us.is_none() && page.page_kind == "markdown";
    let fenced =
        fence_marker(page.compiled_truth.as_deref()) || fence_marker(page.timeline.as_deref());
    let body = |text: Option<&str>| match (live && fenced, text) {
        (true, Some(t)) => json!(t),
        _ => Value::Null,
    };
    json!({
        "id": page.id,
        "slug": page.slug,
        "type": page.page_type,
        "frontmatter": page.frontmatter,
        "source_path": page.source_path,
        "content_hash": page.content_hash,
        "updated_at": iso(page.updated_at_us),
        "live": live,
        "compiled_truth": body(page.compiled_truth.as_deref()),
        "timeline": body(page.timeline.as_deref()),
    })
}

impl Store {
    /// `listFenceCensusSources`: the sources that are not archived (every source has an incarnation), by id.
    pub fn list_fence_census_sources(&self, spec: &CensusSourcesSpec) -> Result<Vec<Value>> {
        let mut sources = all_sources(&*self.read()?)?;
        sources.retain(|s| {
            !s.archived
                && spec
                    .source_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&s.id))
        });
        sources.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(sources
            .into_iter()
            .map(
                |s| json!({ "id": s.id, "incarnation": s.incarnation, "local_path": s.local_path }),
            )
            .collect())
    }

    /// `readFencePassHorizon`: the store's clock minus the grace. One writer, so no open transaction is older.
    pub fn read_fence_pass_horizon(&self, spec: &PassHorizonSpec) -> Result<String> {
        let grace = spec.grace_ms.max(0).saturating_mul(1000);
        Ok(iso(self.env.now_micros().saturating_sub(grace)))
    }

    /// `listFenceCensusPagesById` and `listFenceCensusPagesUpdated`, by `mode`.
    pub fn list_fence_census_pages(&self, spec: &CensusPagesSpec) -> Result<Vec<Value>> {
        let limit = usize::try_from(spec.limit.max(0)).unwrap_or(usize::MAX);
        let mut pages: Vec<PageRecord> = all_pages(&*self.read()?)?
            .into_iter()
            .filter(|p| p.source_id == spec.source_id)
            .collect();
        match spec.mode.as_str() {
            "id" => {
                let after = spec.after_id.unwrap_or(0);
                pages.retain(|p| i128::from(p.id) > i128::from(after));
                pages.sort_by_key(|p| p.id);
            }
            "updated" => {
                let lower = spec.lower.as_deref().ok_or_else(|| {
                    StoreError::invalid("listFenceCensusPages: an updated scan needs lower")
                })?;
                let lower = parse_timestamptz(lower, "lower")?;
                let after = spec
                    .after
                    .as_ref()
                    .map(|a| Ok::<_, StoreError>((parse_timestamptz(&a.at, "after.at")?, a.id)))
                    .transpose()?;
                pages.retain(|p| {
                    p.updated_at_us >= lower
                        && after.is_none_or(|(at, id)| {
                            (p.updated_at_us, i128::from(p.id)) > (at, i128::from(id))
                        })
                });
                pages.sort_by_key(|p| (p.updated_at_us, p.id));
            }
            other => {
                return Err(StoreError::invalid(format!(
                    "listFenceCensusPages: mode is id or updated, not {other:?}"
                )));
            }
        }
        pages.truncate(limit);
        Ok(pages.iter().map(census_page_row).collect())
    }

    /// `listLiveFencePageIds`: the ids among `pageIds` of pages that are not soft-deleted, by id.
    pub fn list_live_fence_page_ids(&self, spec: &PageIdsSpec) -> Result<Vec<u64>> {
        let read = self.read()?;
        let mut live = BTreeSet::new();
        for id in &spec.page_ids {
            let Ok(id) = u64::try_from(*id) else { continue };
            if read_page_by_id(&*read, id)?.is_some_and(|p| p.deleted_at_us.is_none()) {
                live.insert(id);
            }
        }
        Ok(live.into_iter().collect())
    }

    /// `readFenceScanRecord`: `completed_keys[0]` of the row at (op, fingerprint), or null.
    pub fn read_fence_checkpoint_record(&self, r: &CheckpointRef) -> Result<Value> {
        let read = self.read()?;
        let row: Option<HousekeepingRow> = get_json(&*read, &turn_key(&r.op, &r.fingerprint)?)?;
        Ok(row.map_or(Value::Null, |row| first_record(&row)))
    }

    /// `writeFenceScanRecord`: upserts the row, `completed_keys = [record]`, `updated_at` the store's clock.
    pub fn write_fence_scan_record(&self, w: &ScanRecordWrite) -> Result<()> {
        let key = turn_key(&w.op, &w.fingerprint)?;
        let row = HousekeepingRow {
            completed_keys: Value::Array(vec![jsonb_normalize(w.record.clone())]),
            updated_at_us: self.env.now_micros(),
        };
        self.write(|tx| put_json(tx, &key, &row))
    }

    /// `upsertFenceCandidatePart`: sets `part` of the candidate row, keeping the other part; a new row starts with the
    /// ids (`version`, `source_id`, `incarnation`, `key`).
    pub fn upsert_fence_candidate_part(&self, w: &CandidatePartWrite) -> Result<()> {
        let part = part_name(&w.part)?;
        let key = turn_key(&w.op, &w.fingerprint)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let old: Option<HousekeepingRow> = get_json(&*tx, &key)?;
            let mut record = match old.map(|row| first_record(&row)) {
                Some(Value::Object(map)) => map,
                _ => {
                    let mut map = Map::new();
                    map.insert("version".into(), json!(1));
                    map.insert("source_id".into(), json!(w.source_id));
                    map.insert("incarnation".into(), json!(w.incarnation));
                    map.insert("key".into(), json!(w.key));
                    map
                }
            };
            record.insert(part.into(), w.finding.clone());
            let row = HousekeepingRow {
                completed_keys: Value::Array(vec![jsonb_normalize(Value::Object(record))]),
                updated_at_us: now,
            };
            put_json(tx, &key, &row)
        })
    }

    /// `clearFenceCandidateParts`: a candidate with no part besides `part` is deleted; one with both loses `part`.
    pub fn clear_fence_candidate_parts(&self, c: &CandidatePartsClear) -> Result<()> {
        let part = part_name(&c.part)?;
        let other = if part == "page" { "file" } else { "page" };
        let now = self.env.now_micros();
        let keys = c
            .fingerprints
            .iter()
            .map(|fp| turn_key(&c.op, fp))
            .collect::<Result<Vec<_>>>()?;
        self.write(|tx| {
            for key in &keys {
                let Some(row) = get_json::<HousekeepingRow>(&*tx, key)? else {
                    continue;
                };
                let Value::Object(mut record) = first_record(&row) else {
                    continue;
                };
                if !record.contains_key(other) {
                    tx.delete(key)?;
                } else if record.remove(part).is_some() {
                    let row = HousekeepingRow {
                        completed_keys: Value::Array(vec![jsonb_normalize(Value::Object(record))]),
                        updated_at_us: now,
                    };
                    put_json(tx, key, &row)?;
                }
            }
            Ok(())
        })
    }

    /// `listFenceCandidateRecords`: the records of `op` whose source and incarnation are live, by fingerprint.
    pub fn list_fence_candidate_records(&self, spec: &CandidateRecordsSpec) -> Result<Vec<Value>> {
        let prefix = turn_key(&spec.op, "")?;
        let read = self.read()?;
        let mut records = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &prefix, false, &mut |_, v| {
            match serde_json::from_slice::<HousekeepingRow>(v) {
                Ok(row) => records.push(first_record(&row)),
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut out = Vec::new();
        for record in records {
            let (Some(id), Some(incarnation)) = (
                record.get("source_id").and_then(Value::as_str),
                record.get("incarnation").and_then(Value::as_str),
            ) else {
                continue;
            };
            if spec
                .source_ids
                .as_ref()
                .is_some_and(|ids| !ids.iter().any(|want| want == id))
            {
                continue;
            }
            if read_source(&*read, id)?.is_some_and(|s| s.incarnation == incarnation) {
                out.push(record);
            }
        }
        Ok(out)
    }

    /// `countSegmentedFencePages`: live markdown pages of `sourceIds` stored in segments (both body columns NULL) that
    /// have no path, or whose source's checkout was not walked.
    pub fn count_segmented_fence_pages(&self, spec: &SegmentedPagesSpec) -> Result<u64> {
        let count = all_pages(&*self.read()?)?
            .into_iter()
            .filter(|p| {
                p.deleted_at_us.is_none()
                    && p.page_kind == "markdown"
                    && p.compiled_truth.is_null()
                    && spec.source_ids.contains(&p.source_id)
                    && (p.source_path.is_none() || !spec.walked_source_ids.contains(&p.source_id))
            })
            .count();
        Ok(count as u64)
    }
}
