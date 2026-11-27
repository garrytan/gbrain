//! Source archive: the soft delete of `gbrain sources archive`, its restore, the archived-source
//! list, the purge sweep's candidate reads and the impact preview counts (SQL in
//! `src/core/engine-sql/source-archive.ts`, callers in `src/core/destructive-guard.ts`).
//!
//! Members: `archiveSource`, `restoreArchivedSource`, `listArchivedSourceRows`,
//! `listExpiredArchivedSources`, `listUnverifiedArchivedSourceIds`, `readSourceDeleteImpact` and
//! `deleteSourceRecord`.
//!
//! `deleteSourceRecord` removes the source in one write transaction: each page with
//! `pages::remove_page` (the Postgres `ON DELETE CASCADE` of `pages.source_id`, whose cascade
//! always fires here, so no page is ever stranded), the records keyed by source
//! (`cascade::remove_source_rows`), then the rows the SQL scrubs by hand: the source's
//! managed-sync cursors, its write gate holds with their receipts and the eval candidates'
//! retrieved slugs no other covered source has. The store keeps no persistence source bindings,
//! no retrieval events or feedback, no volunteer events and no core edit notices, so those steps
//! have nothing to remove. An OAuth client that names the source refuses the delete, as the
//! `ON DELETE RESTRICT` key does.
//!
//! The archive times live on the source record (`archived_at_us`, `archive_expires_at_us`), as
//! the `sources.archived_at` and `sources.archive_expires_at` columns. An archive is expired when
//! both times are after `1970-01-02` UTC and its expiry has passed; it is unverified when either
//! time is missing or at or before that day (`EXPIRED_ARCHIVE_SQL`, `UNVERIFIED_ARCHIVE_SQL` of
//! the SQL module). Ids sort by bytes; source ids are `a-z`, `0-9` and `-` only.

use super::{SourceRecord, all_sources, read_source, source_key};
use crate::chunks::read_chunks;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::PageRecord;
use crate::timeline_queries::jsonb_field_text;
use crate::{Store, keys, put_json};
use serde::Serialize;
use serde_json::{Map, Value};

/// `1970-01-02T00:00:00Z` in microseconds: a time at or before it is not a real archive time.
const EPOCH_DAY_US: i64 = 86_400_000_000;

/// The row `archiveSource` returns: `ArchivedSourceRow` of the SQL module.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArchivedSource {
    pub id: String,
    pub name: Option<String>,
    pub archived_at: String,
    pub archive_expires_at: String,
}

/// One row of `listArchivedSourceRows`: `ArchivedSourceListRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArchivedSourceListRow {
    pub id: String,
    pub name: Option<String>,
    pub archived_at: Option<String>,
    pub archive_expires_at: Option<String>,
    pub page_count: u64,
}

/// One row of `listExpiredArchivedSources`: `ExpiredArchivedSourceRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExpiredArchivedSource {
    pub id: String,
    pub incarnation: String,
    pub config: Map<String, Value>,
    pub local_path: Option<String>,
}

/// What `readSourceDeleteImpact` returns: `SourceDeleteImpact` (`src/core/engine-sql/sources.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceDeleteImpact {
    pub id: String,
    pub name: Option<String>,
    pub pages: u64,
    pub chunks: u64,
    pub embeddings: u64,
    pub files: u64,
    pub facts: u64,
}

fn real_time(us: Option<i64>) -> bool {
    us.is_some_and(|t| t > EPOCH_DAY_US)
}

fn expired(r: &SourceRecord, now_us: i64) -> bool {
    r.archived
        && real_time(r.archived_at_us)
        && real_time(r.archive_expires_at_us)
        && r.archive_expires_at_us.is_some_and(|t| t <= now_us)
}

fn unverified(r: &SourceRecord) -> bool {
    r.archived && !(real_time(r.archived_at_us) && real_time(r.archive_expires_at_us))
}

/// Every page record of one source, soft-deleted pages included.
pub(crate) fn source_pages(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    if source_id.contains('\0') {
        return Ok(out);
    }
    scan_prefix(
        read,
        &keys::text(keys::PAGE, &[source_id, ""]),
        false,
        &mut |_, v| match serde_json::from_slice::<PageRecord>(v) {
            Ok(page) => {
                out.push(page);
                true
            }
            Err(e) => {
                failure = Some(StoreError::from(e));
                false
            }
        },
    )?;
    failure.map_or(Ok(out), Err)
}

impl Store {
    /// `archiveSource(id, ttlHours)`: archives an active source now, with its expiry `ttl_hours`
    /// later, and sets `config.federated` to false. `None` when the source does not exist or is
    /// already archived (the SQL's `WHERE archived = false`).
    pub fn archive_source(&self, id: &str, ttl_hours: i64) -> Result<Option<ArchivedSource>> {
        let now = self.env.now_micros();
        let expires = now.saturating_add(ttl_hours.saturating_mul(3_600_000_000));
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(None);
            };
            if record.archived {
                return Ok(None);
            }
            record.archived = true;
            record.archived_at_us = Some(now);
            record.archive_expires_at_us = Some(expires);
            record.config.insert("federated".into(), Value::Bool(false));
            put_json(tx, &source_key(id), &record)?;
            Ok(Some(ArchivedSource {
                id: record.id,
                name: record.name,
                archived_at: iso(now),
                archive_expires_at: iso(expires),
            }))
        })
    }

    /// `restoreArchivedSource(id, federated)`: un-archives an archived source, clears both
    /// archive times and sets `config.federated`. Whether a source was restored.
    pub fn restore_archived_source(&self, id: &str, federated: bool) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(false);
            };
            if !record.archived {
                return Ok(false);
            }
            record.archived = false;
            record.archived_at_us = None;
            record.archive_expires_at_us = None;
            record
                .config
                .insert("federated".into(), Value::Bool(federated));
            put_json(tx, &source_key(id), &record)?;
            Ok(true)
        })
    }

    /// `listArchivedSourceRows()`: every archived source with its page count (soft-deleted pages
    /// included), newest archive first. A source with no archive time comes first, as NULL sorts
    /// first under `DESC`; equal times sort by id, greatest first.
    pub fn list_archived_source_rows(&self) -> Result<Vec<ArchivedSourceListRow>> {
        let read = self.read()?;
        let mut archived: Vec<SourceRecord> = all_sources(&*read)?
            .into_iter()
            .filter(|r| r.archived)
            .collect();
        archived.sort_by(|a, b| {
            let key = |r: &SourceRecord| r.archived_at_us.unwrap_or(i64::MAX);
            key(b).cmp(&key(a)).then_with(|| b.id.cmp(&a.id))
        });
        archived
            .into_iter()
            .map(|r| {
                Ok(ArchivedSourceListRow {
                    page_count: source_pages(&*read, &r.id)?.len() as u64,
                    archived_at: r.archived_at_us.map(iso),
                    archive_expires_at: r.archive_expires_at_us.map(iso),
                    id: r.id,
                    name: r.name,
                })
            })
            .collect()
    }

    /// `listExpiredArchivedSources()`: the archived sources whose recovery window has passed, by
    /// id.
    pub fn list_expired_archived_sources(&self) -> Result<Vec<ExpiredArchivedSource>> {
        let now = self.env.now_micros();
        let read = self.read()?;
        Ok(all_sources(&*read)?
            .into_iter()
            .filter(|r| expired(r, now))
            .map(|r| ExpiredArchivedSource {
                id: r.id,
                incarnation: r.incarnation,
                config: r.config,
                local_path: r.local_path,
            })
            .collect())
    }

    /// `listUnverifiedArchivedSourceIds()`: the archived sources whose archive times are missing
    /// or not real, by id.
    pub fn list_unverified_archived_source_ids(&self) -> Result<Vec<String>> {
        let read = self.read()?;
        Ok(all_sources(&*read)?
            .into_iter()
            .filter(unverified)
            .map(|r| r.id)
            .collect())
    }

    /// `readSourceDeleteImpact(id)`: the source's id and name with what deleting it would remove (pages with
    /// soft-deleted ones, their chunks, the chunks that have a vector, the source's files and its
    /// fact rows), or `None` when the source does not exist.
    pub fn read_source_delete_impact(&self, id: &str) -> Result<Option<SourceDeleteImpact>> {
        let read = self.read()?;
        let Some(record) = read_source(&*read, id)? else {
            return Ok(None);
        };
        let pages = source_pages(&*read, id)?;
        let (mut chunks, mut embeddings) = (0u64, 0u64);
        for page in &pages {
            for chunk in read_chunks(&*read, page.id)? {
                chunks += 1;
                if chunk.embed.has_vector() {
                    embeddings += 1;
                }
            }
        }
        Ok(Some(SourceDeleteImpact {
            id: record.id,
            name: record.name,
            pages: pages.len() as u64,
            chunks,
            embeddings,
            files: crate::raw_files::source_file_count(&*read, id)?,
            facts: crate::facts::source_rows(&*read, id)?.len() as u64,
        }))
    }

    /// `deleteSourceRecord(id, expiredArchiveOnly)`: deletes the source with its pages and every
    /// record that names it (module doc). Whether the source was deleted: false when it does not
    /// exist, or when `expired_only` and it is not an archive past its window. A source that an
    /// OAuth client names fails with the foreign-key `CONSTRAINT_VIOLATION` and nothing changes.
    pub fn delete_source_record(&self, id: &str, expired_only: bool) -> Result<bool> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(record) = read_source(&*tx, id)? else {
                return Ok(false);
            };
            if expired_only && !expired(&record, now) {
                return Ok(false);
            }
            crate::jobs::remove_oauth_source_rows(tx, id)?;
            for page in source_pages(&*tx, id)? {
                crate::pages::remove_page(tx, &page)?;
            }
            crate::cascade::remove_source_rows(tx, id)?;
            remove_sync_cursors(tx, id)?;
            crate::persistence::remove_source_binding_in(tx, id, &record.incarnation)?;
            crate::trust::write_gate::remove_source_holds(tx, id)?;
            crate::eval_capture::remove_source_retrieved_slugs(tx, id)?;
            crate::retrieval_feedback::remove_source_rows(tx, id)?;
            crate::volunteer_events::remove_source_rows(tx, id)?;
            tx.delete(&source_key(id))?;
            Ok(true)
        })
    }
}

/// The managed lifecycle's remove (`topologyStore().deleteSourceIncarnation`,
/// `sourceIncarnationDeleteStatement`): when the source row still has `incarnation`, it goes with
/// its pages (the foreign keys cascade on Postgres) and the rows that name the source outside a
/// foreign key (`removedSourceScrubCtes`, gated on the row going). The binding, the sync cursors
/// and the OAuth refusal are the caller's own statements. Returns whether the row went.
pub(crate) fn delete_source_incarnation_in(
    tx: &mut dyn crate::kv::KvWrite,
    id: &str,
    incarnation: &str,
) -> Result<bool> {
    let Some(record) = read_source(&*tx, id)? else {
        return Ok(false);
    };
    if !record.incarnation.eq_ignore_ascii_case(incarnation) {
        return Ok(false);
    }
    for page in source_pages(&*tx, id)? {
        crate::pages::remove_page(tx, &page)?;
    }
    crate::cascade::remove_source_rows(tx, id)?;
    rescrub_removed_source_in(tx, id)?;
    tx.delete(&source_key(id))?;
    Ok(true)
}

/// `removedSourceRescrubStatement`: the rows that name the source outside a foreign key, ungated.
pub(crate) fn rescrub_removed_source_in(tx: &mut dyn crate::kv::KvWrite, id: &str) -> Result<()> {
    crate::trust::write_gate::remove_source_holds(tx, id)?;
    crate::eval_capture::remove_source_retrieved_slugs(tx, id)?;
    crate::retrieval_feedback::remove_source_rows(tx, id)?;
    crate::volunteer_events::remove_source_rows(tx, id)?;
    Ok(())
}

/// The managed retire's page batch (`topologyStore().deletePageBatch`): up to `limit` of the
/// source's pages go, in page id order (the SQL's `LIMIT` takes any; only the count is read).
pub(crate) fn delete_page_batch_in(
    tx: &mut dyn crate::kv::KvWrite,
    id: &str,
    limit: usize,
) -> Result<usize> {
    let mut pages = source_pages(&*tx, id)?;
    pages.sort_by_key(|p| p.id);
    pages.truncate(limit);
    for page in &pages {
        crate::pages::remove_page(tx, page)?;
    }
    Ok(pages.len())
}

/// `EXPIRED_ARCHIVE_SQL` on one source record at `now`.
pub(crate) fn source_expired(record: &SourceRecord, now: i64) -> bool {
    expired(record, now)
}

/// How many pages the source has (`count(*) FROM pages WHERE source_id=$1`).
pub(crate) fn source_page_count_in(read: &dyn KvRead, id: &str) -> Result<usize> {
    Ok(source_pages(read, id)?.len())
}

/// The `cursors` step of the source delete: the `managed-sync` op checkpoints whose first
/// completed key names the source (`completed_keys->0->>'sourceId'`).
pub(crate) fn remove_sync_cursors(tx: &mut dyn crate::kv::KvWrite, source_id: &str) -> Result<()> {
    const OP: &str = "managed-sync";
    let rows = crate::persistence::list_op_checkpoint_records_in(&*tx, OP)?;
    let doomed: Vec<String> = rows
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| {
            row.get("completed_keys")
                .and_then(|keys| keys.get(0))
                .and_then(|first| first.get("sourceId"))
                .and_then(jsonb_field_text)
                .as_deref()
                == Some(source_id)
        })
        .filter_map(|row| {
            row.get("fingerprint")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    for fingerprint in doomed {
        crate::persistence::delete_op_checkpoint_in(tx, OP, &fingerprint)?;
    }
    Ok(())
}
