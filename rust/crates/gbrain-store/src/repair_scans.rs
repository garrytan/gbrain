//! The page scans of the `safe-chunks` and `origin-twins` repair plans
//! (`src/core/engine-sql/repair-page-scans.ts`).
//!
//! Members: listSafeChunksPending, listOriginTwinGroups, listLegacyOriginPairs,
//! listLiveOriginPages, countLiveFileBackedPages.
//!
//! Each member reads every page record once and filters it as the SQL's `WHERE` does, so a brain
//! the store never wrote through its own guards still answers what the SQL engines answer. A
//! live page is one with no `deleted_at`; a file-backed page records a `source_path` (an empty
//! path counts, as SQL's `IS NOT NULL` counts it). Paths group and sort in byte order, as the
//! SQL's `COLLATE "C"` does.

use crate::Store;
use crate::chunks::{SAFE_FENCE_CHUNKER_VERSION, segmented};
use crate::cli_reads::pg_text::{fm_text, jsonb_text};
use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages};
use crate::persistence::op_checkpoint_completed_keys;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The `op_checkpoints.op` of a credential re-chunk hold (`src/core/page-state/credential-reseal.ts`).
const CREDENTIAL_RESEAL_HOLD: &str = "credential-reseal-hold";

/// One page `gbrain repair safe-chunks` re-seals or reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SafeChunksPending {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub page_kind: String,
    /// A markdown page, or a code page that names its file (`frontmatter.file` or `source_path`).
    pub rebuildable: bool,
    /// Characters of `compiled_truth` plus `timeline`; 0 for a segmented page (SQL's NULL sum).
    pub chars: u64,
}

/// Live pages of one source that record the same `source_path`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OriginTwinGroup {
    pub source_path: String,
    pub ids: Vec<u64>,
    pub paths: Vec<String>,
}

/// A live page recording `<prefix><origin>` beside another live page recording `origin`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegacyOriginPair {
    pub legacy_id: u64,
    pub legacy_path: String,
    pub legacy_slug: String,
    pub origin: String,
}

/// A live page and the origin it records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LiveOriginPage {
    pub id: u64,
    pub source_path: String,
}

/// The live, file-backed pages of `source_id`, by id.
fn live_file_backed(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageRecord>> {
    let mut pages: Vec<PageRecord> = all_pages(read)?
        .into_iter()
        .filter(|p| {
            p.source_id == source_id && p.deleted_at_us.is_none() && p.source_path.is_some()
        })
        .collect();
    pages.sort_by_key(|p| p.id);
    Ok(pages)
}

/// `text ->> key` of a JSON object: the string, the jsonb text of any other value, `None` for a
/// missing key or JSON null.
fn field_text(value: &Value, key: &str) -> Option<String> {
    match value.get(key)? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// `CREDENTIAL_RESEAL_HELD`: the page is unsealed and a hold for its id names its current
/// revision and `producer`.
fn reseal_held(read: &dyn KvRead, page: &PageRecord, producer: &str) -> Result<bool> {
    if page.text_projection_revision.as_deref() == Some(page.knowledge_revision.as_str()) {
        return Ok(false);
    }
    let Some(keys) =
        op_checkpoint_completed_keys(read, CREDENTIAL_RESEAL_HOLD, &page.id.to_string())?
    else {
        return Ok(false);
    };
    let Some(hold) = keys.get(0) else {
        return Ok(false);
    };
    Ok(
        field_text(hold, "revision").as_deref() == Some(page.knowledge_revision.as_str())
            && field_text(hold, "producer").as_deref() == Some(producer),
    )
}

fn chars(page: &PageRecord) -> u64 {
    match page.compiled_truth.as_deref() {
        None => 0,
        Some(body) => {
            let timeline = page.timeline.as_deref().unwrap_or("");
            (body.chars().count() + timeline.chars().count()) as u64
        }
    }
}

impl Store {
    /// `listSafeChunksPending(sourceIds, producer)`: the live pages of `source_ids` below the safe
    /// chunker version, or held for a credential re-chunk and not segmented, by id.
    pub fn list_safe_chunks_pending(
        &self,
        source_ids: &[String],
        producer: &str,
    ) -> Result<Vec<SafeChunksPending>> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        for page in all_pages(&*read)? {
            if !wanted.contains(page.source_id.as_str()) || page.deleted_at_us.is_some() {
                continue;
            }
            // `chunker_version < fence`: a page that records no version fails it, as NULL does.
            let below = page
                .chunker_version
                .is_some_and(|v| v < SAFE_FENCE_CHUNKER_VERSION);
            if !below && (segmented(&page) || !reseal_held(&*read, &page, producer)?) {
                continue;
            }
            let rebuildable = page.page_kind == "markdown"
                || (page.page_kind == "code"
                    && (fm_text(&page.frontmatter, "file").is_some()
                        || page.source_path.is_some()));
            out.push(SafeChunksPending {
                id: page.id,
                chars: chars(&page),
                source_id: page.source_id,
                slug: page.slug,
                page_kind: page.page_kind,
                rebuildable,
            });
        }
        out.sort_by_key(|p| p.id);
        Ok(out)
    }

    /// `listOriginTwinGroups(sourceId, limit)`: the origins two or more live pages of the source
    /// record, at most `limit`, in byte order; each group's ids ascending.
    pub fn list_origin_twin_groups(
        &self,
        source_id: &str,
        limit: u64,
    ) -> Result<Vec<OriginTwinGroup>> {
        let read = self.read()?;
        let mut by_path: BTreeMap<String, Vec<u64>> = BTreeMap::new();
        for page in live_file_backed(&*read, source_id)? {
            if let Some(path) = page.source_path {
                by_path.entry(path).or_default().push(page.id);
            }
        }
        Ok(by_path
            .into_iter()
            .filter(|(_, ids)| ids.len() > 1)
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .map(|(source_path, ids)| OriginTwinGroup {
                paths: vec![source_path.clone(); ids.len()],
                source_path,
                ids,
            })
            .collect())
    }

    /// `listLegacyOriginPairs(sourceId, prefix, limit)`: each live page recording `prefix` plus
    /// the origin another live page of the source records, by the legacy page's id then the
    /// other's, at most `limit`.
    pub fn list_legacy_origin_pairs(
        &self,
        source_id: &str,
        prefix: &str,
        limit: u64,
    ) -> Result<Vec<LegacyOriginPair>> {
        let read = self.read()?;
        let pages = live_file_backed(&*read, source_id)?;
        let mut by_path: BTreeMap<&str, Vec<u64>> = BTreeMap::new();
        for page in &pages {
            if let Some(path) = page.source_path.as_deref() {
                by_path.entry(path).or_default().push(page.id);
            }
        }
        let cap = usize::try_from(limit).unwrap_or(usize::MAX);
        let mut out = Vec::new();
        for legacy in &pages {
            let Some(path) = legacy.source_path.as_deref() else {
                continue;
            };
            let Some(origin) = path.strip_prefix(prefix) else {
                continue;
            };
            for &other in by_path.get(origin).into_iter().flatten() {
                if other == legacy.id {
                    continue;
                }
                if out.len() == cap {
                    return Ok(out);
                }
                out.push(LegacyOriginPair {
                    legacy_id: legacy.id,
                    legacy_path: path.to_owned(),
                    legacy_slug: legacy.slug.clone(),
                    origin: origin.to_owned(),
                });
            }
        }
        Ok(out)
    }

    /// `listLiveOriginPages(sourceId, paths)`: the live pages of the source recording any of
    /// `paths`, by id.
    pub fn list_live_origin_pages(
        &self,
        source_id: &str,
        paths: &[String],
    ) -> Result<Vec<LiveOriginPage>> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
        Ok(live_file_backed(&*read, source_id)?
            .into_iter()
            .filter_map(|page| {
                let source_path = page.source_path?;
                wanted
                    .contains(source_path.as_str())
                    .then_some(LiveOriginPage {
                        id: page.id,
                        source_path,
                    })
            })
            .collect())
    }

    /// `countLiveFileBackedPages(sourceId)`: the live pages of the source that record an origin.
    pub fn count_live_file_backed_pages(&self, source_id: &str) -> Result<u64> {
        let read = self.read()?;
        Ok(live_file_backed(&*read, source_id)?.len() as u64)
    }
}
