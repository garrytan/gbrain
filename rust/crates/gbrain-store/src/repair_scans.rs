//! The page scans of the `safe-chunks`, `origin-twins`, `ghost-pages` and `legacy-twins` repair
//! plans, and the twin-merge conflict read (`src/core/engine-sql/repair-page-scans.ts`).
//!
//! Members: listSafeChunksPending, listOriginTwinGroups, listLegacyOriginPairs,
//! listLiveOriginPages, countLiveFileBackedPages, listRepairScanPages, listTwinMergeLosers, and
//! listFileTombstones (the tombstone read of `gbrain repair uncommitted-deletions`).
//!
//! Each member reads every page record once and filters it as the SQL's `WHERE` does, so a brain
//! the store never wrote through its own guards still answers what the SQL engines answer. A
//! live page is one with no `deleted_at`; a file-backed page records a `source_path` (an empty
//! path counts, as SQL's `IS NOT NULL` counts it). Paths group and sort in byte order, as the
//! SQL's `COLLATE "C"` does.

use crate::Store;
use crate::chunks::{SAFE_FENCE_CHUNKER_VERSION, segmented};
use crate::cli_reads::pg_text::{fm_text, jsonb_text};
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::link_queries::link_temporal::{TransitionRecord, all_transitions};
use crate::links::{LinkRecord, in_links, origin_page_links, out_links};
use crate::pages::{PageRecord, all_pages};
use crate::persistence::projection_queue::parse_timestamptz;
use crate::persistence::{all_requests, extra_bool, op_checkpoint_completed_keys};
use crate::raw_files::page_raw_rows;
use crate::timeline::TimelineRecord;
use serde::{Deserialize, Serialize};
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

/// The `op_checkpoints.op` of a managed sync deletion's tombstone record
/// (`src/core/persistence/sync-delete-tombstones.ts`).
const SYNC_DELETE_TOMBSTONE_OP: &str = "sync-delete-tombstone";

/// A soft-deleted page recording a non-blank file (`FileTombstone`): `deleted_at` as ISO 8601,
/// `by_sync` when a managed sync made its current tombstone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileTombstone {
    pub id: u64,
    pub slug: String,
    pub source_path: String,
    pub source_uri: Option<String>,
    pub deleted_at: String,
    pub revision: String,
    pub by_sync: bool,
}

/// `listFileTombstones`'s query: the tombstones below page id `before` (all when `None`), at most
/// `limit`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct FileTombstoneQuery {
    #[serde(default)]
    pub before: Option<u64>,
    #[serde(default)]
    pub limit: u64,
}

/// A page the ghost-pages and legacy-twins repairs read (`RepairScanPage`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RepairScanPage {
    pub id: u64,
    pub slug: String,
    pub revision: String,
    pub content_hash: Option<String>,
    pub source_path: Option<String>,
    pub source_uri: Option<String>,
    /// The write request of the live revision (`revision_write_request_id`).
    pub request_id: Option<String>,
    /// `updated_at` in epoch milliseconds.
    pub updated_ms: f64,
    pub deleted: bool,
    pub database_only_reason: Option<String>,
}

/// `listRepairScanPages`'s query: `ids` (any state), else `slugs` (live, non-blank origin), else
/// the live pages past `after_id`, at most `limit` (`legacy`: blank origin, no database-only stamp).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RepairScanQuery {
    #[serde(default)]
    pub ids: Option<Vec<u64>>,
    #[serde(default)]
    pub slugs: Option<Vec<String>>,
    #[serde(default)]
    pub after_id: u64,
    #[serde(default)]
    pub limit: u64,
    #[serde(default)]
    pub legacy: bool,
}

/// SQL's `COALESCE(btrim(source_path), '') = ''`: no origin, or only spaces.
fn blank_origin(page: &PageRecord) -> bool {
    page.source_path
        .as_deref()
        .is_none_or(|p| p.trim_matches(' ').is_empty())
}

fn scan_page(page: PageRecord) -> RepairScanPage {
    RepairScanPage {
        id: page.id,
        revision: page.knowledge_revision,
        content_hash: page.content_hash,
        source_path: page.source_path,
        source_uri: page.source_uri,
        request_id: page.revision_receipt.request_id,
        updated_ms: page.updated_at_us as f64 / 1000.0,
        deleted: page.deleted_at_us.is_some(),
        database_only_reason: page.database_only_reason,
        slug: page.slug,
    }
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

pub(crate) fn chars(page: &PageRecord) -> u64 {
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

    /// `countLiveFileBackedPages(sourceId, { nonBlank })`: the live pages of the source that record
    /// an origin; `non_blank` skips a blank one.
    pub fn count_live_file_backed_pages(&self, source_id: &str, non_blank: bool) -> Result<u64> {
        let read = self.read()?;
        Ok(live_file_backed(&*read, source_id)?
            .iter()
            .filter(|p| !non_blank || !blank_origin(p))
            .count() as u64)
    }

    /// `listRepairScanPages(sourceId, q)`: the pages of the source `q` names, by id.
    pub fn list_repair_scan_pages(
        &self,
        source_id: &str,
        q: &RepairScanQuery,
    ) -> Result<Vec<RepairScanPage>> {
        let read = self.read()?;
        let ids: Option<BTreeSet<u64>> = q.ids.as_ref().map(|ids| ids.iter().copied().collect());
        let slugs: Option<BTreeSet<&str>> = q
            .slugs
            .as_ref()
            .map(|s| s.iter().map(String::as_str).collect());
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                if p.source_id != source_id {
                    return false;
                }
                if let Some(ids) = &ids {
                    return ids.contains(&p.id);
                }
                if p.deleted_at_us.is_some() {
                    return false;
                }
                if let Some(slugs) = &slugs {
                    return slugs.contains(p.slug.as_str()) && !blank_origin(p);
                }
                p.id > q.after_id
                    && (!q.legacy || (blank_origin(p) && p.database_only_reason.is_none()))
            })
            .collect();
        pages.sort_by_key(|p| p.id);
        if ids.is_none() && slugs.is_none() {
            pages.truncate(usize::try_from(q.limit.max(1)).unwrap_or(usize::MAX));
        }
        Ok(pages.into_iter().map(scan_page).collect())
    }

    /// `listFileTombstones(sourceId, q)`: the soft-deleted pages of the source recording a
    /// non-blank file, below `q.before`, by id descending, at most `q.limit`.
    pub fn list_file_tombstones(
        &self,
        source_id: &str,
        q: &FileTombstoneQuery,
    ) -> Result<Vec<FileTombstone>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.source_id == source_id
                    && p.deleted_at_us.is_some()
                    && !blank_origin(p)
                    && q.before.is_none_or(|before| p.id < before)
            })
            .collect();
        pages.sort_by_key(|p| std::cmp::Reverse(p.id));
        pages.truncate(usize::try_from(q.limit.max(1)).unwrap_or(usize::MAX));
        let receipts: Vec<RequestRecord> = if pages.is_empty() {
            Vec::new()
        } else {
            all_requests(&*read)?
                .into_iter()
                .filter(|r| r.source_id == source_id && sync_delete_receipt(r))
                .collect()
        };
        pages
            .into_iter()
            .map(|p| {
                let deleted_at_us = p.deleted_at_us.unwrap_or_default();
                let by_sync = tombstone_recorded(&*read, p.id, deleted_at_us)?
                    || receipts.iter().any(|r| {
                        r.slug == p.slug
                            && r.page_id == Some(p.id)
                            && r.completed_at_us.is_some_and(|at| at >= deleted_at_us)
                    });
                Ok(FileTombstone {
                    id: p.id,
                    slug: p.slug,
                    source_path: p.source_path.unwrap_or_default(),
                    source_uri: p.source_uri,
                    deleted_at: iso(deleted_at_us),
                    revision: p.knowledge_revision,
                    by_sync,
                })
            })
            .collect()
    }

    /// `listTwinMergeLosers(survivorId, twinId)`: what moving the twin into the survivor would land
    /// on (`TwinMergeLosers`). Read-only.
    pub fn list_twin_merge_losers(
        &self,
        survivor_id: u64,
        twin_id: u64,
    ) -> Result<TwinMergeLosers> {
        let read = self.read()?;
        twin_merge_losers(&*read, survivor_id, twin_id)
    }
}

/// A committed, uncompacted `managed_sync_delete` receipt (`syncDeleteOrigin`'s receipt arm,
/// less the page match).
fn sync_delete_receipt(r: &RequestRecord) -> bool {
    r.state == "committed"
        && !r.intent.is_null()
        && !extra_bool(r, "compacted")
        && r.intent.get("kind").and_then(Value::as_str) == Some("managed_sync_delete")
}

/// `syncDeleteOrigin`'s record arm: the page's `sync-delete-tombstone` record names its current
/// `deleted_at`. A record whose `deleted_at` is not a time is refused, as the SQL's cast refuses it.
fn tombstone_recorded(read: &dyn KvRead, page_id: u64, deleted_at_us: i64) -> Result<bool> {
    let Some(keys) =
        op_checkpoint_completed_keys(read, SYNC_DELETE_TOMBSTONE_OP, &page_id.to_string())?
    else {
        return Ok(false);
    };
    match keys.get(0).and_then(|k| k.get("deleted_at")) {
        None | Some(Value::Null) => Ok(false),
        Some(at) => {
            let text = at.as_str().map_or_else(|| jsonb_text(at), str::to_string);
            Ok(parse_timestamptz(&text, "sync-delete-tombstone deleted_at")? == deleted_at_us)
        }
    }
}

/// A moving link's loser row: its id, its `link_source`, and whether every row on its key says the
/// same thing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkLoser {
    pub id: u64,
    pub link_source: Option<String>,
    pub same: bool,
}

/// A moving link transition's loser row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TransitionLoser {
    pub id: u64,
    pub producer: String,
    pub same: bool,
}

/// A timeline entry of the twin whose detail differs from the survivor's same entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TimelineLoser {
    pub id: u64,
}

/// A raw_data source of the twin whose payload differs from the survivor's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RawLoser {
    pub source: String,
}

/// `TwinMergeLosers`: each list in id (source) order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TwinMergeLosers {
    pub links: Vec<LinkLoser>,
    pub transitions: Vec<TransitionLoser>,
    pub timeline: Vec<TimelineLoser>,
    pub raw_data: Vec<RawLoser>,
}

/// One row of the SQL's `m`: a row touching the pair (not between the two), whether it moves, and
/// its endpoints with the twin mapped to the survivor.
struct Moved<T> {
    row: T,
    moving: bool,
    f: u64,
    t: u64,
    o: Option<u64>,
}

fn moved<T>(
    row: T,
    from: u64,
    to: u64,
    origin: Option<u64>,
    twin: u64,
    survivor: u64,
) -> Option<Moved<T>> {
    let in_pair = |id: u64| id == twin || id == survivor;
    let touches = in_pair(from) || in_pair(to) || origin.is_some_and(in_pair);
    if !touches || (in_pair(from) && in_pair(to)) {
        return None;
    }
    let map = |id: u64| if id == twin { survivor } else { id };
    Some(Moved {
        row,
        moving: from == twin || to == twin || origin == Some(twin),
        f: map(from),
        t: map(to),
        o: origin.map(map),
    })
}

/// The SQL's self-join: for each moving row, the other rows on its mapped key (a moving one only
/// when its id is lower), and whether `same` holds for all of them; rows with none are skipped.
fn losers<T>(
    m: &[Moved<T>],
    id: impl Fn(&T) -> u64,
    key: impl Fn(&Moved<T>, &Moved<T>) -> bool,
    same: impl Fn(&T, &T) -> bool,
) -> Vec<(usize, bool)> {
    let mut out = Vec::new();
    for (i, s) in m.iter().enumerate() {
        if !s.moving {
            continue;
        }
        let sid = id(&s.row);
        let mut all: Option<bool> = None;
        for k in m {
            let kid = id(&k.row);
            if kid != sid
                && k.f == s.f
                && k.t == s.t
                && k.o == s.o
                && key(s, k)
                && (!k.moving || kid < sid)
            {
                all = Some(all.unwrap_or(true) && same(&s.row, &k.row));
            }
        }
        if let Some(all) = all {
            out.push((i, all));
        }
    }
    out.sort_by_key(|(i, _)| id(&m[*i].row));
    out
}

fn twin_merge_losers(read: &dyn KvRead, survivor: u64, twin: u64) -> Result<TwinMergeLosers> {
    let mut links: BTreeMap<u64, LinkRecord> = BTreeMap::new();
    for page in [twin, survivor] {
        for link in out_links(read, page)?
            .into_iter()
            .chain(in_links(read, page)?)
            .chain(origin_page_links(read, page)?)
        {
            links.insert(link.id, link);
        }
    }
    let m: Vec<Moved<LinkRecord>> = links
        .into_values()
        .filter_map(|l| {
            let (f, t, o) = (l.from_page_id, l.to_page_id, l.origin_page_id);
            moved(l, f, t, o, twin, survivor)
        })
        .collect();
    let link_losers = losers(
        &m,
        |l| l.id,
        |s, k| s.row.link_type == k.row.link_type && s.row.link_source == k.row.link_source,
        |s, k| {
            s.context == k.context
                && s.origin_field == k.origin_field
                && s.link_kind == k.link_kind
                && s.resolution_type == k.resolution_type
                && s.assertion_tense == k.assertion_tense
        },
    )
    .into_iter()
    .map(|(i, same)| LinkLoser {
        id: m[i].row.id,
        link_source: m[i].row.link_source.clone(),
        same,
    })
    .collect();

    let mut ts: Vec<TransitionRecord> = all_transitions(read)?;
    ts.sort_by_key(|t| t.id);
    let m: Vec<Moved<TransitionRecord>> = ts
        .into_iter()
        .filter_map(|t| {
            let (f, to, o) = (t.from_page_id, t.to_page_id, t.origin_page_id);
            moved(t, f, to, o, twin, survivor)
        })
        .collect();
    let transition_losers = losers(
        &m,
        |t| t.id,
        |s, k| {
            s.row.link_type == k.row.link_type
                && s.row.kind == k.row.kind
                && s.row.occurred_on == k.row.occurred_on
                && s.row.producer == k.row.producer
        },
        |s, k| s.date_precision == k.date_precision,
    )
    .into_iter()
    .map(|(i, same)| TransitionLoser {
        id: m[i].row.id,
        producer: m[i].row.producer.clone(),
        same,
    })
    .collect();

    let survivor_rows = timeline_rows(read, survivor)?;
    let mut timeline: Vec<TimelineLoser> = timeline_rows(read, twin)?
        .into_iter()
        .filter(|s| {
            survivor_rows.iter().any(|o| {
                o.date == s.date
                    && o.summary == s.summary
                    && o.source == s.source
                    && o.detail != s.detail
            })
        })
        .map(|s| TimelineLoser { id: s.id })
        .collect();
    timeline.sort_by_key(|r| r.id);

    let survivor_raw = page_raw_rows(read, survivor)?;
    let mut raw_data: Vec<RawLoser> = page_raw_rows(read, twin)?
        .into_iter()
        .filter(|s| {
            survivor_raw
                .iter()
                .any(|o| o.source == s.source && o.data != s.data)
        })
        .map(|s| RawLoser { source: s.source })
        .collect();
    raw_data.sort_by(|a, b| a.source.as_bytes().cmp(b.source.as_bytes()));

    Ok(TwinMergeLosers {
        links: link_losers,
        transitions: transition_losers,
        timeline,
        raw_data,
    })
}

/// The timeline rows of `page_id` (event projections included, as the SQL reads them).
fn timeline_rows(read: &dyn KvRead, page_id: u64) -> Result<Vec<TimelineRecord>> {
    let mut rows = Vec::new();
    let mut failure = None;
    scan_prefix(read, &keys::timeline_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(row) => rows.push(row),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(rows), Err)
}
