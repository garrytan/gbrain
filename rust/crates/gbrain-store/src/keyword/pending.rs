//! Pending keyword postings (store format 13): a write keeps one record per document it changed
//! instead of rewriting that document's postings, and a later write folds the pending records into
//! the postings in one go.
//!
//! Why: the postings are keyed by text (`R kind len(2) term doc`), so one page write used to put or
//! delete a few hundred keys spread over the whole record file, and the copy-on-write tree then
//! rewrote one leaf per key before its one disk sync. A pending record is keyed by document
//! (`R 0x07 page_id chunk_index`, `R 0x08 page_id`), so a write puts a few neighbouring keys.
//!
//! Records:
//!
//! - `R 0x07 page_id chunk_index` and `R 0x08 page_id`: the document's whole posting set as the
//!   last write left it, as `kind(1) len(2) term vlen(2) value` entries. Only a write that adds
//!   terms or changes positions stages one: a write that removes a term the stored postings hold
//!   writes the postings at once, so a purge leaves no removed text in a live record. While it exists, the document's postings and forward record are those of the last
//!   fold and every reader takes the pending set instead.
//! - `R 0x09`: how many pending records exist (an `add_i64` counter, so concurrent writers that
//!   stage different documents never conflict on it).
//!
//! The effective postings of a document are its pending set when it has one, else its postings,
//! so every reader returns what it returned when each write rewrote the postings at once: the
//! readers here ([`Overlay`]) remove a pending document from the posting lists and add its pending
//! entries. A write's flush stages each document it touched ([`stage`]); when the counter reaches
//! [`FOLD_AT`] the same write folds every pending record ([`fold_all`]). A rebuild of a document
//! (`index_build.rs`) writes its postings directly and drops its pending record.

use std::collections::BTreeMap;

use super::index::{Doc, Posting, doc_of, folded_postings, folded_terms, replace_postings};
use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::keys::{self, KW_CHUNK_PENDING, KW_CHUNK_POSTING, KW_PAGE_PENDING};
use crate::kv::{KvRead, KvWrite, read_i64, scan_prefix};

/// The pending count at which a write folds every pending record.
pub(crate) const FOLD_AT: i64 = 64;

/// The most postings a document stages; a larger document writes its postings at once, so every
/// read decodes at most `FOLD_AT` x this many pending postings.
pub(crate) const STAGE_MAX_POSTINGS: usize = 512;

#[cfg(test)]
thread_local! {
    /// Tests set the fold threshold (1: every write folds, as before format 13).
    pub(crate) static FOLD_AT_OVERRIDE: std::cell::Cell<Option<i64>> =
        const { std::cell::Cell::new(None) };
}

fn fold_at() -> i64 {
    #[cfg(test)]
    if let Some(n) = FOLD_AT_OVERRIDE.with(|f| f.get()) {
        return n;
    }
    FOLD_AT
}

pub(crate) fn encode(postings: &[Posting]) -> Vec<u8> {
    let mut out = Vec::new();
    for p in postings {
        out.push(p.kind);
        out.extend_from_slice(&(p.term.len() as u16).to_be_bytes());
        out.extend_from_slice(&p.term);
        out.extend_from_slice(&(p.value.len() as u16).to_be_bytes());
        out.extend_from_slice(&p.value);
    }
    out
}

fn take<'a>(bytes: &'a [u8], at: &mut usize, n: usize) -> Result<&'a [u8]> {
    let end = at
        .checked_add(n)
        .filter(|e| *e <= bytes.len())
        .ok_or_else(|| StoreError::new(STORE_CORRUPT, "bad pending keyword record"))?;
    let s = &bytes[*at..end];
    *at = end;
    Ok(s)
}

fn take_u16(bytes: &[u8], at: &mut usize) -> Result<usize> {
    let b = take(bytes, at, 2)?;
    Ok(usize::from(u16::from_be_bytes([b[0], b[1]])))
}

pub(crate) fn decode(bytes: &[u8]) -> Result<Vec<Posting>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let kind = take(bytes, &mut at, 1)?[0];
        let len = take_u16(bytes, &mut at)?;
        let term = take(bytes, &mut at, len)?.to_vec();
        let vlen = take_u16(bytes, &mut at)?;
        let value = take(bytes, &mut at, vlen)?.to_vec();
        out.push(Posting { kind, term, value });
    }
    Ok(out)
}

/// Makes `new` the effective postings of the document: writes its pending record unless the
/// effective postings already are `new`. A document that loses a term its stored postings hold
/// (an edit, a purge, a delete) has its postings written at once instead and its pending record
/// dropped, so a purge leaves none of the removed text in a live record.
pub(super) fn stage(
    w: &mut dyn KvWrite,
    forward: &[u8],
    pending: &[u8],
    doc: &[u8],
    new: Vec<Posting>,
) -> Result<()> {
    // A document that loses a term (an edit, a purge, a delete) has its postings written at once,
    // so no removed text stays in a live record until the next fold; so has a document with more
    // than `STAGE_MAX_POSTINGS` postings, which bounds what a read decodes. Only additions and
    // changed positions of a document that size are staged.
    let folded = folded_terms(&*w, forward)?;
    let kept: std::collections::BTreeSet<(u8, &[u8])> =
        new.iter().map(|p| (p.kind, &p.term[..])).collect();
    if new.is_empty()
        || new.len() > STAGE_MAX_POSTINGS
        || folded.iter().any(|(k, t)| !kept.contains(&(*k, &t[..])))
    {
        replace_postings(w, forward, doc, new)?;
        return drop_pending(w, pending);
    }
    match w.get(pending)? {
        Some(bytes) => {
            if decode(&bytes)? != new {
                w.put(pending, &encode(&new))?;
            }
        }
        None => {
            if folded_postings(&*w, forward, doc)? != new {
                w.put(pending, &encode(&new))?;
                w.add_i64(&keys::keyword_pending_count(), 1)?;
            }
        }
    }
    Ok(())
}

/// Drops the document's pending record, if any (its postings were just written directly). The
/// last pending record takes the count with it, so a brain with nothing pending keeps no count
/// record (`counter_below` re-checks at commit under concurrent writers).
pub(super) fn drop_pending(w: &mut dyn KvWrite, pending: &[u8]) -> Result<()> {
    if w.get(pending)?.is_some() {
        w.delete(pending)?;
        let count = keys::keyword_pending_count();
        if w.counter_below(&count, 2)?.is_none() {
            w.delete(&count)?;
        } else {
            w.add_i64(&count, -1)?;
        }
    }
    Ok(())
}

/// Folds every pending record when the counter has reached the threshold.
pub(super) fn maybe_fold(w: &mut dyn KvWrite) -> Result<()> {
    if w.counter_below(&keys::keyword_pending_count(), fold_at())?
        .is_some()
    {
        fold_all(w)?;
    }
    Ok(())
}

/// Writes every pending set into the postings and forward records, and deletes the pending
/// records and the count.
pub(crate) fn fold_all(w: &mut dyn KvWrite) -> Result<()> {
    let mut staged: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for kind in [KW_CHUNK_PENDING, KW_PAGE_PENDING] {
        scan_prefix(&*w, &[keys::TRIGRAM, kind], false, &mut |k, v| {
            staged.push((k.to_vec(), v.to_vec()));
            true
        })?;
    }
    if staged.is_empty() {
        return Ok(());
    }
    for (key, value) in staged {
        let suffix = &key[2..];
        let (forward, doc): (Vec<u8>, Vec<u8>) = match (key[1], suffix.len()) {
            (KW_CHUNK_PENDING, 12) => {
                let mut f = vec![keys::TRIGRAM, keys::KW_CHUNK_FORWARD];
                f.extend_from_slice(suffix);
                (f, suffix.to_vec())
            }
            (KW_PAGE_PENDING, 8) => {
                let mut f = vec![keys::TRIGRAM, keys::KW_PAGE_FORWARD];
                f.extend_from_slice(suffix);
                (f, suffix.to_vec())
            }
            _ => {
                return Err(StoreError::new(
                    STORE_CORRUPT,
                    "bad pending keyword record key",
                ));
            }
        };
        replace_postings(w, &forward, &doc, decode(&value)?)?;
        w.delete(&key)?;
    }
    // The scan above read every pending record, so a concurrent write that stages one conflicts
    // with this fold: nothing is pending once it commits, and the count goes with the records.
    w.delete(&keys::keyword_pending_count())
}

/// The pending sets of one document family, by document, for readers.
pub(crate) struct Overlay {
    docs: BTreeMap<Doc, Vec<Posting>>,
}

impl Overlay {
    /// The pending sets of chunks (`chunks`) or of pages.
    pub(crate) fn read(read: &dyn KvRead, chunks: bool) -> Result<Self> {
        let kind = if chunks {
            KW_CHUNK_PENDING
        } else {
            KW_PAGE_PENDING
        };
        let mut raw: Vec<(Doc, Vec<u8>)> = Vec::new();
        scan_prefix(read, &[keys::TRIGRAM, kind], false, &mut |k, v| {
            if let Some(doc) = doc_of(&k[2..]) {
                raw.push((doc, v.to_vec()));
            }
            true
        })?;
        let mut docs = BTreeMap::new();
        for (doc, bytes) in raw {
            // Sorted by kind and term, so a term lookup is a binary search, not a scan.
            let mut postings = decode(&bytes)?;
            postings.sort_by(|a, b| (a.kind, &a.term).cmp(&(b.kind, &b.term)));
            docs.insert(doc, postings);
        }
        Ok(Overlay { docs })
    }

    /// The overlay for the posting kind `kind` (`KW_CHUNK_POSTING`: chunks; else pages).
    pub(crate) fn for_kind(read: &dyn KvRead, kind: u8) -> Result<Self> {
        Self::read(read, kind == KW_CHUNK_POSTING)
    }

    /// Whether `doc` has a pending set (its stored postings are stale).
    pub(crate) fn holds(&self, doc: Doc) -> bool {
        self.docs.contains_key(&doc)
    }

    /// The pending documents with a `kind` entry for `term`, ascending, with the entry's value.
    pub(crate) fn entries<'a>(
        &'a self,
        kind: u8,
        term: &'a [u8],
    ) -> impl Iterator<Item = (Doc, &'a [u8])> + 'a {
        self.docs.iter().filter_map(move |(doc, postings)| {
            postings
                .binary_search_by(|p| (p.kind, &p.term[..]).cmp(&(kind, term)))
                .ok()
                .map(|at| (*doc, postings[at].value.as_slice()))
        })
    }

    /// The pending documents, ascending.
    pub(crate) fn docs(&self) -> Vec<Doc> {
        self.docs.keys().copied().collect()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    pub(crate) fn len(&self) -> usize {
        self.docs.len()
    }

    /// The pending set of `doc`, if any, sorted by kind and term.
    pub(crate) fn get(&self, doc: Doc) -> Option<&[Posting]> {
        self.docs.get(&doc).map(Vec::as_slice)
    }
}

/// The pending count as stored.
pub(crate) fn pending_count(read: &dyn KvRead) -> Result<i64> {
    read_i64(read, &keys::keyword_pending_count())
}

#[cfg(test)]
mod tests;
