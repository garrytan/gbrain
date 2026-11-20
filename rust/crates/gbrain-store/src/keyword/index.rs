//! The keyword index: postings that narrow a keyword search to the documents its query can match
//! (docs/plans/rust-keyword-index.md, D2a and D3a).
//!
//! Records, all under `keys::TRIGRAM` (`R`), numbers big-endian:
//!
//! - `R 0x00`: the index state ([`IndexState`], JSON). While it exists every `Store::write`
//!   keeps the postings in step (`index_writer.rs`); only a complete state of this
//!   [`INDEX_VERSION`] serves queries.
//! - `R 0x01 len(2) lexeme page_id chunk_index`: a chunk vector's entry for one lexeme. The value
//!   is the entry's `WordEntryPos` list, two bytes each (empty: a lexeme without positions).
//! - `R 0x02 len(2) lexeme page_id`: the same for the page vector (`titles.rs`).
//! - `R 0x03 len(2) trigram page_id`: empty; one raw pg_trgm trigram of the page's title
//!   (`trgm.rs`, CRC-compacted for multibyte characters), for `findByTitleFuzzy`. Soft-deleted
//!   pages keep theirs, as the unscoped fuzzy read reads them.
//! - `R 0x04 len(2) basename page_id`: empty; the page's slug basename (the handle arm).
//! - `R 0x05 page_id chunk_index` and `R 0x06 page_id`: forward records, the postings the document
//!   owns as `kind(1) len(2) text` entries, so a reindex deletes exactly the postings it no longer
//!   needs, whatever changed.
//!
//! The postings hold the output of the same `chunk_vector` and page vector code the scan uses,
//! so no second tokenizer exists. A vector past the tsvector size cap has no postings: it matches
//! nothing, as in the scan.
//!
//! A query reads the postings of every lexeme of every query it uses ([`Postings`]), takes its
//! candidates from the match query's tree ([`Postings::candidates`]) and gives each candidate a
//! sparse vector of those lexemes ([`Postings::sparse`]). `ts_matches`, `ts_rank` and
//! `ts_rank_cd` read only the query's lexemes, so on a sparse vector they return what they return
//! on the full vector. A tree that can match without a positive lexeme (a NOT, an OR with an
//! unbounded side) has no candidate bound; the member scans.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::filters::readable_chunk_vector;
use super::titles::readable_page_vector;
use super::trgm::trigram_bytes;
use super::tsearch::{Op, QItem, TsEntry, TsQuery, TsVector};
use crate::chunks::ChunkRecord;
use crate::error::Result;
use crate::get_json;
use crate::keys::{self, KW_BASENAME, KW_CHUNK_POSTING, KW_PAGE_POSTING, KW_TITLE_TRIGRAM};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::read_page_by_id;

/// The postings layout this build reads and writes.
pub(crate) const INDEX_VERSION: u32 = 1;

/// The `R 0x00` record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct IndexState {
    pub version: u32,
    /// Every document has its postings; queries may use them.
    pub complete: bool,
    /// The build's next page id (`index_build.rs`); `None` once complete.
    #[serde(default)]
    pub cursor: Option<u64>,
}

pub(crate) fn read_state(read: &dyn KvRead) -> Result<Option<IndexState>> {
    get_json(read, &keys::keyword_index_state())
}

/// `GBRAIN_RUST_KEYWORD_SCAN=1` forces every keyword member to scan (the parity suite's second
/// run, and the bench's correctness mode).
fn scan_forced() -> bool {
    #[cfg(test)]
    if tests::FORCE_SCAN.with(|f| f.get()) {
        return true;
    }
    std::env::var_os("GBRAIN_RUST_KEYWORD_SCAN").is_some_and(|v| v == "1")
}

/// Whether the postings serve the read: the state in this snapshot is complete and of this
/// version, and the scan is not forced.
pub(crate) fn serves(read: &dyn KvRead) -> Result<bool> {
    if scan_forced() {
        return Ok(false);
    }
    Ok(read_state(read)?.is_some_and(|s| s.complete && s.version == INDEX_VERSION))
}

/// One posting a document owns: its kind byte, its text and its value.
struct Posting {
    kind: u8,
    term: Vec<u8>,
    value: Vec<u8>,
}

fn encode_positions(pos: &[u16]) -> Vec<u8> {
    pos.iter().flat_map(|p| p.to_be_bytes()).collect()
}

fn decode_positions(value: &[u8]) -> Vec<u16> {
    value
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| u16::from_be_bytes(*b))
        .collect()
}

fn vector_postings(kind: u8, vector: &TsVector) -> Vec<Posting> {
    vector
        .entries
        .iter()
        .map(|e| Posting {
            kind,
            term: e.lexeme.as_bytes().to_vec(),
            value: encode_positions(&e.pos),
        })
        .collect()
}

fn encode_forward(postings: &[Posting]) -> Vec<u8> {
    let mut out = Vec::new();
    for p in postings {
        out.push(p.kind);
        out.extend_from_slice(&(p.term.len() as u16).to_be_bytes());
        out.extend_from_slice(&p.term);
    }
    out
}

fn decode_forward(bytes: &[u8]) -> Vec<(u8, Vec<u8>)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at + 3 <= bytes.len() {
        let kind = bytes[at];
        let len = usize::from(u16::from_be_bytes([bytes[at + 1], bytes[at + 2]]));
        let end = (at + 3 + len).min(bytes.len());
        out.push((kind, bytes[at + 3..end].to_vec()));
        at = end;
    }
    out
}

fn posting_key(kind: u8, term: &[u8], doc: &[u8]) -> Vec<u8> {
    let mut key = keys::keyword_term_prefix(kind, term);
    key.extend_from_slice(doc);
    key
}

/// Makes the document's postings `new`: deletes the ones its forward record lists and `new` does
/// not, puts the new or changed ones and rewrites the forward record.
fn replace_postings(
    w: &mut dyn KvWrite,
    forward: &[u8],
    doc: &[u8],
    new: Vec<Posting>,
) -> Result<()> {
    let old: BTreeSet<(u8, Vec<u8>)> = match w.get(forward)? {
        Some(bytes) => decode_forward(&bytes).into_iter().collect(),
        None => BTreeSet::new(),
    };
    let wanted: BTreeSet<(u8, &[u8])> = new.iter().map(|p| (p.kind, &p.term[..])).collect();
    for (kind, term) in &old {
        if !wanted.contains(&(*kind, &term[..])) {
            w.delete(&posting_key(*kind, term, doc))?;
        }
    }
    for p in &new {
        let key = posting_key(p.kind, &p.term, doc);
        if old.contains(&(p.kind, p.term.clone())) && w.get(&key)?.as_deref() == Some(&p.value[..])
        {
            continue;
        }
        w.put(&key, &p.value)?;
    }
    if new.is_empty() {
        if !old.is_empty() {
            w.delete(forward)?;
        }
    } else {
        let encoded = encode_forward(&new);
        if w.get(forward)?.as_deref() != Some(&encoded[..]) {
            w.put(forward, &encoded)?;
        }
    }
    Ok(())
}

fn chunk_doc(page_id: u64, index: u32) -> [u8; 12] {
    let mut doc = [0u8; 12];
    doc[..8].copy_from_slice(&page_id.to_be_bytes());
    doc[8..].copy_from_slice(&index.to_be_bytes());
    doc
}

/// The postings chunk `(page_id, index)` owns, from its record as `read` holds it.
fn chunk_postings(read: &dyn KvRead, page_id: u64, index: u32) -> Result<Vec<Posting>> {
    let record: Option<ChunkRecord> = get_json(read, &keys::chunk(page_id, index))?;
    Ok(match record.as_ref().and_then(readable_chunk_vector) {
        Some(vector) => vector_postings(KW_CHUNK_POSTING, &vector),
        None => Vec::new(),
    })
}

/// Rebuilds the postings of chunk `(page_id, index)` from its record as `w` holds it.
pub(crate) fn reindex_chunk(w: &mut dyn KvWrite, page_id: u64, index: u32) -> Result<()> {
    let postings = chunk_postings(&*w, page_id, index)?;
    replace_postings(
        w,
        &keys::chunk_forward(page_id, index),
        &chunk_doc(page_id, index),
        postings,
    )
}

/// The slug's last `/` part, the text a slug handle names.
pub(crate) fn basename(slug: &str) -> &str {
    slug.rsplit('/').next().unwrap_or(slug)
}

/// The postings page `page_id` owns (its vector lexemes, its title trigrams and its basename),
/// from the page as `read` holds it.
fn page_postings(read: &dyn KvRead, page_id: u64) -> Result<Vec<Posting>> {
    let mut postings = Vec::new();
    if let Some(page) = read_page_by_id(read, page_id)? {
        if let Some(vector) = readable_page_vector(read, &page)? {
            postings = vector_postings(KW_PAGE_POSTING, &vector);
        }
        postings.extend(trigram_bytes(&page.title).into_iter().map(|t| Posting {
            kind: KW_TITLE_TRIGRAM,
            term: t.to_vec(),
            value: Vec::new(),
        }));
        let base = basename(&page.slug);
        if base.len() <= usize::from(u16::MAX) {
            postings.push(Posting {
                kind: KW_BASENAME,
                term: base.as_bytes().to_vec(),
                value: Vec::new(),
            });
        }
    }
    Ok(postings)
}

/// Rebuilds the postings of page `page_id` from the page as `w` holds it.
pub(crate) fn reindex_page(w: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    let postings = page_postings(&*w, page_id)?;
    replace_postings(
        w,
        &keys::page_forward(page_id),
        &page_id.to_be_bytes(),
        postings,
    )
}

/// The chunk indexes page `page_id` has (`K page_id ...`), ascending.
pub(crate) fn chunk_indexes(read: &dyn KvRead, page_id: u64) -> Result<Vec<u32>> {
    let prefix = keys::chunk_prefix(page_id);
    let mut indexes = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        if let Some(i) = keys::be4(&k[prefix.len()..]) {
            indexes.push(i);
        }
        true
    })?;
    Ok(indexes)
}

/// Rebuilds every posting of page `page_id` and its chunks (the build's unit of work).
pub(crate) fn reindex_page_and_chunks(w: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    for index in chunk_indexes(&*w, page_id)? {
        reindex_chunk(w, page_id, index)?;
    }
    reindex_page(w, page_id)
}

/// The records a document's postings are stored as, its forward record last; empty when it has
/// none.
fn stored_records(forward: Vec<u8>, doc: &[u8], postings: &[Posting]) -> Vec<(Vec<u8>, Vec<u8>)> {
    if postings.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<(Vec<u8>, Vec<u8>)> = postings
        .iter()
        .map(|p| (posting_key(p.kind, &p.term, doc), p.value.clone()))
        .collect();
    out.push((forward, encode_forward(postings)));
    out
}

/// The records page `page_id` and its chunks should hold, from the page as `read` holds it.
pub(crate) fn expected_records(read: &dyn KvRead, page_id: u64) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
    let mut out = Vec::new();
    for index in chunk_indexes(read, page_id)? {
        let postings = chunk_postings(read, page_id, index)?;
        out.extend(stored_records(
            keys::chunk_forward(page_id, index),
            &chunk_doc(page_id, index),
            &postings,
        ));
    }
    let postings = page_postings(read, page_id)?;
    out.extend(stored_records(
        keys::page_forward(page_id),
        &page_id.to_be_bytes(),
        &postings,
    ));
    Ok(out)
}

/// A document: `(page_id, chunk_index)`; a page document has chunk index 0.
pub(crate) type Doc = (u64, u32);

fn doc_of(suffix: &[u8]) -> Option<Doc> {
    match suffix.len() {
        12 => Some((keys::be8(&suffix[..8])?, keys::be4(&suffix[8..])?)),
        8 => Some((keys::be8(suffix)?, 0)),
        _ => None,
    }
}

/// The page ids whose slug basename is one of `handles`, ascending; `None` when a handle is too
/// long to have a posting (the member scans).
pub(crate) fn basename_pages(
    read: &dyn KvRead,
    handles: &[String],
) -> Result<Option<BTreeSet<u64>>> {
    let mut out = BTreeSet::new();
    for handle in handles {
        if handle.len() > usize::from(u16::MAX) {
            return Ok(None);
        }
        let prefix = keys::keyword_term_prefix(KW_BASENAME, handle.as_bytes());
        scan_prefix(read, &prefix, false, &mut |k, _| {
            if let Some((page, _)) = doc_of(&k[prefix.len()..]) {
                out.insert(page);
            }
            true
        })?;
    }
    Ok(Some(out))
}

/// The page ids, ascending, whose title shares at least `need` of `trigrams` (each counted once;
/// `trigrams` sorted and unique).
pub(crate) fn title_trigram_pages(
    read: &dyn KvRead,
    trigrams: &[[u8; 3]],
    need: usize,
) -> Result<Vec<u64>> {
    let mut shared: BTreeMap<u64, usize> = BTreeMap::new();
    for t in trigrams {
        let prefix = keys::keyword_term_prefix(KW_TITLE_TRIGRAM, t);
        scan_prefix(read, &prefix, false, &mut |k, _| {
            if let Some((page, _)) = doc_of(&k[prefix.len()..]) {
                *shared.entry(page).or_default() += 1;
            }
            true
        })?;
    }
    Ok(shared
        .into_iter()
        .filter(|(_, c)| *c >= need)
        .map(|(page, _)| page)
        .collect())
}

/// The value lexemes of `q`.
fn query_lexemes(q: &TsQuery) -> impl Iterator<Item = &str> {
    q.items.iter().filter_map(|i| match i {
        QItem::Val(v) => Some(v.as_str()),
        _ => None,
    })
}

/// The postings of every lexeme of a set of queries, for one document kind.
pub(crate) struct Postings {
    /// Lexeme to its documents, ascending, with their stored positions.
    lists: BTreeMap<String, Vec<(Doc, Vec<u16>)>>,
}

impl Postings {
    /// Reads the postings (`kind`: `KW_CHUNK_POSTING` or `KW_PAGE_POSTING`) of every lexeme of
    /// `queries`.
    pub(crate) fn read(read: &dyn KvRead, kind: u8, queries: &[&TsQuery]) -> Result<Self> {
        let words: BTreeSet<&str> = queries.iter().flat_map(|q| query_lexemes(q)).collect();
        let mut lists = BTreeMap::new();
        for word in words {
            let prefix = keys::keyword_term_prefix(kind, word.as_bytes());
            let mut list = Vec::new();
            scan_prefix(read, &prefix, false, &mut |k, v| {
                if let Some(doc) = doc_of(&k[prefix.len()..]) {
                    list.push((doc, decode_positions(v)));
                }
                true
            })?;
            lists.insert(word.to_owned(), list);
        }
        Ok(Postings { lists })
    }

    fn docs(&self, word: &str) -> Vec<Doc> {
        self.lists
            .get(word)
            .map_or_else(Vec::new, |l| l.iter().map(|(d, _)| *d).collect())
    }

    /// The documents `q` can match, ascending: a superset of its matches. `None` when the tree
    /// can match a document that holds none of its positive lexemes (the member scans). An
    /// empty query matches nothing.
    pub(crate) fn candidates(&self, q: &TsQuery) -> Option<Vec<Doc>> {
        if q.items.is_empty() {
            return Some(Vec::new());
        }
        // Prefix order puts an operator before its right operand, then its left; walking from
        // the end leaves the left operand under the right one on the stack.
        let mut stack: Vec<Option<Vec<Doc>>> = Vec::new();
        for item in q.items.iter().rev() {
            let bound = match item {
                QItem::Val(word) => Some(self.docs(word)),
                QItem::Stop => None,
                QItem::Opr { op: Op::Not, .. } => {
                    stack.pop()?;
                    None
                }
                QItem::Opr { op, .. } => {
                    let right = stack.pop()?;
                    let left = stack.pop()?;
                    match (op, left, right) {
                        (Op::Or, Some(l), Some(r)) => Some(union(&l, &r)),
                        (Op::Or, _, _) => None,
                        (_, Some(l), Some(r)) => Some(intersect(&l, &r)),
                        (_, Some(b), None) | (_, None, Some(b)) => Some(b),
                        (_, None, None) => None,
                    }
                }
            };
            stack.push(bound);
        }
        if stack.len() == 1 { stack.pop()? } else { None }
    }

    /// The candidates of any of `queries`, ascending; `None` when one has no bound.
    pub(crate) fn candidates_of(&self, queries: &[&TsQuery]) -> Option<Vec<Doc>> {
        let mut out: Vec<Doc> = Vec::new();
        for q in queries {
            out = union(&out, &self.candidates(q)?);
        }
        Some(out)
    }

    /// `doc`'s vector restricted to the lexemes read: byte-sorted, with the stored positions.
    pub(crate) fn sparse(&self, doc: Doc) -> Arc<TsVector> {
        let mut entries = Vec::new();
        for (word, list) in &self.lists {
            if let Ok(at) = list.binary_search_by(|(d, _)| d.cmp(&doc)) {
                entries.push(TsEntry {
                    lexeme: word.clone(),
                    pos: list[at].1.clone(),
                });
            }
        }
        Arc::new(TsVector { entries })
    }
}

fn union(a: &[Doc], b: &[Doc]) -> Vec<Doc> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => {
                out.push(a[i]);
                i += 1;
            }
            std::cmp::Ordering::Greater => {
                out.push(b[j]);
                j += 1;
            }
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
    out
}

fn intersect(a: &[Doc], b: &[Doc]) -> Vec<Doc> {
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests;
