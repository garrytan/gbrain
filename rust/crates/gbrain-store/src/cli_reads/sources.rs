//! Source-resolution reads: `listLocalPathSources`, `listSourceRoutingRows`,
//! `countDefaultSourceSplit` and `countSourcePages` (SQL in `src/core/engine-sql/sources.ts`).
//! Each reads one snapshot. `insertSource` is the CLI's plain source insert; `deleteSourceRecord`
//! and `readSourceDeleteImpact` are `sources remove` and its preview.

use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, remove_page};
use crate::sources::{
    DEFAULT_SOURCE, SourceRecord, SourceRow, all_sources, read_source, source_key, valid_source_id,
};
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// The source a plain-directory sync reads (`PlainSyncSourceRow`). The store keeps no
/// `last_commit`, so it is always null.
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
fn scan_live_pages(
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

impl Store {
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
                last_commit: None,
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
            };
            put_json(tx, &keys::text(keys::SOURCE, &[id]), &record)?;
            Ok(SourceRow::from(record))
        })
    }

    /// `deleteSourceRecord(id, { expiredArchiveOnly })`: deletes the source with every record
    /// keyed by it, in one write: each page of the source (soft-deleted ones too) through
    /// `pages::remove_page`, which fires the page and chunk hooks, then `cascade::remove_source_rows`
    /// (the `ON DELETE CASCADE` of `sources.id`), then the source record. The store's pages always
    /// go with their source, so `stranded` is always 0. The store keeps no archive timestamps, so
    /// it can never prove an archive window elapsed and `expired_archive_only` deletes nothing, as
    /// the SQL engines do for an archive without real timestamps. An unknown source deletes nothing.
    pub fn delete_source_record(
        &self,
        id: &str,
        expired_archive_only: bool,
    ) -> Result<SourceDeleteResult> {
        let kept = SourceDeleteResult {
            deleted: false,
            stranded: 0,
        };
        if id.contains('\0') || expired_archive_only {
            return Ok(kept);
        }
        self.write(|tx| {
            if read_source(&*tx, id)?.is_none() {
                return Ok(kept);
            }
            crate::jobs::oauth_clients::remove_source_rows(tx, id)?;
            let mut pages = Vec::new();
            let mut failure = None;
            scan_prefix(
                &*tx,
                &keys::text(keys::PAGE, &[id, ""]),
                false,
                &mut |_, v| match serde_json::from_slice::<PageRecord>(v) {
                    Ok(page) => {
                        pages.push(page);
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
            for page in &pages {
                remove_page(tx, page)?;
            }
            crate::cascade::remove_source_rows(tx, id)?;
            tx.delete(&source_key(id))?;
            Ok(SourceDeleteResult {
                deleted: true,
                stranded: 0,
            })
        })
    }

    /// `readSourceDeleteImpact(id)`: the source's id and name with what a delete removes: its
    /// pages (soft-deleted ones too), their chunks, the chunks with a vector, its files and its
    /// facts. `None` for an unknown source.
    pub fn read_source_delete_impact(&self, id: &str) -> Result<Option<SourceDeleteImpact>> {
        if id.contains('\0') {
            return Ok(None);
        }
        let read = self.read()?;
        let Some(source) = read_source(&*read, id)? else {
            return Ok(None);
        };
        let mut page_ids = Vec::new();
        let mut failure = None;
        scan_prefix(
            &*read,
            &keys::text(keys::PAGE, &[id, ""]),
            false,
            &mut |_, v| match serde_json::from_slice::<PageId>(v) {
                Ok(page) => {
                    page_ids.push(page.id);
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
        let (mut chunks, mut embeddings) = (0u64, 0u64);
        for page_id in &page_ids {
            for chunk in crate::chunks::read_chunks(&*read, *page_id)? {
                chunks += 1;
                if chunk.embed.has_vector() {
                    embeddings += 1;
                }
            }
        }
        Ok(Some(SourceDeleteImpact {
            id: source.id.clone(),
            name: source.name.clone().unwrap_or_default(),
            pages: page_ids.len() as u64,
            chunks,
            embeddings,
            files: crate::raw_files::count_source_files(&*read, id)?,
            facts: crate::facts::source_rows(&*read, id)?.len() as u64,
        }))
    }
}

/// What `deleteSourceRecord` did (`SourceDeleteResult` in `src/core/engine-sql/sources.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SourceDeleteResult {
    pub deleted: bool,
    pub stranded: u64,
}

/// `SourceDeleteImpact`: the counts the `sources remove` preview prints.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceDeleteImpact {
    pub id: String,
    pub name: String,
    pub pages: u64,
    pub chunks: u64,
    pub embeddings: u64,
    pub files: u64,
    pub facts: u64,
}

/// The id of a page record, read without decoding the rest.
#[derive(Deserialize)]
struct PageId {
    id: u64,
}
