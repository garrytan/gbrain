//! Keyed lookups (store format 9): small secondary indexes that let the members below find their
//! rows by key instead of reading every page, chunk or link record.
//!
//! | Kind | Key (after the two-byte tag `~k`) | Derived from | Read by |
//! |---|---|---|---|
//! | `0x01` | chunk id, page id, chunk index | each chunk record `K page_id index` (its `id`) | `cosinesByChunkIds`, `getEmbeddingsByChunkIds` |
//! | `0x02` | lower-cased title, NUL, page id | each page record: `title.to_lowercase()` and `pg_lower(title)`, when at most `RAW_TITLE_MAX` bytes | `findPagesByTitles`, `listPagesTitledIn` |
//! | `0x07` | h(lower-cased title), page id | the same, for a longer lower-cased title | `findPagesByTitles`, `listPagesTitledIn` |
//! | `0x08` | origin page id, the transition's record key | each link transition record (`q source NUL T ...`) with an origin page | `applyLinkTemporalRows`, `linkRelationshipKeysForOrigin` |
//! | `0x03` | page id | each page record whose text projection is not served | `readProjectionReadiness` |
//! | `0x04` | from page id, link id | each link record `L from link` with `link_type = 'supersedes'` | `hasSupersedeEdges` |
//! | `0x05` | h(source, content hash), page id | each page record with a content hash | `findDuplicatePage(s)` |
//! | `0x06` | h(source, frontmatter `id`), page id | each page record whose frontmatter `id` is not null | `findDuplicatePage(s)` |
//!
//! `h` is the first 16 bytes of the SHA-256 of the parts joined by NUL. Every value is empty. A raw
//! title entry ends in a fixed 9 bytes (NUL, page id), so its title is the bytes between the kind
//! and those 9, whatever they hold, and the entries of one title prefix sort together: the
//! substring read (`listPagesTitledIn`) walks, for each place in the query, the titles that start
//! there.
//!
//! An entry is a pure function of one record, and its key holds that record's identity (page id,
//! chunk key, link key or transition key), so no two records derive the same entry. [`KeyedWriter`] wraps every
//! `Store::write` handle (the write chain in `lib.rs`): it remembers the entries the touched
//! records derived before the statement's first write of each key and the entries their last
//! value derives, and [`KeyedWriter::flush`] deletes and puts only the difference, in the same
//! statement. A bound transaction's savepoint rollback drops the entries with the records.
//!
//! The readers treat an entry as a candidate only: they read the record it names and apply the
//! member's own test to it, then sort as before. So an entry can never add a row; the answers equal
//! the old whole-store scans as long as every record that matches has its entry, which the writer
//! keeps (and `tests` pin against [`expected_entries`]). Store format 9 builds every entry once, in
//! the format upgrade's transaction ([`rebuild`]).

use crate::error::{INVALID_STATE, Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, read_page_by_id};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub(crate) const CHUNK_ID: u8 = 0x01;
pub(crate) const TITLE: u8 = 0x02;
pub(crate) const UNSERVED: u8 = 0x03;
pub(crate) const SUPERSEDES: u8 = 0x04;
pub(crate) const CONTENT_HASH: u8 = 0x05;
pub(crate) const FRONTMATTER_ID: u8 = 0x06;
pub(crate) const LONG_TITLE: u8 = 0x07;
pub(crate) const TRANSITION_ORIGIN: u8 = 0x08;

/// The record tag of a link transition after its source in the `q` family (`link_temporal.rs`).
const TRANSITION_TAG: u8 = b'T';

/// The longest lower-cased title kept as raw bytes (`TITLE`); a longer one is kept hashed
/// (`LONG_TITLE`).
const RAW_TITLE_MAX: usize = 512;

const SUPERSEDES_TYPE: &str = "supersedes";

/// The key families whose records derive entries.
#[derive(Clone, Copy)]
enum Family {
    Page,
    Chunk {
        page_id: u64,
        index: u32,
    },
    Link {
        from: u64,
        link: u64,
    },
    /// A link transition record: `q source NUL T ...`, as `link_temporal.rs` `scan_tag` picks them.
    Transition,
}

fn family_of(key: &[u8]) -> Option<Family> {
    match *key.first()? {
        keys::PAGE => Some(Family::Page),
        keys::CHUNK if key.len() == 13 => Some(Family::Chunk {
            page_id: keys::be8(&key[1..9])?,
            index: keys::be4(&key[9..13])?,
        }),
        keys::LINK if key.len() == 17 => Some(Family::Link {
            from: keys::be8(&key[1..9])?,
            link: keys::be8(&key[9..17])?,
        }),
        keys::LINK_QUERIES if is_transition_key(key) => Some(Family::Transition),
        _ => None,
    }
}

/// Whether a `q` key is a link transition's: the byte after its first NUL (after the tag) is `T`,
/// the test `link_temporal.rs` `scan_tag` applies.
fn is_transition_key(key: &[u8]) -> bool {
    key.iter()
        .skip(1)
        .position(|b| *b == 0)
        .is_some_and(|nul| key.get(nul + 2) == Some(&TRANSITION_TAG))
}

/// `~k kind`: the start of every entry of one lookup.
fn kind_prefix(kind: u8) -> Vec<u8> {
    let mut key = keys::KEYED_INDEX.to_vec();
    key.push(kind);
    key
}

/// `~k kind ids...` for entries keyed by ids only.
fn id_entry(kind: u8, ids: &[u64]) -> Vec<u8> {
    let mut key = kind_prefix(kind);
    for id in ids {
        key.extend_from_slice(&id.to_be_bytes());
    }
    key
}

/// The 16-byte digest of `parts` joined by NUL.
fn digest(parts: &[&str]) -> [u8; 16] {
    let mut hasher = Sha256::new();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            hasher.update([0u8]);
        }
        hasher.update(part.as_bytes());
    }
    let full = hasher.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

/// `3 kind h(parts)`: the scan prefix of every entry for `parts`.
fn hashed_prefix(kind: u8, parts: &[&str]) -> Vec<u8> {
    let mut key = kind_prefix(kind);
    key.extend_from_slice(&digest(parts));
    key
}

/// `3 kind h(parts) page_id`.
fn hashed_entry(kind: u8, parts: &[&str], page_id: u64) -> Vec<u8> {
    let mut key = hashed_prefix(kind, parts);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// `3 0x02 title`: the start of every raw title entry for `title` and for titles that extend it.
fn raw_title_prefix(title: &str) -> Vec<u8> {
    let mut key = kind_prefix(TITLE);
    key.extend_from_slice(title.as_bytes());
    key
}

/// The entry of one lower-cased title of page `id`.
fn title_entry(title: &str, id: u64) -> Vec<u8> {
    if title.len() > RAW_TITLE_MAX {
        return hashed_entry(LONG_TITLE, &[title], id);
    }
    let mut key = raw_title_prefix(title);
    key.push(0);
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// The title and page id of a raw title entry.
fn raw_title_of(key: &[u8]) -> Option<(&[u8], u64)> {
    let start = keys::KEYED_INDEX.len() + 1;
    if key.len() < start + 9 || key[key.len() - 9] != 0 {
        return None;
    }
    Some((
        &key[start..key.len() - 9],
        keys::be8(&key[key.len() - 8..])?,
    ))
}

/// The entries one page record derives.
fn page_entries(page: &PageRecord, out: &mut BTreeSet<Vec<u8>>) {
    let id = page.id;
    out.insert(title_entry(&page.title.to_lowercase(), id));
    out.insert(title_entry(&crate::keyword::pg_lower(&page.title), id));
    if !crate::link_queries::retrieval_coverage::served(page) {
        out.insert(id_entry(UNSERVED, &[id]));
    }
    if let Some(hash) = &page.content_hash {
        out.insert(hashed_entry(CONTENT_HASH, &[&page.source_id, hash], id));
    }
    if let Some(fm_id) = crate::page_ops::fm_text(&page.frontmatter, "id") {
        out.insert(hashed_entry(FRONTMATTER_ID, &[&page.source_id, &fm_id], id));
    }
}

/// What a chunk record's entry needs of it.
#[derive(Deserialize)]
struct ChunkId {
    id: u64,
}

/// What a transition record's entry needs of it.
#[derive(Deserialize)]
struct TransitionOrigin {
    origin_page_id: Option<u64>,
}

/// What a link record's entry needs of it.
#[derive(Deserialize)]
struct LinkType {
    link_type: String,
}

/// The entries the record `value` stored at `key` derives (none when `value` is `None`).
fn entries_of(family: Family, key: &[u8], value: Option<&[u8]>) -> Result<BTreeSet<Vec<u8>>> {
    let mut out = BTreeSet::new();
    let Some(value) = value else {
        return Ok(out);
    };
    match family {
        Family::Page => page_entries(&serde_json::from_slice::<PageRecord>(value)?, &mut out),
        Family::Chunk { page_id, index } => {
            let id = serde_json::from_slice::<ChunkId>(value)?.id;
            let mut key = id_entry(CHUNK_ID, &[id, page_id]);
            key.extend_from_slice(&index.to_be_bytes());
            out.insert(key);
        }
        Family::Link { from, link } => {
            if serde_json::from_slice::<LinkType>(value)?.link_type == SUPERSEDES_TYPE {
                out.insert(id_entry(SUPERSEDES, &[from, link]));
            }
        }
        Family::Transition => {
            if let Some(origin) = serde_json::from_slice::<TransitionOrigin>(value)?.origin_page_id
            {
                let mut entry = id_entry(TRANSITION_ORIGIN, &[origin]);
                entry.extend_from_slice(key);
                out.insert(entry);
            }
        }
    }
    Ok(out)
}

/// One touched record: the entries it derived before the statement's first write of its key, and
/// the entries its value derives now.
struct Touch {
    before: BTreeSet<Vec<u8>>,
    after: BTreeSet<Vec<u8>>,
}

/// The `Store::write` handle that keeps the keyed index in step (see the module docs).
pub(crate) struct KeyedWriter<'a> {
    inner: &'a mut dyn KvWrite,
    touched: BTreeMap<Vec<u8>, Touch>,
}

impl<'a> KeyedWriter<'a> {
    pub(crate) fn new(inner: &'a mut dyn KvWrite) -> Self {
        KeyedWriter {
            inner,
            touched: BTreeMap::new(),
        }
    }

    /// Records what a put (`Some`) or delete (`None`) of `key` does to the index. Runs before the
    /// write, so the first touch of a key reads the record as stored before the statement.
    fn track(&mut self, key: &[u8], value: Option<&[u8]>) -> Result<()> {
        let Some(family) = family_of(key) else {
            return Ok(());
        };
        let after = entries_of(family, key, value)?;
        if let Some(touch) = self.touched.get_mut(key) {
            touch.after = after;
            return Ok(());
        }
        let before = entries_of(family, key, self.inner.get(key)?.as_deref())?;
        self.touched.insert(key.to_vec(), Touch { before, after });
        Ok(())
    }

    /// Ends the statement's index work: deletes the entries no record derives any more and puts
    /// the new ones. An entry one touched record dropped and another now derives stays as it is.
    pub(crate) fn flush(self) -> Result<()> {
        let mut removed: BTreeSet<Vec<u8>> = BTreeSet::new();
        let mut added: BTreeSet<Vec<u8>> = BTreeSet::new();
        for touch in self.touched.values() {
            removed.extend(touch.before.difference(&touch.after).cloned());
            added.extend(touch.after.difference(&touch.before).cloned());
        }
        for key in removed.difference(&added) {
            self.inner.delete(key)?;
        }
        for key in added.difference(&removed) {
            self.inner.put(key, &[])?;
        }
        Ok(())
    }
}

impl KvRead for KeyedWriter<'_> {
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

impl KvWrite for KeyedWriter<'_> {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        self.track(key, Some(value))?;
        self.inner.put(key, value)
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        self.track(key, None)?;
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

// ---------------------------------------------------------------------------------------------
// Building and checking the whole index.

/// Every entry the stored records derive: what the index must hold.
pub(crate) fn expected_entries(read: &dyn KvRead) -> Result<BTreeSet<Vec<u8>>> {
    let mut out = BTreeSet::new();
    let mut failure = None;
    for tag in [keys::PAGE, keys::CHUNK, keys::LINK, keys::LINK_QUERIES] {
        scan_prefix(read, &[tag], false, &mut |k, v| {
            if let Some(family) = family_of(k) {
                match entries_of(family, k, Some(v)) {
                    Ok(entries) => out.extend(entries),
                    Err(e) => failure = Some(e),
                }
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
    }
    Ok(out)
}

/// Every entry the index holds.
pub(crate) fn stored_entries(read: &dyn KvRead) -> Result<BTreeSet<Vec<u8>>> {
    let mut out = BTreeSet::new();
    scan_prefix(read, &keys::KEYED_INDEX, false, &mut |k, _| {
        out.insert(k.to_vec());
        true
    })?;
    Ok(out)
}

/// Drops every entry and writes the ones the stored records derive (the store format 9 upgrade).
pub(crate) fn rebuild(tx: &mut dyn KvWrite) -> Result<()> {
    for key in stored_entries(&*tx)? {
        tx.delete(&key)?;
    }
    for key in expected_entries(&*tx)? {
        tx.put(&key, &[])?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Reads.

#[cfg(test)]
thread_local! {
    /// Test switch: the readers below return every record instead of their keyed candidates, so a
    /// member answers exactly as the whole-store scan it replaced (`tests.rs` compares the two).
    pub(crate) static FULL_SCAN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn full_scan() -> bool {
    #[cfg(test)]
    {
        FULL_SCAN.with(std::cell::Cell::get)
    }
    #[cfg(not(test))]
    {
        false
    }
}

/// Every stored page, in id order (the test switch's answer).
fn every_page(read: &dyn KvRead) -> Result<Vec<PageRecord>> {
    let mut pages = crate::pages::all_pages(read)?;
    pages.sort_by_key(|p| p.id);
    Ok(pages)
}

/// The page id at the end of each entry under `prefix` (a hashed kind's entries).
fn page_ids_under(read: &dyn KvRead, prefix: &[u8], ids: &mut BTreeSet<u64>) -> Result<()> {
    scan_prefix(read, prefix, false, &mut |k, _| {
        if k.len() == prefix.len() + 8
            && let Some(id) = keys::be8(&k[prefix.len()..])
        {
            ids.insert(id);
        }
        true
    })
}

/// The stored pages with these ids, in id order; an id with no page is skipped.
fn pages_by_ids(read: &dyn KvRead, ids: BTreeSet<u64>) -> Result<Vec<PageRecord>> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(page) = read_page_by_id(read, id)? {
            out.push(page);
        }
    }
    Ok(out)
}

/// Candidates for an exact lower-cased title test: every page (soft-deleted included) whose
/// title lower-cases, by `to_lowercase` or by `pg_lower`, to one of `titles`. In id order. The
/// caller applies its own test.
pub(crate) fn pages_titled<'t>(
    read: &dyn KvRead,
    titles: impl IntoIterator<Item = &'t str>,
) -> Result<Vec<PageRecord>> {
    if full_scan() {
        return every_page(read);
    }
    let mut ids = BTreeSet::new();
    for title in titles {
        if title.len() > RAW_TITLE_MAX {
            page_ids_under(read, &hashed_prefix(LONG_TITLE, &[title]), &mut ids)?;
            continue;
        }
        let mut prefix = raw_title_prefix(title);
        prefix.push(0);
        page_ids_under(read, &prefix, &mut ids)?;
    }
    pages_by_ids(read, ids)
}

/// Candidates for a substring title test (`listPagesTitledIn`): every page (soft-deleted
/// included) whose title lower-cases, by `to_lowercase` or by `pg_lower`, to a substring of `query`
/// of at least `min_chars` characters. In id order. `None` when the index cannot answer that
/// exactly (the query holds a NUL, or is longer than the longest raw title, so a hashed title could
/// match): the caller then reads every page. The caller applies its own test.
pub(crate) fn pages_titled_within(
    read: &dyn KvRead,
    query: &str,
    min_chars: usize,
) -> Result<Option<Vec<PageRecord>>> {
    if full_scan() || query.contains('\0') || query.len() > RAW_TITLE_MAX {
        return Ok(None);
    }
    let mut ids = BTreeSet::new();
    for (start, _) in query.char_indices() {
        let rest = &query[start..];
        // The shortest title that can match: its first `min_chars` characters.
        let Some(lead_end) = rest
            .char_indices()
            .nth(min_chars.max(1) - 1)
            .map(|(i, c)| i + c.len_utf8())
        else {
            break;
        };
        // Every title that is a prefix of `rest` and starts with its lead sorts in this range.
        let from = raw_title_prefix(&rest[..lead_end]);
        let Some(to) = crate::kv::prefix_end(&raw_title_prefix(rest)) else {
            continue;
        };
        read.scan(&from, &to, false, &mut |k, _| {
            if let Some((title, id)) = raw_title_of(k)
                && rest.as_bytes().starts_with(title)
            {
                ids.insert(id);
            }
            true
        })?;
    }
    Ok(Some(pages_by_ids(read, ids)?))
}

/// Candidates for `findDuplicatePage` in `source_id`: every page (soft-deleted included) that
/// stores this content hash, or this frontmatter `id` when one is given. In id order.
pub(crate) fn duplicate_candidates(
    read: &dyn KvRead,
    source_id: &str,
    hash: &str,
    frontmatter_id: Option<&str>,
) -> Result<Vec<PageRecord>> {
    if full_scan() {
        return every_page(read);
    }
    let mut ids = BTreeSet::new();
    page_ids_under(
        read,
        &hashed_prefix(CONTENT_HASH, &[source_id, hash]),
        &mut ids,
    )?;
    if let Some(fm_id) = frontmatter_id {
        page_ids_under(
            read,
            &hashed_prefix(FRONTMATTER_ID, &[source_id, fm_id]),
            &mut ids,
        )?;
    }
    pages_by_ids(read, ids)
}

/// Every page whose text projection is not served (soft-deleted included), in id order.
pub(crate) fn unserved_pages(read: &dyn KvRead) -> Result<Vec<PageRecord>> {
    if full_scan() {
        return every_page(read);
    }
    let prefix = kind_prefix(UNSERVED);
    let mut ids = BTreeSet::new();
    page_ids_under(read, &prefix, &mut ids)?;
    pages_by_ids(read, ids)
}

/// The ids of the pages that hold a chunk record with one of `chunk_ids`, in id order.
pub(crate) fn pages_holding_chunks(
    read: &dyn KvRead,
    chunk_ids: &HashSet<u64>,
) -> Result<Vec<u64>> {
    if full_scan() {
        return Ok(every_page(read)?.iter().map(|p| p.id).collect());
    }
    let mut pages = BTreeSet::new();
    for &id in chunk_ids {
        let prefix = id_entry(CHUNK_ID, &[id]);
        scan_prefix(read, &prefix, false, &mut |k, _| {
            if k.len() == prefix.len() + 12
                && let Some(page_id) = keys::be8(&k[prefix.len()..prefix.len() + 8])
            {
                pages.insert(page_id);
            }
            true
        })?;
    }
    Ok(pages.into_iter().collect())
}

/// The record keys of the link transitions whose `origin_page_id` is `page_id`, in key order (the
/// order `link_temporal.rs` `scan_tag` reads them in). The caller reads each record and applies its
/// own test.
pub(crate) fn transitions_by_origin(read: &dyn KvRead, page_id: u64) -> Result<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    if full_scan() {
        scan_prefix(read, &[keys::LINK_QUERIES], false, &mut |k, _| {
            if is_transition_key(k) {
                out.push(k.to_vec());
            }
            true
        })?;
        return Ok(out);
    }
    let prefix = id_entry(TRANSITION_ORIGIN, &[page_id]);
    scan_prefix(read, &prefix, false, &mut |k, _| {
        out.push(k[prefix.len()..].to_vec());
        true
    })?;
    Ok(out)
}

/// Whether any stored link has `link_type = 'supersedes'`. Each entry's link record is read back
/// and checked, so the answer rests on the records.
pub(crate) fn has_supersedes(read: &dyn KvRead) -> Result<bool> {
    if full_scan() {
        let mut found = false;
        let mut failed = None;
        scan_prefix(read, &[keys::LINK], false, &mut |_, v| {
            match serde_json::from_slice::<LinkType>(v) {
                Ok(link) => found = link.link_type == SUPERSEDES_TYPE,
                Err(e) => failed = Some(StoreError::from(e)),
            }
            !found && failed.is_none()
        })?;
        return failed.map_or(Ok(found), Err);
    }
    let prefix = kind_prefix(SUPERSEDES);
    let at = prefix.len();
    let mut links = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        if k.len() == at + 16
            && let (Some(from), Some(link)) =
                (keys::be8(&k[at..at + 8]), keys::be8(&k[at + 8..at + 16]))
        {
            links.push((from, link));
        }
        true
    })?;
    for (from, link) in links {
        if let Some(value) = read.get(&keys::link(from, link))?
            && serde_json::from_slice::<LinkType>(&value)?.link_type == SUPERSEDES_TYPE
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests;
