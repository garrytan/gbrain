//! Follow and reconcile: the calls that keep the store level with the primary brain after the seed.
//!
//! Every seeded row can carry a digest entry, `M shadow_digest/<relation>/<sort bytes>`, written in
//! the transaction that writes the row. The caller computes the sort key and the 32-byte row digest
//! (`src/shadow/follow-digest.ts`); the store keeps both as opaque bytes. The value is
//! `digest(32) || generation(u64 big-endian) || JSON { column: text }`, the row's identity: the
//! primary key columns, plus the natural-key and parent columns the family needs to find the row
//! again ([`Follow::identity`]).
//!
//! - [`Store::replace_relation_rows`]: the rows the primary changed, as keys with, or without, a row.
//! - [`Store::replace_interval`]: one sort interval made equal to the rows the caller read.
//! - [`Store::relation_digest`]: the digest of an interval, for the comparison with the primary's.
//!
//! An entry written at a generation above the call's is never overwritten or deleted: an older read
//! does not undo a newer one. See rust/docs/store/seed.md.

mod allocators;
mod fingerprints;
mod remove_core;
mod remove_history;
mod remove_ops;
#[cfg(test)]
mod tests;

pub use allocators::AllocatorCheck;
pub use fingerprints::{FactFingerprints, fact_fingerprints};

use super::decode::Row;
use super::{
    ImportResult, Importer, Losses, MANIFEST, Outcome, Relation, SeedManifest, SeedRow,
    note_unmapped, relation_spec, seed_trust,
};
use crate::error::{INVALID_ARGUMENT, INVALID_STATE, Result, StoreError};
use crate::kv::{KvRead, KvWrite, prefix_end};
use crate::{Store, get_json, keys};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// The error code of a row the store cannot remove or replace safely.
pub const UNSUPPORTED: &str = "unsupported";

/// A row's identity: column name to the Postgres text of its value.
pub(super) type Identity = BTreeMap<String, String>;

/// How a stored row goes away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    /// The primary row is gone: its dependents go the way its foreign keys say (`ON DELETE CASCADE`
    /// removes them, `SET NULL` clears them).
    Delete,
    /// The primary row changed: the row is removed so its new version can be stored in its place,
    /// and its dependents stay.
    Replace,
}

/// Removes the row an identity names and every index key its family keeps. `false` when no stored
/// row matches, or the identity lacks the columns the family finds the row by.
pub(super) type Remover = fn(&mut dyn KvWrite, &Identity, Mode) -> Result<bool>;

/// How a changed row is stored over its old version.
#[derive(Clone, Copy)]
pub(super) enum Replace {
    /// Remove the old row in [`Mode::Replace`], then import the new one.
    ByRemove,
    /// The importer overwrites a different stored value itself.
    Import,
    /// The relation's own replace, given the relation's importer.
    Custom(fn(&mut dyn KvWrite, &Row, &mut Losses, Importer) -> Result<Outcome>),
}

/// What the follow calls know of one relation.
pub(super) struct Follow {
    /// The columns a digest entry keeps of a row, in addition to nothing else: the primary key and
    /// what the remover needs.
    pub identity: &'static [&'static str],
    /// `None`: the relation cannot be removed safely (`removable: false` in the plan).
    pub remove: Option<Remover>,
    pub replace: Replace,
}

/// The follow spec of `relation`.
pub(super) fn follow_spec(relation: &str) -> Option<&'static Follow> {
    remove_core::SPECS
        .iter()
        .chain(remove_history::SPECS)
        .chain(remove_ops::SPECS)
        .find(|(name, _)| *name == relation)
        .map(|(_, spec)| spec)
}

/// Whether the store can remove rows of `relation`.
pub(super) fn removable(relation: &str) -> bool {
    follow_spec(relation).is_some_and(|f| f.remove.is_some())
}

// ---- the digest index ----------------------------------------------------------------------

/// What `importRelation` and the follow calls take per row: its sort key and digest, as hex.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DigestInput {
    pub sort: String,
    pub digest: String,
}

/// A changed primary row: its sort key and its primary key columns.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyInput {
    pub sort: String,
    pub key: BTreeMap<String, String>,
}

/// A parsed [`DigestInput`].
#[derive(Debug, Clone)]
pub(super) struct RowDigest {
    sort: Vec<u8>,
    digest: [u8; 32],
}

/// One digest entry as stored.
#[derive(Debug, Clone)]
pub(super) struct Entry {
    pub digest: [u8; 32],
    pub generation: u64,
    pub identity: Identity,
}

impl Entry {
    fn encode(&self) -> Result<Vec<u8>> {
        let mut out = self.digest.to_vec();
        out.extend_from_slice(&self.generation.to_be_bytes());
        out.extend_from_slice(&serde_json::to_vec(&self.identity)?);
        Ok(out)
    }

    fn decode(bytes: &[u8]) -> Result<Entry> {
        let corrupt = || StoreError::new(crate::error::STORE_CORRUPT, "bad shadow digest entry");
        let digest = bytes
            .get(..32)
            .and_then(|b| <[u8; 32]>::try_from(b).ok())
            .ok_or_else(corrupt)?;
        let generation = bytes
            .get(32..40)
            .and_then(|b| <[u8; 8]>::try_from(b).ok())
            .map(u64::from_be_bytes)
            .ok_or_else(corrupt)?;
        let identity = serde_json::from_slice(&bytes[40..]).map_err(|_| corrupt())?;
        Ok(Entry {
            digest,
            generation,
            identity,
        })
    }
}

fn digest_prefix(relation: &str) -> Vec<u8> {
    keys::meta(&format!("shadow_digest/{relation}/"))
}

fn digest_key(relation: &str, sort: &[u8]) -> Vec<u8> {
    let mut key = digest_prefix(relation);
    key.extend_from_slice(sort);
    key
}

fn read_entry(read: &dyn KvRead, relation: &str, sort: &[u8]) -> Result<Option<Entry>> {
    read.get(&digest_key(relation, sort))?
        .map(|bytes| Entry::decode(&bytes))
        .transpose()
}

fn write_entry(tx: &mut dyn KvWrite, relation: &str, sort: &[u8], entry: &Entry) -> Result<()> {
    tx.put(&digest_key(relation, sort), &entry.encode()?)
}

/// Every entry of `relation` with a sort key in `[lo, hi)`, in sort order.
fn entries_in(
    read: &dyn KvRead,
    relation: &str,
    lo: Option<&[u8]>,
    hi: Option<&[u8]>,
    limit: Option<usize>,
) -> Result<Vec<(Vec<u8>, Entry)>> {
    let prefix = digest_prefix(relation);
    let start = digest_key(relation, lo.unwrap_or_default());
    let end = match hi {
        Some(hi) => digest_key(relation, hi),
        None => prefix_end(&prefix).unwrap_or_else(|| vec![0xFF; 64]),
    };
    let mut out = Vec::new();
    let mut failure = None;
    if start < end && limit != Some(0) {
        read.scan(&start, &end, false, &mut |k, v| {
            match Entry::decode(v) {
                Ok(entry) => out.push((k[prefix.len()..].to_vec(), entry)),
                Err(e) => failure = Some(e),
            }
            failure.is_none() && limit.is_none_or(|limit| out.len() < limit)
        })?;
    }
    failure.map_or(Ok(out), Err)
}

/// The columns of `row` that a digest entry keeps.
fn identity_of(follow: &Follow, row: &Row) -> Identity {
    follow
        .identity
        .iter()
        .filter_map(|col| Some((col.to_string(), row.value(col)?.to_owned())))
        .collect()
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, message)
}

fn parse_hex(what: &str, text: &str) -> Result<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(2)
        || !bytes.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(invalid(format!(
            "shadow_follow: {what} is not lowercase hex of whole bytes"
        )));
    }
    Ok((0..bytes.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap_or_default())
        .collect())
}

fn parse_digest(input: &DigestInput) -> Result<RowDigest> {
    let sort = parse_hex("a sort key", &input.sort)?;
    let digest = <[u8; 32]>::try_from(parse_hex("a row digest", &input.digest)?)
        .map_err(|_| invalid("shadow_follow: a row digest is 32 bytes"))?;
    Ok(RowDigest { sort, digest })
}

fn parse_digests(digests: &[DigestInput]) -> Result<Vec<RowDigest>> {
    digests.iter().map(parse_digest).collect()
}

fn parse_bound(what: &str, bound: Option<&str>) -> Result<Option<Vec<u8>>> {
    bound.map(|text| parse_hex(what, text)).transpose()
}

/// The manifest of `seed_id`. Refused (`invalid_state`) when no seed owns the store or another does.
fn check_seed(read: &dyn KvRead, seed_id: &str) -> Result<SeedManifest> {
    let Some(manifest) = get_json::<SeedManifest>(read, &keys::meta(MANIFEST))? else {
        return Err(StoreError::new(
            INVALID_STATE,
            "shadow_follow: no seed owns the store; seed it first",
        ));
    };
    if manifest.seed_id != seed_id {
        return Err(StoreError::new(
            INVALID_STATE,
            format!(
                "shadow_follow: the store holds seed {} and refuses calls of seed {seed_id}",
                manifest.seed_id
            ),
        ));
    }
    Ok(manifest)
}

fn check_seed_id(seed_id: &str) -> Result<()> {
    if seed_id.is_empty() || seed_id.contains('\0') {
        return Err(invalid("shadow_seed: the seed id must be non-empty text"));
    }
    Ok(())
}

/// The entry `importRelation` stores for a row it was given a digest for: only where the row has no
/// entry yet, or an entry at generation 0 (a retried batch). A follow call's entry is newer.
pub(super) fn store_import_entry(
    tx: &mut dyn KvWrite,
    relation: &str,
    row: &Row,
    digest: &RowDigest,
) -> Result<()> {
    let follow = follow_spec(relation).ok_or_else(|| missing_spec(relation))?;
    if read_entry(&*tx, relation, &digest.sort)?.is_some_and(|e| e.generation > 0) {
        return Ok(());
    }
    let entry = Entry {
        digest: digest.digest,
        generation: 0,
        identity: identity_of(follow, row),
    };
    write_entry(tx, relation, &digest.sort, &entry)
}

fn missing_spec(relation: &str) -> StoreError {
    StoreError::new(
        crate::error::STORE_CORRUPT,
        format!("shadow_follow: relation {relation} has no follow spec"),
    )
}

// ---- results -------------------------------------------------------------------------------

/// What one `replaceRelationRows` or `replaceInterval` call did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct FollowResult {
    /// Rows stored: the new rows and the ones that replaced an older version.
    pub upserted: u64,
    /// Keys whose row and digest entry are gone.
    pub deleted: u64,
    /// Keys left alone because the store holds a newer generation of them.
    pub skipped_older: u64,
    /// Rows the store cannot hold; `losses` names why. Their digest entries are stored.
    pub dropped: u64,
    pub unmapped_columns: Vec<String>,
    pub losses: BTreeMap<String, u64>,
}

/// What [`Store::relation_digest`] returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IntervalDigest {
    pub rows: u64,
    /// sha256 hex over each entry's `u32be(len sort) || sort || digest`, in sort order.
    pub digest: String,
}

/// One digest entry as `relationEntries` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EntryInfo {
    /// The sort key, hex.
    pub sort: String,
    /// The row digest, hex.
    pub digest: String,
    pub generation: u64,
}

/// The most entries one `relationEntries` call returns.
pub const MAX_ENTRIES: u64 = 5000;

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The digest of entries in sort order.
fn interval_digest(entries: &[(Vec<u8>, Entry)]) -> IntervalDigest {
    let mut hasher = Sha256::new();
    for (sort, entry) in entries {
        hasher.update((sort.len() as u32).to_be_bytes());
        hasher.update(sort);
        hasher.update(entry.digest);
    }
    IntervalDigest {
        rows: entries.len() as u64,
        digest: to_hex(&hasher.finalize()),
    }
}

// ---- the calls -----------------------------------------------------------------------------

/// One call's state.
struct Apply<'a> {
    relation: &'a str,
    spec: &'static Relation,
    follow: &'static Follow,
    generation: u64,
    result: FollowResult,
    losses: Losses,
    unmapped: BTreeSet<String>,
    /// The rows removed in [`Mode::Delete`], for the digest entries of their dependents.
    deleted: Vec<Identity>,
}

impl<'a> Apply<'a> {
    fn new(relation: &'a str, generation: u64) -> Result<Self> {
        Ok(Apply {
            relation,
            spec: relation_spec(relation)?,
            follow: follow_spec(relation).ok_or_else(|| missing_spec(relation))?,
            generation,
            result: FollowResult::default(),
            losses: Losses::default(),
            unmapped: BTreeSet::new(),
            deleted: Vec::new(),
        })
    }

    fn finish(mut self, tx: &mut dyn KvWrite) -> Result<FollowResult> {
        if !self.deleted.is_empty() {
            drop_dependent_entries(tx, self.relation, &self.deleted)?;
        }
        self.result.unmapped_columns = self.unmapped.into_iter().collect();
        self.result.losses = self.losses.0;
        Ok(self.result)
    }

    /// The row a key names is gone from the primary: remove it and its entry, unless the store
    /// holds a newer generation of it.
    fn delete(&mut self, tx: &mut dyn KvWrite, sort: &[u8], key: &Identity) -> Result<()> {
        let entry = read_entry(&*tx, self.relation, sort)?;
        if entry
            .as_ref()
            .is_some_and(|e| e.generation > self.generation)
        {
            self.result.skipped_older += 1;
            return Ok(());
        }
        let mut identity = entry
            .as_ref()
            .map(|e| e.identity.clone())
            .unwrap_or_default();
        identity.extend(key.iter().map(|(k, v)| (k.clone(), v.clone())));
        let Some(remove) = self.follow.remove else {
            return Err(self.unsupported("remove"));
        };
        let removed = remove(tx, &identity, Mode::Delete)?;
        tx.delete(&digest_key(self.relation, sort))?;
        if removed {
            self.deleted.push(identity);
        }
        if removed || entry.is_some() {
            self.result.deleted += 1;
        }
        Ok(())
    }

    /// A row of the primary, new or changed: store it over its old version, with its entry.
    fn upsert(
        &mut self,
        tx: &mut dyn KvWrite,
        n: usize,
        row: &SeedRow,
        digest: &RowDigest,
    ) -> Result<()> {
        let old = read_entry(&*tx, self.relation, &digest.sort)?;
        if old.as_ref().is_some_and(|e| e.generation > self.generation) {
            self.result.skipped_older += 1;
            return Ok(());
        }
        let relation = self.relation;
        let row = Row { relation, row };
        note_unmapped(self.spec, &row, &mut self.unmapped);
        let fresh = identity_of(self.follow, &row);
        let old_identity = old.map_or_else(|| fresh.clone(), |e| e.identity);
        let outcome = self
            .store(tx, &row, &old_identity)
            .map_err(|e| StoreError::new(e.code, format!("{relation} row {n}: {}", e.message)))?;
        match outcome {
            Outcome::Imported | Outcome::Skipped => self.result.upserted += 1,
            Outcome::Dropped(reason) => {
                self.result.dropped += 1;
                self.losses.add(reason);
            }
        }
        let entry = Entry {
            digest: digest.digest,
            generation: self.generation,
            identity: fresh,
        };
        write_entry(tx, relation, &digest.sort, &entry)
    }

    fn store(&mut self, tx: &mut dyn KvWrite, row: &Row, old: &Identity) -> Result<Outcome> {
        match (self.follow.replace, self.follow.remove) {
            (Replace::Custom(replace), _) => replace(tx, row, &mut self.losses, self.spec.import),
            (Replace::Import, _) => (self.spec.import)(tx, row, &mut self.losses),
            (Replace::ByRemove, Some(remove)) => {
                remove(tx, old, Mode::Replace)?;
                (self.spec.import)(tx, row, &mut self.losses)
            }
            (Replace::ByRemove, None) => {
                let outcome = (self.spec.import)(tx, row, &mut self.losses)?;
                if matches!(outcome, Outcome::Skipped) {
                    return Err(self.unsupported("replace"));
                }
                Ok(outcome)
            }
        }
    }

    fn unsupported(&self, what: &str) -> StoreError {
        StoreError::new(
            UNSUPPORTED,
            format!(
                "shadow_follow: the store cannot {what} a row of {} safely",
                self.relation
            ),
        )
    }
}

/// The digest of each row must name a changed key or sit in the interval; the digests align with
/// the rows. Returns them parsed.
fn row_digests(rows: &[SeedRow], digests: &[DigestInput]) -> Result<Vec<RowDigest>> {
    if rows.len() != digests.len() {
        return Err(invalid(format!(
            "shadow_follow: {} rows and {} digests; they must align",
            rows.len(),
            digests.len()
        )));
    }
    let parsed = parse_digests(digests)?;
    let mut seen = BTreeSet::new();
    for d in &parsed {
        if !seen.insert(&d.sort) {
            return Err(invalid("shadow_follow: two rows share a sort key"));
        }
    }
    Ok(parsed)
}

impl Store {
    /// `replaceRelationRows(seedId, relation, generation, keys, rows, digests)`: the primary changed
    /// the rows `keys` names. A key with a row (its digest has the key's sort) is stored over its old
    /// version or inserted; a key with none is deleted. One write transaction. Deletes run before
    /// stores, so a natural key a deleted row held is free for a new one.
    pub fn replace_relation_rows(
        &self,
        seed_id: &str,
        relation: &str,
        generation: u64,
        keys: &[KeyInput],
        rows: &[SeedRow],
        digests: &[DigestInput],
    ) -> Result<FollowResult> {
        check_seed_id(seed_id)?;
        let mut apply = Apply::new(relation, generation)?;
        let digests = row_digests(rows, digests)?;
        let mut sorts = BTreeMap::new();
        for key in keys {
            let sort = parse_hex("a sort key", &key.sort)?;
            if sorts.insert(sort, &key.key).is_some() {
                return Err(invalid("shadow_follow: two keys share a sort key"));
            }
        }
        for digest in &digests {
            if !sorts.contains_key(&digest.sort) {
                return Err(invalid("shadow_follow: a row has no key with its sort key"));
            }
        }
        let with_row: BTreeSet<&Vec<u8>> = digests.iter().map(|d| &d.sort).collect();
        self.write_as(seed_trust(), |tx| {
            check_seed(&*tx, seed_id)?;
            for (sort, key) in &sorts {
                if !with_row.contains(sort) {
                    apply.delete(tx, sort, key)?;
                }
            }
            for (n, (row, digest)) in rows.iter().zip(&digests).enumerate() {
                apply.upsert(tx, n, row, digest)?;
            }
            apply.finish(tx)
        })
    }

    /// `replaceInterval(seedId, relation, generation, lo, hi, rows, digests)`: the primary holds
    /// exactly `rows` with a sort key in `[lo, hi)` (`None`: unbounded). Entries in the interval that
    /// are not among them are deleted, the rows are stored over their old versions or inserted. One
    /// write transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn replace_interval(
        &self,
        seed_id: &str,
        relation: &str,
        generation: u64,
        lo: Option<&str>,
        hi: Option<&str>,
        rows: &[SeedRow],
        digests: &[DigestInput],
    ) -> Result<FollowResult> {
        check_seed_id(seed_id)?;
        let mut apply = Apply::new(relation, generation)?;
        let (lo, hi) = (parse_bound("lo", lo)?, parse_bound("hi", hi)?);
        let digests = row_digests(rows, digests)?;
        for d in &digests {
            let above = lo.as_ref().is_none_or(|lo| d.sort >= *lo);
            let below = hi.as_ref().is_none_or(|hi| d.sort < *hi);
            if !(above && below) {
                return Err(invalid(
                    "shadow_follow: a row's sort key is outside [lo, hi)",
                ));
            }
        }
        let given: BTreeSet<&Vec<u8>> = digests.iter().map(|d| &d.sort).collect();
        self.write_as(seed_trust(), |tx| {
            check_seed(&*tx, seed_id)?;
            for (sort, _) in entries_in(&*tx, relation, lo.as_deref(), hi.as_deref(), None)? {
                if !given.contains(&sort) {
                    apply.delete(tx, &sort, &Identity::new())?;
                }
            }
            for (n, (row, digest)) in rows.iter().zip(&digests).enumerate() {
                apply.upsert(tx, n, row, digest)?;
            }
            apply.finish(tx)
        })
    }

    /// `relationDigest(seedId, relation, lo, hi)`: the entry count and the digest of the entries
    /// with a sort key in `[lo, hi)`. Read only.
    pub fn relation_digest(
        &self,
        seed_id: &str,
        relation: &str,
        lo: Option<&str>,
        hi: Option<&str>,
    ) -> Result<IntervalDigest> {
        check_seed_id(seed_id)?;
        relation_spec(relation)?;
        let (lo, hi) = (parse_bound("lo", lo)?, parse_bound("hi", hi)?);
        let read = self.read()?;
        check_seed(&*read, seed_id)?;
        let entries = entries_in(&*read, relation, lo.as_deref(), hi.as_deref(), None)?;
        Ok(interval_digest(&entries))
    }

    /// `relationEntries(seedId, relation, lo, hi, limit)`: the digest entries with a sort key in
    /// `[lo, hi)`, in sort order, at most `limit` (1 to [`MAX_ENTRIES`]). Read only.
    pub fn relation_entries(
        &self,
        seed_id: &str,
        relation: &str,
        lo: Option<&str>,
        hi: Option<&str>,
        limit: u64,
    ) -> Result<Vec<EntryInfo>> {
        check_seed_id(seed_id)?;
        relation_spec(relation)?;
        if !(1..=MAX_ENTRIES).contains(&limit) {
            return Err(invalid(format!(
                "shadow_follow: limit must be a whole number from 1 to {MAX_ENTRIES}"
            )));
        }
        let (lo, hi) = (parse_bound("lo", lo)?, parse_bound("hi", hi)?);
        let read = self.read()?;
        check_seed(&*read, seed_id)?;
        let entries = entries_in(
            &*read,
            relation,
            lo.as_deref(),
            hi.as_deref(),
            Some(limit as usize),
        )?;
        Ok(entries
            .into_iter()
            .map(|(sort, entry)| EntryInfo {
                sort: to_hex(&sort),
                digest: to_hex(&entry.digest),
                generation: entry.generation,
            })
            .collect())
    }

    /// [`Store::import_relation`] that also stores a digest entry per row (generation 0), for rows
    /// stored, skipped and dropped alike. `digests` align with `rows`.
    pub fn import_relation_with_digests(
        &self,
        seed_id: &str,
        relation: &str,
        rows: Vec<SeedRow>,
        digests: &[DigestInput],
    ) -> Result<ImportResult> {
        let digests = row_digests(&rows, digests)?;
        self.import_rows(seed_id, relation, rows, Some(&digests))
    }
}

// ---- dependents ----------------------------------------------------------------------------

/// The relations whose rows a deleted row takes with it, and the identity columns that name the
/// deleted row in each: `(parent, [(dependent, [(dependent column, parent column)])])`. Every
/// column pair of one dependent is an alternative: a row matching any of them goes.
type Dependent = (&'static str, &'static [(&'static str, &'static str)]);

const DEPENDENTS: &[(&str, &[Dependent])] = &[
    (
        "pages",
        &[
            ("tags", &[("page_id", "id")]),
            ("content_chunks", &[("page_id", "id")]),
            ("links", &[("from_page_id", "id"), ("to_page_id", "id")]),
            (
                "timeline_entries",
                &[("page_id", "id"), ("event_page_id", "id")],
            ),
            ("page_versions", &[("page_id", "id")]),
            ("raw_data", &[("page_id", "id")]),
            ("wanted_links", &[("origin_page_id", "id")]),
            ("takes", &[("page_id", "id")]),
            (
                "synthesis_evidence",
                &[("synthesis_page_id", "id"), ("take_page_id", "id")],
            ),
            ("page_facts_reconcile", &[("page_id", "id")]),
        ],
    ),
    (
        "content_chunks",
        &[
            (
                "code_edges_chunk",
                &[("from_chunk_id", "id"), ("to_chunk_id", "id")],
            ),
            ("code_edges_symbol", &[("from_chunk_id", "id")]),
        ],
    ),
    (
        "takes",
        &[(
            "synthesis_evidence",
            &[("take_page_id", "page_id"), ("take_row_num", "row_num")],
        )],
    ),
    (
        "derived_generations",
        &[("derived_generation_items", &[("generation_id", "id")])],
    ),
];

/// Deletes the digest entries of the rows that went with the deleted `rows` of `parent`.
fn drop_dependent_entries(tx: &mut dyn KvWrite, parent: &str, rows: &[Identity]) -> Result<()> {
    let Some((_, dependents)) = DEPENDENTS.iter().find(|(name, _)| *name == parent) else {
        return Ok(());
    };
    for (dependent, links) in *dependents {
        let mut doomed = Vec::new();
        for (sort, entry) in entries_in(&*tx, dependent, None, None, None)? {
            // `takes` names its parent by two columns together; the others by any one of them.
            let together = *dependent == "synthesis_evidence" && parent == "takes";
            let matches = |row: &Identity| {
                let hit = |(col, pcol): &&(&str, &str)| matches!((entry.identity.get(*col), row.get(*pcol)), (Some(a), Some(b)) if a == b);
                if together {
                    links.iter().all(|l| hit(&l))
                } else {
                    links.iter().any(|l| hit(&l))
                }
            };
            if rows.iter().any(matches) {
                doomed.push(sort);
            }
        }
        for sort in doomed {
            tx.delete(&digest_key(dependent, &sort))?;
        }
    }
    Ok(())
}

// ---- the helpers the removers share --------------------------------------------------------

/// A text column of an identity.
fn text<'a>(id: &'a Identity, col: &str) -> Option<&'a str> {
    id.get(col).map(String::as_str)
}

/// A numeric column of an identity.
fn number<T: std::str::FromStr>(id: &Identity, col: &str) -> Option<T> {
    id.get(col)?.parse().ok()
}
