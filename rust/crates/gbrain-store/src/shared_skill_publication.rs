//! Shared skill publication on a Rust brain: the activation flag, the sealed pack rows, and the
//! reads and checks `put_skill` makes before it writes revisions, heads and the pack in one bound
//! store transaction.
//!
//! The SQL engines keep the flag on `persistence_brain` (`skill_bundles_enabled`,
//! `writer_protocol_floor`) and activate it under the quiescence rules of activation.ts and
//! skill-activation.ts. A Rust brain has no managed persistence epoch and no worktree bindings, so
//! the flag lives in its own meta record and activation checks what the SQL engines check, in the
//! same order: a registered canonical root (a live source with a local path), no legacy cycle lock
//! (an `embed-page:` lease is not one), no blocking request, no effect holding a recovery record,
//! and no queued or running effect.
//!
//! Keys:
//! - `M shared_skill_publication` -> `FlagRecord` (JSON). Absent means disabled at floor 1.
//! - `x 0x0c <source id> 0x00 <incarnation>` -> `PackRecord` (JSON): one `shared_skill_packs` row.
//!
//! Retention follows retention.ts: `stored_bytes` is the byte length of the jsonb text of `files`
//! plus that of `metadata`; a revision is eligible for pruning when it is not a head, not deleted,
//! not under a live lease, not named by a pending publication, below the 20 newest of its skill,
//! and older than the 24-hour grace period.

use crate::cli_reads::pg_text::jsonb_text;
use crate::env::iso;
use crate::error::Result;
use crate::kv::{KvRead, KvWrite};
use crate::shared_skill_catalog::{
    DAY_US, HEAD, HeadRecord, LEASE, LeaseRecord, REVISION, RevisionRecord, key, scan_json,
};
use crate::shared_skill_members::{now, refused, uuid};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const PACK: u8 = 0x0c;
const FLAG: &str = "shared_skill_publication";

const RECENT_PER_SKILL: usize = 20;
const GRACE_US: i64 = DAY_US;
const PRUNE_BATCH: usize = 128;

/// The activation flag.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FlagRecord {
    skill_bundles_enabled: bool,
    writer_protocol_floor: i64,
    activated_at_us: i64,
}

/// One `shared_skill_packs` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PackRecord {
    source_id: String,
    source_incarnation: String,
    pack_id: String,
    revision: String,
    manifest: Value,
    manifest_hash: String,
}

/// A source and incarnation.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillSourceKey {
    pub source_id: String,
    pub incarnation: String,
}

/// The heads of one pack: `limit` keys, or the revisions of `names`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillPackHeads {
    pub source_id: String,
    pub incarnation: String,
    pub pack_id: String,
    pub limit: i64,
    pub names: Vec<String>,
}

/// One expected head of the dependency closure.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ExpectedHead {
    pub name: String,
    pub revision: Option<String>,
}

/// One incoming revision's stored columns.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct IncomingRevision {
    pub metadata: Value,
    pub files: Value,
}

/// The checks `put_skill` makes in its transaction before it writes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillPublicationCheck {
    pub source_id: String,
    pub incarnation: String,
    pub pack_id: String,
    pub expected_pack_revision: Option<String>,
    pub heads: Vec<ExpectedHead>,
    pub revisions: Vec<IncomingRevision>,
}

/// One `shared_skill_packs` upsert.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillPackWrite {
    pub source_id: String,
    pub incarnation: String,
    pub pack_id: String,
    pub revision: String,
    pub manifest: Value,
    pub manifest_hash: String,
}

fn flag(read: &dyn KvRead) -> Result<Option<FlagRecord>> {
    get_json(read, &keys::meta(FLAG))
}

/// True once publication was activated on this brain (`skill_bundles_enabled`), whatever the floor.
pub(crate) fn publication_activated(read: &dyn KvRead) -> Result<bool> {
    Ok(flag(read)?.is_some_and(|f| f.skill_bundles_enabled))
}

/// `skill_bundles_enabled AND writer_protocol_floor = 2`.
pub(crate) fn publication_enabled(read: &dyn KvRead) -> Result<bool> {
    Ok(flag(read)?.is_some_and(|f| f.skill_bundles_enabled && f.writer_protocol_floor == 2))
}

fn disabled() -> crate::error::StoreError {
    refused(
        "shared_skill_publication",
        "writer_not_quiesced: shared publication is disabled".to_string(),
    )
}

fn stored_bytes(metadata: &Value, files: &Value) -> i64 {
    (jsonb_text(files).len() + jsonb_text(metadata).len()) as i64
}

fn revisions_of(read: &dyn KvRead, source: Option<(&str, &str)>) -> Result<Vec<RevisionRecord>> {
    let mut prefix = vec![keys::ACCESS_MEMBERS, REVISION];
    if let Some((id, inc)) = source {
        prefix = key(REVISION, &[id, inc]);
        prefix.push(0);
    }
    scan_json(read, &prefix)
}

/// One revision of a source incarnation with the flags retention.ts derives for it.
struct Candidate {
    key: Vec<u8>,
    bytes: i64,
    head: bool,
    deleted: bool,
    leased: bool,
    publishing: bool,
    eligible: bool,
    order: (i64, String, String, String),
}

fn candidates(read: &dyn KvRead, source: &str, inc: &str, now_us: i64) -> Result<Vec<Candidate>> {
    let pending = crate::persistence::pending_skill_revisions(read, source, inc)?;
    let leases: Vec<LeaseRecord> = scan_json(read, &[keys::ACCESS_MEMBERS, LEASE])?;
    let live = |r: &RevisionRecord| {
        leases.iter().any(|l| {
            l.source_id == r.source_id
                && l.source_incarnation == r.source_incarnation
                && l.pack_id == r.pack_id
                && l.name == r.name
                && l.revision == r.revision
                && l.expires_at_us > now_us
        })
    };
    let mut by_skill: BTreeMap<(String, String), Vec<RevisionRecord>> = BTreeMap::new();
    for r in revisions_of(read, Some((source, inc)))? {
        by_skill
            .entry((r.pack_id.clone(), r.name.clone()))
            .or_default()
            .push(r);
    }
    let mut out = Vec::new();
    for ((pack, name), mut rows) in by_skill {
        rows.sort_by(|a, b| (b.created_at_us, &b.revision).cmp(&(a.created_at_us, &a.revision)));
        let head: Option<HeadRecord> = get_json(read, &key(HEAD, &[source, inc, &pack, &name]))?;
        for (i, r) in rows.into_iter().enumerate() {
            let is_head = head.as_ref().is_some_and(|h| h.revision == r.revision);
            let leased = live(&r);
            let publishing = pending.contains(&r.revision);
            let eligible = !(is_head || r.deleted || leased || publishing)
                && i + 1 > RECENT_PER_SKILL
                && r.created_at_us < now_us - GRACE_US;
            out.push(Candidate {
                key: key(REVISION, &[source, inc, &pack, &name, &r.revision]),
                bytes: stored_bytes(&r.metadata, &r.files),
                head: is_head,
                deleted: r.deleted,
                leased,
                publishing,
                eligible,
                order: (
                    r.created_at_us,
                    pack.clone(),
                    name.clone(),
                    r.revision.clone(),
                ),
            });
        }
    }
    Ok(out)
}

fn brain_totals(read: &dyn KvRead) -> Result<(i64, i64)> {
    let all = revisions_of(read, None)?;
    let bytes = all
        .iter()
        .map(|r| stored_bytes(&r.metadata, &r.files))
        .sum();
    Ok((all.len() as i64, bytes))
}

/// `pruneSharedSkillRevisionsInTransaction`: drops the source's expired leases, then deletes at
/// most one batch of eligible revisions, oldest first, that no lease names.
fn prune(tx: &mut dyn KvWrite, source: &str, inc: &str, now_us: i64) -> Result<i64> {
    let leases: Vec<(Vec<u8>, LeaseRecord)> = {
        let mut rows = Vec::new();
        let prefix = [keys::ACCESS_MEMBERS, LEASE];
        let mut bad = None;
        crate::kv::scan_prefix(&*tx, &prefix, false, &mut |k, v| {
            match serde_json::from_slice::<LeaseRecord>(v) {
                Ok(l) => rows.push((k.to_vec(), l)),
                Err(e) => bad = Some(e),
            }
            bad.is_none()
        })?;
        if let Some(e) = bad {
            return Err(e.into());
        }
        rows
    };
    let mut kept = Vec::new();
    for (k, l) in leases {
        if l.source_id == source && l.source_incarnation == inc && l.expires_at_us <= now_us {
            tx.delete(&k)?;
        } else {
            kept.push(l);
        }
    }
    let mut eligible: Vec<Candidate> = candidates(&*tx, source, inc, now_us)?
        .into_iter()
        .filter(|c| c.eligible)
        .collect();
    eligible.sort_by(|a, b| a.order.cmp(&b.order));
    let mut pruned = 0;
    for c in eligible.into_iter().take(PRUNE_BATCH) {
        let (_, pack, name, revision) = &c.order;
        let named = kept.iter().any(|l| {
            l.source_id == source
                && l.source_incarnation == inc
                && &l.pack_id == pack
                && &l.name == name
                && &l.revision == revision
        });
        if !named {
            tx.delete(&c.key)?;
            pruned += 1;
        }
    }
    Ok(pruned)
}

fn capacity(read: &dyn KvRead, source: &str, inc: &str) -> Result<Value> {
    let rows = revisions_of(read, Some((source, inc)))?;
    let bytes: i64 = rows
        .iter()
        .map(|r| stored_bytes(&r.metadata, &r.files))
        .sum();
    let (brain_revisions, brain_bytes) = brain_totals(read)?;
    Ok(json!({
        "retained_revisions": rows.len(),
        "retained_bytes": bytes,
        "brain_retained_revisions": brain_revisions,
        "brain_retained_bytes": brain_bytes,
    }))
}

fn pack_key(source: &str, inc: &str) -> Vec<u8> {
    key(PACK, &[source, inc])
}

fn revision_row(r: &RevisionRecord) -> Value {
    json!({
        "source_id": r.source_id,
        "source_incarnation": r.source_incarnation,
        "pack_id": r.pack_id,
        "name": r.name,
        "revision": r.revision,
        "metadata": r.metadata,
        "files": r.files,
        "deleted": r.deleted,
        "policy_epoch": r.policy_epoch,
        "request_id": r.request_id,
        "created_at": iso(r.created_at_us),
        "stored_bytes": stored_bytes(&r.metadata, &r.files),
    })
}

fn heads_of(read: &dyn KvRead, source: &str, inc: &str, pack: &str) -> Result<Vec<HeadRecord>> {
    let mut prefix = key(HEAD, &[source, inc, pack]);
    prefix.push(0);
    scan_json(read, &prefix)
}

impl Store {
    /// The activation flag: `{skill_bundles_enabled, writer_protocol_floor}`.
    pub fn read_shared_skill_publication(&self) -> Result<Value> {
        let f = flag(&*self.read()?)?;
        Ok(json!({
            "skill_bundles_enabled": f.as_ref().is_some_and(|f| f.skill_bundles_enabled),
            "writer_protocol_floor": f.as_ref().map_or(1, |f| f.writer_protocol_floor),
        }))
    }

    /// Activates shared publication, or reports the first thing that keeps it from activating:
    /// `{registration_required}`, `{legacy_lock}`, `{blocked}` (with its `phase`), or
    /// `{activated, protocol_version: 2, filesystem_sources}`. A dry run writes nothing.
    pub fn activate_shared_skill_publication(&self, dry_run: bool) -> Result<Value> {
        self.write(|tx| {
            let roots = crate::sources::all_sources(&*tx)?
                .into_iter()
                .filter(|s| !s.archived && s.local_path.as_deref().is_some_and(|p| !p.is_empty()))
                .count();
            if roots == 0 {
                return Ok(json!({ "registration_required": true }));
            }
            if crate::jobs::cycle_lock_ids(&*tx)?
                .iter()
                .any(|id| !id.starts_with("embed-page:"))
            {
                return Ok(json!({ "legacy_lock": true }));
            }
            if let Some(blocked) = crate::persistence::activation_blocker(&*tx)? {
                return Ok(json!({ "blocked": blocked }));
            }
            if !dry_run {
                put_json(
                    tx,
                    &keys::meta(FLAG),
                    &FlagRecord {
                        skill_bundles_enabled: true,
                        writer_protocol_floor: 2,
                        activated_at_us: now(self),
                    },
                )?;
            }
            Ok(json!({ "activated": !dry_run, "protocol_version": 2, "filesystem_sources": roots }))
        })
    }

    /// The source a publication binds: `{id, incarnation, archived, local_path, aliases}`, where
    /// `aliases` are the other live sources registered at the same local path; null when absent.
    pub fn read_shared_skill_source(&self, source_id: &str) -> Result<Value> {
        let sources = crate::sources::all_sources(&*self.read()?)?;
        let Some(s) = sources.iter().find(|s| s.id == source_id) else {
            return Ok(Value::Null);
        };
        let aliases: Vec<&str> = match s.local_path.as_deref() {
            Some(path) if !path.is_empty() => sources
                .iter()
                .filter(|o| o.id != s.id && !o.archived && o.local_path.as_deref() == Some(path))
                .map(|o| o.id.as_str())
                .collect(),
            _ => Vec::new(),
        };
        Ok(json!({
            "id": s.id,
            "incarnation": s.incarnation,
            "archived": s.archived,
            "local_path": s.local_path,
            "aliases": aliases,
        }))
    }

    /// `SELECT * FROM shared_skill_packs WHERE source_id AND source_incarnation`, or null.
    pub fn read_shared_skill_pack(&self, k: &SharedSkillSourceKey) -> Result<Value> {
        let rec: Option<PackRecord> = get_json(
            &*self.read()?,
            &pack_key(&k.source_id, &uuid(&k.incarnation)?),
        )?;
        Ok(rec.map_or(Value::Null, |p| {
            json!({
                "source_id": p.source_id,
                "source_incarnation": p.source_incarnation,
                "pack_id": p.pack_id,
                "revision": p.revision,
                "manifest": p.manifest,
                "manifest_hash": p.manifest_hash,
            })
        }))
    }

    /// The pack's head keys `{name, revision, deleted}` in name order, at most `limit`.
    pub fn list_shared_skill_head_keys(&self, q: &SharedSkillPackHeads) -> Result<Value> {
        let limit = usize::try_from(q.limit.max(0)).unwrap_or(usize::MAX);
        let rows = heads_of(
            &*self.read()?,
            &q.source_id,
            &uuid(&q.incarnation)?,
            &q.pack_id,
        )?;
        Ok(Value::Array(
            rows.into_iter()
                .take(limit)
                .map(|h| json!({ "name": h.name, "revision": h.revision, "deleted": h.deleted }))
                .collect(),
        ))
    }

    /// The revision rows the heads of `names` point at, in name order.
    pub fn read_shared_skill_head_revisions(&self, q: &SharedSkillPackHeads) -> Result<Value> {
        let read = self.read()?;
        let inc = uuid(&q.incarnation)?;
        let names: BTreeSet<&str> = q.names.iter().map(String::as_str).collect();
        let mut rows = Vec::new();
        for h in heads_of(&*read, &q.source_id, &inc, &q.pack_id)? {
            if !names.contains(h.name.as_str()) {
                continue;
            }
            let rkey = key(
                REVISION,
                &[&h.source_id, &inc, &h.pack_id, &h.name, &h.revision],
            );
            if let Some(r) = get_json::<RevisionRecord>(&*read, &rkey)? {
                rows.push(revision_row(&r));
            }
        }
        Ok(Value::Array(rows))
    }

    /// The checks of `prepareSharedSkillMutation(...).validate` that read the catalog: the flag,
    /// the pack revision, the closure heads (in name order), the prune, then the retention
    /// capacity and the incoming bytes. A changed pack or head returns `{conflict}` and writes
    /// nothing; otherwise `{pruned, capacity, incoming_bytes}`.
    pub fn check_shared_skill_publication(&self, c: &SharedSkillPublicationCheck) -> Result<Value> {
        let inc = uuid(&c.incarnation)?;
        self.write(|tx| {
            if !publication_enabled(&*tx)? {
                return Err(disabled());
            }
            let pack: Option<PackRecord> = get_json(&*tx, &pack_key(&c.source_id, &inc))?;
            if pack.map(|p| p.revision) != c.expected_pack_revision {
                return Ok(json!({ "conflict": "pack" }));
            }
            let mut heads = c.heads.clone();
            heads.sort_by(|a, b| a.name.cmp(&b.name));
            for target in &heads {
                let head: Option<HeadRecord> = get_json(
                    &*tx,
                    &key(HEAD, &[&c.source_id, &inc, &c.pack_id, &target.name]),
                )?;
                if head.map(|h| h.revision) != target.revision {
                    return Ok(json!({ "conflict": "head" }));
                }
            }
            let pruned = prune(tx, &c.source_id, &inc, now(self))?;
            let incoming: i64 = c
                .revisions
                .iter()
                .map(|r| stored_bytes(&r.metadata, &r.files))
                .sum();
            Ok(json!({
                "pruned": pruned,
                "capacity": capacity(&*tx, &c.source_id, &inc)?,
                "incoming_bytes": incoming,
            }))
        })
    }

    /// The `shared_skill_packs` upsert of one publication; refuses while publication is disabled.
    pub fn write_shared_skill_pack(&self, w: &SharedSkillPackWrite) -> Result<()> {
        let inc = uuid(&w.incarnation)?;
        let revision = uuid(&w.revision)?;
        self.write(|tx| {
            if !publication_enabled(&*tx)? {
                return Err(disabled());
            }
            put_json(
                tx,
                &pack_key(&w.source_id, &inc),
                &PackRecord {
                    source_id: w.source_id.clone(),
                    source_incarnation: inc.clone(),
                    pack_id: w.pack_id.clone(),
                    revision: revision.clone(),
                    manifest: w.manifest.clone(),
                    manifest_hash: w.manifest_hash.clone(),
                },
            )
        })
    }

    /// `sharedSkillRetentionStatus` without the limits: the source's and the brain's retained
    /// counts and bytes, and the protected and eligible counts.
    pub fn read_shared_skill_retention(&self, k: &SharedSkillSourceKey) -> Result<Value> {
        let read = self.read()?;
        let inc = uuid(&k.incarnation)?;
        let rows = candidates(&*read, &k.source_id, &inc, now(self))?;
        let count = |f: fn(&Candidate) -> bool| rows.iter().filter(|c| f(c)).count();
        let (brain_revisions, brain_bytes) = brain_totals(&*read)?;
        Ok(json!({
            "retained_revisions": rows.len(),
            "retained_bytes": rows.iter().map(|c| c.bytes).sum::<i64>(),
            "protected_heads": count(|c| c.head),
            "protected_tombstones": count(|c| c.deleted),
            "protected_leases": count(|c| c.leased),
            "protected_publications": count(|c| c.publishing),
            "eligible_revisions": count(|c| c.eligible),
            "brain_retained_revisions": brain_revisions,
            "brain_retained_bytes": brain_bytes,
        }))
    }
}
