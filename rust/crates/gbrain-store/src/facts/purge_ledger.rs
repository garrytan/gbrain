//! The fact purge ledger: the `fact_purges` table (src/core/facts/purge-schema.ts).
//!
//! A purge tombstone says "this claim, at this visibility, about this subject, was purged from this
//! source and may not be saved again". It lives at `F 0x0F source \0 visibility \0 subject \0
//! fact_hash \0` with the JSON value [`PurgeRecord`]; the key is the table's primary key. `subject`
//! `*` covers every subject. `fact_hash` is the claim's fingerprint (`gbrain_fact_fingerprint`).
//!
//! Five things read it:
//!
//! - the fact guard ([`refuse_purged`]), which [`super::write_fact`] runs on every insert and on
//!   every update that changes `fact`, `source_id`, `visibility` or `entity_slug`, as the
//!   `gbrain_guard_inserted_facts` and `gbrain_refuse_purged_fact` triggers do;
//! - the claim checks every writer runs before it saves (`isFactPurged`, [`Store::is_fact_purged`],
//!   and the purge half of `isFactWithdrawn`, `Store::is_fact_withdrawn` in `trust::withdrawals`),
//!   through [`purged_claim`];
//! - the fence overlay's `purged` ([`purged_claim`] with the page as the entity);
//! - the persistence journal and the belief ledger's purge probe ([`has_fact_purges`]);
//! - the belief ledger's `readBeliefTombstones`, by fingerprint ([`tombstoned_fact_hashes`]).
//!
//! Deleting a source removes its tombstones (`ON DELETE CASCADE`, [`remove_source_rows`]).

use super::{FactRecord, fact_fingerprint, purge};
use crate::Store;
use crate::env::is_uuid;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::sources::require_source;
use crate::{get_json, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The byte after `keys::FACT` that marks a purge tombstone.
const PURGE: u8 = 0x0F;

/// The two values of the table's `visibility` CHECK.
const VISIBILITIES: [&str; 2] = ["private", "world"];

/// The refusal the purge guards raise (`P0001`); callers test the `purged_content:` prefix.
pub const PURGED_CONTENT: &str = "purged_content";
const PURGED_MESSAGE: &str =
    "purged_content: this claim was purged from this source and cannot be saved again";

/// The columns of a tombstone besides its key. `purged_at_us` is the transaction's clock.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PurgeRecord {
    request_id: Option<String>,
    actor: Option<String>,
    reason: Option<String>,
    purged_at_us: i64,
}

/// `insertFactPurge`'s argument (`FactPurgeInsert`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactPurgeInsert {
    pub source_id: String,
    pub visibility: String,
    pub subject: String,
    pub fact_hash: String,
    pub request_id: Option<String>,
    pub actor: Option<String>,
    pub reason: Option<String>,
}

fn key(parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::FACT, PURGE];
    for part in parts {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key
}

fn exists(read: &dyn KvRead, parts: &[&str]) -> Result<bool> {
    Ok(read.get(&key(parts))?.is_some())
}

/// The tombstones of `[source, visibility, subject]`: each fact_hash with its purge time (micros),
/// in fact_hash order (the snapshot ledger, `page_withdrawals.rs`).
pub(crate) fn purges_under_subject(
    read: &dyn KvRead,
    source_id: &str,
    visibility: &str,
    subject: &str,
) -> Result<Vec<(String, i64)>> {
    let prefix = key(&[source_id, visibility, subject]);
    let len = prefix.len();
    let mut rows = Vec::new();
    let mut failed = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        // The rest of the key is `fact_hash \0`.
        let rest = &k[len..];
        let hash = String::from_utf8_lossy(rest.strip_suffix(&[0]).unwrap_or(rest)).into_owned();
        match serde_json::from_slice::<PurgeRecord>(v) {
            Ok(r) => rows.push((hash, r.purged_at_us)),
            Err(e) => {
                failed = Some(e);
                return false;
            }
        }
        true
    })?;
    if let Some(e) = failed {
        return Err(StoreError::invalid(format!(
            "fact_purges: corrupt record: {e}"
        )));
    }
    Ok(rows)
}

/// Whether the source has any tombstone (`EXISTS (SELECT 1 FROM fact_purges WHERE source_id = $1)`).
pub(crate) fn has_fact_purges(read: &dyn KvRead, source_id: &str) -> Result<bool> {
    let mut found = false;
    scan_prefix(read, &key(&[source_id]), false, &mut |_, _| {
        found = true;
        false
    })?;
    Ok(found)
}

/// `SELECT fact_hash FROM fact_purges WHERE source_id = $source AND fact_hash = ANY($hashes)`: the
/// hashes among `hashes` that a tombstone of the source names, at any visibility and under any
/// subject (`*` included), each once (the belief ledger's `readBeliefTombstones`).
pub(crate) fn tombstoned_fact_hashes(
    read: &dyn KvRead,
    source_id: &str,
    hashes: &[String],
) -> Result<BTreeSet<String>> {
    let wanted: BTreeSet<&[u8]> = hashes.iter().map(|h| h.as_bytes()).collect();
    let mut found = BTreeSet::new();
    if wanted.is_empty() {
        return Ok(found);
    }
    let prefix = key(&[source_id]);
    scan_prefix(read, &prefix, false, &mut |k, _| {
        // The rest of the key is `visibility \0 subject \0 fact_hash \0`.
        if let Some(hash) = k[prefix.len()..].split(|b| *b == 0).nth(2)
            && wanted.contains(hash)
        {
            found.insert(String::from_utf8_lossy(hash).into_owned());
        }
        true
    })?;
    Ok(found)
}

/// `SELECT 1 FROM fact_purges WHERE source_id = $source AND visibility = $visibility AND fact_hash =
/// gbrain_fact_fingerprint(claim) AND (subject = '*' OR subject = entity)`: a tombstone at
/// `visibility` names the claim's fingerprint under subject `*` or `entity`; a None entity matches
/// only `*`. The fence overlay passes the page as the entity.
/// `listGlobalPurgeWithdrawals(sourceId, hashes, worldOnly)` (engine-sql/segmented-mirror-effects.ts):
/// the source's subject `*` tombstones whose `fact_hash` is one of `hashes` (world rows only when
/// `world_only`), as `{ visibility, fact_hash, withdrawn_at, purged: true }` in (visibility, fact_hash)
/// order. The key is the table's primary key, so each (visibility, hash) has one row and `min(purged_at)`
/// is its own time.
pub(crate) fn global_purge_withdrawals(
    read: &dyn KvRead,
    source_id: &str,
    hashes: &[String],
    world_only: bool,
) -> Result<Vec<serde_json::Value>> {
    let wanted: std::collections::BTreeSet<&str> = hashes.iter().map(String::as_str).collect();
    let mut found: Vec<(String, String, i64)> = Vec::new();
    let mut bad = None;
    let prefix = key(&[source_id]);
    scan_prefix(read, &prefix, false, &mut |k, v| {
        // The rest of the key is `visibility \0 subject \0 fact_hash \0`.
        let mut parts = k[prefix.len()..].split(|b| *b == 0);
        let (Some(vis), Some(subject), Some(hash)) = (parts.next(), parts.next(), parts.next())
        else {
            return true;
        };
        if subject != b"*" || (world_only && vis != b"world") {
            return true;
        }
        let (vis, hash) = (
            String::from_utf8_lossy(vis).into_owned(),
            String::from_utf8_lossy(hash).into_owned(),
        );
        if !wanted.contains(hash.as_str()) {
            return true;
        }
        match serde_json::from_slice::<PurgeRecord>(v) {
            Ok(record) => found.push((vis, hash, record.purged_at_us)),
            Err(err) => {
                bad = Some(err);
                return false;
            }
        }
        true
    })?;
    if let Some(err) = bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            format!("unreadable fact_purges row: {err}"),
        ));
    }
    found.sort_by(|a, b| (a.0.as_bytes(), a.1.as_bytes()).cmp(&(b.0.as_bytes(), b.1.as_bytes())));
    Ok(found
        .into_iter()
        .map(|(visibility, fact_hash, at)| {
            serde_json::json!({
                "visibility": visibility,
                "fact_hash": fact_hash,
                "withdrawn_at": crate::cli_reads::export::jsonb_timestamptz(at),
                "purged": true,
            })
        })
        .collect())
}

pub(crate) fn purged_claim(
    read: &dyn KvRead,
    source_id: &str,
    visibility: &str,
    claim: &str,
    entity: Option<&str>,
) -> Result<bool> {
    let hash = fact_fingerprint(claim);
    for subject in std::iter::once("*").chain(entity) {
        if exists(read, &[source_id, visibility, subject, &hash])? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `EXISTS (SELECT 1 FROM fact_purges WHERE source_id = $source AND visibility = $visibility AND
/// fact_hash = $hash AND ($subject IS NULL OR subject = '*' OR subject = $subject))`: a tombstone at
/// `visibility` with exactly `hash`, under subject `*` or `subject`, any subject when None.
pub(crate) fn purge_hash_under(
    read: &dyn KvRead,
    source_id: &str,
    visibility: &str,
    subject: Option<&str>,
    hash: &str,
) -> Result<bool> {
    if let Some(subject) = subject {
        for who in ["*", subject] {
            if exists(read, &[source_id, visibility, who, hash])? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    let prefix = key(&[source_id, visibility]);
    let mut found = false;
    scan_prefix(read, &prefix, false, &mut |k, _| {
        // The rest of the key is `subject \0 fact_hash \0`.
        let mut parts = k[prefix.len()..].split(|b| *b == 0);
        found = parts.nth(1).is_some_and(|h| h == hash.as_bytes());
        !found
    })?;
    Ok(found)
}

/// Whether a tombstone reaches `row`: same source, visibility and fingerprint, and subject `*`, the
/// row's entity, or any subject when the entity is an unbacked name key.
fn purged_row(read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
    if !has_fact_purges(read, &row.source_id)? {
        return Ok(false);
    }
    let hash = fact_fingerprint(&row.fact);
    let src = row.source_id.as_str();
    let vis = row.visibility.as_str();
    for subject in std::iter::once("*").chain(row.entity_slug.as_deref()) {
        if exists(read, &[src, vis, subject, &hash])? {
            return Ok(true);
        }
    }
    if !purge::unbacked(read, row)? {
        return Ok(false);
    }
    let prefix = key(&[src, vis]);
    let mut found = false;
    scan_prefix(read, &prefix, false, &mut |k, _| {
        // The rest of the key is `subject \0 fact_hash \0`.
        found = k[prefix.len()..]
            .split(|b| *b == 0)
            .nth(1)
            .is_some_and(|h| h == hash.as_bytes());
        !found
    })?;
    Ok(found)
}

/// The purge guards. `old` is `None` for an insert (`gbrain_guard_inserted_facts`, which skips an
/// extraction outcome marker); for an update the guard (`gbrain_refuse_purged_fact`, `BEFORE UPDATE
/// OF fact, source_id, visibility, entity_slug`) runs when one of those columns changed.
pub(crate) fn refuse_purged(
    read: &dyn KvRead,
    old: Option<&FactRecord>,
    new: &FactRecord,
) -> Result<()> {
    let applies = match old {
        None => !purge::outcome_marker(new),
        Some(old) => {
            old.fact != new.fact
                || old.source_id != new.source_id
                || old.visibility != new.visibility
                || old.entity_slug != new.entity_slug
        }
    };
    if applies && purged_row(read, new)? {
        return Err(StoreError::new(PURGED_CONTENT, PURGED_MESSAGE));
    }
    Ok(())
}

/// One fact purge tombstone of a source as `listPurgeTombstones` answers it (the `fact_purges` columns).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FactPurgeTombstone {
    pub subject: String,
    pub visibility: String,
    pub fact_hash: String,
    pub request_id: Option<String>,
    pub actor: Option<String>,
    pub reason: Option<String>,
}

/// Every fact purge tombstone of `source_id` with its request, actor and reason, in key order:
/// (visibility, subject, fact_hash), each in byte order, as `ORDER BY visibility COLLATE "C",
/// subject COLLATE "C", fact_hash COLLATE "C"` sorts them. A source id holding NUL names none.
pub(crate) fn fact_purge_tombstones(
    read: &dyn KvRead,
    source_id: &str,
) -> Result<Vec<FactPurgeTombstone>> {
    if source_id.contains('\0') {
        return Ok(Vec::new());
    }
    let prefix = key(&[source_id]);
    let mut rows = Vec::new();
    let mut failed = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let parts: Vec<&[u8]> = k[prefix.len()..].split(|b| *b == 0).collect();
        let [visibility, subject, fact_hash, ..] = parts.as_slice() else {
            return true;
        };
        let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
        match serde_json::from_slice::<PurgeRecord>(v) {
            Ok(r) => {
                rows.push(FactPurgeTombstone {
                    subject: text(subject),
                    visibility: text(visibility),
                    fact_hash: text(fact_hash),
                    request_id: r.request_id,
                    actor: r.actor,
                    reason: r.reason,
                });
                true
            }
            Err(e) => {
                failed = Some(e);
                false
            }
        }
    })?;
    match failed {
        Some(e) => Err(StoreError::invalid(format!(
            "fact purges: corrupt record: {e}"
        ))),
        None => Ok(rows),
    }
}

/// One tombstone of a source (`fact_purges` row) as the export lists it.
pub(crate) struct SourcePurgeRow {
    pub visibility: String,
    pub subject: String,
    pub fact_hash: String,
    pub purged_at_us: i64,
}

/// Every tombstone of `source_id`, in key order (visibility, subject, fact_hash): the
/// `SELECT visibility,fact_hash,purged_at,subject FROM fact_purges WHERE source_id=$1` half of the
/// export's withdrawal list.
pub(crate) fn source_purges(read: &dyn KvRead, source_id: &str) -> Result<Vec<SourcePurgeRow>> {
    let prefix = key(&[source_id]);
    let mut rows = Vec::new();
    let mut failed = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        // The rest of the key is `visibility \0 subject \0 fact_hash \0`.
        let parts: Vec<&[u8]> = k[prefix.len()..].split(|b| *b == 0).collect();
        let [visibility, subject, fact_hash, ..] = parts.as_slice() else {
            return true;
        };
        let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
        match serde_json::from_slice::<PurgeRecord>(v) {
            Ok(r) => {
                rows.push(SourcePurgeRow {
                    visibility: text(visibility),
                    subject: text(subject),
                    fact_hash: text(fact_hash),
                    purged_at_us: r.purged_at_us,
                });
                true
            }
            Err(e) => {
                failed = Some(e);
                false
            }
        }
    })?;
    match failed {
        Some(e) => Err(StoreError::invalid(format!(
            "fact purges: corrupt record: {e}"
        ))),
        None => Ok(rows),
    }
}

/// Adds to `out` the request id of every tombstone purged after `since_us`, the `fact_purges` arm of
/// `listRecentPurgeRequests` (`request_id IS NOT NULL AND purged_at > now() - make_interval(...)`).
pub(crate) fn recent_request_ids(
    read: &dyn KvRead,
    since_us: i64,
    out: &mut std::collections::BTreeSet<String>,
) -> Result<()> {
    let mut failure = None;
    scan_prefix(read, &[keys::FACT, PURGE], false, &mut |_, v| {
        match serde_json::from_slice::<PurgeRecord>(v) {
            Ok(r) => {
                if let (Some(request), true) = (r.request_id, r.purged_at_us > since_us) {
                    out.insert(request);
                }
            }
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(()), Err)
}

/// Removes every tombstone of a source, for the source delete.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    scan_prefix(tx, &key(&[source_id]), false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for k in doomed {
        tx.delete(&k)?;
    }
    Ok(())
}

/// The shadow seed (`seed/state.rs`): stores a tombstone copied from another engine, with its own request id, actor, reason
/// and time. `false` when the key is held.
pub(crate) fn seed_fact_purge(
    tx: &mut dyn KvWrite,
    parts: [&str; 4],
    request_id: Option<String>,
    note: (Option<String>, Option<String>),
    purged_at_us: i64,
) -> Result<bool> {
    let [source_id, visibility, subject, fact_hash] = parts;
    no_nul(
        "seed fact_purges",
        &[
            ("source_id", source_id),
            ("visibility", visibility),
            ("subject", subject),
            ("fact_hash", fact_hash),
            ("actor", note.0.as_deref().unwrap_or("")),
            ("reason", note.1.as_deref().unwrap_or("")),
        ],
    )?;
    if !VISIBILITIES.contains(&visibility) {
        return Err(StoreError::invalid(format!(
            "seed fact_purges: visibility must be private or world, not \"{visibility}\""
        )));
    }
    let k = key(&parts);
    if tx.get(&k)?.is_some() {
        return Ok(false);
    }
    put_json(
        tx,
        &k,
        &PurgeRecord {
            request_id,
            actor: note.0,
            reason: note.1,
            purged_at_us,
        },
    )?;
    Ok(true)
}

/// The shadow follow (`seed/follow/remove_state.rs`): removes the tombstone of the key. `false` when there is none.
pub(crate) fn remove_fact_purge(tx: &mut dyn KvWrite, parts: [&str; 4]) -> Result<bool> {
    if parts.iter().any(|p| p.contains('\0')) {
        return Ok(false);
    }
    let k = key(&parts);
    if tx.get(&k)?.is_none() {
        return Ok(false);
    }
    tx.delete(&k)?;
    Ok(true)
}

impl Store {
    /// `insertFactPurge`: stores the tombstone; false when the same key exists (`ON CONFLICT DO
    /// NOTHING`), which keeps its columns.
    pub fn insert_fact_purge(&self, row: &FactPurgeInsert) -> Result<bool> {
        let op = "insertFactPurge";
        no_nul(
            op,
            &[
                ("sourceId", &row.source_id),
                ("visibility", &row.visibility),
                ("subject", &row.subject),
                ("factHash", &row.fact_hash),
                ("actor", row.actor.as_deref().unwrap_or("")),
                ("reason", row.reason.as_deref().unwrap_or("")),
            ],
        )?;
        if !VISIBILITIES.contains(&row.visibility.as_str()) {
            return Err(StoreError::invalid(format!(
                "{op}: visibility must be private or world, not \"{}\"",
                row.visibility
            )));
        }
        let request_id = match &row.request_id {
            None => None,
            Some(text) if is_uuid(text) => Some(text.to_lowercase()),
            Some(_) => {
                return Err(StoreError::invalid(format!(
                    "{op}: requestId is not a UUID"
                )));
            }
        };
        let purged_at_us = self.env.now_micros();
        self.write(|tx| {
            require_source(tx, &row.source_id)?;
            let k = key(&[
                &row.source_id,
                &row.visibility,
                &row.subject,
                &row.fact_hash,
            ]);
            if get_json::<PurgeRecord>(tx, &k)?.is_some() {
                return Ok(false);
            }
            put_json(
                tx,
                &k,
                &PurgeRecord {
                    request_id: request_id.clone(),
                    actor: row.actor.clone(),
                    reason: row.reason.clone(),
                    purged_at_us,
                },
            )?;
            Ok(true)
        })
    }

    /// `insertPageFactPurges`: `INSERT ... SELECT DISTINCT` of the page purge: one tombstone for each distinct
    /// (visibility, entity or `*`, fingerprint) of the page's facts that are not outcome markers, reason `page purge`,
    /// at the transaction clock; a tombstone that exists keeps its columns (`ON CONFLICT DO NOTHING`). A missing source
    /// fails as the foreign key does, but only when there is a row to insert.
    pub fn insert_page_fact_purges(
        &self,
        source_id: &str,
        slug: &str,
        request_id: &str,
        actor: &str,
    ) -> Result<()> {
        let op = "insertPageFactPurges";
        no_nul(
            op,
            &[("sourceId", source_id), ("slug", slug), ("actor", actor)],
        )?;
        if !is_uuid(request_id) {
            return Err(StoreError::invalid(format!(
                "{op}: requestId is not a UUID"
            )));
        }
        let request_id = request_id.to_lowercase();
        self.write(|tx| {
            let rows = super::page_purge_reads::page_fact_tombstones(&*tx, source_id, slug)?;
            if rows.is_empty() {
                return Ok(());
            }
            require_source(tx, source_id)?;
            let purged_at_us = crate::env::transaction_clock::transaction_now()
                .unwrap_or_else(|| self.env.now_micros());
            for (hash, visibility, subject) in rows {
                let k = key(&[source_id, &visibility, &subject, &hash]);
                if get_json::<PurgeRecord>(tx, &k)?.is_some() {
                    continue;
                }
                put_json(
                    tx,
                    &k,
                    &PurgeRecord {
                        request_id: Some(request_id.clone()),
                        actor: Some(actor.to_string()),
                        reason: Some("page purge".to_string()),
                        purged_at_us,
                    },
                )?;
            }
            Ok(())
        })
    }

    /// `deleteFactPurgesByRequests`: removes the source's fact tombstones of these purge requests; how many.
    pub fn delete_fact_purges_by_requests(
        &self,
        source_id: &str,
        request_ids: &[String],
    ) -> Result<u64> {
        let op = "deleteFactPurgesByRequests";
        no_nul(op, &[("sourceId", source_id)])?;
        let mut wanted = BTreeSet::new();
        for id in request_ids {
            if !is_uuid(id) {
                return Err(StoreError::invalid(format!(
                    "{op}: requestIds holds a value that is not a UUID"
                )));
            }
            wanted.insert(id.to_lowercase());
        }
        self.write(|tx| {
            let mut doomed = Vec::new();
            let mut failed = None;
            scan_prefix(&*tx, &key(&[source_id]), false, &mut |k, v| {
                match serde_json::from_slice::<PurgeRecord>(v) {
                    Ok(r) => {
                        if r.request_id.as_ref().is_some_and(|id| wanted.contains(id)) {
                            doomed.push(k.to_vec());
                        }
                    }
                    Err(e) => {
                        failed = Some(e);
                        return false;
                    }
                }
                true
            })?;
            if let Some(e) = failed {
                return Err(StoreError::invalid(format!(
                    "{op}: corrupt fact purge record: {e}"
                )));
            }
            let count = doomed.len() as u64;
            for k in doomed {
                tx.delete(&k)?;
            }
            Ok(count)
        })
    }

    /// `isFactPurged`: whether a tombstone of the source at `visibility` names the fingerprint of
    /// `claim` for subject `*` or `entity_slug`. A visibility outside the CHECK matches nothing.
    pub fn is_fact_purged(
        &self,
        source_id: &str,
        visibility: &str,
        claim: &str,
        entity_slug: Option<&str>,
    ) -> Result<bool> {
        no_nul(
            "isFactPurged",
            &[
                ("sourceId", source_id),
                ("visibility", visibility),
                ("claim", claim),
                ("entitySlug", entity_slug.unwrap_or("")),
            ],
        )?;
        purged_claim(&*self.read()?, source_id, visibility, claim, entity_slug)
    }

    /// `listGlobalPurgeWithdrawals(sourceId, hashes, worldOnly)`: the source's subject `*` tombstones
    /// of `hashes` as withdrawals, in (visibility, fact_hash) order.
    pub fn list_global_purge_withdrawals(
        &self,
        source_id: &str,
        hashes: &[String],
        world_only: bool,
    ) -> Result<Vec<serde_json::Value>> {
        global_purge_withdrawals(&*self.read()?, source_id, hashes, world_only)
    }

    /// Whether the source has any fact purge tombstone (`readLedgerSource`'s `purgesPossible`).
    pub fn has_fact_purges(&self, source_id: &str) -> Result<bool> {
        no_nul("hasFactPurges", &[("sourceId", source_id)])?;
        has_fact_purges(&*self.read()?, source_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OpenOptions;
    use crate::sources::SourceInput;
    use serde_json::json;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tombstone(source: &str) -> FactPurgeInsert {
        serde_json::from_value(
            json!({ "sourceId": source, "visibility": "world", "subject": "*",
            "factHash": "abc", "requestId": null, "actor": null, "reason": null }),
        )
        .unwrap()
    }

    #[test]
    fn deleting_a_source_removes_its_tombstones_only() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/unit-tmp")
            .join(format!("fact-purges-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _guard = Dir(dir.clone());
        let store = Store::open_dir(&dir.join("brain"), OpenOptions::default()).unwrap();
        let team: SourceInput = serde_json::from_value(json!({ "id": "team" })).unwrap();
        store.upsert_source(&team).unwrap();
        assert!(store.insert_fact_purge(&tombstone("default")).unwrap());
        assert!(store.insert_fact_purge(&tombstone("team")).unwrap());
        store
            .write(|tx| crate::cascade::remove_source_rows(tx, "team"))
            .unwrap();
        assert!(!store.has_fact_purges("team").unwrap());
        assert!(store.has_fact_purges("default").unwrap());
    }
}
