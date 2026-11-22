//! The files commands and file operations of the PGLite engine (`src/core/engine-sql/files-ops.ts`).
//!
//! Members: listFileRowsForSlug, listAllFileRows, listFileRowsForVerify, hasFileWithHash, upsertCliFileRow,
//! upsertRawFileRow, upsertSyncFileRow, upsertOpFileRow, registerFileRow, readFileOwner, claimFilePage,
//! countFilesRegisteredElsewhere, readPageIdInSource, listReadableFileRows, listReadableFilePaths,
//! readReadableFileForUrl, readReadableFileForVerify, readReadablePageId, countUnreadableFilesAt.
//!
//! They read and write the `files` records of `raw_files.rs` (the path is the key, `r 0x03` indexes a file by its
//! page). Lists sort bytewise, as PGLite's `C` collation does, with a null page slug last, and break a tie by
//! storage path. The readable reads take the caller's page policy (`excludePrivate`): a file is hidden when the
//! policy hides its page by id, or any page by its slug in any source, soft-deleted pages included (the SQL has no
//! `deleted_at` test), so a file that names its page loosely fails closed.

use super::{
    FILE, FileRecord, FileSpec, NEXT_FILE_ID, collect_values, file_page_key, foreign_key, int4,
    jsonb, jsonb_order, not_null, put_file, read_file, whole,
};
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::{KvRead, KvWrite};
use crate::links::no_nul;
use crate::pages::{next_id, read_page, read_page_by_id};
use crate::sources::{DEFAULT_SOURCE, all_sources, read_source};
use crate::{Store, keys};
use serde_json::{Map, Value, json};
use std::cmp::Ordering;

/// Rows a file list returns: the command lists and the operation lists, and the verify list.
const LIST_LIMIT: usize = 100;
const VERIFY_LIMIT: usize = 1000;

/// Which write a files statement is, by what its conflict clause changes.
#[derive(Clone, Copy, PartialEq)]
enum Lane {
    /// The command upserts: a repeat of a path takes the hash, size, type and merged metadata.
    Command,
    /// `upsertOpFileRow`: also the source and page, when the new row names a page.
    Operation,
    /// `registerFileRow`: the same, only when the page slug, name, source and page id all match.
    Register,
}

fn all_files(read: &dyn KvRead) -> Result<Vec<FileRecord>> {
    let rows: Vec<(Vec<u8>, FileRecord)> = collect_values(read, &[keys::RAW_FILES, FILE])?;
    Ok(rows.into_iter().map(|(_, file)| file).collect())
}

/// `ORDER BY page_slug, filename` (nulls last), then the path for a tie.
fn by_slug_then_name(a: &FileRecord, b: &FileRecord) -> Ordering {
    let slugs = match (&a.page_slug, &b.page_slug) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    };
    slugs
        .then_with(|| a.filename.cmp(&b.filename))
        .then_with(|| a.storage_path.cmp(&b.storage_path))
}

fn by_name(a: &FileRecord, b: &FileRecord) -> Ordering {
    a.filename
        .cmp(&b.filename)
        .then_with(|| a.storage_path.cmp(&b.storage_path))
}

fn by_path(a: &FileRecord, b: &FileRecord) -> Ordering {
    a.storage_path.cmp(&b.storage_path)
}

fn page_exists(read: &dyn KvRead, id: i64) -> Result<bool> {
    Ok(id > 0 && read_page_by_id(read, id as u64)?.is_some())
}

/// `files.metadata || $new`: the stored object (a value that is not an object reads as `{}`) under the new keys.
fn merged_metadata(stored: &Value, new: &Value) -> Value {
    let mut merged: Map<String, Value> = stored.as_object().cloned().unwrap_or_default();
    if let Some(new) = new.as_object() {
        for (key, value) in new {
            merged.insert(key.clone(), value.clone());
        }
    }
    jsonb_order(Value::Object(merged))
}

/// Moves a file to `source_id` and `page_id`, keeping the page index in step. A changed source must exist and a
/// changed page must exist (Postgres checks a foreign key only when its column changes).
fn relink(
    tx: &mut dyn KvWrite,
    file: &mut FileRecord,
    source_id: &str,
    page_id: Option<i64>,
) -> Result<()> {
    let page = page_id.map(|id| id as u64);
    if file.source_id != source_id && read_source(&*tx, source_id)?.is_none() {
        return Err(foreign_key("source_id"));
    }
    if let Some(id) = page_id
        && file.page_id != page
        && !page_exists(&*tx, id)?
    {
        return Err(foreign_key("page_id"));
    }
    if file.page_id != page {
        if let Some(old) = file.page_id {
            tx.delete(&file_page_key(old, file.id))?;
        }
        if let Some(new) = page {
            tx.put(
                &file_page_key(new, file.id),
                &serde_json::to_vec(&file.storage_path)?,
            )?;
        }
    }
    file.source_id = source_id.to_string();
    file.page_id = page;
    Ok(())
}

/// A page id from a spec: a whole `integer`, or none.
fn spec_page_id(op: &str, spec: &FileSpec) -> Result<Option<i64>> {
    match spec.page_id.as_ref().filter(|v| !v.is_null()) {
        Some(v) => Ok(Some(int4(op, "page_id", v)?)),
        None => Ok(None),
    }
}

fn spec_texts(spec: &FileSpec) -> Vec<(&'static str, &str)> {
    let mut texts = Vec::new();
    for (name, value) in [
        ("source_id", &spec.source_id),
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
    texts
}

impl Store {
    /// `listFileRowsForSlug(slug)`, `listAllFileRows()` and `listFileRowsForVerify()`: `kind` is `slug`, `all` or
    /// `verify`. Every `files` column of up to 100 rows (1000 for verify): by file name for one page's, by page then
    /// name for all, by storage path for verify. `slug` is read only for `slug`.
    pub fn list_file_rows(&self, kind: &str, slug: Option<&str>) -> Result<Vec<Value>> {
        const OP: &str = "listFileRows";
        let read = self.read()?;
        let mut files = all_files(&*read)?;
        let limit = match kind {
            "slug" => {
                let slug = slug.unwrap_or_default();
                no_nul(OP, &[("slug", slug)])?;
                files.retain(|f| f.page_slug.as_deref() == Some(slug));
                files.sort_by(by_name);
                LIST_LIMIT
            }
            "all" => {
                files.sort_by(by_slug_then_name);
                LIST_LIMIT
            }
            "verify" => {
                files.sort_by(by_path);
                VERIFY_LIMIT
            }
            other => {
                return Err(StoreError::invalid(format!(
                    "{OP}: unknown list kind {other}"
                )));
            }
        };
        files.truncate(limit);
        Ok(files.iter().map(FileRecord::to_json).collect())
    }

    /// `hasFileWithHash(contentHash, storagePath)`: whether the file at that path holds that hash.
    pub fn has_file_with_hash(&self, content_hash: &str, storage_path: &str) -> Result<bool> {
        no_nul(
            "hasFileWithHash",
            &[("contentHash", content_hash), ("storagePath", storage_path)],
        )?;
        let read = self.read()?;
        Ok(read_file(&*read, storage_path)?.is_some_and(|f| f.content_hash == content_hash))
    }

    /// The four upserts and `registerFileRow`: `op` names the member, `lane` its conflict clause. A new row takes
    /// `source_id` (`default` for the command lanes when absent) and, for the operation lanes, `page_id`; it needs
    /// its source and page to exist. Returns whether a row was written (false only for a register that another
    /// identity holds). `constraint_violation` for a null required column or a missing source or page;
    /// `invalid_argument` for a NUL byte, a number a column cannot hold, or metadata that is not an object.
    fn write_file_row(&self, op: &str, lane: Lane, spec: &FileSpec) -> Result<bool> {
        const TABLE: &str = "files";
        no_nul(op, &spec_texts(spec))?;
        let page_id = if lane == Lane::Command {
            None
        } else {
            spec_page_id(op, spec)?
        };
        let size_bytes = match spec.size_bytes.as_ref().filter(|v| !v.is_null()) {
            Some(v) => Some(whole(
                op,
                "size_bytes",
                "bigint",
                v,
                i64::MIN as f64,
                i64::MAX as f64,
            )?),
            None => None,
        };
        let metadata = match spec.metadata.as_deref() {
            Some(text) => Some(jsonb(op, "metadata", text)?),
            None => None,
        };
        if metadata.as_ref().is_some_and(|m| !m.is_object()) {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("{op}: metadata must be a JSON object"),
            ));
        }
        let source_id = match (spec.source_id.as_deref(), lane) {
            (Some(id), _) => id,
            (None, Lane::Command) => DEFAULT_SOURCE,
            (None, _) => return Err(not_null(TABLE, "source_id")),
        };
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

        self.write(|tx| match read_file(&*tx, &storage_path)? {
            Some(mut file) => {
                match lane {
                    Lane::Command => {}
                    Lane::Operation => {
                        if page_id.is_some() {
                            relink(tx, &mut file, source_id, page_id)?;
                        }
                    }
                    Lane::Register => {
                        let same = file.page_slug == spec.page_slug
                            && file.filename == filename
                            && file.source_id == source_id
                            && file.page_id == page_id.map(|id| id as u64);
                        if !same {
                            return Ok(false);
                        }
                    }
                }
                file.content_hash = content_hash.clone();
                file.size_bytes = size_bytes;
                file.mime_type = spec.mime_type.clone();
                file.metadata = merged_metadata(&file.metadata, &metadata);
                put_file(tx, &file)?;
                Ok(true)
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
                    page_id: page_id.map(|id| id as u64),
                    filename: filename.clone(),
                    storage_path: storage_path.clone(),
                    mime_type: spec.mime_type.clone(),
                    size_bytes,
                    content_hash: content_hash.clone(),
                    metadata: merged_metadata(&json!({}), &metadata),
                    created_at_us: self.env.now_micros(),
                };
                if let Some(page) = file.page_id {
                    tx.put(
                        &file_page_key(page, id),
                        &serde_json::to_vec(&storage_path)?,
                    )?;
                }
                put_file(tx, &file)?;
                Ok(true)
            }
        })
    }

    /// `upsertCliFileRow`, `upsertRawFileRow`, `upsertSyncFileRow` (`lane` `command`, the raw one naming its
    /// `source_id`) and `upsertOpFileRow` (`operation`): inserts the row, or on its storage path takes the new hash,
    /// size and type and merges the metadata. The operation lane also takes the new source and page when the row
    /// names a page. `spec.metadata` is the JSON text of the metadata object.
    pub fn upsert_file_row(&self, lane: &str, spec: &FileSpec) -> Result<()> {
        let (op, lane) = match lane {
            "command" => ("upsertFileRow", Lane::Command),
            "operation" => ("upsertOpFileRow", Lane::Operation),
            other => {
                return Err(StoreError::invalid(format!(
                    "upsertFileRow: unknown lane {other}"
                )));
            }
        };
        self.write_file_row(op, lane, spec).map(|_| ())
    }

    /// `registerFileRow`: records the row, or refreshes it when the same page slug, filename, source and page id hold
    /// the path. False when another identity holds it, with nothing written.
    pub fn register_file_row(&self, spec: &FileSpec) -> Result<bool> {
        self.write_file_row("registerFileRow", Lane::Register, spec)
    }

    /// `readFileOwner(storagePath)`: the source, page id and hash of the file at that path, or null.
    pub fn read_file_owner(&self, storage_path: &str) -> Result<Option<Value>> {
        no_nul("readFileOwner", &[("storagePath", storage_path)])?;
        let read = self.read()?;
        Ok(read_file(&*read, storage_path)?.map(|f| {
            json!({ "source_id": f.source_id, "page_id": f.page_id, "content_hash": f.content_hash })
        }))
    }

    /// `claimFilePage(storagePath, sourceId, pageId)`: gives the file at that path to a source and page; nothing when
    /// no file is there. A source or page that does not exist is a `constraint_violation`.
    pub fn claim_file_page(
        &self,
        storage_path: &str,
        source_id: &str,
        page_id: &Value,
    ) -> Result<()> {
        const OP: &str = "claimFilePage";
        no_nul(
            OP,
            &[("storagePath", storage_path), ("sourceId", source_id)],
        )?;
        let page_id = if page_id.is_null() {
            None
        } else {
            Some(int4(OP, "pageId", page_id)?)
        };
        self.write(|tx| {
            let Some(mut file) = read_file(&*tx, storage_path)? else {
                return Ok(());
            };
            relink(tx, &mut file, source_id, page_id)?;
            put_file(tx, &file)
        })
    }

    /// `countFilesRegisteredElsewhere(identity)`: 1 when the file at `spec.storage_path` differs from the identity in
    /// page slug, filename, source or page id, else 0 (also when no file is there). `filename <> $3` is unknown for
    /// a null filename, so a null filename never differs.
    pub fn count_files_registered_elsewhere(&self, spec: &FileSpec) -> Result<u64> {
        const OP: &str = "countFilesRegisteredElsewhere";
        no_nul(OP, &spec_texts(spec))?;
        let page_id = spec_page_id(OP, spec)?.map(|id| id as u64);
        let Some(path) = spec.storage_path.as_deref() else {
            return Ok(0);
        };
        let read = self.read()?;
        let Some(file) = read_file(&*read, path)? else {
            return Ok(0);
        };
        let differs = file.page_slug != spec.page_slug
            || spec
                .filename
                .as_deref()
                .is_some_and(|name| name != file.filename)
            || spec.source_id.as_deref() != Some(file.source_id.as_str())
            || file.page_id != page_id;
        Ok(u64::from(differs))
    }

    /// `readPageIdInSource(slug, sourceId)`: the id of the page at that slug in that source (a soft-deleted one
    /// too), or null.
    pub fn read_page_id_in_source(&self, slug: &str, source_id: &str) -> Result<Option<u64>> {
        no_nul(
            "readPageIdInSource",
            &[("slug", slug), ("sourceId", source_id)],
        )?;
        let read = self.read()?;
        Ok(read_page(&*read, source_id, slug)?.map(|p| p.id))
    }

    /// Whether `policy` lets the caller read the page a file names: not hidden by id, and no page at its slug in any
    /// source is hidden. No policy reads every file.
    fn file_readable(
        read: &dyn KvRead,
        file: &FileRecord,
        policy: Option<&PrivacyPolicy>,
        sources: &[String],
    ) -> Result<bool> {
        let Some(policy) = policy else {
            return Ok(true);
        };
        if let Some(id) = file.page_id
            && let Some(page) = read_page_by_id(read, id)?
            && page_hidden(read, &page, policy)?
        {
            return Ok(false);
        }
        if let Some(slug) = file.page_slug.as_deref() {
            for source in sources {
                if let Some(page) = read_page(read, source, slug)?
                    && page_hidden(read, &page, policy)?
                {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// `listReadableFileRows(slug, excludePrivate)` (`columns` `rows`: id, page_slug, filename, storage_path,
    /// mime_type, size_bytes, content_hash, created_at, by name for one page and by page then name for all) and
    /// `listReadableFilePaths` (`paths`: storage_path and page_slug by path): up to 100 files of the page (or every
    /// page, `slug` none) that `policy` lets the caller read.
    pub fn list_readable_files(
        &self,
        columns: &str,
        slug: Option<&str>,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listReadableFiles";
        if let Some(slug) = slug {
            no_nul(OP, &[("slug", slug)])?;
        }
        let read = self.read()?;
        let sources: Vec<String> = all_sources(&*read)?.into_iter().map(|s| s.id).collect();
        let mut files = all_files(&*read)?;
        files.retain(|f| slug.is_none_or(|s| f.page_slug.as_deref() == Some(s)));
        match (columns, slug) {
            ("rows", Some(_)) => files.sort_by(by_name),
            ("rows", None) => files.sort_by(by_slug_then_name),
            ("paths", _) => files.sort_by(by_path),
            (other, _) => {
                return Err(StoreError::invalid(format!(
                    "{OP}: unknown columns {other}"
                )));
            }
        }
        let mut out = Vec::new();
        for file in &files {
            if out.len() == LIST_LIMIT {
                break;
            }
            if !Self::file_readable(&*read, file, policy, &sources)? {
                continue;
            }
            out.push(if columns == "rows" {
                json!({
                    "id": file.id, "page_slug": file.page_slug, "filename": file.filename,
                    "storage_path": file.storage_path, "mime_type": file.mime_type,
                    "size_bytes": file.size_bytes, "content_hash": file.content_hash,
                    "created_at": crate::env::iso(file.created_at_us),
                })
            } else {
                json!({ "storage_path": file.storage_path, "page_slug": file.page_slug })
            });
        }
        Ok(out)
    }

    /// `readReadableFileForUrl(storagePath, excludePrivate)` (`columns` `url`: storage_path, mime_type, size_bytes)
    /// and `readReadableFileForVerify` (`verify`: size_bytes, content_hash): the file at that path when `policy`
    /// lets the caller read it, else null.
    pub fn read_readable_file(
        &self,
        columns: &str,
        storage_path: &str,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Option<Value>> {
        const OP: &str = "readReadableFile";
        no_nul(OP, &[("storagePath", storage_path)])?;
        if columns != "url" && columns != "verify" {
            return Err(StoreError::invalid(format!(
                "{OP}: unknown columns {columns}"
            )));
        }
        let read = self.read()?;
        let sources: Vec<String> = all_sources(&*read)?.into_iter().map(|s| s.id).collect();
        let Some(file) = read_file(&*read, storage_path)? else {
            return Ok(None);
        };
        if !Self::file_readable(&*read, &file, policy, &sources)? {
            return Ok(None);
        }
        Ok(Some(if columns == "url" {
            json!({ "storage_path": file.storage_path, "mime_type": file.mime_type, "size_bytes": file.size_bytes })
        } else {
            json!({ "size_bytes": file.size_bytes, "content_hash": file.content_hash })
        }))
    }

    /// `readReadablePageId(slug, sourceId, excludePrivate)`: the id of the page at that slug in that source when
    /// `policy` lets the caller read it, else null.
    pub fn read_readable_page_id(
        &self,
        slug: &str,
        source_id: &str,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Option<u64>> {
        no_nul(
            "readReadablePageId",
            &[("slug", slug), ("sourceId", source_id)],
        )?;
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)? else {
            return Ok(None);
        };
        match policy {
            Some(policy) if page_hidden(&*read, &page, policy)? => Ok(None),
            _ => Ok(Some(page.id)),
        }
    }

    /// `countUnreadableFilesAt(storagePath, excludePrivate)`: 1 when a file is at that path and `policy` hides it
    /// from the caller, else 0.
    pub fn count_unreadable_files_at(
        &self,
        storage_path: &str,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<u64> {
        no_nul("countUnreadableFilesAt", &[("storagePath", storage_path)])?;
        let read = self.read()?;
        let sources: Vec<String> = all_sources(&*read)?.into_iter().map(|s| s.id).collect();
        let Some(file) = read_file(&*read, storage_path)? else {
            return Ok(0);
        };
        Ok(u64::from(!Self::file_readable(
            &*read, &file, policy, &sources,
        )?))
    }
}
