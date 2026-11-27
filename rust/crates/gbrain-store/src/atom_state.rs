//! The extract_atoms ledgers (store format 17): the PGLite `extract_atoms_page_state` and
//! `extract_atoms_transcript_state` tables, written by the extract_atoms phase
//! (`src/core/engine-sql/extract-atoms-state.ts`, `extract-atoms-reads.ts`) and read by its discovery, its
//! transcript tombstone read and the backlog count.
//!
//! Keys (family `~a`, `keys::ATOM_EXTRACTION_STATE`):
//! - `~a 0x01 <page id BE8> <source incarnation> 0x00 <content hash>`: one page row
//!   (`(source_incarnation, page_id, content_hash)`, the table's primary key). The page id leads, so the rows of one
//!   page are one prefix: a hard delete, a soft delete or restore, a move to another source and a generation bump
//!   drop them with one scan.
//! - `~a 0x02 <source id> 0x00 <file path> 0x00 <content hash>`: one transcript row
//!   (`(source_id, file_path, content_hash)`).
//!
//! The value is an [`AtomStateRecord`]: `fail_count`, `tombstoned`, `partial_input_chars` and `updated_at`.
//!
//! The page table's foreign keys and trigger are kept as Postgres keeps them: a page deleted for good drops its rows
//! (`cascade::remove_page_rows`), and a page whose `deleted_at` or `source_id` changes drops them too
//! (`gbrain_clear_atom_page_state`, run from `pages::store_page`). A deleted source's pages are deleted first, which
//! drops their rows; [`remove_source_rows`] drops any row of the source's incarnation left after that. The transcript
//! table has no foreign key, so its rows outlive their source, as in Postgres.
//!
//! Postgres text can hold no NUL, so a key part with one is refused (`invalid_argument`), as the SQL refuses it.

use crate::env::is_uuid;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const PAGE_ROW: u8 = 0x01;
const TRANSCRIPT_ROW: u8 = 0x02;

/// One row of either table.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct AtomStateRecord {
    pub fail_count: i32,
    pub tombstoned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial_input_chars: Option<i32>,
    pub updated_at_us: i64,
}

fn text<'a>(part: &'a str, what: &str) -> Result<&'a str> {
    if part.contains('\0') {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("invalid byte sequence for encoding \"UTF8\": 0x00 (the {what})"),
        ));
    }
    Ok(part)
}

fn page_prefix(page_id: u64) -> Vec<u8> {
    let mut key = keys::ATOM_EXTRACTION_STATE.to_vec();
    key.push(PAGE_ROW);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn page_key(page_id: u64, incarnation: &str, content_hash: &str) -> Result<Vec<u8>> {
    let mut key = page_prefix(page_id);
    key.extend_from_slice(text(incarnation, "source incarnation")?.as_bytes());
    key.push(0);
    key.extend_from_slice(text(content_hash, "content hash")?.as_bytes());
    Ok(key)
}

/// `(incarnation, content_hash)` of a page row key under `page_prefix(page_id)`.
fn split_page_key(rest: &[u8]) -> Option<(&str, &str)> {
    let at = rest.iter().position(|b| *b == 0)?;
    Some((
        std::str::from_utf8(&rest[..at]).ok()?,
        std::str::from_utf8(&rest[at + 1..]).ok()?,
    ))
}

fn transcript_prefix(source_id: Option<&str>) -> Result<Vec<u8>> {
    let mut key = keys::ATOM_EXTRACTION_STATE.to_vec();
    key.push(TRANSCRIPT_ROW);
    if let Some(source) = source_id {
        key.extend_from_slice(text(source, "source id")?.as_bytes());
        key.push(0);
    }
    Ok(key)
}

fn transcript_key(source_id: &str, file_path: &str, content_hash: &str) -> Result<Vec<u8>> {
    let mut key = transcript_prefix(Some(source_id))?;
    key.extend_from_slice(text(file_path, "file path")?.as_bytes());
    key.push(0);
    key.extend_from_slice(text(content_hash, "content hash")?.as_bytes());
    Ok(key)
}

/// `(file_path, content_hash)` of a transcript row key under `transcript_prefix(Some(source))`.
fn split_transcript_key(rest: &[u8]) -> Option<(String, String)> {
    let at = rest.iter().position(|b| *b == 0)?;
    Some((
        std::str::from_utf8(&rest[..at]).ok()?.to_owned(),
        std::str::from_utf8(&rest[at + 1..]).ok()?.to_owned(),
    ))
}

fn corrupt() -> StoreError {
    StoreError::new(
        crate::error::STORE_CORRUPT,
        "an extract_atoms state row is not readable",
    )
}

/// A page row of one page: its key, incarnation, content hash and record.
type PageRow = (Vec<u8>, String, String, AtomStateRecord);
/// A page row of the store: its key, page id, incarnation and record.
type StorePageRow = (Vec<u8>, u64, String, AtomStateRecord);

/// Every page row of `page_id`.
fn page_rows(read: &dyn KvRead, page_id: u64) -> Result<Vec<PageRow>> {
    let prefix = page_prefix(page_id);
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        match (
            split_page_key(&k[prefix.len()..]),
            serde_json::from_slice::<AtomStateRecord>(v),
        ) {
            (Some((inc, hash)), Ok(record)) => {
                out.push((k.to_vec(), inc.to_owned(), hash.to_owned(), record))
            }
            _ => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(corrupt());
    }
    Ok(out)
}

/// Every page row of the store: `(key, page_id, incarnation, record)`.
fn all_page_rows(read: &dyn KvRead) -> Result<Vec<StorePageRow>> {
    let mut prefix = keys::ATOM_EXTRACTION_STATE.to_vec();
    prefix.push(PAGE_ROW);
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let rest = &k[prefix.len()..];
        let parsed = (rest.len() > 8)
            .then(|| {
                let id = u64::from_be_bytes(rest[..8].try_into().ok()?);
                let (inc, _) = split_page_key(&rest[8..])?;
                Some((id, inc.to_owned()))
            })
            .flatten();
        match (parsed, serde_json::from_slice::<AtomStateRecord>(v)) {
            (Some((id, inc)), Ok(record)) => out.push((k.to_vec(), id, inc, record)),
            _ => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(corrupt());
    }
    Ok(out)
}

/// The page row at `(incarnation, page_id, content_hash)`, if any (discovery and the backlog count read it).
pub(crate) fn page_state(
    read: &dyn KvRead,
    incarnation: &str,
    page_id: u64,
    content_hash: &str,
) -> Result<Option<AtomStateRecord>> {
    if incarnation.contains('\0') || content_hash.contains('\0') {
        return Ok(None);
    }
    get_json(
        read,
        &page_key(page_id, &incarnation.to_ascii_lowercase(), content_hash)?,
    )
}

/// Drops every page row of `page_id`: a hard delete (`cascade::remove_page_rows`), and a write that changes the
/// page's `deleted_at` or `source_id` (the `gbrain_clear_atom_page_state` trigger, from `pages::store_page`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    for (key, ..) in page_rows(&*tx, page_id)? {
        tx.delete(&key)?;
    }
    Ok(())
}

/// The trigger `gbrain_clear_atom_page_state`: a page write that changes `deleted_at` or `source_id` drops the page's rows.
pub(crate) fn on_page_write(
    tx: &mut dyn KvWrite,
    before: Option<&PageRecord>,
    after: &PageRecord,
) -> Result<()> {
    match before {
        Some(b) if b.deleted_at_us != after.deleted_at_us || b.source_id != after.source_id => {
            remove_page_rows(tx, b.id)
        }
        _ => Ok(()),
    }
}

/// The incarnation foreign key of a deleted source (`cascade::remove_source_rows`): its pages are removed first, which
/// drops their rows; while the source record is still readable this drops any row of its incarnation that is left.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let Some(source) = read_source(&*tx, source_id)? else {
        return Ok(());
    };
    let incarnation = source.incarnation.to_ascii_lowercase();
    for (key, _, inc, _) in all_page_rows(&*tx)? {
        if inc == incarnation {
            tx.delete(&key)?;
        }
    }
    Ok(())
}

/// `recordAtomGenerationBump`'s `DELETE FROM extract_atoms_page_state WHERE source_incarnation=$1 AND page_id=$2 AND
/// content_hash IS DISTINCT FROM $3`.
pub(crate) fn drop_other_contents(
    tx: &mut dyn KvWrite,
    incarnation: &str,
    page_id: u64,
    keep_content_hash: Option<&str>,
) -> Result<()> {
    let incarnation = incarnation.to_ascii_lowercase();
    for (key, inc, hash, _) in page_rows(&*tx, page_id)? {
        if inc == incarnation && keep_content_hash != Some(hash.as_str()) {
            tx.delete(&key)?;
        }
    }
    Ok(())
}

/// The page a state write pins: `p.id=$1 AND s.incarnation=$2::uuid AND p.source_id=$3 AND p.slug=$4 AND
/// p.content_hash=$5 AND p.knowledge_revision=$6::uuid AND p.deleted_at IS NULL`. `None`: the page changed.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AtomPagePin {
    pub page_id: i64,
    pub source_incarnation: String,
    pub source_id: String,
    pub slug: String,
    pub content_hash: String,
    pub revision: String,
}

fn uuid(value: &str, what: &str) -> Result<String> {
    if !is_uuid(value) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("invalid input syntax for type uuid: \"{value}\" (the {what})"),
        ));
    }
    Ok(value.to_ascii_lowercase())
}

/// The pinned page, or `None` when it no longer matches. `incarnation` is returned lower case.
fn pinned_page(read: &dyn KvRead, pin: &AtomPagePin) -> Result<Option<(u64, String, String)>> {
    let incarnation = uuid(&pin.source_incarnation, "source incarnation")?;
    let revision = uuid(&pin.revision, "knowledge revision")?;
    let Ok(id) = u64::try_from(pin.page_id) else {
        return Ok(None);
    };
    let Some(page) = read_page_by_id(read, id)? else {
        return Ok(None);
    };
    let Some(source) = read_source(read, &page.source_id)? else {
        return Ok(None);
    };
    let matches = source.incarnation.to_ascii_lowercase() == incarnation
        && page.source_id == pin.source_id
        && page.slug == pin.slug
        && page.content_hash.as_deref() == Some(pin.content_hash.as_str())
        && page.knowledge_revision.to_ascii_lowercase() == revision
        && page.deleted_at_us.is_none();
    Ok(matches.then(|| (id, incarnation, pin.content_hash.clone())))
}

impl Store {
    /// `readAtomPageIdentity(sourceId, slug, contentHash)`: `{ id, incarnation, knowledge_revision }` of the live page
    /// of the source with that slug and content hash, or null.
    pub fn read_atom_page_identity(
        &self,
        source_id: &str,
        slug: &str,
        content_hash: &str,
    ) -> Result<Value> {
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)? else {
            return Ok(Value::Null);
        };
        if page.deleted_at_us.is_some() || page.content_hash.as_deref() != Some(content_hash) {
            return Ok(Value::Null);
        }
        let Some(source) = read_source(&*read, source_id)? else {
            return Ok(Value::Null);
        };
        Ok(
            json!({ "id": page.id, "incarnation": source.incarnation, "knowledge_revision": page.knowledge_revision }),
        )
    }

    /// `readLivePageSourcePath(sourceId, slug)`: `{ source_path }` (`frontmatter->>'source_path'`) of the live page of the
    /// source with that slug, or null when there is none.
    pub fn read_live_page_source_path(&self, source_id: &str, slug: &str) -> Result<Value> {
        let read = self.read()?;
        Ok(match read_page(&*read, source_id, slug)? {
            Some(page) if page.deleted_at_us.is_none() => {
                json!({ "source_path": crate::cli_reads::pg_text::fm_text(&page.frontmatter, "source_path") })
            }
            _ => Value::Null,
        })
    }

    /// `listConversationPageFrontmatter(sourceId)`: `{ slug, frontmatter }` of each live `conversation` page of the source,
    /// in slug byte order.
    pub fn list_conversation_page_frontmatter(&self, source_id: &str) -> Result<Vec<Value>> {
        Ok(crate::pages::all_pages(&*self.read()?)?
            .into_iter()
            .filter(|p| {
                p.source_id == source_id
                    && p.page_type == "conversation"
                    && p.deleted_at_us.is_none()
            })
            .map(|p| json!({ "slug": p.slug, "frontmatter": Value::Object(p.frontmatter) }))
            .collect())
    }

    /// `writeAtomPageState(pin, failIncrement, tombstone)`: the pinned page's row gains `failIncrement` failures and
    /// is tombstoned when `tombstone` (a new row starts there); the row's `fail_count`, or null when the page changed.
    pub fn write_atom_page_state(
        &self,
        pin: &AtomPagePin,
        fail_increment: i32,
        tombstone: bool,
    ) -> Result<Value> {
        self.write(|tx| {
            let Some((id, inc, hash)) = pinned_page(&*tx, pin)? else {
                return Ok(Value::Null);
            };
            let key = page_key(id, &inc, &hash)?;
            let mut record = get_json::<AtomStateRecord>(&*tx, &key)?.unwrap_or_default();
            record.fail_count = record.fail_count.checked_add(fail_increment).ok_or_else(|| {
                StoreError::new(INVALID_ARGUMENT, "integer out of range")
            })?;
            if record.fail_count < 0 {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    "new row for relation \"extract_atoms_page_state\" violates check constraint \"extract_atoms_page_state_fail_count_check\"",
                ));
            }
            record.tombstoned |= tombstone;
            record.updated_at_us = self.env.now_micros();
            put_json(tx, &key, &record)?;
            Ok(json!(record.fail_count))
        })
    }

    /// `recordAtomPagePartial(pin, maxInputChars)`: the pinned page's row records the cap it was cut at (a new row
    /// starts with no failure and no tombstone); the page id, or null when the page changed.
    pub fn record_atom_page_partial(
        &self,
        pin: &AtomPagePin,
        max_input_chars: i32,
    ) -> Result<Value> {
        self.write(|tx| {
            let Some((id, inc, hash)) = pinned_page(&*tx, pin)? else {
                return Ok(Value::Null);
            };
            let key = page_key(id, &inc, &hash)?;
            let mut record = get_json::<AtomStateRecord>(&*tx, &key)?.unwrap_or_default();
            record.partial_input_chars = Some(max_input_chars);
            record.updated_at_us = self.env.now_micros();
            put_json(tx, &key, &record)?;
            Ok(json!(id))
        })
    }

    /// The transcript row of `(source, path, hash)` after `change`, written now.
    fn write_transcript_row(
        &self,
        source_id: &str,
        file_path: &str,
        content_hash: &str,
        change: impl Fn(&mut AtomStateRecord, bool) -> Result<()>,
    ) -> Result<AtomStateRecord> {
        let key = transcript_key(source_id, file_path, content_hash)?;
        self.write(|tx| {
            let existing = get_json::<AtomStateRecord>(&*tx, &key)?;
            let fresh = existing.is_none();
            let mut record = existing.unwrap_or_default();
            change(&mut record, fresh)?;
            record.updated_at_us = self.env.now_micros();
            put_json(tx, &key, &record)?;
            Ok(record)
        })
    }

    /// `recordTranscriptPartial(sourceId, filePath, contentHash, maxInputChars)`: the row records the cut cap.
    pub fn record_transcript_partial(
        &self,
        source_id: &str,
        file_path: &str,
        content_hash: &str,
        max_input_chars: i32,
    ) -> Result<()> {
        self.write_transcript_row(source_id, file_path, content_hash, |r, _| {
            r.partial_input_chars = Some(max_input_chars);
            Ok(())
        })
        .map(|_| ())
    }

    /// `stampTranscriptTombstone(sourceId, filePath, contentHash)`: the row is tombstoned.
    pub fn stamp_transcript_tombstone(
        &self,
        source_id: &str,
        file_path: &str,
        content_hash: &str,
    ) -> Result<()> {
        self.write_transcript_row(source_id, file_path, content_hash, |r, _| {
            r.tombstoned = true;
            Ok(())
        })
        .map(|_| ())
    }

    /// `strikeTranscript(sourceId, filePath, contentHash)`: one more failure (a new row starts at 1); the count.
    pub fn strike_transcript(
        &self,
        source_id: &str,
        file_path: &str,
        content_hash: &str,
    ) -> Result<i32> {
        self.write_transcript_row(source_id, file_path, content_hash, |r, _| {
            r.fail_count = r
                .fail_count
                .checked_add(1)
                .ok_or_else(|| StoreError::new(INVALID_ARGUMENT, "integer out of range"))?;
            Ok(())
        })
        .map(|r| r.fail_count)
    }

    /// `listTombstonedTranscripts(sourceId, hashes)`: `{ file_path, content_hash }` of the source's rows that are
    /// tombstoned or partial and whose hash is one of `hashes`, in path order.
    pub fn list_tombstoned_transcripts(
        &self,
        source_id: &str,
        hashes: &[String],
    ) -> Result<Vec<Value>> {
        if source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let wanted: BTreeSet<&str> = hashes.iter().map(String::as_str).collect();
        let read = self.read()?;
        let prefix = transcript_prefix(Some(source_id))?;
        let mut out = Vec::new();
        let mut bad = false;
        scan_prefix(&*read, &prefix, false, &mut |k, v| {
            match (
                split_transcript_key(&k[prefix.len()..]),
                serde_json::from_slice::<AtomStateRecord>(v),
            ) {
                (Some((path, hash)), Ok(record)) => {
                    if (record.tombstoned || record.partial_input_chars.is_some())
                        && wanted.contains(hash.as_str())
                    {
                        out.push(json!({ "file_path": path, "content_hash": hash }));
                    }
                }
                _ => bad = true,
            }
            !bad
        })?;
        if bad {
            return Err(corrupt());
        }
        Ok(out)
    }
}

/// The two state updates of `releasePartialAtomDispositions(sourceId, maxInputChars)`: the partial cap of the source's
/// page rows (of its current incarnation) and transcript rows recorded below `max_input_chars` is cleared, stamped now.
pub(crate) fn release_partial_rows(
    tx: &mut dyn KvWrite,
    now_us: i64,
    source_id: &str,
    max_input_chars: i64,
) -> Result<()> {
    if let Some(source) = read_source(&*tx, source_id)? {
        let incarnation = source.incarnation.to_ascii_lowercase();
        for (key, _, inc, mut record) in all_page_rows(&*tx)? {
            if inc == incarnation
                && record
                    .partial_input_chars
                    .is_some_and(|p| i64::from(p) < max_input_chars)
            {
                record.partial_input_chars = None;
                record.updated_at_us = now_us;
                put_json(tx, &key, &record)?;
            }
        }
    }
    if source_id.contains('\0') {
        return Ok(());
    }
    let prefix = transcript_prefix(Some(source_id))?;
    let mut rows: Vec<(Vec<u8>, AtomStateRecord)> = Vec::new();
    let mut bad = false;
    scan_prefix(&*tx, &prefix, false, &mut |k, v| {
        match serde_json::from_slice::<AtomStateRecord>(v) {
            Ok(record) => rows.push((k.to_vec(), record)),
            Err(_) => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(corrupt());
    }
    for (key, mut record) in rows {
        if record
            .partial_input_chars
            .is_some_and(|p| i64::from(p) < max_input_chars)
        {
            record.partial_input_chars = None;
            record.updated_at_us = now_us;
            put_json(tx, &key, &record)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
