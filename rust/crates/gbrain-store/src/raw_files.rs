//! Raw source data and files attached to pages: the `raw_data` and `files` tables of the PGLite
//! engine.
//!
//! Members: putRawData, getRawData, upsertFile, getFile, listFilesForPage.
//!
//! Keys (every record starts with `keys::RAW_FILES`, `r`):
//! - `r 0x01 <page id u64 BE> 0x00 <source name>` -> `RawRecord` (JSON). One per (page, source),
//!   the `UNIQUE(page_id, source)` of `raw_data`. A page's raw data is the prefix
//!   `r 0x01 <page id> 0x00`.
//! - `r 0x02 <storage path>` -> `FileRecord` (JSON). `files` is `UNIQUE(storage_path)` across
//!   every source, so the path alone is the key; `source_id` is a field of the record and
//!   `getFile` checks it.
//! - `r 0x03 <page id u64 BE> 0x00 <file id u64 BE>` -> the file's storage path. One per file
//!   whose `page_id` is set, so `listFilesForPage` reads one prefix.
//! - Id counter: `M next_file_id`. A refused insert takes no id; an update keeps the row's id.
//!
//! `data` and `metadata` are JSONB in Postgres, which stores object keys ordered by length, then
//! bytes. The store keeps that order (`crate::jsonb::order`), so rows come back as Postgres returns them.
//!
//! Cascades:
//! - Page hard delete (`remove_page_rows`): deletes the page's raw data (`ON DELETE CASCADE`) and
//!   sets `page_id` to null on its files (`ON DELETE SET NULL`), keeping the file rows and their
//!   `page_slug`.
//! - Source delete (`remove_source_rows`): deletes the files of the source (`ON DELETE CASCADE` of
//!   `files.source_id`). Raw data hangs off pages, so the page hook removes it. Files are keyed by
//!   path, so this scans every file record; source delete is rare.

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, PAGE_NOT_FOUND, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{PageRecord, next_id, read_page, read_page_by_id, scope_sources};
use crate::sources::{all_sources, read_source};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const RAW: u8 = 0x01;
const FILE: u8 = 0x02;
const FILE_BY_PAGE: u8 = 0x03;
pub(crate) const NEXT_FILE_ID: &str = "next_file_id";

fn raw_page_prefix(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::RAW_FILES, RAW];
    key.extend_from_slice(&page_id.to_be_bytes());
    key.push(0);
    key
}

fn raw_key(page_id: u64, source: &str) -> Vec<u8> {
    let mut key = raw_page_prefix(page_id);
    key.extend_from_slice(source.as_bytes());
    key
}

fn file_key(storage_path: &str) -> Vec<u8> {
    let mut key = vec![keys::RAW_FILES, FILE];
    key.extend_from_slice(storage_path.as_bytes());
    key
}

fn file_page_prefix(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::RAW_FILES, FILE_BY_PAGE];
    key.extend_from_slice(&page_id.to_be_bytes());
    key.push(0);
    key
}

fn file_page_key(page_id: u64, file_id: u64) -> Vec<u8> {
    let mut key = file_page_prefix(page_id);
    key.extend_from_slice(&file_id.to_be_bytes());
    key
}

/// One `raw_data` row. The serial `id` is never read by a member, so it is not kept.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RawRecord {
    pub page_id: u64,
    pub source: String,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    pub data: Value,
    pub fetched_at_us: i64,
}

impl RawRecord {
    fn to_json(&self) -> Value {
        json!({ "source": self.source, "data": crate::jsonb::ordered(&self.data), "fetched_at": iso(self.fetched_at_us) })
    }
}

/// One `files` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FileRecord {
    pub id: u64,
    pub source_id: String,
    #[serde(default)]
    pub page_slug: Option<String>,
    #[serde(default)]
    pub page_id: Option<u64>,
    pub filename: String,
    pub storage_path: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<i64>,
    pub content_hash: String,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    pub metadata: Value,
    pub created_at_us: i64,
}

impl FileRecord {
    /// The `FileRow` of `getFile` and `listFilesForPage`.
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "source_id": self.source_id,
            "page_slug": self.page_slug,
            "page_id": self.page_id,
            "filename": self.filename,
            "storage_path": self.storage_path,
            "mime_type": self.mime_type,
            "size_bytes": self.size_bytes,
            "content_hash": self.content_hash,
            "metadata": crate::jsonb::ordered(&self.metadata),
            "created_at": iso(self.created_at_us),
        })
    }
}

/// `getRawData` options: the page scope of `PageReadScope`, `includeDeleted`, and the page policy
/// `excludePrivate` names (`privatePagesFilterForCaller('p')`): a page it hides has no raw data.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RawDataScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub include_deleted: bool,
    pub exclude_private: Option<crate::facts::PrivacyPolicy>,
}

/// `FileSpec`. Numbers arrive as JSON numbers (whole or not) so a bad one fails as Postgres
/// fails it; `metadata` is the `JSON.stringify` text the PGLite engine binds as jsonb.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct FileSpec {
    pub source_id: Option<String>,
    pub page_slug: Option<String>,
    pub page_id: Option<Value>,
    pub filename: Option<String>,
    pub storage_path: Option<String>,
    pub mime_type: Option<String>,
    pub size_bytes: Option<Value>,
    pub content_hash: Option<String>,
    pub metadata: Option<String>,
}

/// What `upsertFile` resolves.
#[derive(Debug, Clone, Serialize)]
pub struct UpsertFileResult {
    pub id: u64,
    pub created: bool,
}

fn has_nul(value: &Value) -> bool {
    match value {
        Value::String(s) => s.contains('\0'),
        Value::Array(items) => items.iter().any(has_nul),
        Value::Object(map) => map.iter().any(|(k, v)| k.contains('\0') || has_nul(v)),
        _ => false,
    }
}

/// Parses jsonb input text. Postgres refuses `\u0000` in jsonb text (`unsupported Unicode escape
/// sequence`); the store refuses it with `invalid_argument` too.
fn jsonb(op: &str, column: &str, text: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(text).map_err(|e| {
        StoreError::invalid(format!(
            "{op}: invalid input syntax for type json ({column}): {e}"
        ))
    })?;
    if has_nul(&value) {
        return Err(StoreError::invalid(format!(
            "{op}: unsupported Unicode escape sequence in {column} (\\u0000 cannot be converted to text)"
        )));
    }
    Ok(crate::jsonb::order(value))
}

fn not_null(table: &str, column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "null value in column \"{column}\" of relation \"{table}\" violates not-null constraint"
        ),
    )
}

fn foreign_key(column: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "insert or update on table \"files\" violates foreign key constraint \"files_{column}_fkey\""
        ),
    )
}

/// A whole JSON number in `[min, max]`, else `invalid_argument` (Postgres refuses `1.5` for an
/// integer column, and a number outside the column's range, before it runs the statement).
fn whole(op: &str, column: &str, ty: &str, value: &Value, min: f64, max: f64) -> Result<i64> {
    let refused =
        || StoreError::invalid(format!("{op}: {column} must be a whole {ty}, got {value}"));
    let Value::Number(n) = value else {
        return Err(refused());
    };
    if let Some(i) = n.as_i64() {
        if (i as f64) < min || (i as f64) > max {
            return Err(refused());
        }
        return Ok(i);
    }
    let f = n.as_f64().ok_or_else(refused)?;
    if !f.is_finite() || f.fract() != 0.0 || f < min || f > max || f >= -(i64::MIN as f64) {
        return Err(refused());
    }
    // Whole and inside the range, so the cast is exact.
    Ok(f as i64)
}

fn int4(op: &str, column: &str, value: &Value) -> Result<i64> {
    whole(
        op,
        column,
        "integer",
        value,
        f64::from(i32::MIN),
        f64::from(i32::MAX),
    )
}

fn read_file(read: &dyn KvRead, storage_path: &str) -> Result<Option<FileRecord>> {
    get_json(read, &file_key(storage_path))
}

fn put_file(tx: &mut dyn KvWrite, record: &FileRecord) -> Result<()> {
    put_json(tx, &file_key(&record.storage_path), record)
}

/// The shadow seed (`seed.rs`): stores `record`, a file copied from another engine with its own id
/// and `created_at`, with the page index entry `upsert_file` writes. `false` when the path already
/// holds that file; the path held by another id is the unique `storage_path` violation. The caller
/// checked the source and the page.
pub(crate) fn seed_file(tx: &mut dyn KvWrite, record: &FileRecord) -> Result<bool> {
    if let Some(stored) = read_file(&*tx, &record.storage_path)? {
        if stored.id == record.id {
            return Ok(false);
        }
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "duplicate key value violates unique constraint on files (storage_path)",
        ));
    }
    if let Some(page) = record.page_id {
        tx.put(
            &file_page_key(page, record.id),
            &serde_json::to_vec(&record.storage_path)?,
        )?;
    }
    put_file(tx, record)?;
    Ok(true)
}

/// The shadow seed: stores `record`, raw data copied from another engine with its own `fetched_at`,
/// where `put_raw_data` stores it. `false` when the page already holds raw data of that source.
/// The caller checked the page.
pub(crate) fn seed_raw_data(tx: &mut dyn KvWrite, record: &RawRecord) -> Result<bool> {
    let key = raw_key(record.page_id, &record.source);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    put_json(tx, &key, record)?;
    Ok(true)
}

/// The raw_data rows of page `page_id`, in key order (the export reads every row of a page).
pub(crate) fn page_raw_rows(read: &dyn KvRead, page_id: u64) -> Result<Vec<RawRecord>> {
    Ok(
        collect_values::<RawRecord>(read, &raw_page_prefix(page_id))?
            .into_iter()
            .map(|(_, row)| row)
            .collect(),
    )
}

fn collect_values<T: serde::de::DeserializeOwned>(
    read: &dyn KvRead,
    prefix: &[u8],
) -> Result<Vec<(Vec<u8>, T)>> {
    let mut raw = Vec::new();
    scan_prefix(read, prefix, false, &mut |k, v| {
        raw.push((k.to_vec(), v.to_vec()));
        true
    })?;
    raw.into_iter()
        .map(|(k, v)| Ok((k, serde_json::from_slice(&v)?)))
        .collect()
}

/// The pages `putRawData` writes to: the page in `source_id` when one is named, else every page
/// by that slug in any source. Soft-deleted pages count (the PGLite lookup has no `deleted_at`
/// filter).
fn raw_data_pages(
    read: &dyn KvRead,
    slug: &str,
    source_id: Option<&str>,
) -> Result<Vec<PageRecord>> {
    let sources: Vec<String> = match source_id {
        Some(id) => vec![id.to_string()],
        None => all_sources(read)?.into_iter().map(|s| s.id).collect(),
    };
    let mut pages = Vec::new();
    for source in sources {
        if let Some(page) = read_page(read, &source, slug)? {
            pages.push(page);
        }
    }
    Ok(pages)
}

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`):
/// the page's raw data, and the page reference of its files (the file rows stay).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    let raw: Vec<(Vec<u8>, RawRecord)> = collect_values(&*tx, &raw_page_prefix(page.id))?;
    for (key, _) in raw {
        tx.delete(&key)?;
    }
    let attached: Vec<(Vec<u8>, String)> = collect_values(&*tx, &file_page_prefix(page.id))?;
    for (key, path) in attached {
        tx.delete(&key)?;
        if let Some(mut file) = read_file(&*tx, &path)? {
            file.page_id = None;
            put_file(tx, &file)?;
        }
    }
    Ok(())
}

/// Deletes this family's records keyed by a source that is deleted (`cascade::remove_source_rows`):
/// the files of that source, with their page index entries.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let files: Vec<(Vec<u8>, FileRecord)> = collect_values(&*tx, &[keys::RAW_FILES, FILE])?;
    for (key, file) in files {
        if file.source_id != source_id {
            continue;
        }
        if let Some(page_id) = file.page_id {
            tx.delete(&file_page_key(page_id, file.id))?;
        }
        tx.delete(&key)?;
    }
    Ok(())
}

impl Store {
    /// `putRawData(slug, source, data, { sourceId? })`: inserts or replaces the raw data of
    /// `(page, source)` and stamps `fetched_at`. `data_json` is `JSON.stringify(data)`. With a
    /// `source_id` (not empty) only that source's page is written; without one, every page by
    /// that slug in any source is, soft-deleted pages included. No page: `page_not_found` with
    /// PGLite's message. A null `source` or `data` on a found page: `constraint_violation`.
    pub fn put_raw_data(
        &self,
        slug: &str,
        source: Option<&str>,
        data_json: Option<&str>,
        source_id: Option<&str>,
    ) -> Result<()> {
        const OP: &str = "putRawData";
        let source_id = source_id.filter(|s| !s.is_empty());
        let mut texts = vec![("slug", slug)];
        if let Some(s) = source {
            texts.push(("source", s));
        }
        if let Some(s) = source_id {
            texts.push(("sourceId", s));
        }
        no_nul(OP, &texts)?;
        let data = data_json.map(|t| jsonb(OP, "data", t)).transpose()?;
        self.write(|tx| {
            let pages = raw_data_pages(&*tx, slug, source_id)?;
            if pages.is_empty() {
                let message = match source_id {
                    Some(id) => {
                        format!("putRawData failed: page \"{slug}\" (source={id}) not found")
                    }
                    None => format!("putRawData failed: page \"{slug}\" not found"),
                };
                return Err(StoreError::new(PAGE_NOT_FOUND, message));
            }
            let source = source.ok_or_else(|| not_null("raw_data", "source"))?;
            let data = data.clone().ok_or_else(|| not_null("raw_data", "data"))?;
            let now = self.env.now_micros();
            for page in pages {
                let record = RawRecord {
                    page_id: page.id,
                    source: source.to_string(),
                    data: data.clone(),
                    fetched_at_us: now,
                };
                put_json(tx, &raw_key(page.id, source), &record)?;
            }
            Ok(())
        })
    }

    /// `getRawData(slug, source?, { sourceId?, sourceIds?, includeDeleted?, excludePrivate? })`: the
    /// raw data of every page by that slug in scope (`sourceIds` when not empty, else `sourceId`
    /// when not empty, else every source), only `source` when one is given (not empty). Pages that
    /// are soft deleted are skipped unless `includeDeleted`, and pages the page policy hides always. Rows come in SQL's
    /// order: page source, then raw-data source, both byte-wise (`COLLATE "C"`). `sourceIds` is a set: a repeated id
    /// returns its rows once.
    pub fn get_raw_data(
        &self,
        slug: &str,
        source: Option<&str>,
        scope: &RawDataScope,
    ) -> Result<Vec<Value>> {
        const OP: &str = "getRawData";
        let source = source.filter(|s| !s.is_empty());
        let mut texts = vec![("slug", slug)];
        if let Some(s) = source {
            texts.push(("source", s));
        }
        no_nul(OP, &texts)?;
        let read = self.read()?;
        let mut out = Vec::new();
        let mut ids = scope_sources(&*read, &scope.source_id, &scope.source_ids)?;
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            let Some(page) = read_page(&*read, &id, slug)? else {
                continue;
            };
            if page.deleted_at_us.is_some() && !scope.include_deleted {
                continue;
            }
            if let Some(policy) = &scope.exclude_private
                && crate::facts::page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            let rows: Vec<(Vec<u8>, RawRecord)> =
                collect_values(&*read, &raw_page_prefix(page.id))?;
            for (_, row) in rows {
                if source.is_none_or(|s| s == row.source) {
                    out.push(row.to_json());
                }
            }
        }
        Ok(out)
    }

    /// `upsertFile(spec)`: inserts the file, or, when a file already has that `storage_path` (in
    /// any source), updates every column but `id`, `source_id` and `created_at`. `created` says
    /// which. `source_id` is `default` when absent. A new row needs its source and page to
    /// exist; an update checks the page only when it changes (Postgres checks a foreign key when
    /// its column changes). `constraint_violation` for a null required column or a missing
    /// source or page; `invalid_argument` for a NUL byte or a number the column cannot hold.
    pub fn upsert_file(&self, spec: &FileSpec) -> Result<UpsertFileResult> {
        const OP: &str = "upsertFile";
        const TABLE: &str = "files";
        let source_id = spec
            .source_id
            .as_deref()
            .unwrap_or(crate::sources::DEFAULT_SOURCE);
        let mut texts = vec![("source_id", source_id)];
        for (name, value) in [
            ("page_slug", &spec.page_slug),
            ("filename", &spec.filename),
            ("storage_path", &spec.storage_path),
            ("mime_type", &spec.mime_type),
            ("content_hash", &spec.content_hash),
        ] {
            if let Some(text) = value.as_deref() {
                texts.push((name, text));
            }
        }
        no_nul(OP, &texts)?;
        let page_id = match spec.page_id.as_ref().filter(|v| !v.is_null()) {
            Some(v) => Some(int4(OP, "page_id", v)?),
            None => None,
        };
        let size_bytes = match spec.size_bytes.as_ref().filter(|v| !v.is_null()) {
            Some(v) => Some(whole(
                OP,
                "size_bytes",
                "bigint",
                v,
                i64::MIN as f64,
                i64::MAX as f64,
            )?),
            None => None,
        };
        let metadata = match spec.metadata.as_deref() {
            Some(text) => Some(jsonb(OP, "metadata", text)?),
            None => None,
        };
        // NOT NULL, in column order.
        let filename = spec
            .filename
            .clone()
            .ok_or_else(|| not_null(TABLE, "filename"))?;
        let storage_path = spec
            .storage_path
            .clone()
            .ok_or_else(|| not_null(TABLE, "storage_path"))?;
        let content_hash = spec
            .content_hash
            .clone()
            .ok_or_else(|| not_null(TABLE, "content_hash"))?;
        let metadata = metadata.ok_or_else(|| not_null(TABLE, "metadata"))?;

        self.write(|tx| {
            // A page id below 1 names no page; the foreign key refuses it like a missing one.
            let page_exists = |tx: &dyn KvRead, id: i64| -> Result<bool> {
                Ok(id > 0 && read_page_by_id(tx, id as u64)?.is_some())
            };
            let new_page = page_id.map(|id| id as u64);
            match read_file(&*tx, &storage_path)? {
                Some(mut file) => {
                    if let Some(id) = page_id
                        && file.page_id != new_page
                        && !page_exists(&*tx, id)?
                    {
                        return Err(foreign_key("page_id"));
                    }
                    if file.page_id != new_page {
                        if let Some(old) = file.page_id {
                            tx.delete(&file_page_key(old, file.id))?;
                        }
                        if let Some(new) = new_page {
                            tx.put(
                                &file_page_key(new, file.id),
                                &serde_json::to_vec(&storage_path)?,
                            )?;
                        }
                    }
                    file.page_slug = spec.page_slug.clone();
                    file.page_id = new_page;
                    file.filename = filename.clone();
                    file.mime_type = spec.mime_type.clone();
                    file.size_bytes = size_bytes;
                    file.content_hash = content_hash.clone();
                    file.metadata = metadata.clone();
                    put_file(tx, &file)?;
                    Ok(UpsertFileResult {
                        id: file.id,
                        created: false,
                    })
                }
                None => {
                    if read_source(&*tx, source_id)?.is_none() {
                        return Err(foreign_key("source_id"));
                    }
                    if let Some(id) = page_id
                        && !page_exists(&*tx, id)?
                    {
                        return Err(foreign_key("page_id"));
                    }
                    let id = next_id(tx, NEXT_FILE_ID)?;
                    let file = FileRecord {
                        id,
                        source_id: source_id.to_string(),
                        page_slug: spec.page_slug.clone(),
                        page_id: new_page,
                        filename: filename.clone(),
                        storage_path: storage_path.clone(),
                        mime_type: spec.mime_type.clone(),
                        size_bytes,
                        content_hash: content_hash.clone(),
                        metadata: metadata.clone(),
                        created_at_us: self.env.now_micros(),
                    };
                    if let Some(page) = new_page {
                        tx.put(
                            &file_page_key(page, id),
                            &serde_json::to_vec(&storage_path)?,
                        )?;
                    }
                    put_file(tx, &file)?;
                    Ok(UpsertFileResult { id, created: true })
                }
            }
        })
    }

    /// `getFile(sourceId, storagePath)`: the file at that path when it belongs to that source,
    /// else null. `invalid_argument` for a NUL byte.
    pub fn get_file(&self, source_id: &str, storage_path: &str) -> Result<Option<Value>> {
        no_nul(
            "getFile",
            &[("sourceId", source_id), ("storagePath", storage_path)],
        )?;
        let read = self.read()?;
        Ok(read_file(&*read, storage_path)?
            .filter(|f| f.source_id == source_id)
            .map(|f| f.to_json()))
    }

    /// `listFilesForPage(pageId)`: the files whose `page_id` is `page_id`, oldest first
    /// (`created_at ASC`; the store breaks ties by id). `page_id` must be a whole number in the
    /// `integer` range (`invalid_argument` otherwise); one that names no page lists nothing.
    pub fn list_files_for_page(&self, page_id: &Value) -> Result<Vec<Value>> {
        let id = int4("listFilesForPage", "pageId", page_id)?;
        if id < 1 {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let paths: Vec<(Vec<u8>, String)> = collect_values(&*read, &file_page_prefix(id as u64))?;
        let mut files = Vec::with_capacity(paths.len());
        for (_, path) in paths {
            if let Some(file) = read_file(&*read, &path)? {
                files.push(file);
            }
        }
        files.sort_by_key(|f| (f.created_at_us, f.id));
        Ok(files.iter().map(FileRecord::to_json).collect())
    }

    /// `listFiles({ pageSlug?, limit })`: with a `page_slug`, the files of that slug in any source,
    /// by `filename`; without one, every file, by `page_slug` (files with no slug last), then
    /// `filename`. Ties go by id, and text sorts by bytes. At most `limit` rows. `limit` must be a
    /// whole number in the `integer` range and not negative (`invalid_argument` otherwise).
    pub fn list_files(&self, page_slug: Option<&str>, limit: &Value) -> Result<Vec<Value>> {
        if let Some(slug) = page_slug {
            no_nul("listFiles", &[("pageSlug", slug)])?;
        }
        let limit = int4("listFiles", "limit", limit)?;
        if limit < 0 {
            return Err(StoreError::invalid(
                "listFiles: limit must not be negative".to_string(),
            ));
        }
        let read = self.read()?;
        let all: Vec<(Vec<u8>, FileRecord)> = collect_values(&*read, &[keys::RAW_FILES, FILE])?;
        let mut files: Vec<FileRecord> = all
            .into_iter()
            .map(|(_, f)| f)
            .filter(|f| page_slug.is_none_or(|slug| f.page_slug.as_deref() == Some(slug)))
            .collect();
        files.sort_by(|a, b| {
            let slug = match (&a.page_slug, &b.page_slug) {
                (Some(x), Some(y)) => x.as_bytes().cmp(y.as_bytes()),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            };
            slug.then_with(|| a.filename.as_bytes().cmp(b.filename.as_bytes()))
                .then_with(|| a.id.cmp(&b.id))
        });
        files.truncate(limit as usize);
        Ok(files.iter().map(FileRecord::to_json).collect())
    }
}

/// The shadow follow (`seed/follow.rs`): removes the file `id` stored at `storage_path`, with its
/// page index entry. `false` when the path holds no file of that id.
pub(crate) fn remove_file(tx: &mut dyn KvWrite, id: u64, storage_path: &str) -> Result<bool> {
    let Some(old) = read_file(&*tx, storage_path)? else {
        return Ok(false);
    };
    if old.id != id {
        return Ok(false);
    }
    if let Some(page) = old.page_id {
        tx.delete(&file_page_key(page, id))?;
    }
    tx.delete(&file_key(storage_path))?;
    Ok(true)
}

/// The shadow follow: removes the raw data of `source` on a page. `false` when there is none.
pub(crate) fn remove_raw_data(tx: &mut dyn KvWrite, page_id: u64, source: &str) -> Result<bool> {
    let key = raw_key(page_id, source);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    //! The cascade hooks are crate-private; their contract is tested here. The members are
    //! tested through the public API in `tests/raw_files.rs`.
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;

    fn put(store: &Store, slug: &str) -> u64 {
        let input: PageInput =
            serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "x"}))
                .unwrap();
        let page = store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        page["id"].as_u64().unwrap()
    }

    fn file(path: &str, page_id: Option<u64>) -> FileSpec {
        FileSpec {
            page_id: page_id.map(|id| json!(id)),
            filename: Some(path.into()),
            storage_path: Some(path.into()),
            content_hash: Some("h".into()),
            metadata: Some("{}".into()),
            ..FileSpec::default()
        }
    }

    #[test]
    fn a_page_delete_drops_raw_data_and_detaches_files() {
        let store = store();
        let id = put(&store, "notes/a");
        let other = put(&store, "notes/b");
        store
            .put_raw_data("notes/a", Some("feed"), Some("{\"x\":1}"), None)
            .unwrap();
        store
            .put_raw_data("notes/b", Some("feed"), Some("{\"x\":2}"), None)
            .unwrap();
        store.upsert_file(&file("f/a.png", Some(id))).unwrap();
        store.upsert_file(&file("f/b.png", Some(other))).unwrap();
        store
            .write(|tx| {
                let page = read_page(&*tx, "default", "notes/a")?.unwrap();
                remove_page_rows(tx, &page)
            })
            .unwrap();
        let read = store.read().unwrap();
        let left: Vec<(Vec<u8>, RawRecord)> = collect_values(&*read, &raw_page_prefix(id)).unwrap();
        assert!(left.is_empty());
        let kept: Vec<(Vec<u8>, RawRecord)> =
            collect_values(&*read, &raw_page_prefix(other)).unwrap();
        assert_eq!(kept.len(), 1);
        let detached = read_file(&*read, "f/a.png").unwrap().unwrap();
        assert_eq!(detached.page_id, None);
        assert!(store.list_files_for_page(&json!(id)).unwrap().is_empty());
        assert_eq!(store.list_files_for_page(&json!(other)).unwrap().len(), 1);
    }

    #[test]
    fn a_source_delete_drops_only_that_sources_files() {
        let store = store();
        let source: crate::sources::SourceInput =
            serde_json::from_value(json!({"id": "other"})).unwrap();
        store.upsert_source(&source).unwrap();
        let id = put(&store, "notes/a");
        store.upsert_file(&file("f/a.png", Some(id))).unwrap();
        let mut theirs = file("f/b.png", Some(id));
        theirs.source_id = Some("other".into());
        store.upsert_file(&theirs).unwrap();
        store.write(|tx| remove_source_rows(tx, "other")).unwrap();
        assert!(store.get_file("other", "f/b.png").unwrap().is_none());
        assert!(store.get_file("default", "f/a.png").unwrap().is_some());
        let listed = store.list_files_for_page(&json!(id)).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["storage_path"], "f/a.png");
    }
}
