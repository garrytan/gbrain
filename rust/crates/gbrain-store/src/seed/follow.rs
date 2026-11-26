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
//! A key the store holds at a generation above the call's (a live entry, a tombstone of a delete or
//! an interval fence, see `fences.rs`) is never overwritten or deleted: an older read does not undo a
//! newer one. Rows that trade a unique natural key are released before they are stored, and a stale
//! row in the way is displaced. See rust/docs/store/seed.md.

mod allocators;
mod fences;
mod fingerprints;
mod remove_core;
mod remove_history;
mod remove_ops;
mod remove_state;
#[cfg(test)]
mod tests;

pub use allocators::AllocatorCheck;
pub use fingerprints::{FactFingerprints, fact_fingerprints};

use self::fences::Fences;
use super::decode::Row;
use super::{
    ImportResult, Importer, Losses, MANIFEST, Outcome, Relation, SeedManifest, SeedRow,
    note_unmapped, relation_spec, seed_trust,
};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, INVALID_STATE, Result, StoreError};
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
    /// The relation's own replace, in two steps.
    Custom(Custom),
}

/// A relation's own replace: `release` removes the old version of the row (all rows of a call go
/// first, so rows can trade a natural key) and returns what `store` must put back; `store` imports
/// the new version with the relation's importer.
#[derive(Clone, Copy)]
pub(super) struct Custom {
    pub release: fn(&mut dyn KvWrite, &Row) -> Result<Option<serde_json::Value>>,
    pub store: CustomStore,
}

/// Stores the new version of a row, given the importer and what `release` carried.
pub(super) type CustomStore = fn(
    &mut dyn KvWrite,
    &Row,
    &mut Losses,
    Importer,
    Option<&serde_json::Value>,
) -> Result<Outcome>;

/// What the follow calls know of one relation.
pub(super) struct Follow {
    /// The columns a digest entry keeps of a row, in addition to nothing else: the primary key and
    /// what the remover needs.
    pub identity: &'static [&'static str],
    /// The unique natural keys of the relation besides its primary key, each a set of `identity`
    /// columns. Two rows holding the same values in every column of a set collide in the store.
    pub unique: &'static [&'static [&'static str]],
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
        .chain(remove_state::SPECS)
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
    /// Stored rows removed because a row of the call took a unique natural key they held. Their
    /// digest entries are gone too: the relation differs from the primary until a reconcile
    /// restores them, so the caller marks it dirty when this is above zero.
    pub displaced: u64,
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

/// [`Store::relation_digest`] over one read, in the same bytes ([`interval_digest`]), without
/// keeping the entries: each is hashed as the scan reaches it, so the memory is one entry however
/// large the relation. A digest entry is checked for its 32-byte digest and generation, not for
/// its identity JSON, which the digest does not use. `lo` and `hi` are raw sort-key bounds
/// (`None`: unbounded), as `relation_digest` takes them after hex parsing. The store snapshot
/// (`snapshot.rs`) calls it for every relation of the seed.
pub fn relation_digest_stream(
    read: &dyn KvRead,
    relation: &str,
    lo: Option<&[u8]>,
    hi: Option<&[u8]>,
) -> Result<IntervalDigest> {
    relation_digest_stream_until(read, relation, lo, hi, &|| false)?.ok_or_else(|| {
        StoreError::new(crate::error::STORE_CORRUPT, "the digest scan stopped early")
    })
}

/// [`relation_digest_stream`] that asks `stop` before every entry and returns `None` the moment
/// it says yes, with nothing hashed kept. The store snapshot passes its cancellation here, so a
/// cancelled copy gives its pinned read back at the next entry, not at the end of the relation.
pub(crate) fn relation_digest_stream_until(
    read: &dyn KvRead,
    relation: &str,
    lo: Option<&[u8]>,
    hi: Option<&[u8]>,
    stop: &dyn Fn() -> bool,
) -> Result<Option<IntervalDigest>> {
    let prefix = digest_prefix(relation);
    let start = digest_key(relation, lo.unwrap_or_default());
    let end = match hi {
        Some(hi) => digest_key(relation, hi),
        None => prefix_end(&prefix).unwrap_or_else(|| vec![0xFF; 64]),
    };
    let mut hasher = Sha256::new();
    let mut rows = 0u64;
    let mut failure = None;
    let mut stopped = false;
    if start < end {
        read.scan(&start, &end, false, &mut |k, v| {
            if stop() {
                stopped = true;
                return false;
            }
            if v.len() < 40 {
                failure = Some(StoreError::new(
                    crate::error::STORE_CORRUPT,
                    "bad shadow digest entry",
                ));
                return false;
            }
            let sort = &k[prefix.len()..];
            hasher.update((sort.len() as u32).to_be_bytes());
            hasher.update(sort);
            hasher.update(&v[..32]);
            rows += 1;
            true
        })?;
    }
    if stopped {
        return Ok(None);
    }
    failure.map_or_else(
        || {
            Ok(Some(IntervalDigest {
                rows,
                digest: to_hex(&hasher.finalize()),
            }))
        },
        Err,
    )
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
    /// The interval fences of the relation as the call found them.
    fences: Fences,
    /// The live entries as the call found them, loaded when a row first collides, for the rows that
    /// hold the natural key a new row takes.
    live: Option<Vec<(Vec<u8>, Entry)>>,
}

/// A row of the call that will be stored.
struct Todo<'r> {
    n: usize,
    row: Row<'r>,
    sort: &'r [u8],
    digest: [u8; 32],
    /// The identity the row's entry will keep.
    fresh: Identity,
    /// The identity of the entry the store holds for the sort key, if any.
    old: Option<Identity>,
    /// What the relation's own replace carried over from the old version.
    carry: Option<serde_json::Value>,
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
            fences: Fences::empty(relation),
            live: None,
        })
    }

    /// Reads what the call needs of the store; first in the write transaction.
    fn begin(&mut self, tx: &mut dyn KvWrite, seed_id: &str) -> Result<()> {
        check_seed(&*tx, seed_id)?;
        self.fences = Fences::load(&*tx, self.relation)?;
        Ok(())
    }

    fn finish(mut self, tx: &mut dyn KvWrite) -> Result<FollowResult> {
        if !self.deleted.is_empty() {
            drop_dependent_entries(tx, self.relation, &self.deleted)?;
        }
        self.result.unmapped_columns = self.unmapped.into_iter().collect();
        self.result.losses = self.losses.0;
        Ok(self.result)
    }

    /// Whether the store holds a newer generation of the sort key: a live entry, a tombstone or an
    /// interval fence above the call's. An older call leaves such a key alone.
    fn newer(&self, tx: &dyn KvRead, sort: &[u8], entry: Option<&Entry>) -> Result<bool> {
        let held = entry.map_or(0, |e| e.generation);
        let newest = held
            .max(fences::tombstone(tx, self.relation, sort)?)
            .max(self.fences.covering(sort));
        Ok(newest > self.generation)
    }

    /// The row a key names is gone from the primary: remove it and its entry, unless the store
    /// holds a newer generation of it. `bury`: leave a tombstone at the call's generation, so an
    /// older call does not bring the row back (an interval call leaves a fence instead).
    fn delete(
        &mut self,
        tx: &mut dyn KvWrite,
        sort: &[u8],
        key: &Identity,
        bury: bool,
    ) -> Result<()> {
        let entry = read_entry(&*tx, self.relation, sort)?;
        if self.newer(&*tx, sort, entry.as_ref())? {
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
        if bury {
            fences::bury(tx, self.relation, sort, self.generation)?;
        }
        if removed {
            self.deleted.push(identity);
        }
        if removed || entry.is_some() {
            self.result.deleted += 1;
        }
        Ok(())
    }

    /// The rows of the primary, new or changed: store each over its old version, with its entry.
    ///
    /// Every row's old version goes first and the new versions come after, so rows that trade a
    /// unique natural key (two chunks swapping their index) never meet the other's old version. A
    /// new version that still collides with a stored row the call does not name displaces that row.
    fn upsert_all(
        &mut self,
        tx: &mut dyn KvWrite,
        rows: &[SeedRow],
        digests: &[RowDigest],
    ) -> Result<()> {
        let relation = self.relation;
        let mut todo = Vec::new();
        for (n, (row, digest)) in rows.iter().zip(digests).enumerate() {
            let old = read_entry(&*tx, relation, &digest.sort)?;
            if self.newer(&*tx, &digest.sort, old.as_ref())? {
                self.result.skipped_older += 1;
                continue;
            }
            let row = Row { relation, row };
            note_unmapped(self.spec, &row, &mut self.unmapped);
            todo.push(Todo {
                n,
                fresh: identity_of(self.follow, &row),
                old: old.map(|e| e.identity),
                carry: None,
                row,
                sort: &digest.sort,
                digest: digest.digest,
            });
        }
        let wrap = |n: usize, e: StoreError| {
            StoreError::new(e.code, format!("{relation} row {n}: {}", e.message))
        };
        // A row that moves a unique key onto a stored row newer than the call is skipped before
        // anything of it is removed.
        let named: BTreeSet<&[u8]> = todo.iter().map(|t| t.sort).collect();
        let mut kept = Vec::new();
        for t in todo {
            if self.moves_key(&t) && self.blocked(tx, &t, &named).map_err(|e| wrap(t.n, e))? {
                self.result.skipped_older += 1;
            } else {
                kept.push(t);
            }
        }
        let mut todo = kept;
        for t in &mut todo {
            self.release(tx, t).map_err(|e| wrap(t.n, e))?;
        }
        let sorts: BTreeSet<&[u8]> = todo.iter().map(|t| t.sort).collect();
        for t in &todo {
            let Some(outcome) = self.store(tx, t, &sorts).map_err(|e| wrap(t.n, e))? else {
                self.result.skipped_older += 1;
                continue;
            };
            match outcome {
                Outcome::Imported | Outcome::Skipped => self.result.upserted += 1,
                Outcome::Dropped(reason) => {
                    self.result.dropped += 1;
                    self.losses.add(reason);
                }
            }
            let entry = Entry {
                digest: t.digest,
                generation: self.generation,
                identity: t.fresh.clone(),
            };
            write_entry(tx, relation, t.sort, &entry)?;
            fences::lift(tx, relation, t.sort, self.generation)?;
        }
        Ok(())
    }

    /// Removes the old version of a row, keeping what hangs off it.
    fn release(&mut self, tx: &mut dyn KvWrite, todo: &mut Todo) -> Result<()> {
        match (self.follow.replace, self.follow.remove, &todo.old) {
            (Replace::Custom(custom), _, _) => {
                todo.carry = (custom.release)(tx, &todo.row)?;
            }
            (Replace::ByRemove, Some(remove), Some(old)) => {
                remove(tx, old, Mode::Replace)?;
            }
            _ => {}
        }
        Ok(())
    }

    /// Stores the new version of a row. A collision with a stored row that holds a natural key the
    /// row takes displaces that row and tries once more. `None`: a holder is newer than the call, so
    /// the row is left unstored.
    fn store(
        &mut self,
        tx: &mut dyn KvWrite,
        todo: &Todo,
        sorts: &BTreeSet<&[u8]>,
    ) -> Result<Option<Outcome>> {
        let first = self.import(tx, todo);
        if !collided(&first) {
            return first.map(Some);
        }
        match self.displace(tx, todo, sorts)? {
            Displaced::Newer => return Ok(None),
            Displaced::Some => return self.import(tx, todo).map(Some),
            Displaced::None => {}
        }
        // A row with no entry of its own may be a stored version the store has no entry for (the
        // rows `importRelation` stored without digests): replace it by what the row names.
        if todo.old.is_none()
            && let (Replace::ByRemove, Some(remove)) = (self.follow.replace, self.follow.remove)
            && remove(tx, &todo.fresh, Mode::Replace)?
        {
            return self.import(tx, todo).map(Some);
        }
        first.map(Some)
    }

    fn import(&mut self, tx: &mut dyn KvWrite, todo: &Todo) -> Result<Outcome> {
        match (self.follow.replace, self.follow.remove) {
            (Replace::Custom(custom), _) => (custom.store)(
                tx,
                &todo.row,
                &mut self.losses,
                self.spec.import,
                todo.carry.as_ref(),
            ),
            (Replace::Import, _) | (Replace::ByRemove, Some(_)) => {
                (self.spec.import)(tx, &todo.row, &mut self.losses)
            }
            (Replace::ByRemove, None) => {
                let outcome = (self.spec.import)(tx, &todo.row, &mut self.losses)?;
                if matches!(outcome, Outcome::Skipped) {
                    return Err(self.unsupported("replace"));
                }
                Ok(outcome)
            }
        }
    }

    /// Whether the row takes a unique natural key its old version did not hold.
    fn moves_key(&self, todo: &Todo) -> bool {
        let Some(old) = &todo.old else {
            return false;
        };
        self.follow.unique.iter().any(|set| {
            set.iter().any(|col| todo.fresh.contains_key(*col))
                && set.iter().any(|col| old.get(*col) != todo.fresh.get(*col))
        })
    }

    /// Whether a stored row that holds a unique natural key of the row is newer than the call.
    fn blocked(
        &mut self,
        tx: &mut dyn KvWrite,
        todo: &Todo,
        sorts: &BTreeSet<&[u8]>,
    ) -> Result<bool> {
        for (sort, entry) in self.holders(tx, todo, sorts)? {
            if self.newer(&*tx, &sort, Some(&entry))? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The identity of the stored row, other than the call's own, that holds a unique key the digest identity does not
    /// carry. Only `access_tokens` has one: its hash, which stays out of every digest entry.
    fn held_by(&self, tx: &dyn KvRead, todo: &Todo) -> Result<Option<Identity>> {
        if self.relation != "access_tokens" {
            return Ok(None);
        }
        let Some(hash) = todo.row.value("token_hash") else {
            return Ok(None);
        };
        Ok(crate::jobs::token_hash_holder(tx, hash)?
            .filter(|id| todo.fresh.get("id") != Some(id))
            .map(|id| Identity::from([("id".to_owned(), id)])))
    }

    /// The live entries, other than the call's own, that hold a unique natural key of the row.
    fn holders(
        &mut self,
        tx: &mut dyn KvWrite,
        todo: &Todo,
        sorts: &BTreeSet<&[u8]>,
    ) -> Result<Vec<(Vec<u8>, Entry)>> {
        let held = self.held_by(&*tx, todo)?;
        if self.follow.unique.is_empty() && held.is_none() {
            return Ok(Vec::new());
        }
        if self.live.is_none() {
            self.live = Some(entries_in(&*tx, self.relation, None, None, None)?);
        }
        let unique = self.follow.unique;
        let holds = |entry: &Entry| {
            held.as_ref() == Some(&entry.identity)
                || unique.iter().any(|set| {
                    set.iter().any(|col| todo.fresh.contains_key(*col))
                        && set
                            .iter()
                            .all(|col| entry.identity.get(*col) == todo.fresh.get(*col))
                })
        };
        Ok(self
            .live
            .iter()
            .flatten()
            .filter(|(sort, entry)| !sorts.contains(sort.as_slice()) && holds(entry))
            .cloned()
            .collect())
    }

    /// Removes the stored rows, other than the call's own, that hold a unique natural key of
    /// `todo`'s row, with their digest entries (no tombstone: a reconcile restores them) and those
    /// of the dependents the removal took with it ([`CARRIED`]). Removes nothing when one of them
    /// is newer than the call: the same guard as for any write.
    fn displace(
        &mut self,
        tx: &mut dyn KvWrite,
        todo: &Todo,
        sorts: &BTreeSet<&[u8]>,
    ) -> Result<Displaced> {
        let Some(remove) = self.follow.remove else {
            return Ok(Displaced::None);
        };
        let holders = self.holders(tx, todo, sorts)?;
        if holders.is_empty() {
            return Ok(Displaced::None);
        }
        for (sort, entry) in &holders {
            if self.newer(&*tx, sort, Some(entry))? {
                return Ok(Displaced::Newer);
            }
        }
        for (sort, entry) in &holders {
            if remove(tx, &entry.identity, Mode::Replace)? {
                self.result.displaced += 1;
            }
            tx.delete(&digest_key(self.relation, sort))?;
            drop_entries_of(
                tx,
                CARRIED,
                self.relation,
                std::slice::from_ref(&entry.identity),
            )?;
        }
        if let Some(live) = &mut self.live {
            live.retain(|(sort, _)| !holders.iter().any(|(h, _)| h == sort));
        }
        Ok(Displaced::Some)
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

/// What displacing the holders of a natural key came to.
enum Displaced {
    /// There were none.
    None,
    /// They were removed.
    Some,
    /// One is newer than the call, so nothing was removed.
    Newer,
}

/// Whether an import met a stored row holding the natural key it takes: the importers refuse
/// (`constraint_violation`), or skip silently, then.
fn collided(outcome: &Result<Outcome>) -> bool {
    match outcome {
        Ok(outcome) => matches!(outcome, Outcome::Skipped),
        Err(e) => e.code == CONSTRAINT_VIOLATION,
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
        // Checked here for its errors; the write below builds its own, since it may run again.
        Apply::new(relation, generation)?;
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
            let mut apply = Apply::new(relation, generation)?;
            apply.begin(tx, seed_id)?;
            for (sort, key) in &sorts {
                if !with_row.contains(sort) {
                    apply.delete(tx, sort, key, true)?;
                }
            }
            apply.upsert_all(tx, rows, &digests)?;
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
        // Checked here for its errors; the write below builds its own, since it may run again.
        Apply::new(relation, generation)?;
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
            let mut apply = Apply::new(relation, generation)?;
            apply.begin(tx, seed_id)?;
            for (sort, _) in entries_in(&*tx, relation, lo.as_deref(), hi.as_deref(), None)? {
                if !given.contains(&sort) {
                    apply.delete(tx, &sort, &Identity::new(), false)?;
                }
            }
            apply.upsert_all(tx, rows, &digests)?;
            // The fence of this read stands in for the tombstones inside the interval.
            fences::lift_in(tx, relation, lo.as_deref(), hi.as_deref(), generation)?;
            apply
                .fences
                .raise(tx, lo.as_deref(), hi.as_deref(), generation)?;
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
            ("entity_identities", &[("page_id", "id")]),
            (
                "link_relationships",
                &[("from_page_id", "id"), ("to_page_id", "id")],
            ),
            (
                "link_transitions",
                &[
                    ("from_page_id", "id"),
                    ("to_page_id", "id"),
                    ("origin_page_id", "id"),
                ],
            ),
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

/// The rows a displaced row takes with it although they are not rows of the store's own: they live
/// inside the parent's record, so removing the parent removes them, and nothing carries them back
/// when the parent is stored again (a replace carries them across, a displacement has no row to
/// carry them from). Their digest entries go with them, so a reconcile finds them missing. Only a
/// page holds any: its tags and their sources. Chunks, takes and facts keep their dependents
/// (code edges, citations, referrers) under keys of their own, which a replace leaves alone.
const CARRIED: &[(&str, &[Dependent])] = &[("pages", &[("tags", &[("page_id", "id")])])];

/// Deletes the digest entries of the rows that went with the deleted `rows` of `parent`.
fn drop_dependent_entries(tx: &mut dyn KvWrite, parent: &str, rows: &[Identity]) -> Result<()> {
    drop_entries_of(tx, DEPENDENTS, parent, rows)
}

fn drop_entries_of(
    tx: &mut dyn KvWrite,
    table: &[(&str, &[Dependent])],
    parent: &str,
    rows: &[Identity],
) -> Result<()> {
    let Some((_, dependents)) = table.iter().find(|(name, _)| *name == parent) else {
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
