//! The keyword index write handle: [`IndexingWriter`] wraps every `Store::write` handle, so any
//! write path, present or future, keeps the keyword index in step with the records it writes, in
//! the same statement (docs/plans/rust-keyword-index.md, D1a).
//!
//! The wrapper is transparent. Reads, puts and deletes go to the inner handle unchanged, and the
//! special primitives (`allocate`, `raise_counter`, `add_i64`, `counter_below`) are forwarded, so
//! the inner handle's own forms stay in force (`OccTxn`'s conflict-free counters, the bound
//! statement's sequence handling). The `KvWrite` defaults would turn each of them into a read and
//! a put, which conflicts under concurrent writers.
//!
//! While the index is on (its state record `R 0x00` exists), the wrapper records which documents
//! a write touched, from the families of the keys it puts or deletes:
//!
//! - `K page_id chunk_index`: the chunk.
//! - `P source NUL slug`: the page as stored before the statement's first write of that key (its
//!   preimage, read before the write) and the page as stored at the end of the statement. The
//!   preimage keeps the old id, source and slug of a renamed or hard-deleted page.
//! - `M page_search_timeline/<page id>` (the sealed search timeline), `b 0x05 page_id` (the
//!   segmented lead state) and `E page_id ...` (timeline entries): the page, whose keyword vector
//!   reads them.
//!
//! Every other key is ignored, so the member-access flag writes (`C access.restrictions_present`,
//! `M access_flag_scan`) and the index's own postings never mark a document. [`IndexingWriter::flush`]
//! runs at the end of the statement, before it is kept: before the OCC commit, or inside the bound
//! transaction's statement, so a flush error fails the statement and its writes and postings go
//! together. `Store::write` makes a fresh wrapper for each OCC attempt and each bound statement.
//!
//! The flush rebuilds the postings of each touched document (`index.rs`) through the inner handle,
//! so the postings never mark a document themselves. While the index is off the wrapper reads
//! nothing and tracks nothing.

use crate::error::{INVALID_STATE, Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

/// The documents one statement touched while the index was on.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Touched {
    /// Chunks whose `K` record was put or deleted: `(page_id, chunk_index)`.
    pub chunks: BTreeSet<(u64, u32)>,
    /// Pages whose keyword vector inputs may have changed. After [`IndexingWriter::flush`]
    /// resolves the page records, it also holds the ids of every `page_records` entry, before and
    /// after.
    pub pages: BTreeSet<u64>,
    /// Every `P` key put or deleted, with the record stored before the statement's first write of
    /// that key (`None`: there was none).
    pub page_records: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
}

impl Touched {
    fn is_empty(&self) -> bool {
        self.chunks.is_empty() && self.pages.is_empty() && self.page_records.is_empty()
    }
}

/// The `Store::write` handle that tracks keyword index inputs (see the module docs).
pub(crate) struct IndexingWriter<'a> {
    inner: &'a mut dyn KvWrite,
    /// Whether the index is on, read from the state record at the first tracked write.
    enabled: Option<bool>,
    touched: Touched,
}

/// The id of a stored page record. Only the id is read.
#[derive(Deserialize)]
struct PageId {
    id: u64,
}

impl<'a> IndexingWriter<'a> {
    pub(crate) fn new(inner: &'a mut dyn KvWrite) -> Self {
        IndexingWriter {
            inner,
            enabled: None,
            touched: Touched::default(),
        }
    }

    fn enabled(&mut self) -> Result<bool> {
        if let Some(on) = self.enabled {
            return Ok(on);
        }
        let on = self.inner.get(&keys::keyword_index_state())?.is_some();
        self.enabled = Some(on);
        Ok(on)
    }

    /// Records what a put or delete of `key` touches. Runs before the write, so a `P` key's
    /// preimage is the record as stored before it.
    fn track(&mut self, key: &[u8]) -> Result<()> {
        let Some(family) = family_of(key) else {
            return Ok(());
        };
        if !self.enabled()? {
            return Ok(());
        }
        match family {
            Family::Chunk(page_id, index) => {
                self.touched.chunks.insert((page_id, index));
            }
            Family::PageInput(page_id) => {
                self.touched.pages.insert(page_id);
            }
            Family::PageRecord => {
                if !self.touched.page_records.contains_key(key) {
                    let preimage = self.inner.get(key)?;
                    self.touched.page_records.insert(key.to_vec(), preimage);
                }
            }
        }
        Ok(())
    }

    /// The touched set with every page record resolved to its ids, before and after; `None`
    /// when the index is off or nothing was touched.
    pub(crate) fn resolve(&mut self) -> Result<Option<Touched>> {
        if self.enabled != Some(true) || self.touched.is_empty() {
            return Ok(None);
        }
        let mut touched = std::mem::take(&mut self.touched);
        for (key, preimage) in &touched.page_records {
            for record in [preimage.clone(), self.inner.get(key)?]
                .into_iter()
                .flatten()
            {
                touched.pages.insert(page_id_of(&record)?);
            }
        }
        Ok(Some(touched))
    }

    /// Ends the statement's index work (see the module docs): rebuilds the postings of every
    /// touched chunk and page from the records as the statement leaves them.
    pub(crate) fn flush(mut self) -> Result<()> {
        let Some(touched) = self.resolve()? else {
            return Ok(());
        };
        #[cfg(test)]
        tests::FLUSHED.with(|flushed| flushed.borrow_mut().push(touched.clone()));
        for &(page_id, index) in &touched.chunks {
            super::index::reindex_chunk(self.inner, page_id, index)?;
        }
        for &page_id in &touched.pages {
            super::index::reindex_page(self.inner, page_id)?;
        }
        Ok(())
    }
}

/// The key families the wrapper tracks.
enum Family {
    Chunk(u64, u32),
    PageRecord,
    PageInput(u64),
}

fn family_of(key: &[u8]) -> Option<Family> {
    match *key.first()? {
        keys::CHUNK if key.len() == 13 => Some(Family::Chunk(
            keys::be8(&key[1..9])?,
            keys::be4(&key[9..13])?,
        )),
        keys::PAGE => Some(Family::PageRecord),
        keys::TIMELINE if key.len() >= 9 => Some(Family::PageInput(keys::be8(&key[1..9])?)),
        keys::PAGE_BODY if key.len() == 10 && key[1] == crate::page_body::BODY => {
            Some(Family::PageInput(keys::be8(&key[2..10])?))
        }
        keys::META => {
            let rest = key[1..].strip_prefix(crate::pages::SEARCH_TIMELINE.as_bytes())?;
            let digits = rest.strip_prefix(b"/")?;
            let id = std::str::from_utf8(digits).ok()?.parse().ok()?;
            Some(Family::PageInput(id))
        }
        _ => None,
    }
}

fn page_id_of(record: &[u8]) -> Result<u64> {
    serde_json::from_slice::<PageId>(record)
        .map(|p| p.id)
        .map_err(StoreError::from)
}

impl KvRead for IndexingWriter<'_> {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.inner.get(key)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        self.inner.scan(start, end, reverse, f)
    }
}

impl KvWrite for IndexingWriter<'_> {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        self.track(key)?;
        self.inner.put(key, value)
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        self.track(key)?;
        self.inner.delete(key)
    }

    fn commit(self: Box<Self>) -> Result<u64> {
        Err(StoreError::new(
            INVALID_STATE,
            "a store write handle commits with its write, not on its own",
        ))
    }

    fn allocate(&mut self, key: &[u8], count: u64) -> Result<u64> {
        self.inner.allocate(key, count)
    }

    fn raise_counter(&mut self, key: &[u8], value: u64) -> Result<()> {
        self.inner.raise_counter(key, value)
    }

    fn add_i64(&mut self, key: &[u8], delta: i64) -> Result<()> {
        self.inner.add_i64(key, delta)
    }

    fn counter_below(&mut self, key: &[u8], cap: i64) -> Result<Option<i64>> {
        self.inner.counter_below(key, cap)
    }
}

#[cfg(test)]
pub(crate) mod tests;
