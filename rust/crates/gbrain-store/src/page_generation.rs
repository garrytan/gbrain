//! The per-page generation counter: `pages.generation` of the SQL engines, kept the way their trigger keeps it.
//!
//! PGLite and Postgres run `bump_page_generation_fn` (src/schema.sql, generated from PAGE_GENERATION_BUMP_FN_SQL in
//! src/core/page-body/schema.ts) before every insert and update of a `pages` row:
//!
//! - an INSERT takes `COALESCE(MAX(generation) over every page row, 0) + 1`; live and soft-deleted rows both count;
//! - an UPDATE adds one to the row's own generation when a watched column changes (`compiled_truth`, `timeline`,
//!   `frontmatter`, `deleted_at`, `contextual_retrieval_mode`, `title`, `type`, `page_kind`, `corpus_generation`,
//!   `content_hash`), or, when `compiled_truth` is NULL on both sides, when `body_generation` changes; any other
//!   update leaves it. One statement adds at most one, however many watched columns it changes.
//!
//! The page record keeps the number (`PageRecord::generation`; a record stored before the counter reads as 1), and
//! [`write_page`](crate::pages::write_page) applies the rule to each page write, which is one statement of the SQL
//! engines. Two watched columns live outside the page record, so the writers that change them say so: the contextual
//! retrieval state (`aliases.rs`, one record per page) and `body_generation` (`page_body.rs`, the body columns). The
//! rule counts them with the record's own columns, so a statement that changes both adds one.
//!
//! Index: `M page_generation/<generation BE8><page id BE8>`, an empty value, one per page record (live or
//! soft-deleted), written in the same transaction as the page change. A generation change deletes the old key and
//! puts the new one; a purge deletes the page's key. The highest generation is the last key of the range, one reverse
//! seek. The index lives under `META`, not under the page family: four scans decode every `P` value as a page record.
//! Everything here reads or writes only the `page_generation/` range.
//!
//! The only writers that name a generation are the shadow seed and its follower, which copy the primary's number
//! ([`Counter::Stored`]): the primary's trigger is the source of truth for a seeded brain.

use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, for_each_prefix_paged_from, scan_prefix};
use crate::pages::PageRecord;
use crate::{get_json, keys, put_json};

/// The name part of the index keys: `M` + this + `<generation BE8><page id BE8>`.
pub(crate) const INDEX_NAME: &str = "page_generation/";

/// The first key of the index range, and the prefix of every row in it.
fn prefix() -> Vec<u8> {
    keys::text(keys::META, &[INDEX_NAME])
}

/// `M page_generation/<generation BE8><page id BE8>`.
pub(crate) fn index_key(generation: u64, page_id: u64) -> Vec<u8> {
    let mut key = prefix();
    key.extend_from_slice(&generation.to_be_bytes());
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// What the write that stores a page record means for the counter.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) enum Counter {
    /// One SQL statement of the engines the trigger runs on: the number is the rule's, whatever the record carries.
    #[default]
    Statement,
    /// The statement also changes `contextual_retrieval_mode` or `corpus_generation` (outside the page record).
    StatementStamping,
    /// The statement also moves `body_generation` (outside the page record).
    StatementMovingBody,
    /// The record's own number is stored as given: the shadow seed and follower copy the primary's.
    Stored,
}

/// Whether the trigger's UPDATE branch adds one for `after` replacing `before`: a watched column of the record
/// changes, or the statement changes a watched column kept elsewhere (`counter`).
fn bumps(before: &PageRecord, after: &PageRecord, counter: Counter) -> bool {
    if before.compiled_truth != after.compiled_truth
        || before.timeline != after.timeline
        || before.frontmatter != after.frontmatter
        || before.deleted_at_us != after.deleted_at_us
        || before.title != after.title
        || before.page_type != after.page_type
        || before.page_kind != after.page_kind
        || before.content_hash != after.content_hash
    {
        return true;
    }
    match counter {
        Counter::StatementStamping => true,
        // `body_generation` is read only while `compiled_truth` is NULL on both sides.
        Counter::StatementMovingBody => {
            before.compiled_truth.is_null() && after.compiled_truth.is_null()
        }
        Counter::Statement | Counter::Stored => false,
    }
}

/// Sets `record.generation` for a write that replaces `before` (`None`: the page is new) with `record`, whatever
/// number the record carried: a caller may hold a copy read before an earlier write of the same transaction.
pub(crate) fn assign(
    read: &dyn KvRead,
    before: Option<&PageRecord>,
    record: &mut PageRecord,
    counter: Counter,
) -> Result<()> {
    if matches!(counter, Counter::Stored) {
        return Ok(());
    }
    record.generation = match before {
        None => highest(read)?.saturating_add(1),
        Some(old) if bumps(old, record, counter) => old.generation.saturating_add(1),
        Some(old) => old.generation,
    };
    Ok(())
}

/// Keeps the index in step with a page record just stored: the old row out, the new row in, only when the number
/// changed or the page is new.
pub(crate) fn reindex(
    tx: &mut dyn KvWrite,
    before: Option<&PageRecord>,
    record: &PageRecord,
) -> Result<()> {
    match before {
        Some(old) if old.generation == record.generation => return Ok(()),
        Some(old) => tx.delete(&index_key(old.generation, old.id))?,
        None => {}
    }
    tx.put(&index_key(record.generation, record.id), &[])
}

/// Removes the index row of a page record that is deleted for good.
pub(crate) fn remove(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    tx.delete(&index_key(page.generation, page.id))
}

/// `COALESCE(MAX(generation), 0)` over every page row: the last key of the index range.
pub(crate) fn highest(read: &dyn KvRead) -> Result<u64> {
    let prefix = prefix();
    let mut highest = 0;
    let mut bad = false;
    scan_prefix(read, &prefix, true, &mut |key, _| {
        match key.get(prefix.len()..prefix.len() + 8).and_then(keys::be8) {
            Some(generation) => highest = generation,
            None => bad = true,
        }
        false
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "a page generation index key is malformed",
        ));
    }
    Ok(highest)
}

/// Calls `f(generation, page id)` for each index row with a generation of `first` or more, in generation order and then
/// id order, until it returns false or fails. The rows are read a few at a time, so `f` may read the store and a stop
/// leaves the later rows unread.
pub(crate) fn for_each_from(
    read: &dyn KvRead,
    first: u64,
    f: &mut dyn FnMut(u64, u64) -> Result<bool>,
) -> Result<()> {
    let prefix = prefix();
    let mut from = prefix.clone();
    from.extend_from_slice(&first.to_be_bytes());
    for_each_prefix_paged_from(read, &prefix, &from, 8, &mut |key, _| {
        let tail = &key[prefix.len()..];
        match (
            tail.get(..8).and_then(keys::be8),
            tail.get(8..16).and_then(keys::be8),
        ) {
            (Some(generation), Some(id)) => f(generation, id),
            _ => Err(StoreError::new(
                crate::error::STORE_CORRUPT,
                "a page generation index key is malformed",
            )),
        }
    })
}

/// The format upgrade (`upgrade_format` in lib.rs): every page record gets a generation, and every page its index
/// row. No primary names the numbers, so the pages take 1, 2, 3, ... in page id order, soft-deleted pages included.
/// Records are rewritten as JSON values with the one field added, so a field this build does not know survives.
pub(crate) fn backfill(tx: &mut dyn KvWrite) -> Result<()> {
    #[derive(serde::Deserialize)]
    struct Head {
        id: u64,
    }
    let mut pages: Vec<(u64, Vec<u8>)> = Vec::new();
    let mut failure = None;
    scan_prefix(&*tx, &[keys::PAGE], false, &mut |key, value| {
        match serde_json::from_slice::<Head>(value) {
            Ok(head) => pages.push((head.id, key.to_vec())),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    pages.sort_unstable();
    for (generation, (id, key)) in (1u64..).zip(pages) {
        let Some(mut record) = get_json::<serde_json::Value>(&*tx, &key)? else {
            continue;
        };
        if let Some(fields) = record.as_object_mut() {
            fields.insert("generation".into(), generation.into());
        }
        put_json(tx, &key, &record)?;
        tx.put(&index_key(generation, id), &[])?;
    }
    Ok(())
}
