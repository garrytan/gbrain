//! The `guest_marks` table of the SQL engines (src/core/guests/schema.ts): who each guest note was saved for, from which
//! group and by which writer, one row per guest page. The TypeScript statements are in
//! src/core/engine-sql/guest-notes.ts.
//!
//! Members: insertGuestMark (written in a guest note's publication transaction, right after the page row) and
//! readGuestMarks (the guest stamp every read of a guest page carries, guests/marker.ts).
//!
//! Key: `~g <page id BE8>` (`keys::GUEST_MARK`, a two-byte family tag) -> the row (JSON, [`MarkRecord`]). One row per
//! page, as the table's primary key `page_id`: a second mark of one page is the primary key's duplicate-key error. The
//! row goes with the page when it is deleted for good ([`remove_page_rows`], from `cascade::remove_page_rows`), as the
//! foreign key's `ON DELETE CASCADE` drops it; a soft delete keeps it.
//!
//! `promoted` reads whether the page has a promotion row (`guest_promotions.rs`).

use crate::error::{CONSTRAINT_VIOLATION, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::links::no_nul;
use crate::pages::{PageRecord, read_page};
use crate::{Result, Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// One row: the table's columns but `page_id` (the key). `saved_at` and `created_at` in microseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct MarkRecord {
    pub source_id: String,
    pub slug_at_write: String,
    pub audience_member: String,
    pub group_slug: String,
    pub sender_label: String,
    pub saved_at_us: i64,
    pub writer_kind: String,
    pub writer_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub created_at_us: i64,
}

/// `insertGuestMark(mark)`'s input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuestMarkInsert {
    pub source_id: String,
    pub slug: String,
    pub audience_member: String,
    pub group_slug: String,
    pub sender_label: String,
    pub writer_kind: String,
    pub writer_id: String,
    pub request_id: String,
}

pub(crate) fn mark_key(page_id: u64) -> Vec<u8> {
    let mut key = keys::GUEST_MARK.to_vec();
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// The mark of page `page_id`, if it has one.
pub(crate) fn read_mark(read: &dyn KvRead, page_id: u64) -> Result<Option<MarkRecord>> {
    get_json(read, &mark_key(page_id))
}

/// A page deleted for good takes its mark with it (the foreign key's `ON DELETE CASCADE`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    tx.delete(&mark_key(page.id))
}

/// The seed's copy of a primary's mark (seed/privacy.rs): false when the store already holds the same row.
pub(crate) fn seed_mark(tx: &mut dyn KvWrite, page_id: u64, row: MarkRecord) -> Result<bool> {
    if read_mark(&*tx, page_id)?.is_some_and(|stored| stored == row) {
        return Ok(false);
    }
    put_json(tx, &mark_key(page_id), &row)?;
    Ok(true)
}

/// The shadow follower's removal of a mark the primary deleted; false when the store holds none.
pub(crate) fn remove_mark(tx: &mut dyn KvWrite, page_id: u64) -> Result<bool> {
    if read_mark(&*tx, page_id)?.is_none() {
        return Ok(false);
    }
    tx.delete(&mark_key(page_id))?;
    Ok(true)
}

fn iso(us: i64) -> Value {
    json!(crate::env::iso(us))
}

impl Store {
    /// `insertGuestMark(mark)`: the mark of the page at `(sourceId, slug)` (live or soft-deleted, as the statement
    /// joins `pages` with no `deleted_at` filter), saved and created now; how many rows it wrote, 0 when no page is
    /// there. A page that already has a mark is the primary key's duplicate-key error and writes nothing.
    pub fn insert_guest_mark(&self, mark: &GuestMarkInsert) -> Result<u64> {
        no_nul(
            "insertGuestMark",
            &[
                ("sourceId", mark.source_id.as_str()),
                ("slug", mark.slug.as_str()),
                ("audienceMember", mark.audience_member.as_str()),
                ("groupSlug", mark.group_slug.as_str()),
                ("senderLabel", mark.sender_label.as_str()),
                ("writerKind", mark.writer_kind.as_str()),
                ("writerId", mark.writer_id.as_str()),
                ("requestId", mark.request_id.as_str()),
            ],
        )?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(page) = read_page(&*tx, &mark.source_id, &mark.slug)? else {
                return Ok(0);
            };
            if read_mark(&*tx, page.id)?.is_some() {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    "duplicate key value violates unique constraint \"guest_marks_pkey\"",
                ));
            }
            let row = MarkRecord {
                source_id: page.source_id.clone(),
                slug_at_write: page.slug.clone(),
                audience_member: mark.audience_member.clone(),
                group_slug: mark.group_slug.clone(),
                sender_label: mark.sender_label.clone(),
                saved_at_us: now,
                writer_kind: mark.writer_kind.clone(),
                writer_id: mark.writer_id.clone(),
                request_id: Some(mark.request_id.clone()),
                created_at_us: now,
            };
            put_json(tx, &mark_key(page.id), &row)?;
            Ok(1)
        })
    }

    /// `readGuestMarks(pageIds)`: the mark of each page id that has one (each id once, in id order; the SQL sets no
    /// order), as `{page_id, sender_label, group_slug, audience_member, saved_at, writer_kind, writer_id, promoted}` with
    /// `saved_at` an ISO time and `promoted` whether the owner kept the page.
    pub fn read_guest_marks(&self, page_ids: &[u64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for id in page_ids.iter().collect::<BTreeSet<_>>() {
            if let Some(row) = read_mark(&*read, *id)? {
                out.push(json!({
                    "page_id": id,
                    "sender_label": row.sender_label,
                    "group_slug": row.group_slug,
                    "audience_member": row.audience_member,
                    "saved_at": iso(row.saved_at_us),
                    "writer_kind": row.writer_kind,
                    "writer_id": row.writer_id,
                    "promoted": crate::guest_promotions::page_promoted(&*read, *id)?,
                }));
            }
        }
        Ok(out)
    }
}
