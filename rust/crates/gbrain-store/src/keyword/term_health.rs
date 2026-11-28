//! The core term postings' doctor check and repair: the `T` half of what `gbrain doctor` reports as
//! `rust_derived_indexes` and what `gbrain doctor --fix` runs (docs/designs/RUST_ENGINE.md,
//! "Maintenance path"; rust/docs/store/keyword.md, "Doctor").
//!
//! `T term \0 page_id chunk_index` holds the term's frequency in the chunk (`u32` big-endian). The
//! chunk writes (`chunks.rs`) keep them in the same transaction as the chunk record, for a chunk
//! its page's segment view shows (`ChunkRecord::visible_at`). They have no state record: every
//! search reads them (`search.rs`), so they go wrong only when their records are damaged.
//!
//! The postings a chunk should hold are the term frequencies of its text when its page has an id
//! record (`I page_id`) and its segment view shows the chunk; no other `T` key should exist.
//! [`verify`] compares them over the first `max_pages` pages, like the keyword index's verify, and
//! counts orphans only when the walk covered every page. [`repair`] fixes them in place, with no
//! reset: page batches put each missing or changed posting, then key batches delete each posting
//! no chunk should hold. Each batch is one write transaction through a handle that refuses any
//! write outside the `T` tag, so a search during the repair reads every posting it read before
//! except the ones the repair corrects.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use super::index::chunk_indexes;
use super::index_build::{BATCH_PAGES, checked_page_ids, page_ids_from};
use super::index_health::IndexOnly;
use crate::chunks::{ChunkRecord, read_segment_view, term_frequencies};
use crate::error::Result;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{Store, get_json, keys};

/// `T` keys one orphan batch reads.
const BATCH_KEYS: usize = 4096;

/// What [`verify`] found. `orphan` counts postings no chunk should hold; it is `None` when
/// `max_pages` stopped the walk before the last page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TermPostingsReport {
    /// Pages and visible chunks checked.
    pub pages: u64,
    pub chunks: u64,
    /// Postings those chunks should hold, and of those the ones the store lacks or holds with
    /// another frequency.
    pub expected: u64,
    pub missing: u64,
    pub changed: u64,
    pub orphan: Option<u64>,
    pub ok: bool,
}

/// The term frequencies of each chunk of page `page_id` its segment view shows, by chunk index.
fn page_terms(read: &dyn KvRead, page_id: u64) -> Result<Vec<(u32, BTreeMap<String, u32>)>> {
    let generation = read_segment_view(read, page_id)?.generation;
    let mut out = Vec::new();
    for index in chunk_indexes(read, page_id)? {
        let Some(record) = get_json::<ChunkRecord>(read, &keys::chunk(page_id, index))? else {
            continue;
        };
        if record.visible_at(generation) {
            out.push((index, term_frequencies(&record.chunk_text).0));
        }
    }
    Ok(out)
}

/// Compares the stored `T` postings with the postings the chunks of the first `max_pages` pages
/// (every page when `None`) give (see the module docs).
pub(crate) fn verify(read: &dyn KvRead, max_pages: Option<u64>) -> Result<TermPostingsReport> {
    let (ids, complete_walk) = checked_page_ids(read, max_pages)?;
    let mut report = TermPostingsReport {
        pages: 0,
        chunks: 0,
        expected: 0,
        missing: 0,
        changed: 0,
        orphan: None,
        ok: false,
    };
    for id in ids {
        report.pages += 1;
        for (index, terms) in page_terms(read, id)? {
            report.chunks += 1;
            for (term, count) in terms {
                report.expected += 1;
                match read.get(&keys::posting(&term, id, index))? {
                    None => report.missing += 1,
                    Some(stored) if stored != count.to_be_bytes() => report.changed += 1,
                    Some(_) => {}
                }
            }
        }
    }
    if complete_walk {
        let mut stored = 0u64;
        scan_prefix(read, &[keys::POSTING], false, &mut |_, _| {
            stored += 1;
            true
        })?;
        report.orphan = Some(stored - (report.expected - report.missing));
    }
    report.ok = report.missing == 0 && report.changed == 0 && report.orphan.unwrap_or(0) == 0;
    Ok(report)
}

/// What [`repair`] did: its write transactions and the `T` postings it put and deleted.
pub(crate) struct TermRepair {
    pub transactions: u64,
    pub puts: u64,
    pub deletes: u64,
}

/// `(term, page_id, chunk_index)` of a `T` key; `None` for a key of no posting layout.
fn parse_posting(key: &[u8]) -> Option<(&str, u64, u32)> {
    let split = key.len().checked_sub(13)?;
    if split < 1 || key[split] != 0 {
        return None;
    }
    let term = std::str::from_utf8(&key[1..split]).ok()?;
    let page_id = keys::be8(&key[split + 1..split + 9])?;
    let index = keys::be4(&key[split + 9..])?;
    Some((term, page_id, index))
}

/// Puts the missing or changed postings of the next `pages` pages from `cursor`; returns the page
/// to start the next batch from (`None`: no page is left).
pub(super) fn put_batch(w: &mut dyn KvWrite, cursor: u64, pages: usize) -> Result<Option<u64>> {
    let pages = pages.max(1);
    let ids = page_ids_from(&*w, cursor, pages + 1)?;
    for &id in ids.iter().take(pages) {
        for (index, terms) in page_terms(&*w, id)? {
            for (term, count) in terms {
                let key = keys::posting(&term, id, index);
                let value = count.to_be_bytes();
                if w.get(&key)?.as_deref() != Some(&value[..]) {
                    w.put(&key, &value)?;
                }
            }
        }
    }
    Ok(ids.get(pages).copied())
}

/// Deletes each posting no chunk should hold among the next `limit` `T` keys from `start`;
/// returns the key to start the next batch from (`None`: no key is left).
pub(super) fn delete_batch(
    w: &mut dyn KvWrite,
    start: &[u8],
    limit: usize,
) -> Result<Option<Vec<u8>>> {
    let limit = limit.max(1);
    let mut batch: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    w.scan(start, &[keys::POSTING + 1], false, &mut |k, v| {
        batch.push((k.to_vec(), v.to_vec()));
        batch.len() <= limit
    })?;
    let next = (batch.len() > limit)
        .then(|| batch.pop().map(|(k, _)| k))
        .flatten();
    let mut chunks: HashMap<u64, HashMap<u32, BTreeMap<String, u32>>> = HashMap::new();
    for (key, value) in batch {
        let held = match parse_posting(&key) {
            Some((term, page_id, index)) => {
                let page = match chunks.entry(page_id) {
                    Entry::Occupied(entry) => entry.into_mut(),
                    Entry::Vacant(entry) => {
                        entry.insert(if w.get(&keys::page_id(page_id))?.is_some() {
                            page_terms(&*w, page_id)?.into_iter().collect()
                        } else {
                            HashMap::new()
                        })
                    }
                };
                page.get(&index)
                    .and_then(|terms| terms.get(term))
                    .is_some_and(|count| value == count.to_be_bytes())
            }
            None => false,
        };
        if !held {
            w.delete(&key)?;
        }
    }
    Ok(next)
}

/// Makes the `T` postings match the chunks (see the module docs), batch by batch through `store`'s
/// write and its OCC retry. A write that commits between two batches keeps its own postings.
pub(crate) fn repair(store: &Store) -> Result<TermRepair> {
    repair_in(store, BATCH_PAGES, BATCH_KEYS)
}

/// [`repair`] with `pages` pages a put batch and `limit` keys a delete batch.
pub(super) fn repair_in(store: &Store, pages: usize, limit: usize) -> Result<TermRepair> {
    let mut receipt = TermRepair {
        transactions: 0,
        puts: 0,
        deletes: 0,
    };
    let mut cursor = Some(0u64);
    while let Some(from) = cursor {
        let (next, puts, deletes) = store.write(|w| {
            let mut only = IndexOnly::new(w, keys::POSTING);
            let next = put_batch(&mut only, from, pages)?;
            Ok((next, only.puts, only.deletes))
        })?;
        receipt.transactions += 1;
        receipt.puts += puts;
        receipt.deletes += deletes;
        cursor = next;
    }
    let mut start = Some(vec![keys::POSTING]);
    while let Some(from) = start {
        let (next, puts, deletes) = store.write(|w| {
            let mut only = IndexOnly::new(w, keys::POSTING);
            let next = delete_batch(&mut only, &from, limit)?;
            Ok((next, only.puts, only.deletes))
        })?;
        receipt.transactions += 1;
        receipt.puts += puts;
        receipt.deletes += deletes;
        start = next;
    }
    Ok(receipt)
}

#[cfg(test)]
mod tests;
