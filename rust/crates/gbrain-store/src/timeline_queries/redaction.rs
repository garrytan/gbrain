//! The timeline half of `gbrain repair secret-spans` (src/core/engine-sql/secret-spans-rows.ts): the rows a redaction of
//! one page reads and rewrites.
//!
//! - A page's rows are the entries on the page itself and the event projections that name it as their event page (the
//!   SQL's `page_id = $1 OR event_page_id = $1`), by id.
//! - The dedup rows of a redaction are every entry of every page those rows belong to: a rewritten summary or source
//!   changes the row's `(page, date, summary, source)` key, which must stay unique across them.
//! - A rewrite goes through the core timeline helper `put_entry`: the entry's `E` key stays, its `D` (dedup) key moves
//!   to the new text, and its trust tier and write receipt follow the update trigger. The event index is keyed by event
//!   page and date, which a text rewrite does not change.

use std::collections::BTreeMap;

use super::twin_move::{page_entries, projections};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::timeline::{TimelineRecord, put_entry};

/// The entries on page `page_id` and the projections that name it as their event page, in id order.
pub(crate) fn page_and_event_entries(
    read: &dyn KvRead,
    page_id: u64,
) -> Result<Vec<TimelineRecord>> {
    let mut by_id: BTreeMap<u64, TimelineRecord> = BTreeMap::new();
    for entry in page_entries(read, page_id)? {
        by_id.insert(entry.id, entry);
    }
    for entry in projections(read, page_id)? {
        by_id.insert(entry.id, entry);
    }
    Ok(by_id.into_values().collect())
}

/// Every entry of the pages the rows of `page_id` belong to, in id order.
pub(crate) fn dedup_rows(read: &dyn KvRead, page_id: u64) -> Result<Vec<TimelineRecord>> {
    let mut pages: Vec<u64> = page_and_event_entries(read, page_id)?
        .iter()
        .map(|entry| entry.page_id)
        .collect();
    pages.sort_unstable();
    pages.dedup();
    let mut by_id: BTreeMap<u64, TimelineRecord> = BTreeMap::new();
    for page in pages {
        for entry in page_entries(read, page)? {
            by_id.insert(entry.id, entry);
        }
    }
    Ok(by_id.into_values().collect())
}

/// `UPDATE timeline_entries SET <column> = text WHERE id = id` for a row of page `page_id`'s redaction: no row with the
/// id among the page's rows changes nothing. A new key another entry holds refuses `constraint_violation`.
pub(crate) fn rewrite_column(
    tx: &mut dyn KvWrite,
    page_id: u64,
    id: u64,
    column: &str,
    text: &str,
) -> Result<()> {
    let Some(old) = page_and_event_entries(&*tx, page_id)?
        .into_iter()
        .find(|entry| entry.id == id)
    else {
        return Ok(());
    };
    let mut new = old.clone();
    match column {
        "summary" => new.summary = text.to_owned(),
        "detail" => new.detail = text.to_owned(),
        "source" => new.source = text.to_owned(),
        other => {
            return Err(StoreError::invalid(format!(
                "setRedactedRowText: timeline_entries.{other} is not a column a redaction rewrites"
            )));
        }
    }
    put_entry(tx, Some(&old), &new)
}
