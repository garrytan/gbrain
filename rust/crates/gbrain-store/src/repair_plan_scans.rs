//! The plan reads of the `frontmatter` and `segmented-tiling` repairs and the source hold
//! listing every sync hold reader starts from (`src/core/engine-sql/repair-plan-scans.ts`).
//!
//! Members: listPagesByOriginPath, countSegmentedOriginPages, listSegmentedPageSlugs,
//! listUntiledSegmentedPages,
//! listSourceHoldRecords, and readRepairBusyRows (`src/core/engine-sql/repair-busy.ts`).
//!
//! Each member reads the records once and filters them as the SQL's `WHERE` does. A live page has
//! no `deleted_at`; a file-backed page records a `source_path`; a segmented page has a body state
//! whose `body_storage` is `segmented` (PGLite's column, not the NULL body test). Slugs, source ids
//! and fingerprints sort in byte order, as the SQL's `COLLATE "C"` does.

use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::error::Result;
use crate::kv::KvRead;
use crate::page_body::{in_generation, manifest_rows, read_body_state, tiling};
use crate::pages::{PageRecord, all_pages};
use crate::persistence::{all_requests, list_op_checkpoint_records_in};
use crate::sources::{all_sources, read_source};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// A live page of a source that records an origin, with the first 400 characters of its
/// compiled truth (`None` for a segmented page, whose column is NULL).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OriginPathPage {
    pub id: u64,
    pub slug: String,
    pub source_path: String,
    pub revision: String,
    pub title: String,
    pub head: Option<String>,
}

/// A live segmented page of an unarchived source whose live generation's rows do not tile its
/// body. `covered` and `gapless` are the tiling aggregate `liveTilingSql` reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UntiledSegmentedPage {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub revision: String,
    pub body_generation: i64,
    pub body_bytes: Option<i64>,
    pub segment_count: Option<i64>,
    pub source_path: Option<String>,
    pub n: i64,
    pub covered: i64,
    pub gapless: bool,
}

/// One hold record (`completed_keys->0` of an `op_checkpoints` row of `op`) that names a source
/// and that source's current incarnation, and whether the source is a read-only mirror.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceHoldRecord {
    pub record: Value,
    pub mirror_read_only: bool,
}

/// One open request of a source, as `readRepairBusyRows` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepairBusyPending {
    pub slug: Option<String>,
    pub path: Option<String>,
    pub source_path: Option<String>,
    pub rename_slug: Option<String>,
    pub rename_source_path: Option<String>,
}

/// One unfinished managed sync cursor: its run id and next manifest index, as `->>` text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepairBusyCursor {
    pub run_id: Option<String>,
    pub index: Option<String>,
}

/// The rows a repair's busy set is built from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepairBusyRows {
    pub pending: Vec<RepairBusyPending>,
    pub cursors: Vec<RepairBusyCursor>,
    pub held: Vec<String>,
}

/// The request states that keep a request open (`state IN (...)` of the busy read).
const OPEN_STATES: [&str; 4] = ["queued", "deferred", "running", "recovering"];

fn live(page: &PageRecord) -> bool {
    page.deleted_at_us.is_none()
}

fn body_segmented(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    Ok(read_body_state(read, page.id)?.is_some_and(|state| state.body_storage == "segmented"))
}

/// `->> key` of a JSON value that is an object; `None` for anything else, as SQL's NULL.
fn text_of(value: &Value, key: &str) -> Option<String> {
    value.as_object().and_then(|object| fm_text(object, key))
}

impl Store {
    /// `listPagesByOriginPath(sourceId)`: the live pages of the source that record an origin, by
    /// slug in byte order.
    pub fn list_pages_by_origin_path(&self, source_id: &str) -> Result<Vec<OriginPathPage>> {
        let read = self.read()?;
        let mut out: Vec<OriginPathPage> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && live(p))
            .filter_map(|page| {
                let source_path = page.source_path.clone()?;
                Some(OriginPathPage {
                    id: page.id,
                    head: page
                        .compiled_truth
                        .as_deref()
                        .map(|body| body.chars().take(400).collect()),
                    slug: page.slug,
                    source_path,
                    revision: page.knowledge_revision,
                    title: page.title,
                })
            })
            .collect();
        out.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(out)
    }

    /// `countSegmentedOriginPages(sourceIds)`: the live, file-backed pages of `source_ids` stored
    /// in segments.
    pub fn count_segmented_origin_pages(&self, source_ids: &[String]) -> Result<u64> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let mut n = 0u64;
        for page in all_pages(&*read)? {
            if wanted.contains(page.source_id.as_str())
                && live(&page)
                && page.source_path.is_some()
                && body_segmented(&*read, &page)?
            {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `listSegmentedPageSlugs(sourceId)`: the slugs of the live pages of `source_id` stored in
    /// segments, file-backed or not, in byte order.
    pub fn list_segmented_page_slugs(&self, source_id: &str) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut slugs = Vec::new();
        for page in all_pages(&*read)? {
            if page.source_id == source_id && live(&page) && body_segmented(&*read, &page)? {
                slugs.push(page.slug);
            }
        }
        slugs.sort();
        Ok(slugs)
    }

    /// `listUntiledSegmentedPages({ sourceIds, slugs, limit })`: the live segmented pages of
    /// unarchived sources whose live generation's published rows, by seq, do not cover
    /// `body_bytes` gapless from 0, by source id then slug, at most `limit`. `None` filters do not
    /// narrow. A page with a NULL `body_bytes` is listed only when its rows leave a gap, as SQL's
    /// `NOT gapless OR covered <> body_bytes` is NULL otherwise.
    pub fn list_untiled_segmented_pages(
        &self,
        source_ids: Option<&[String]>,
        slugs: Option<&[String]>,
        limit: u64,
    ) -> Result<Vec<UntiledSegmentedPage>> {
        let read = self.read()?;
        let active: BTreeSet<String> = all_sources(&*read)?
            .into_iter()
            .filter(|s| !s.archived)
            .map(|s| s.id)
            .collect();
        let sources: Option<BTreeSet<&str>> =
            source_ids.map(|ids| ids.iter().map(String::as_str).collect());
        let slugs: Option<BTreeSet<&str>> =
            slugs.map(|ids| ids.iter().map(String::as_str).collect());
        let mut out = Vec::new();
        for page in all_pages(&*read)? {
            if !live(&page)
                || !active.contains(&page.source_id)
                || sources
                    .as_ref()
                    .is_some_and(|s| !s.contains(page.source_id.as_str()))
                || slugs
                    .as_ref()
                    .is_some_and(|s| !s.contains(page.slug.as_str()))
            {
                continue;
            }
            let Some(state) = read_body_state(&*read, page.id)? else {
                continue;
            };
            if state.body_storage != "segmented" {
                continue;
            }
            let rows: Vec<_> = manifest_rows(&*read, page.id)?
                .into_iter()
                .map(|(_, row)| row)
                .filter(|row| in_generation(row, state.body_generation))
                .collect();
            let refs: Vec<_> = rows.iter().collect();
            let (n, covered, gapless) = tiling(&refs);
            let untiled = !gapless || state.body_bytes.is_some_and(|bytes| bytes != covered);
            if !untiled {
                continue;
            }
            out.push(UntiledSegmentedPage {
                id: page.id,
                source_id: page.source_id,
                slug: page.slug,
                revision: page.knowledge_revision,
                body_generation: state.body_generation,
                body_bytes: state.body_bytes,
                segment_count: state.segment_count,
                source_path: page.source_path,
                n,
                covered,
                gapless,
            });
        }
        out.sort_by(|a, b| {
            a.source_id
                .cmp(&b.source_id)
                .then_with(|| a.slug.cmp(&b.slug))
        });
        out.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(out)
    }

    /// `listSourceHoldRecords(op, { sourceIds, runId })`: the first record of each `op` checkpoint
    /// that names an existing source and its current incarnation, narrowed to `source_ids` and to
    /// records whose `run_id` is `run_id`, by source id then fingerprint.
    pub fn list_source_hold_records(
        &self,
        op: &str,
        source_ids: Option<&[String]>,
        run_id: Option<&str>,
    ) -> Result<Vec<SourceHoldRecord>> {
        let read = self.read()?;
        let wanted: Option<BTreeSet<&str>> =
            source_ids.map(|ids| ids.iter().map(String::as_str).collect());
        let rows = list_op_checkpoint_records_in(&*read, op)?;
        let mut sources = BTreeMap::new();
        let mut out: Vec<(String, String, SourceHoldRecord)> = Vec::new();
        for row in rows.as_array().into_iter().flatten() {
            let Some(record) = row.get("completed_keys").and_then(|keys| keys.get(0)) else {
                continue;
            };
            let Some(source_id) = text_of(record, "source_id") else {
                continue;
            };
            if wanted
                .as_ref()
                .is_some_and(|w| !w.contains(source_id.as_str()))
            {
                continue;
            }
            if run_id.is_some_and(|run| text_of(record, "run_id").as_deref() != Some(run)) {
                continue;
            }
            if !sources.contains_key(&source_id) {
                let found = read_source(&*read, &source_id)?;
                sources.insert(source_id.clone(), found);
            }
            let Some(source) = sources.get(&source_id).and_then(Option::as_ref) else {
                continue;
            };
            if text_of(record, "incarnation").as_deref() != Some(source.incarnation.as_str()) {
                continue;
            }
            let mirror_read_only =
                fm_text(&source.config, "mirror_read_only").as_deref() == Some("true");
            let fingerprint = row
                .get("fingerprint")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            out.push((
                source_id,
                fingerprint,
                SourceHoldRecord {
                    record: record.clone(),
                    mirror_read_only,
                },
            ));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        Ok(out.into_iter().map(|(_, _, hold)| hold).collect())
    }

    /// `readRepairBusyRows(sourceId, incarnation)`: the open requests of the source (queued,
    /// deferred, running or recovering, or carrying a recovery) by sequence; the unfinished
    /// `managed-sync` cursors of the source at `incarnation`; and, when a cursor is open, the paths
    /// of its `sync-hold` records at `incarnation`. Cursors and holds sort by fingerprint in byte
    /// order, the key order of the scan.
    pub fn read_repair_busy_rows(
        &self,
        source_id: &str,
        incarnation: &str,
    ) -> Result<RepairBusyRows> {
        let read = self.read()?;
        let mut requests: Vec<_> = all_requests(&*read)?
            .into_iter()
            .filter(|r| {
                r.source_id == source_id
                    && (OPEN_STATES.contains(&r.state.as_str())
                        || r.extra.get("recovery").is_some_and(|v| !v.is_null()))
            })
            .collect();
        requests.sort_by_key(|r| r.sequence);
        let pending = requests
            .into_iter()
            .map(|r| {
                let rename = r.intent.get("renameFrom").cloned().unwrap_or(Value::Null);
                RepairBusyPending {
                    path: text_of(&r.intent, "path"),
                    source_path: text_of(&r.intent, "sourcePath"),
                    rename_slug: text_of(&rename, "slug"),
                    rename_source_path: text_of(&rename, "sourcePath"),
                    slug: Some(r.slug),
                }
            })
            .collect();
        let first = |row: &Value| {
            row.get("completed_keys")
                .and_then(|keys| keys.get(0))
                .cloned()
        };
        let mut cursors = Vec::new();
        for row in list_op_checkpoint_records_in(&*read, "managed-sync")?
            .as_array()
            .into_iter()
            .flatten()
        {
            let Some(record) = first(row) else { continue };
            if text_of(&record, "done").as_deref().unwrap_or("false") == "true"
                || text_of(&record, "sourceId").as_deref() != Some(source_id)
                || text_of(&record, "incarnation").as_deref() != Some(incarnation)
            {
                continue;
            }
            cursors.push(RepairBusyCursor {
                run_id: text_of(&record, "runId"),
                index: text_of(&record, "index"),
            });
        }
        let mut held = Vec::new();
        if !cursors.is_empty() {
            for row in list_op_checkpoint_records_in(&*read, "sync-hold")?
                .as_array()
                .into_iter()
                .flatten()
            {
                let Some(record) = first(row) else { continue };
                if text_of(&record, "source_id").as_deref() == Some(source_id)
                    && text_of(&record, "incarnation").as_deref() == Some(incarnation)
                    && let Some(path) = text_of(&record, "path")
                {
                    held.push(path);
                }
            }
        }
        Ok(RepairBusyRows {
            pending,
            cursors,
            held,
        })
    }
}
