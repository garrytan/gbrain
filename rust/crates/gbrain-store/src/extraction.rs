//! Extraction state of pages: the `links_extracted_at`, `links_attendance_blocked_revision` and
//! `links_attendance_blocked_at` columns of the PGLite `pages` table, and the sweep of
//! parser-reserved frontmatter keys.
//!
//! Members: countStalePagesForExtraction, listStalePagesForExtraction, markPagesExtractedBatch,
//! markPagesAttendanceBlocked, countStaleFrontmatterKeyPages, listStaleFrontmatterKeyPages,
//! stripStaleFrontmatterKeys.
//!
//! Keys: `e page_id` (`keys::EXTRACTION`, then the page id as 8 big-endian bytes) holds the
//! page's [`ExtractionRecord`]. A page with no record has every column NULL. The record hangs off
//! the page id, so a hard delete removes it ([`remove_page_rows`]) and a page created again under
//! the same slug starts unstamped, as a new PGLite row does.
//!
//! What PGLite has and this engine does not: the `links_extract_failure` record (`held`) and the
//! `wanted_links` rows have no typed writer, so no page is ever held and no wanted link makes a
//! page stale. `held: 'exclude'` and `wantedProducers` change nothing and `held: 'only'` matches
//! nothing, as in PGLite while those tables are empty. A guest source is one whose config says
//! `guest: true` (or `"true"`); this engine has no `guest_sources` table.

use crate::env::{is_uuid, iso, parse_iso};
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::page_columns::PageColumns;
use crate::pages::{PageRecord, all_pages, read_page, write_page};
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The parser-reserved top-level frontmatter keys (`RESERVED_FRONTMATTER_KEYS_SQL`), sorted.
const RESERVED_KEYS: [&str; 4] = ["slug", "tags", "title", "type"];
/// The frontmatter key that hides a page (`QUARANTINE_KEY`).
const QUARANTINE_KEY: &str = "quarantine";

/// What is stored for a page's extraction state. Every field absent is the all-NULL row.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct ExtractionRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links_extracted_at_us: Option<i64>,
    /// The knowledge revision the attendance marker was written at, lower case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links_attendance_blocked_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links_attendance_blocked_at_us: Option<i64>,
}

fn record_key(page_id: u64) -> Vec<u8> {
    keys::id_key(keys::EXTRACTION, &[page_id])
}

fn read_record(read: &dyn KvRead, page_id: u64) -> Result<ExtractionRecord> {
    Ok(get_json(read, &record_key(page_id))?.unwrap_or_default())
}

fn write_record(tx: &mut dyn KvWrite, page_id: u64, record: &ExtractionRecord) -> Result<()> {
    if *record == ExtractionRecord::default() {
        tx.delete(&record_key(page_id))
    } else {
        put_json(tx, &record_key(page_id), record)
    }
}

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    tx.delete(&record_key(page.id))
}

/// The options of `countStalePagesForExtraction` and `listStalePagesForExtraction`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StaleOptions {
    pub source_id: Option<String>,
    /// ISO timestamp of the extractor version; a stamp older than it is stale.
    pub version_ts: Option<String>,
    /// `exclude` drops attendance-blocked pages, `blocked` keeps only them.
    pub attendance: Option<String>,
    /// `exclude` changes nothing; `only` matches nothing (no page is ever held here).
    pub held: Option<String>,
    /// Changes nothing: no wanted link exists here.
    pub wanted_producers: Option<Vec<String>>,
    /// `listStalePagesForExtraction` only: at most this many rows (absent: all).
    pub batch_size: Option<i64>,
    /// `listStalePagesForExtraction` only: rows with a larger page id.
    pub after_page_id: Option<i64>,
}

/// One ref of `markPagesExtractedBatch`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtractedRef {
    pub slug: String,
    #[serde(rename = "source_id")]
    pub source_id: String,
    pub extracted_at: Option<String>,
}

/// One ref of `markPagesAttendanceBlocked`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct AttendanceRef {
    pub slug: String,
    pub source_id: String,
    pub revision: String,
}

/// The options of `countStaleFrontmatterKeyPages`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FrontmatterKeyCountOptions {
    pub source_ids: Vec<String>,
}

/// The options of `listStaleFrontmatterKeyPages`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FrontmatterKeyListOptions {
    pub source_id: String,
    pub after_id: i64,
    pub limit: Option<i64>,
}

/// The options of `stripStaleFrontmatterKeys`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StripFrontmatterKeysOptions {
    pub source_id: String,
    pub ids: Vec<i64>,
}

/// `::timestamptz` of the ISO strings this engine reads; `invalid_argument` for any other shape.
fn timestamp(text: &str, what: &str) -> Result<i64> {
    parse_iso(text).ok_or_else(|| {
        StoreError::new(
            INVALID_ARGUMENT,
            format!(
                "{what}: invalid input syntax for type timestamp with time zone: \"{text}\" (the rust engine reads ISO 8601 UTC strings ending in Z)"
            ),
        )
    })
}

/// `LIMIT n`: absent is no limit, a negative value is refused as Postgres refuses it.
fn limit(n: Option<i64>) -> Result<usize> {
    match n {
        None => Ok(usize::MAX),
        Some(n) if n < 0 => Err(StoreError::new(
            INVALID_ARGUMENT,
            "LIMIT must not be negative",
        )),
        Some(n) => Ok(usize::try_from(n).unwrap_or(usize::MAX)),
    }
}

fn has_reserved_key(frontmatter: &Map<String, Value>) -> bool {
    RESERVED_KEYS.iter().any(|k| frontmatter.contains_key(*k))
}

/// The guest sources among the pages' sources: config `guest` is `true` or `"true"`
/// (`config->>'guest' = 'true'`).
fn guest_sources(read: &dyn KvRead, pages: &[PageRecord]) -> Result<BTreeSet<String>> {
    let ids: BTreeSet<&str> = pages.iter().map(|p| p.source_id.as_str()).collect();
    let mut guests = BTreeSet::new();
    for id in ids {
        let guest = read_source(read, id)?.is_some_and(|s| match s.config.get("guest") {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => s == "true",
            _ => false,
        });
        if guest {
            guests.insert(id.to_string());
        }
    }
    Ok(guests)
}

/// The pages `stalePagesWhere(opts)` selects, in page id order.
fn stale_pages(read: &dyn KvRead, options: &StaleOptions) -> Result<Vec<PageRecord>> {
    let version = match options.version_ts.as_deref().filter(|v| !v.is_empty()) {
        Some(text) => Some(timestamp(text, "versionTs")?),
        None => None,
    };
    let source = options.source_id.as_deref().filter(|s| !s.is_empty());
    let mut pages: Vec<PageRecord> = all_pages(read)?
        .into_iter()
        .filter(|p| p.deleted_at_us.is_none() && !p.frontmatter.contains_key(QUARANTINE_KEY))
        .filter(|p| source.is_none_or(|s| p.source_id == s))
        .collect();
    if options.held.as_deref() == Some("only") {
        return Ok(Vec::new());
    }
    let guests = guest_sources(read, &pages)?;
    pages.retain(|p| !guests.contains(&p.source_id));
    let mut out = Vec::new();
    for page in pages {
        let record = read_record(read, page.id)?;
        let stale = match record.links_extracted_at_us {
            None => true,
            Some(stamp) => version.is_some_and(|v| stamp < v) || page.updated_at_us > stamp,
        };
        if !stale {
            continue;
        }
        let blocked = record.links_attendance_blocked_revision.as_deref()
            == Some(page.knowledge_revision.to_ascii_lowercase().as_str());
        let keep = match options.attendance.as_deref() {
            Some("exclude") => !blocked,
            Some("blocked") => blocked,
            _ => true,
        };
        if keep {
            out.push(page);
        }
    }
    out.sort_by_key(|p| p.id);
    Ok(out)
}

/// A `StalePageRow`, `updated_at` and `updated_at_iso` as ISO strings.
/// One `StalePageRow`. A segmented page's NULL body columns read as `''`, as PGLite's
/// `rowToStalePage` lists them (`compiled_truth ?? ''`).
fn stale_row(page: &PageRecord) -> Value {
    json!({
        "id": page.id,
        "slug": page.slug,
        "source_id": page.source_id,
        "type": page.page_type,
        "title": page.title,
        "compiled_truth": &*page.compiled_truth,
        "timeline": &*page.timeline,
        "frontmatter": page.frontmatter,
        "updated_at": iso(page.updated_at_us),
        "updated_at_iso": iso(page.updated_at_us),
    })
}

impl Store {
    /// `countStalePagesForExtraction(opts?)`: live, non-quarantined pages outside guest sources
    /// whose stamp is absent, older than `versionTs` or older than the page's `updated_at`.
    pub fn count_stale_pages_for_extraction(&self, options: &StaleOptions) -> Result<u64> {
        let read = self.read()?;
        Ok(stale_pages(&*read, options)?.len() as u64)
    }

    /// `listStalePagesForExtraction(opts)`: the same pages, `id > afterPageId`, by id, at most
    /// `batchSize`.
    pub fn list_stale_pages_for_extraction(&self, options: &StaleOptions) -> Result<Vec<Value>> {
        let cap = limit(options.batch_size)?;
        let read = self.read()?;
        let after = options.after_page_id;
        Ok(stale_pages(&*read, options)?
            .iter()
            .filter(|p| after.is_none_or(|a| i128::from(p.id) > i128::from(a)))
            .take(cap)
            .map(stale_row)
            .collect())
    }

    /// `markPagesExtractedBatch(refs, defaultExtractedAt)`: stamps each `(slug, source_id)` page,
    /// soft-deleted ones included, with its `extractedAt` or the default, and clears its
    /// attendance marker. Returns the number of pages stamped; a page named twice counts once and
    /// takes its first stamp. `updated_at` does not change.
    pub fn mark_pages_extracted_batch(
        &self,
        refs: &[ExtractedRef],
        default_extracted_at: &str,
    ) -> Result<u64> {
        if refs.is_empty() {
            return Ok(0);
        }
        let mut stamps = Vec::with_capacity(refs.len());
        for r in refs {
            let text = r.extracted_at.as_deref().unwrap_or(default_extracted_at);
            stamps.push(timestamp(text, "markPagesExtractedBatch")?);
        }
        self.write(|tx| {
            let mut stamped: BTreeSet<u64> = BTreeSet::new();
            for (r, stamp) in refs.iter().zip(stamps) {
                let Some(page) = read_page(&*tx, &r.source_id, &r.slug)? else {
                    continue;
                };
                if !stamped.insert(page.id) {
                    continue;
                }
                let record = ExtractionRecord {
                    links_extracted_at_us: Some(stamp),
                    links_attendance_blocked_revision: None,
                    links_attendance_blocked_at_us: None,
                };
                write_record(tx, page.id, &record)?;
            }
            Ok(stamped.len() as u64)
        })
    }

    /// `markPagesAttendanceBlocked(refs)`: marks each live `(slug, source_id)` page whose
    /// knowledge revision is still `revision`. Returns the number of pages marked.
    /// `invalid_argument` when a revision is not a UUID, as the `::uuid` cast fails.
    pub fn mark_pages_attendance_blocked(&self, refs: &[AttendanceRef]) -> Result<u64> {
        if refs.is_empty() {
            return Ok(0);
        }
        for r in refs {
            if !is_uuid(&r.revision) {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("invalid input syntax for type uuid: \"{}\"", r.revision),
                ));
            }
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut marked: BTreeSet<u64> = BTreeSet::new();
            for r in refs {
                let revision = r.revision.to_ascii_lowercase();
                let Some(page) = read_page(&*tx, &r.source_id, &r.slug)?.filter(|p| {
                    p.deleted_at_us.is_none()
                        && p.knowledge_revision.to_ascii_lowercase() == revision
                }) else {
                    continue;
                };
                if !marked.insert(page.id) {
                    continue;
                }
                let mut record = read_record(&*tx, page.id)?;
                record.links_attendance_blocked_revision = Some(revision);
                record.links_attendance_blocked_at_us = Some(now);
                write_record(tx, page.id, &record)?;
            }
            Ok(marked.len() as u64)
        })
    }

    /// `countStaleFrontmatterKeyPages({ sourceIds })`: `{ source_id, n }` per source that has live
    /// pages carrying a reserved frontmatter key, by source id. Empty `sourceIds` is `[]`.
    pub fn count_stale_frontmatter_key_pages(
        &self,
        options: &FrontmatterKeyCountOptions,
    ) -> Result<Vec<Value>> {
        if options.source_ids.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: BTreeSet<&str> = options.source_ids.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut counts: BTreeMap<String, u64> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_none()
                && wanted.contains(page.source_id.as_str())
                && has_reserved_key(&page.frontmatter)
            {
                *counts.entry(page.source_id).or_default() += 1;
            }
        }
        Ok(counts
            .into_iter()
            .map(|(source_id, n)| json!({ "source_id": source_id, "n": n }))
            .collect())
    }

    /// `listStaleFrontmatterKeyPages({ sourceId, afterId, limit })`: `{ id, slug, keys }` of the
    /// source's live pages carrying a reserved key, `id > afterId`, by id; `keys` sorted.
    pub fn list_stale_frontmatter_key_pages(
        &self,
        options: &FrontmatterKeyListOptions,
    ) -> Result<Vec<Value>> {
        let cap = limit(options.limit)?;
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.deleted_at_us.is_none()
                    && p.source_id == options.source_id
                    && i128::from(p.id) > i128::from(options.after_id)
                    && has_reserved_key(&p.frontmatter)
            })
            .collect();
        pages.sort_by_key(|p| p.id);
        Ok(pages
            .iter()
            .take(cap)
            .map(|p| {
                let present: Vec<&str> = RESERVED_KEYS
                    .iter()
                    .copied()
                    .filter(|k| p.frontmatter.contains_key(*k))
                    .collect();
                json!({ "id": p.id, "slug": p.slug, "keys": present })
            })
            .collect())
    }

    /// `stripStaleFrontmatterKeys({ sourceId, ids })`: removes the reserved keys from the named
    /// live pages of the source. Each changed page takes a new knowledge revision and its text
    /// projection is cleared, as the PGLite revision trigger does; `updated_at` and the chunks do
    /// not change. Returns the number of pages changed.
    pub fn strip_stale_frontmatter_keys(
        &self,
        options: &StripFrontmatterKeysOptions,
    ) -> Result<u64> {
        if options.ids.is_empty() {
            return Ok(0);
        }
        let ids: BTreeSet<i64> = options.ids.iter().copied().collect();
        self.write(|tx| {
            let mut changed = 0u64;
            for id in ids {
                let Ok(id) = u64::try_from(id) else {
                    continue;
                };
                let Some(mut page) = crate::pages::read_page_by_id(&*tx, id)? else {
                    continue;
                };
                if page.source_id != options.source_id
                    || page.deleted_at_us.is_some()
                    || !has_reserved_key(&page.frontmatter)
                {
                    continue;
                }
                page.frontmatter
                    .retain(|k, _| !RESERVED_KEYS.contains(&k.as_str()));
                page.knowledge_revision = self.env.new_uuid();
                page.text_projection_revision = None;
                write_page(tx, &page)?;
                changed += 1;
            }
            Ok(changed)
        })
    }
}

/// Adds this family's `getPage` columns to a page (`page_columns::add_page_columns`). Adds none
/// yet: PGLite's `getPage` returns no extraction stamp today, so this stays empty unless a
/// parity case shows one.
pub(crate) fn page_columns(
    _read: &dyn KvRead,
    _page: &PageRecord,
    _columns: &mut PageColumns,
) -> Result<()> {
    Ok(())
}

/// Deletes this family's records of a source that is deleted (`cascade::remove_source_rows`): the
/// record of every page still in the source. Core removes the source's pages first, which already
/// removes their records through [`remove_page_rows`], so this normally finds nothing; it makes the
/// cascade hold whatever order core calls it in. `extract_atoms_page_state`, the table Postgres
/// cascades here, has no records in this engine.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for page in all_pages(&*tx)? {
        if page.source_id == source_id {
            tx.delete(&record_key(page.id))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod source_delete_tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::sources::SourceInput;

    #[test]
    fn a_source_delete_removes_the_records_of_that_source_only() {
        let store = crate::test_support::store();
        let other: SourceInput =
            serde_json::from_value(json!({ "id": "other", "name": "other", "config": {} }))
                .unwrap();
        store.upsert_source(&other).unwrap();
        let input = PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        let in_other: PutPageOptions =
            serde_json::from_value(json!({ "sourceId": "other" })).unwrap();
        store
            .put_page("a", &input, &PutPageOptions::default())
            .unwrap();
        store.put_page("a", &input, &in_other).unwrap();
        let refs: Vec<ExtractedRef> = serde_json::from_value(json!([
            { "slug": "a", "source_id": "default" },
            { "slug": "a", "source_id": "other" },
        ]))
        .unwrap();
        assert_eq!(
            store
                .mark_pages_extracted_batch(&refs, "2099-01-01T00:00:00.000Z")
                .unwrap(),
            2
        );
        let ids = |store: &Store| -> (u64, u64) {
            let read = store.read().unwrap();
            let a = read_page(&*read, "default", "a").unwrap().unwrap().id;
            let b = read_page(&*read, "other", "a").unwrap().unwrap().id;
            (a, b)
        };
        let (kept, gone) = ids(&store);
        store.write(|tx| remove_source_rows(tx, "other")).unwrap();
        let read = store.read().unwrap();
        assert!(
            read_record(&*read, kept)
                .unwrap()
                .links_extracted_at_us
                .is_some()
        );
        assert!(read.get(&record_key(gone)).unwrap().is_none());
    }
}

#[cfg(test)]
mod segmented_tests {
    use super::*;
    use crate::pages::{PageInput, PageText, PutPageOptions};

    #[test]
    fn a_segmented_page_is_listed_stale_with_empty_body_texts() {
        let store = crate::test_support::store();
        let input = PageInput {
            page_type: "note".into(),
            title: "Shell".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page("shell", &input, &PutPageOptions::default())
            .unwrap();
        // PGLite's `createSegmentedPageShell` leaves both body columns NULL; the page_body family
        // will write such pages, so the test writes the record directly.
        store
            .write(|tx| {
                let mut page = read_page(&*tx, "default", "shell")?.unwrap();
                page.compiled_truth = PageText::null();
                page.timeline = PageText::null();
                write_page(tx, &page)
            })
            .unwrap();
        let rows = store
            .list_stale_pages_for_extraction(&StaleOptions::default())
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["compiled_truth"], json!(""));
        assert_eq!(rows[0]["timeline"], json!(""));
    }
}
