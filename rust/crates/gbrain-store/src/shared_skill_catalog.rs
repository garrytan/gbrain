//! Shared-skill catalog rows: the `shared_skill_policies`, `shared_skill_policy_audit`,
//! `shared_skill_heads`, `shared_skill_revisions` and `shared_skill_revision_leases` tables of the
//! PGLite engine, as set_skill_policy, the catalog read and sync_brain_skills' delivery leases use
//! them (engine-sql/shared-skill-members.ts).
//!
//! Keys (every record starts with `keys::ACCESS_MEMBERS`, `x`; shared_skill_members.rs holds
//! 0x04-0x06). Text parts end with 0x00; ids hold no NUL (Postgres text holds none):
//! - `x 0x07 <source> 0 <incarnation>` -> `PolicyRecord` (JSON).
//! - `x 0x08 <audit id>` -> `PolicyAuditRecord` (JSON), append only.
//! - `x 0x09 <source> 0 <incarnation> 0 <pack> 0 <name>` -> `HeadRecord` (JSON).
//! - `x 0x0a <source> 0 <incarnation> 0 <pack> 0 <name> 0 <revision>` -> `RevisionRecord` (JSON).
//! - `x 0x0b <kind> 0 <lease id> 0 <source> 0 <incarnation> 0 <pack> 0 <name> 0 <revision>` ->
//!   `LeaseRecord` (JSON).
//!
//! The SQL engines guard heads and revisions with the publication trigger (an activated brain,
//! skill bundles enabled, a coordinated write of the source). On a Rust brain the engine member
//! that publishes checks the activation flag (shared_skill_publication.rs) before it reaches the
//! store; `write_shared_skill_revision` itself also serves fixtures that seed a catalog the way a
//! trigger-bypassing fixture transaction seeds the SQL engines.
//!
//! The head list orders by byte order of its key; Postgres orders text by the database collation,
//! which agrees for the lowercase ids skill packs use.

use crate::env::iso;
use crate::error::Result;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::shared_skill_members::{now, refused, uuid};
use crate::{Store, get_json, keys, put_json};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(crate) const POLICY: u8 = 0x07;
const POLICY_AUDIT: u8 = 0x08;
pub(crate) const HEAD: u8 = 0x09;
pub(crate) const REVISION: u8 = 0x0a;
pub(crate) const LEASE: u8 = 0x0b;

pub(crate) const DAY_US: i64 = 24 * 3_600_000_000;

pub(crate) fn key(tag: u8, parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::ACCESS_MEMBERS, tag];
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part.as_bytes());
    }
    key
}

/// One `shared_skill_policies` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PolicyRecord {
    epoch: String,
    policy: Value,
    updated_at_us: i64,
}

/// One `shared_skill_policy_audit` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PolicyAuditRecord {
    id: String,
    source_id: String,
    source_incarnation: String,
    principal_kind: String,
    principal_id: String,
    previous_epoch: String,
    epoch: String,
    policy: Value,
    created_at_us: i64,
}

/// One `shared_skill_heads` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct HeadRecord {
    pub(crate) source_id: String,
    pub(crate) source_incarnation: String,
    pub(crate) pack_id: String,
    pub(crate) name: String,
    pub(crate) revision: String,
    pub(crate) metadata: Value,
    pub(crate) deleted: bool,
    pub(crate) policy_epoch: String,
    pub(crate) updated_at_us: i64,
}

/// One `shared_skill_revisions` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RevisionRecord {
    pub(crate) source_id: String,
    pub(crate) source_incarnation: String,
    pub(crate) pack_id: String,
    pub(crate) name: String,
    pub(crate) revision: String,
    pub(crate) metadata: Value,
    pub(crate) files: Value,
    pub(crate) deleted: bool,
    pub(crate) policy_epoch: String,
    pub(crate) request_id: String,
    pub(crate) created_at_us: i64,
}

/// One `shared_skill_revision_leases` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LeaseRecord {
    pub(crate) lease_kind: String,
    pub(crate) lease_id: String,
    pub(crate) source_id: String,
    pub(crate) source_incarnation: String,
    pub(crate) pack_id: String,
    pub(crate) name: String,
    pub(crate) revision: String,
    pub(crate) principal_kind: String,
    pub(crate) principal_id: String,
    pub(crate) expires_at_us: i64,
}

/// `writeSharedSkillPolicy(write)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillPolicyWrite {
    pub source_id: String,
    pub incarnation: String,
    pub epoch: String,
    pub policy: Value,
    pub principal_kind: String,
    pub principal_id: String,
    pub previous_epoch: String,
}

/// `writeSharedSkillRevision(write)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillRevisionWrite {
    pub source_id: String,
    pub incarnation: String,
    pub pack_id: String,
    pub name: String,
    pub revision: String,
    pub metadata: Value,
    pub files: Value,
    pub deleted: bool,
    pub policy_epoch: String,
    pub request_id: String,
}

/// `readSharedSkillRevision(key)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillRevisionKey {
    pub source_id: String,
    pub incarnation: String,
    pub pack_id: String,
    pub name: String,
    pub revision: String,
}

/// `listSharedSkillCatalogHeads(query)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillHeadQuery {
    pub source_ids: Option<Vec<String>>,
    pub limit: i64,
    pub source_id: Option<String>,
    pub source_incarnation: Option<String>,
    pub pack_id: Option<String>,
    pub name: Option<String>,
    pub hide_private: bool,
}

pub(crate) fn scan_json<T: DeserializeOwned>(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<T>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, prefix, false, &mut |_, v| {
        match serde_json::from_slice::<T>(v) {
            Ok(r) => out.push(r),
            Err(e) => bad = Some(e),
        }
        bad.is_none()
    })?;
    match bad {
        Some(e) => Err(e.into()),
        None => Ok(out),
    }
}

fn head_json(h: &HeadRecord, policy: Option<&PolicyRecord>) -> Value {
    json!({
        "source_id": h.source_id,
        "source_incarnation": h.source_incarnation,
        "pack_id": h.pack_id,
        "name": h.name,
        "revision": h.revision,
        "metadata": h.metadata,
        "deleted": h.deleted,
        "policy_epoch": h.policy_epoch,
        "updated_at": iso(h.updated_at_us),
        "current_policy": policy.map(|p| p.policy.clone()),
        "current_epoch": policy.map(|p| p.epoch.clone()),
    })
}

/// The delivery item a batch names for a revision: `brain/source/incarnation/pack/name@revision`.
fn delivery_item(brain_id: &str, r: &RevisionRecord) -> String {
    format!(
        "{brain_id}/{}/{}/{}/{}@{}",
        r.source_id, r.source_incarnation, r.pack_id, r.name, r.revision
    )
}

/// The delivery-lease trigger of `shared_skill_delivery_batches`: for each item in value order,
/// the retained revision it names (refused with `revision_unavailable` when there is none), then
/// a `delivery` lease on it that expires at `LEAST(issued_at, now) + 24h`, never moved earlier.
/// A refusal leaves the caller's write to roll back with everything it did before.
pub(crate) fn lease_delivery_revisions(
    tx: &mut dyn KvWrite,
    brain_id: &str,
    items: &[String],
    issued_at_us: i64,
    now_us: i64,
) -> Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let retained: BTreeMap<String, RevisionRecord> =
        scan_json::<RevisionRecord>(&*tx, &[keys::ACCESS_MEMBERS, REVISION])?
            .into_iter()
            .filter(|_| !brain_id.is_empty())
            .map(|r| (delivery_item(brain_id, &r), r))
            .collect();
    let mut sorted: Vec<&String> = items.iter().collect();
    sorted.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let expires_at_us = issued_at_us.min(now_us) + DAY_US;
    for item in sorted {
        let Some(r) = retained.get(item) else {
            return Err(refused(
                "shared_skill_delivery_lease",
                "revision_unavailable: delivery revision is no longer retained".to_string(),
            ));
        };
        let lkey = key(
            LEASE,
            &[
                "delivery",
                &r.revision,
                &r.source_id,
                &r.source_incarnation,
                &r.pack_id,
                &r.name,
                &r.revision,
            ],
        );
        let expires = match get_json::<LeaseRecord>(&*tx, &lkey)? {
            Some(prior) => prior.expires_at_us.max(expires_at_us),
            None => expires_at_us,
        };
        put_json(
            tx,
            &lkey,
            &LeaseRecord {
                lease_kind: "delivery".to_string(),
                lease_id: r.revision.clone(),
                source_id: r.source_id.clone(),
                source_incarnation: r.source_incarnation.clone(),
                pack_id: r.pack_id.clone(),
                name: r.name.clone(),
                revision: r.revision.clone(),
                principal_kind: "application".to_string(),
                principal_id: "delivery".to_string(),
                expires_at_us: expires,
            },
        )?;
    }
    Ok(())
}

/// Inserts one revision (an existing one is the primary key's refusal), then inserts or replaces
/// the head of its skill, inside the caller's write.
pub(crate) fn write_revision_in(
    tx: &mut dyn KvWrite,
    now_us: i64,
    w: &SharedSkillRevisionWrite,
) -> Result<()> {
    let incarnation = uuid(&w.incarnation)?;
    let revision = uuid(&w.revision)?;
    let request_id = uuid(&w.request_id)?;
    let rkey = key(
        REVISION,
        &[&w.source_id, &incarnation, &w.pack_id, &w.name, &revision],
    );
    if tx.get(&rkey)?.is_some() {
        return Err(refused(
            "shared_skill_revisions_pkey",
            format!(
                "duplicate key value violates unique constraint \"shared_skill_revisions_pkey\": Key (source_id, source_incarnation, pack_id, name, revision)=({}, {incarnation}, {}, {}, {revision}) already exists.",
                w.source_id, w.pack_id, w.name
            ),
        ));
    }
    put_json(
        tx,
        &rkey,
        &RevisionRecord {
            source_id: w.source_id.clone(),
            source_incarnation: incarnation.clone(),
            pack_id: w.pack_id.clone(),
            name: w.name.clone(),
            revision: revision.clone(),
            metadata: w.metadata.clone(),
            files: w.files.clone(),
            deleted: w.deleted,
            policy_epoch: w.policy_epoch.clone(),
            request_id: request_id.clone(),
            created_at_us: now_us,
        },
    )?;
    put_json(
        tx,
        &key(HEAD, &[&w.source_id, &incarnation, &w.pack_id, &w.name]),
        &HeadRecord {
            source_id: w.source_id.clone(),
            source_incarnation: incarnation.clone(),
            pack_id: w.pack_id.clone(),
            name: w.name.clone(),
            revision: revision.clone(),
            metadata: w.metadata.clone(),
            deleted: w.deleted,
            policy_epoch: w.policy_epoch.clone(),
            updated_at_us: now_us,
        },
    )
}

impl Store {
    /// `writeSharedSkillPolicy(write)`, in one write: the source incarnation's policy under the
    /// new epoch (inserted, or replacing the stored one with `updated_at` now), then its audit row.
    pub fn write_shared_skill_policy(&self, w: &SharedSkillPolicyWrite) -> Result<()> {
        let incarnation = uuid(&w.incarnation)?;
        let epoch = uuid(&w.epoch)?;
        let env = self.env.clone();
        self.write(|tx| {
            let now_us = now(self);
            put_json(
                tx,
                &key(POLICY, &[&w.source_id, &incarnation]),
                &PolicyRecord {
                    epoch: epoch.clone(),
                    policy: w.policy.clone(),
                    updated_at_us: now_us,
                },
            )?;
            let id = env.new_uuid();
            put_json(
                tx,
                &key(POLICY_AUDIT, &[&id]),
                &PolicyAuditRecord {
                    id: id.clone(),
                    source_id: w.source_id.clone(),
                    source_incarnation: incarnation.clone(),
                    principal_kind: w.principal_kind.clone(),
                    principal_id: w.principal_id.clone(),
                    previous_epoch: w.previous_epoch.clone(),
                    epoch: epoch.clone(),
                    policy: w.policy.clone(),
                    created_at_us: now_us,
                },
            )
        })
    }

    /// `readSharedSkillPolicyRow(sourceId, incarnation)`: `{ epoch, policy }`, or null.
    pub fn read_shared_skill_policy_row(
        &self,
        source_id: &str,
        incarnation: &str,
    ) -> Result<Value> {
        let pkey = key(POLICY, &[source_id, &uuid(incarnation)?]);
        Ok(get_json::<PolicyRecord>(&*self.read()?, &pkey)?
            .map(|p| json!({ "epoch": p.epoch, "policy": p.policy }))
            .unwrap_or(Value::Null))
    }

    /// `writeSharedSkillRevision(write)`, in one write: inserts the revision (an existing one is
    /// the primary key's refusal), then inserts or replaces the head of its skill.
    pub fn write_shared_skill_revision(&self, w: &SharedSkillRevisionWrite) -> Result<()> {
        self.write(|tx| write_revision_in(tx, now(self), w))
    }

    /// `readSharedSkillRevision(key)`: the stored revision that is not deleted, or null.
    pub fn read_shared_skill_revision(&self, k: &SharedSkillRevisionKey) -> Result<Value> {
        let rkey = key(
            REVISION,
            &[
                &k.source_id,
                &uuid(&k.incarnation)?,
                &k.pack_id,
                &k.name,
                &uuid(&k.revision)?,
            ],
        );
        Ok(get_json::<RevisionRecord>(&*self.read()?, &rkey)?
            .filter(|r| !r.deleted)
            .map(|r| {
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
                })
            })
            .unwrap_or(Value::Null))
    }

    /// `listSharedSkillCatalogHeads(query)`: the heads that are not deleted, of a source that is
    /// not archived at the head's incarnation, that match every filter given, in key order, at
    /// most `limit`; each with the source incarnation's current policy and epoch, or nulls.
    pub fn list_shared_skill_catalog_heads(&self, q: &SharedSkillHeadQuery) -> Result<Value> {
        let read = self.read()?;
        let live: BTreeMap<String, String> = crate::sources::all_sources(&*read)?
            .into_iter()
            .filter(|s| !s.archived)
            .map(|s| (s.id, s.incarnation))
            .collect();
        let limit = usize::try_from(q.limit.max(0)).unwrap_or(usize::MAX);
        let mut rows = Vec::new();
        for h in scan_json::<HeadRecord>(&*read, &[keys::ACCESS_MEMBERS, HEAD])? {
            if rows.len() >= limit {
                break;
            }
            let private = h.metadata.get("private").and_then(Value::as_bool) == Some(true);
            if h.deleted
                || live.get(&h.source_id) != Some(&h.source_incarnation)
                || q.source_ids
                    .as_ref()
                    .is_some_and(|ids| !ids.contains(&h.source_id))
                || q.source_id.as_ref().is_some_and(|s| s != &h.source_id)
                || q.source_incarnation
                    .as_ref()
                    .is_some_and(|s| s != &h.source_incarnation)
                || q.pack_id.as_ref().is_some_and(|s| s != &h.pack_id)
                || q.name.as_ref().is_some_and(|s| s != &h.name)
                || q.hide_private && private
            {
                continue;
            }
            let policy = get_json::<PolicyRecord>(
                &*read,
                &key(POLICY, &[&h.source_id, &h.source_incarnation]),
            )?;
            rows.push(head_json(&h, policy.as_ref()));
        }
        Ok(Value::Array(rows))
    }
}
