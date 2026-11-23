//! Doctor-derived reads: the typed members that replace the raw SQL of the second set of doctor
//! checks (SQL in `src/core/engine-sql/doctor-derived.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-derived.md`). Each read takes one snapshot and has no keys of
//! its own. Members the store has no relation for are answered by the TypeScript engine layer
//! (empty, with no store call) or refused; see the doc.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Deserialize;
use serde_json::{Value, json};

use super::pg_text::fm_text;
use crate::Store;
use crate::chunks::SAFE_FENCE_CHUNKER_VERSION;
use crate::env::iso;
use crate::error::Result;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::page_ops::restorable_atoms;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::raw_files::all_file_records;
use crate::sources::{SourceRecord, read_source};
use crate::timeline::TimelineRecord;

/// One day of PGLite's `interval '1 day'`; PGLite runs in `Etc/GMT0`, so a day is 24 hours.
const DAY_US: i64 = 86_400_000_000;
/// `ATOM_RESTORE_HOLD_DAYS` (`src/core/persistence/atom-retirement-hold.ts`).
const ATOM_RESTORE_HOLD_DAYS: i64 = 30;
/// The batch size of `listTimelineHistoryBatch` (`LIMIT 200` of its statement).
const TIMELINE_BATCH: usize = 200;

/// `listAtomFenceCandidates` input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtomFenceInput {
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub atom_id: Option<i64>,
    #[serde(default)]
    pub after: i64,
    pub limit: u64,
}

/// `s.archived IS NOT TRUE` over `JOIN sources s ON s.id = p.source_id`: the source exists and is
/// not archived. Looked up once per source.
pub(super) struct LiveSources<'a> {
    read: &'a dyn KvRead,
    seen: HashMap<String, bool>,
}

impl<'a> LiveSources<'a> {
    pub(super) fn new(read: &'a dyn KvRead) -> Self {
        Self {
            read,
            seen: HashMap::new(),
        }
    }

    pub(super) fn unarchived(&mut self, id: &str) -> Result<bool> {
        if let Some(known) = self.seen.get(id) {
            return Ok(*known);
        }
        let live = read_source(self.read, id)?
            .as_ref()
            .is_some_and(|s: &SourceRecord| !s.archived);
        self.seen.insert(id.to_string(), live);
        Ok(live)
    }
}

pub(super) fn in_scope(sources: Option<&[String]>, source_id: &str) -> bool {
    sources.is_none_or(|s| s.iter().any(|x| x == source_id))
}

/// `p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file', p.source_path) IS NOT NULL)`.
pub(super) fn rebuildable(page: &PageRecord) -> bool {
    page.page_kind == "markdown"
        || (page.page_kind == "code"
            && (fm_text(&page.frontmatter, "file").is_some() || page.source_path.is_some()))
}

/// The page ids that own at least one timeline row no event page owns (`event_page_id IS NULL`).
fn pages_with_own_rows(read: &dyn KvRead) -> Result<BTreeSet<u64>> {
    let mut pages = BTreeSet::new();
    let mut failure = None;
    scan_prefix(read, &[keys::TIMELINE], false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(entry) => {
                if entry.event_page_id.is_none() {
                    pages.insert(entry.page_id);
                }
            }
            Err(e) => failure = Some(crate::error::StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(pages), Err)
}

impl Store {
    /// `countSafeIndexPending(sourceIds?)`: live pages of unarchived sources chunked below the
    /// safe-chunk fence, split into the ones a repair can rebuild and the ones it keeps. A record
    /// with no chunker version is below the fence (PGLite's column default is 1).
    pub fn count_safe_index_pending(&self, source_ids: Option<&[String]>) -> Result<Value> {
        let read = self.read()?;
        let mut live = LiveSources::new(&*read);
        let (mut rebuild, mut kept) = (0u64, 0u64);
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || page.chunker_version.unwrap_or(0) >= SAFE_FENCE_CHUNKER_VERSION
                || !in_scope(source_ids, &page.source_id)
                || !live.unarchived(&page.source_id)?
            {
                continue;
            }
            if rebuildable(&page) {
                rebuild += 1;
            } else {
                kept += 1;
            }
        }
        Ok(json!({ "rebuildable": rebuild, "kept": kept }))
    }

    /// `countPagesByTypeAndOwner(sourceIds?)`: live pages per source, stored type and writer
    /// ownership (true, false, or NULL as SQL gives it), by source, type, then owner; `n` is text as the SQL engines return it.
    pub fn count_pages_by_type_and_owner(
        &self,
        source_ids: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut groups: BTreeMap<(String, String, Option<bool>), u64> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || !in_scope(source_ids, &page.source_id) {
                continue;
            }
            // `WRITER_OWNED_PAGE_SQL` (`src/core/engine-sql/pages.ts`), with SQL's three values: an
            // `extracts/` receipt with no `dream_generated` key is NULL, not false, and groups apart.
            let own = if page.page_type == "code" && page.page_kind == "code" {
                Some(true)
            } else if page.page_type == "extract_receipt" && page.slug.starts_with("extracts/") {
                fm_text(&page.frontmatter, "dream_generated").map(|v| v == "true")
            } else {
                Some(false)
            };
            *groups
                .entry((page.source_id.clone(), page.page_type.clone(), own))
                .or_default() += 1;
        }
        Ok(groups
            .into_iter()
            .map(|((src, ty, own), n)| json!({ "src": src, "type": ty, "own": own, "n": n.to_string() }))
            .collect())
    }

    /// `listImageAssetFiles()`: the first 1000 `files` rows whose mime type starts `image/`, in
    /// file id order, with the root of the file's source and the source path of its page.
    pub fn list_image_asset_files(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut roots: HashMap<String, Option<String>> = HashMap::new();
        let mut rows = Vec::new();
        for file in all_file_records(&*read)? {
            if !file
                .mime_type
                .as_deref()
                .is_some_and(|m| m.starts_with("image/"))
            {
                continue;
            }
            let root = match roots.get(&file.source_id) {
                Some(root) => root.clone(),
                None => {
                    let root = read_source(&*read, &file.source_id)?.and_then(|s| s.local_path);
                    roots.insert(file.source_id.clone(), root.clone());
                    root
                }
            };
            let page_source = match file.page_id {
                Some(id) => read_page_by_id(&*read, id)?.and_then(|p| p.source_path),
                None => None,
            };
            rows.push(json!({
                "storage_path": file.storage_path,
                "metadata": file.metadata,
                "source_local_path": root,
                "page_source_path": page_source,
            }));
            if rows.len() == 1000 {
                break;
            }
        }
        Ok(rows)
    }

    /// `listRestorableAtomRetirements(sourceIds)`: per source, the restorable re-extraction
    /// retirements (the rule of `atomRetirementsSql`, shared with the purge hold) with their
    /// count, distinct origins, oldest and newest `retired_at` text and the day the hold ends.
    /// The store keeps no generation ledger, so no retirement is ledger-covered.
    pub fn list_restorable_atom_retirements(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| source_ids.contains(&p.source_id))
            .collect();
        let restorable = restorable_atoms(&pages);
        let mut per_source: BTreeMap<&str, Vec<&PageRecord>> = BTreeMap::new();
        for page in pages.iter().filter(|p| restorable.contains(&p.id)) {
            per_source
                .entry(page.source_id.as_str())
                .or_default()
                .push(page);
        }
        let nonempty = |page: &PageRecord, key: &str| {
            fm_text(&page.frontmatter, key).filter(|v| !v.is_empty())
        };
        Ok(per_source
            .into_iter()
            .map(|(source, atoms)| {
                let origins: BTreeSet<String> = atoms
                    .iter()
                    .map(|a| match nonempty(a, "source_slug") {
                        Some(slug) => format!("page:{slug}"),
                        None => format!(
                            "transcript:{}",
                            nonempty(a, "source_path").unwrap_or_default()
                        ),
                    })
                    .collect();
                let stamps: Vec<String> = atoms
                    .iter()
                    .filter_map(|a| fm_text(&a.frontmatter, "retired_at"))
                    .collect();
                let oldest_deleted = atoms
                    .iter()
                    .filter_map(|a| a.deleted_at_us)
                    .min()
                    .unwrap_or(0);
                // `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`: whole seconds.
                let hold = iso(oldest_deleted.saturating_add(ATOM_RESTORE_HOLD_DAYS * DAY_US));
                json!({
                    "source_id": source,
                    "count": atoms.len(),
                    "origins": origins.len(),
                    "oldest": stamps.iter().min_by(|a, b| a.as_bytes().cmp(b.as_bytes())),
                    "newest": stamps.iter().max_by(|a, b| a.as_bytes().cmp(b.as_bytes())),
                    "hold_until": format!("{}Z", &hold[..19]),
                })
            })
            .collect())
    }

    /// `listTimelineHistoryBatch(sourceIds, afterId)`: the next 200 live inline pages of the
    /// sources after `afterId`, by id, that hold a timeline row no event page owns.
    pub fn list_timeline_history_batch(
        &self,
        source_ids: &[String],
        after_id: i64,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let owners = pages_with_own_rows(&*read)?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && source_ids.contains(&p.source_id))
            .filter(|p| i64::try_from(p.id).is_ok_and(|id| id > after_id))
            // `body_storage = 'inline'`: a segmented page has NULL `compiled_truth` and `timeline`.
            .filter(|p| !(p.compiled_truth.is_null() && p.timeline.is_null()))
            .filter(|p| owners.contains(&p.id))
            .collect();
        pages.sort_by_key(|p| p.id);
        pages.truncate(TIMELINE_BATCH);
        Ok(pages
            .into_iter()
            .map(|p| {
                json!({
                    "id": p.id,
                    "source_id": p.source_id,
                    "slug": p.slug,
                    "compiled_truth": p.compiled_truth.as_deref(),
                    "timeline": p.timeline.as_deref(),
                })
            })
            .collect())
    }

    /// `readPageCompiledTruths(ids)`: `{ id, body }` of the named pages that exist (soft-deleted
    /// ones too), by id; `body` is null for a segmented page.
    pub fn read_page_compiled_truths(&self, ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let wanted: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut rows = Vec::new();
        for id in wanted {
            if let Some(page) = read_page_by_id(&*read, id)? {
                rows.push(json!({ "id": id, "body": page.compiled_truth.as_deref() }));
            }
        }
        Ok(rows)
    }
}
