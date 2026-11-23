//! Source-resolution reads: `listLocalPathSources`, `listSourceRoutingRows`,
//! `countDefaultSourceSplit` and `countSourcePages` (SQL in `src/core/engine-sql/sources.ts`).
//! Each reads one snapshot. `insertSource` is the CLI's plain source insert.
//! `listSourcePathPages` and `readRenameIdentityRows` are the page reads of a git sync: the live
//! pages a full sync reconciles, and the stored side a rename's identity check compares.
//! `listQuarantinedSlugs` names the live pages its link and timeline extraction skips.

use crate::cli_reads::pg_text::fm_text;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::PageRecord;
use crate::sources::{
    DEFAULT_SOURCE, SourceRecord, SourceRow, all_sources, read_source, valid_source_id,
};
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// The source a plain-directory sync reads (`PlainSyncSourceRow`). `last_commit` is the one
/// `advance_source_commit` stored.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlainSyncSourceRow {
    pub local_path: Option<String>,
    pub last_commit: Option<String>,
    pub config: Map<String, Value>,
}

/// A source with a checkout path: `LocalPathSourceRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LocalPathSourceRow {
    pub id: String,
    pub local_path: String,
    pub archived: bool,
}

/// One source as the resolver routes on it: `SourceRoutingRow`. `default_has_pages` is the same
/// on every row: whether the `default` source has a live page.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceRoutingRow {
    pub id: String,
    pub local_path: Option<String>,
    pub archived: bool,
    pub config: Map<String, Value>,
    pub default_has_pages: bool,
}

/// Live pages in `default`, live pages elsewhere, and how many other sources hold them:
/// `DefaultSourceSplit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultSourceSplit {
    pub default_pages: u64,
    pub non_default_pages: u64,
    pub non_default_sources: u64,
}

/// The two fields of a page record these reads need; the rest of the record is not decoded.
#[derive(Deserialize)]
struct PageLiveness {
    source_id: String,
    #[serde(default)]
    deleted_at_us: Option<i64>,
}

/// Calls `f` with the source of each live page under `prefix` until it returns false.
pub(super) fn scan_live_pages(
    read: &dyn KvRead,
    prefix: &[u8],
    f: &mut dyn FnMut(&str) -> bool,
) -> Result<()> {
    let mut failure = None;
    scan_prefix(
        read,
        prefix,
        false,
        &mut |_, v| match serde_json::from_slice::<PageLiveness>(v) {
            Ok(page) if page.deleted_at_us.is_none() => f(&page.source_id),
            Ok(_) => true,
            Err(e) => {
                failure = Some(e.into());
                false
            }
        },
    )?;
    failure.map_or(Ok(()), Err)
}

fn default_has_live_pages(read: &dyn KvRead) -> Result<bool> {
    let mut found = false;
    scan_live_pages(
        read,
        &keys::text(keys::PAGE, &[DEFAULT_SOURCE, ""]),
        &mut |_| {
            found = true;
            false
        },
    )?;
    Ok(found)
}

/// A live page with a file origin: `SourcePathPageRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourcePathPageRow {
    pub slug: String,
    pub source_path: String,
}

/// A live page a rename's identity check compares: `RenameIdentityRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RenameIdentityRow {
    pub slug: String,
    pub source_path: Option<String>,
    pub title: Option<String>,
}

/// A live page that holds a frontmatter id or a title: `LiveIdentityHolder`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveIdentityHolder {
    pub slug: String,
    pub source_path: Option<String>,
    pub fm_id: Option<String>,
    pub title: Option<String>,
}

/// A stored page a sync size-state read reports: `PageSizeRow`. `state` and `reason` are the
/// page's `page_embedding_budget` row; this store keeps no such row, so both are always None.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageSizeRow {
    pub slug: String,
    pub bytes: Option<i64>,
    pub segmented: bool,
    pub frontmatter: Map<String, Value>,
    pub state: Option<String>,
    pub reason: Option<String>,
}

/// The page fields the sync page reads need; the rest of the record is not decoded.
#[derive(Deserialize)]
struct PageOrigin {
    slug: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    frontmatter: Map<String, Value>,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    deleted_at_us: Option<i64>,
}

/// Calls `f` with each live page of `source_id`, in slug order.
fn scan_live_origins(
    read: &dyn KvRead,
    source_id: &str,
    f: &mut dyn FnMut(PageOrigin),
) -> Result<()> {
    if source_id.contains('\0') {
        return Ok(());
    }
    let mut failure = None;
    scan_prefix(
        read,
        &keys::text(keys::PAGE, &[source_id, ""]),
        false,
        &mut |_, v| match serde_json::from_slice::<PageOrigin>(v) {
            Ok(page) => {
                if page.deleted_at_us.is_none() {
                    f(page);
                }
                true
            }
            Err(e) => {
                failure = Some(e.into());
                false
            }
        },
    )?;
    failure.map_or(Ok(()), Err)
}

impl Store {
    /// `readPageSizeRows(sourceId, maxBytes, slugs)`: the live pages of one source (only the listed
    /// slugs when `slugs` is Some) that carry `embed_skip`, have a body over `max_bytes` or are
    /// segmented or have a ledger row (`page_embedding_budget.rs`, the `page_embedding_budget` row),
    /// in slug order. `bytes` is a segmented page's `body_bytes`, else the UTF-8 length of its
    /// compiled truth plus its timeline; `state` and `reason` are the ledger row's, else null.
    pub fn read_page_size_rows(
        &self,
        source_id: &str,
        max_bytes: i64,
        slugs: Option<&[String]>,
    ) -> Result<Vec<PageSizeRow>> {
        if slugs.is_some_and(<[String]>::is_empty) || source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let wanted: Option<BTreeSet<&str>> = slugs.map(|s| s.iter().map(String::as_str).collect());
        let read = self.read()?;
        let mut pages = Vec::new();
        let mut failure = None;
        scan_prefix(
            &*read,
            &keys::text(keys::PAGE, &[source_id, ""]),
            false,
            &mut |_, v| match serde_json::from_slice::<PageRecord>(v) {
                Ok(page) => {
                    if page.deleted_at_us.is_none()
                        && wanted
                            .as_ref()
                            .is_none_or(|w| w.contains(page.slug.as_str()))
                    {
                        pages.push(page);
                    }
                    true
                }
                Err(e) => {
                    failure = Some(e.into());
                    false
                }
            },
        )?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut rows = Vec::new();
        for page in pages {
            let reference = crate::page_body::segmented_reference(&*read, page.id)?;
            let segmented = reference.is_some();
            let bytes = match reference {
                Some((_, body_bytes)) => body_bytes,
                None => i64::try_from(page.compiled_truth.len() + page.timeline.len()).ok(),
            };
            let skip = page.frontmatter.contains_key("embed_skip");
            let hold = crate::page_embedding_budget::read_state_reason(&*read, page.id)?;
            if skip || segmented || bytes.is_some_and(|b| b > max_bytes) || hold.is_some() {
                let (state, reason) =
                    hold.map_or((None, None), |(state, reason)| (Some(state), reason));
                rows.push(PageSizeRow {
                    slug: page.slug,
                    bytes,
                    segmented,
                    frontmatter: page.frontmatter,
                    state,
                    reason,
                });
            }
        }
        Ok(rows)
    }

    /// `listSourcePathPages(sourceId)`: the live pages of one source that have a `source_path`, in
    /// slug order. The SQL engines return them in no set order.
    pub fn list_source_path_pages(&self, source_id: &str) -> Result<Vec<SourcePathPageRow>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        scan_live_origins(&*read, source_id, &mut |page| {
            if let Some(source_path) = page.source_path {
                rows.push(SourcePathPageRow {
                    slug: page.slug,
                    source_path,
                });
            }
        })?;
        Ok(rows)
    }

    /// `readLiveIdentityHolders(sourceId, ids, titles)`: the live pages of one source whose
    /// frontmatter `id` is in `ids` or whose title is in `titles`, in slug order. `fm_id` is the
    /// id as Postgres `frontmatter->>'id'` reads it: a non-string value in jsonb's text form. The SQL engines return them in no set order.
    pub fn read_live_identity_holders(
        &self,
        source_id: &str,
        ids: &[String],
        titles: &[String],
    ) -> Result<Vec<LiveIdentityHolder>> {
        if ids.is_empty() && titles.is_empty() {
            return Ok(Vec::new());
        }
        let ids: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
        let titles: BTreeSet<&str> = titles.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut rows = Vec::new();
        scan_live_origins(&*read, source_id, &mut |page| {
            let fm_id = fm_text(&page.frontmatter, "id");
            let by_id = fm_id.as_deref().is_some_and(|id| ids.contains(id));
            let by_title = page
                .title
                .as_deref()
                .is_some_and(|title| titles.contains(title));
            if by_id || by_title {
                rows.push(LiveIdentityHolder {
                    slug: page.slug,
                    source_path: page.source_path,
                    fm_id,
                    title: page.title,
                });
            }
        })?;
        Ok(rows)
    }

    /// `listQuarantinedSlugs(sourceId)`: the slugs of one source's live pages whose frontmatter has a
    /// `quarantine` key (any value, JSON null included, as the SQL `?` test reads it), in slug
    /// order. The SQL engines return them in no set order.
    pub fn list_quarantined_slugs(&self, source_id: &str) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut slugs = Vec::new();
        scan_live_origins(&*read, source_id, &mut |page| {
            if page.frontmatter.contains_key("quarantine") {
                slugs.push(page.slug);
            }
        })?;
        Ok(slugs)
    }

    /// `readRenameIdentityRows(sourceId, paths, slugs)`: the live pages of one source whose
    /// `source_path` is in `paths` or whose slug is in `slugs`, in slug order. The SQL engines
    /// return them in no set order.
    pub fn read_rename_identity_rows(
        &self,
        source_id: &str,
        paths: &[String],
        slugs: &[String],
    ) -> Result<Vec<RenameIdentityRow>> {
        if paths.is_empty() && slugs.is_empty() {
            return Ok(Vec::new());
        }
        let paths: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
        let slugs: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut rows = Vec::new();
        scan_live_origins(&*read, source_id, &mut |page| {
            let by_path = page
                .source_path
                .as_deref()
                .is_some_and(|path| paths.contains(path));
            if by_path || slugs.contains(page.slug.as_str()) {
                rows.push(RenameIdentityRow {
                    slug: page.slug,
                    source_path: page.source_path,
                    title: page.title,
                });
            }
        })?;
        Ok(rows)
    }

    /// Every source with a `local_path`, archived ones included, in id order.
    pub fn list_local_path_sources(&self) -> Result<Vec<LocalPathSourceRow>> {
        let read = self.read()?;
        Ok(all_sources(&*read)?
            .into_iter()
            .filter_map(|s| {
                s.local_path.map(|local_path| LocalPathSourceRow {
                    id: s.id,
                    local_path,
                    archived: s.archived,
                })
            })
            .collect())
    }

    /// `readPlainSyncSource(id)`: the source when it exists and is not archived.
    pub fn read_plain_sync_source(&self, id: &str) -> Result<Option<PlainSyncSourceRow>> {
        Ok(read_source(&*self.read()?, id)?
            .filter(|s| !s.archived)
            .map(|s| PlainSyncSourceRow {
                local_path: s.local_path,
                last_commit: s.last_commit,
                config: s.config,
            }))
    }

    /// Every source, archived ones included, in id order, each with `default_has_pages`.
    pub fn list_source_routing_rows(&self) -> Result<Vec<SourceRoutingRow>> {
        let read = self.read()?;
        let sources = all_sources(&*read)?;
        let default_has_pages = default_has_live_pages(&*read)?;
        Ok(sources
            .into_iter()
            .map(|s| SourceRoutingRow {
                id: s.id,
                local_path: s.local_path,
                archived: s.archived,
                config: s.config,
                default_has_pages,
            })
            .collect())
    }

    /// How live pages split between `default` and the other sources.
    pub fn count_default_source_split(&self) -> Result<DefaultSourceSplit> {
        let read = self.read()?;
        let mut split = DefaultSourceSplit {
            default_pages: 0,
            non_default_pages: 0,
            non_default_sources: 0,
        };
        let mut others = BTreeSet::new();
        scan_live_pages(&*read, &[keys::PAGE], &mut |source_id| {
            if source_id == DEFAULT_SOURCE {
                split.default_pages += 1;
            } else {
                split.non_default_pages += 1;
                if !others.contains(source_id) {
                    others.insert(source_id.to_string());
                }
            }
            true
        })?;
        split.non_default_sources = others.len() as u64;
        Ok(split)
    }

    /// `countSourcePages(sourceId, { includeDeleted })`: the pages of one source, soft-deleted
    /// pages only when `include_deleted`. An unknown source has none.
    pub fn count_source_pages(&self, source_id: &str, include_deleted: bool) -> Result<u64> {
        if source_id.contains('\0') {
            return Ok(0);
        }
        let read = self.read()?;
        let mut n = 0u64;
        let mut failure = None;
        scan_prefix(
            &*read,
            &keys::text(keys::PAGE, &[source_id, ""]),
            false,
            &mut |_, v| match serde_json::from_slice::<PageLiveness>(v) {
                Ok(page) => {
                    if include_deleted || page.deleted_at_us.is_none() {
                        n += 1;
                    }
                    true
                }
                Err(e) => {
                    failure = Some(e.into());
                    false
                }
            },
        )?;
        failure.map_or(Ok(n), Err)
    }

    /// `insertSource(row)`: creates a source with this name, path and config. Like the SQL
    /// primary key and the unique name, a source that already has the id or the name refuses
    /// `constraint_violation` and nothing is written. Source ids are 1 to 32 characters of
    /// `a-z`, `0-9` and `-` (`invalid_argument` otherwise).
    pub fn insert_source(
        &self,
        id: &str,
        name: &str,
        local_path: Option<&str>,
        config: &Map<String, Value>,
    ) -> Result<SourceRow> {
        if !valid_source_id(id) {
            return Err(StoreError::invalid(
                "a source id is 1 to 32 characters of a-z, 0-9 and -",
            ));
        }
        self.write(|tx| {
            if read_source(&*tx, id)?.is_some() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("source \"{id}\" already exists"),
                ));
            }
            if all_sources(&*tx)?
                .iter()
                .any(|s| s.name.as_deref() == Some(name))
            {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("a source named \"{name}\" already exists"),
                ));
            }
            let record = SourceRecord {
                id: id.to_string(),
                name: Some(name.to_string()),
                local_path: local_path.map(str::to_string),
                last_sync_at_us: None,
                config: config.clone(),
                incarnation: self.env.new_uuid(),
                archived: false,
                created_at_us: self.env.now_micros(),
                chunker_version: None,
                archived_at_us: None,
                archive_expires_at_us: None,
                last_commit: None,
                newest_content_at_us: None,
                upstream_checked_at_us: None,
                upstream_commit: None,
                upstream_behind: None,
                purge_epoch: 0,
            };
            put_json(tx, &keys::text(keys::SOURCE, &[id]), &record)?;
            Ok(SourceRow::from(record))
        })
    }
}
