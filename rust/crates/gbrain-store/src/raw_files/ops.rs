//! The readable file list of the PGLite engine (`src/core/engine-sql/collate-page-reads.ts`).
//!
//! Members: listReadableFileRows (the napi call `listReadableFiles`) and listFilesByStoragePath (`listFilesByPath`).
//!
//! They read the `files` records of `raw_files.rs` (the path is the key). Lists sort bytewise, as PGLite's `C`
//! collation does, with a null page slug last, and break a tie by file id. The readable reads take the caller's page
//! policy (`excludePrivate`): a file is hidden when the policy hides its page by id, or any page by its slug in any
//! source, soft-deleted pages included (the SQL has no `deleted_at` test), so a file that names its page loosely fails
//! closed.

use super::{FILE, FileRecord, collect_values, int4};
use crate::error::{Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::{read_page, read_page_by_id};
use crate::sources::all_sources;
use crate::{Store, keys};
use serde_json::{Value, json};
use std::cmp::Ordering;

/// Rows a file list returns.
const LIST_LIMIT: usize = 100;

fn all_files(read: &dyn KvRead) -> Result<Vec<FileRecord>> {
    let rows: Vec<(Vec<u8>, FileRecord)> = collect_values(read, &[keys::RAW_FILES, FILE])?;
    Ok(rows.into_iter().map(|(_, file)| file).collect())
}

/// `ORDER BY page_slug COLLATE "C", filename COLLATE "C", id` (nulls last).
fn by_slug_then_name(a: &FileRecord, b: &FileRecord) -> Ordering {
    let slugs = match (&a.page_slug, &b.page_slug) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    };
    slugs
        .then_with(|| a.filename.cmp(&b.filename))
        .then_with(|| a.id.cmp(&b.id))
}

/// `ORDER BY filename COLLATE "C", id`.
fn by_name(a: &FileRecord, b: &FileRecord) -> Ordering {
    a.filename.cmp(&b.filename).then_with(|| a.id.cmp(&b.id))
}

impl Store {
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

    /// `listReadableFileRows(slug, excludePrivate)` (id, page_slug, filename, storage_path, mime_type, size_bytes,
    /// content_hash, created_at; by name for one page and by page then name for all): up to 100 files of the page (or
    /// every page, `slug` none) that `policy` lets the caller read.
    pub fn list_readable_files(
        &self,
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
        match slug {
            Some(_) => files.sort_by(by_name),
            None => files.sort_by(by_slug_then_name),
        }
        let mut out = Vec::new();
        for file in &files {
            if out.len() == LIST_LIMIT {
                break;
            }
            if !Self::file_readable(&*read, file, policy, &sources)? {
                continue;
            }
            out.push(json!({
                "id": file.id, "page_slug": file.page_slug, "filename": file.filename,
                "storage_path": file.storage_path, "mime_type": file.mime_type,
                "size_bytes": file.size_bytes, "content_hash": file.content_hash,
                "created_at": crate::env::iso(file.created_at_us),
            }));
        }
        Ok(out)
    }

    /// `listFilesByStoragePath(limit)` (every `FileRow` column; `files verify` walks it): the files by `storage_path`
    /// bytes, at most `limit`. A storage path names one file, so the order has no tie. `limit` must be a whole number
    /// in the `integer` range and not negative (`invalid_argument` otherwise).
    pub fn list_files_by_storage_path(&self, limit: &Value) -> Result<Vec<Value>> {
        let limit = int4("listFilesByStoragePath", "limit", limit)?;
        if limit < 0 {
            return Err(StoreError::invalid(
                "listFilesByStoragePath: limit must not be negative".to_string(),
            ));
        }
        let read = self.read()?;
        let mut files = all_files(&*read)?;
        files.sort_by(|a, b| a.storage_path.cmp(&b.storage_path));
        files.truncate(limit as usize);
        Ok(files.iter().map(FileRecord::to_json).collect())
    }
}
