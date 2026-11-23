//! Shared-skill membership: the `shared_skill_state`, `shared_skill_members` and
//! `shared_skill_delivery_batches` tables of the PGLite engine, as join_brain, sync_brain_skills
//! and leave_brain use them (engine-sql/shared-skill-members.ts).
//!
//! Keys (every record starts with `keys::ACCESS_MEMBERS`, `x`; access_members.rs holds 0x01-0x03):
//! - `x 0x04` -> `StateRecord` (JSON): the catalog token secret.
//! - `x 0x05 <installation id>` -> `MemberRecord` (JSON).
//! - `x 0x06 <installation id> 0x00 <token>` -> `BatchRecord` (JSON). A member's batches are the
//!   prefix `x 0x06 <installation id> 0x00`; ids are lowercase UUID text, so they hold no NUL.
//!
//! A brain holds at most 4096 members (join_brain's quota), so the principal-and-adapter lookup
//! and the member count scan the member prefix. A member keeps at most `retainedBatches` batches.
//!
//! The token secret is 64 lowercase hex digits from two random UUIDs, as the Postgres column
//! default builds it. A fresh brain gets it in `seed`; a brain created before this family mints it
//! on the first read, in one write.
//!
//! A new batch leases each revision it names as the Postgres delivery-lease trigger does
//! (shared_skill_catalog.rs); a revision the store does not retain refuses the whole issue with
//! `revision_unavailable`, so the prune before it rolls back too.
//!
//! Each method is one `Store::write` or one read, so a multi-statement write of the SQL engines
//! (`issueSharedSkillDeliveryBatch`, `acknowledgeSharedSkillDeliveryBatch`) commits together or
//! not at all; inside an engine transaction it is one statement of it. Refusals carry
//! `constraint_violation` with the Postgres constraint name in the message.

use crate::env::{Env, iso, transaction_clock};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const STATE: u8 = 0x04;
const MEMBER: u8 = 0x05;
const BATCH: u8 = 0x06;

const HOUR_US: i64 = 3_600_000_000;
const DAY_US: i64 = 24 * HOUR_US;
const MINUTE_US: i64 = 60_000_000;

pub(crate) fn state_key() -> Vec<u8> {
    vec![keys::ACCESS_MEMBERS, STATE]
}

fn member_key(installation_id: &str) -> Vec<u8> {
    let mut key = vec![keys::ACCESS_MEMBERS, MEMBER];
    key.extend_from_slice(installation_id.as_bytes());
    key
}

fn batches_prefix(installation_id: &str) -> Vec<u8> {
    let mut key = vec![keys::ACCESS_MEMBERS, BATCH];
    key.extend_from_slice(installation_id.as_bytes());
    key.push(0);
    key
}

fn batch_key(installation_id: &str, token: &str) -> Vec<u8> {
    let mut key = batches_prefix(installation_id);
    key.extend_from_slice(token.as_bytes());
    key
}

/// The `shared_skill_state` singleton.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StateRecord {
    token_secret: String,
}

/// One `shared_skill_members` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MemberRecord {
    installation_id: String,
    principal_kind: String,
    principal_id: String,
    adapter: String,
    brain_id: String,
    epoch: i64,
    active: bool,
    follow_policy: Value,
    issued_sequence: i64,
    acknowledged_sequence: i64,
    desired_view: Option<String>,
    acknowledged_view: Option<String>,
    joined_at_us: i64,
    last_seen_at_us: i64,
    join_window_us: i64,
    join_count: i64,
}

/// One `shared_skill_delivery_batches` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BatchRecord {
    token: String,
    installation_id: String,
    epoch: i64,
    sequence: i64,
    view_token: String,
    authority_digest: String,
    revisions: Vec<String>,
    issued_at_us: i64,
    acknowledged_at_us: Option<i64>,
    evidence: Option<Value>,
}

/// `readSharedSkillMember(by)`: by installation id under its principal, or by principal and adapter.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillMemberLookup {
    pub installation_id: Option<String>,
    pub principal_kind: String,
    pub principal_id: String,
    pub adapter: Option<String>,
}

/// `enrollSharedSkillMember(spec)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillMemberEnroll {
    pub installation_id: String,
    pub principal_kind: String,
    pub principal_id: String,
    pub adapter: String,
    pub brain_id: String,
    pub follow_policy: Value,
}

/// `issueSharedSkillDeliveryBatch(spec)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillBatchIssue {
    pub installation_id: String,
    pub epoch: i64,
    pub issued_sequence: i64,
    pub view_token: String,
    pub authority_digest: String,
    pub revisions: Vec<String>,
    pub token: String,
    pub retained_batches: i64,
}

/// The member's acknowledged sequence and view an installed acknowledgment advances to.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillAdvance {
    pub sequence: i64,
    pub view_token: String,
}

/// `acknowledgeSharedSkillDeliveryBatch(spec)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SharedSkillBatchAcknowledge {
    pub token: String,
    pub evidence: Value,
    pub installation_id: String,
    pub advance: Option<SharedSkillAdvance>,
}

pub(crate) fn refused(constraint: &str, message: String) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("{message} (constraint {constraint})"),
    )
}

/// A UUID column value in the form Postgres stores and prints: lowercase, hyphenated 8-4-4-4-12.
/// Input follows Postgres `uuid_in`: 32 hex digits, a hyphen allowed after any group of four.
/// Anything else is the `invalid input syntax for type uuid` Postgres raises.
pub(crate) fn uuid(text: &str) -> Result<String> {
    let mut hex = String::with_capacity(32);
    let mut after_hyphen = false;
    let mut valid = true;
    for c in text.chars() {
        if c == '-' {
            valid &= !hex.is_empty() && hex.len().is_multiple_of(4) && !after_hyphen;
            after_hyphen = true;
        } else if c.is_ascii_hexdigit() {
            hex.push(c.to_ascii_lowercase());
            after_hyphen = false;
        } else {
            valid = false;
        }
    }
    if !valid || after_hyphen || hex.len() != 32 {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("invalid input syntax for type uuid: \"{text}\""),
        ));
    }
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// `now()` of the write transaction.
pub(crate) fn now(store: &Store) -> i64 {
    transaction_clock::transaction_now().unwrap_or_else(|| store.env.now_micros())
}

/// 64 lowercase hex digits from two random UUIDs, as the `token_secret` column default.
fn new_secret(env: &dyn Env) -> String {
    format!("{}{}", env.new_uuid(), env.new_uuid()).replace('-', "")
}

/// Writes the token secret of a fresh brain (`seed`).
pub(crate) fn seed_state(tx: &mut dyn KvWrite, env: &dyn Env) -> Result<()> {
    put_json(
        tx,
        &state_key(),
        &StateRecord {
            token_secret: new_secret(env),
        },
    )
}

fn all_members(read: &dyn KvRead) -> Result<Vec<MemberRecord>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, &[keys::ACCESS_MEMBERS, MEMBER], false, &mut |_, v| {
        match serde_json::from_slice::<MemberRecord>(v) {
            Ok(m) => out.push(m),
            Err(e) => bad = Some(e),
        }
        bad.is_none()
    })?;
    match bad {
        Some(e) => Err(e.into()),
        None => Ok(out),
    }
}

fn member_batches(read: &dyn KvRead, installation_id: &str) -> Result<Vec<BatchRecord>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        &batches_prefix(installation_id),
        false,
        &mut |_, v| {
            match serde_json::from_slice::<BatchRecord>(v) {
                Ok(b) => out.push(b),
                Err(e) => bad = Some(e),
            }
            bad.is_none()
        },
    )?;
    match bad {
        Some(e) => Err(e.into()),
        None => Ok(out),
    }
}

fn member_json(m: &MemberRecord) -> Value {
    json!({
        "installation_id": m.installation_id,
        "principal_kind": m.principal_kind,
        "principal_id": m.principal_id,
        "adapter": m.adapter,
        "brain_id": m.brain_id,
        "epoch": m.epoch,
        "active": m.active,
        "follow_policy": m.follow_policy,
        "issued_sequence": m.issued_sequence,
        "acknowledged_sequence": m.acknowledged_sequence,
        "desired_view": m.desired_view,
        "acknowledged_view": m.acknowledged_view,
        "joined_at": iso(m.joined_at_us),
        "last_seen_at": iso(m.last_seen_at_us),
        "join_window": iso(m.join_window_us),
        "join_count": m.join_count,
    })
}

fn batch_json(b: &BatchRecord) -> Value {
    json!({
        "token": b.token,
        "installation_id": b.installation_id,
        "epoch": b.epoch,
        "sequence": b.sequence,
        "view_token": b.view_token,
        "authority_digest": b.authority_digest,
        "revisions": b.revisions,
        "issued_at": iso(b.issued_at_us),
        "acknowledged_at": b.acknowledged_at_us.map(iso),
        "evidence": b.evidence,
    })
}

impl Store {
    /// The catalog token secret (`shared_skill_state.token_secret`). A brain without one (created
    /// before this family) gets one now, in one write; a later read returns the same secret.
    pub fn shared_skill_token_secret(&self) -> Result<String> {
        if let Some(state) = get_json::<StateRecord>(&*self.read()?, &state_key())? {
            return Ok(state.token_secret);
        }
        let env = self.env.clone();
        self.write(|tx| {
            if let Some(state) = get_json::<StateRecord>(&*tx, &state_key())? {
                return Ok(state.token_secret);
            }
            let state = StateRecord {
                token_secret: new_secret(&*env),
            };
            put_json(tx, &state_key(), &state)?;
            Ok(state.token_secret)
        })
    }

    /// `readSharedSkillMember(by)`: the member row, or null. By installation id the row matches
    /// only under the principal that owns it.
    pub fn read_shared_skill_member(&self, by: &SharedSkillMemberLookup) -> Result<Value> {
        let read = self.read()?;
        let found = match (&by.installation_id, &by.adapter) {
            (Some(id), _) => {
                get_json::<MemberRecord>(&*read, &member_key(&uuid(id)?))?.filter(|m| {
                    m.principal_kind == by.principal_kind && m.principal_id == by.principal_id
                })
            }
            (None, Some(adapter)) => all_members(&*read)?.into_iter().find(|m| {
                m.principal_kind == by.principal_kind
                    && m.principal_id == by.principal_id
                    && &m.adapter == adapter
            }),
            (None, None) => {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    "readSharedSkillMember needs installationId or adapter".to_string(),
                ));
            }
        };
        Ok(found.as_ref().map(member_json).unwrap_or(Value::Null))
    }

    /// `countSharedSkillMembers()`: every member, active or not.
    pub fn count_shared_skill_members(&self) -> Result<i64> {
        let mut n = 0i64;
        scan_prefix(
            &*self.read()?,
            &[keys::ACCESS_MEMBERS, MEMBER],
            false,
            &mut |_, _| {
                n += 1;
                true
            },
        )?;
        Ok(n)
    }

    /// `enrollSharedSkillMember(spec)`: inserts the member, or re-activates the one with this
    /// installation id at the next epoch with the new follow policy, its sequences and views reset,
    /// `joined_at` now and the join count advanced (a window older than an hour restarts at 1).
    /// The principal, adapter and brain id of an existing member stay as they are.
    pub fn enroll_shared_skill_member(&self, spec: &SharedSkillMemberEnroll) -> Result<()> {
        let id = uuid(&spec.installation_id)?;
        let brain_id = uuid(&spec.brain_id)?;
        self.write(|tx| {
            let now_us = now(self);
            let key = member_key(&id);
            if let Some(mut m) = get_json::<MemberRecord>(&*tx, &key)? {
                let restart = m.join_window_us < now_us - HOUR_US;
                m.active = true;
                m.epoch += 1;
                m.follow_policy = spec.follow_policy.clone();
                m.issued_sequence = 0;
                m.acknowledged_sequence = 0;
                m.desired_view = None;
                m.acknowledged_view = None;
                m.joined_at_us = now_us;
                m.join_count = if restart { 1 } else { m.join_count + 1 };
                if restart {
                    m.join_window_us = now_us;
                }
                return put_json(tx, &key, &m);
            }
            if all_members(&*tx)?.iter().any(|m| {
                m.principal_kind == spec.principal_kind
                    && m.principal_id == spec.principal_id
                    && m.adapter == spec.adapter
            }) {
                return Err(refused(
                    "shared_skill_members_principal_kind_principal_id_adapter_key",
                    format!(
                        "duplicate key value violates unique constraint \"shared_skill_members_principal_kind_principal_id_adapter_key\": Key (principal_kind, principal_id, adapter)=({}, {}, {}) already exists.",
                        spec.principal_kind, spec.principal_id, spec.adapter
                    ),
                ));
            }
            put_json(
                tx,
                &key,
                &MemberRecord {
                    installation_id: id.clone(),
                    principal_kind: spec.principal_kind.clone(),
                    principal_id: spec.principal_id.clone(),
                    adapter: spec.adapter.clone(),
                    brain_id: brain_id.clone(),
                    epoch: 1,
                    active: true,
                    follow_policy: spec.follow_policy.clone(),
                    issued_sequence: 0,
                    acknowledged_sequence: 0,
                    desired_view: None,
                    acknowledged_view: None,
                    joined_at_us: now_us,
                    last_seen_at_us: now_us,
                    join_window_us: now_us,
                    join_count: 1,
                },
            )
        })
    }

    /// `rebindSharedSkillMember(id, followPolicy, epoch)`: the narrowed follow policy and epoch,
    /// sequences and views reset. An absent member changes nothing.
    pub fn rebind_shared_skill_member(
        &self,
        installation_id: &str,
        follow_policy: &Value,
        epoch: i64,
    ) -> Result<()> {
        let key = member_key(&uuid(installation_id)?);
        self.write(|tx| {
            let Some(mut m) = get_json::<MemberRecord>(&*tx, &key)? else {
                return Ok(());
            };
            m.follow_policy = follow_policy.clone();
            m.epoch = epoch;
            m.issued_sequence = 0;
            m.acknowledged_sequence = 0;
            m.desired_view = None;
            m.acknowledged_view = None;
            put_json(tx, &key, &m)
        })
    }

    /// `leaveSharedSkillMember(id)`: marks the member inactive. An absent member changes nothing.
    pub fn leave_shared_skill_member(&self, installation_id: &str) -> Result<()> {
        let key = member_key(&uuid(installation_id)?);
        self.write(|tx| {
            let Some(mut m) = get_json::<MemberRecord>(&*tx, &key)? else {
                return Ok(());
            };
            m.active = false;
            put_json(tx, &key, &m)
        })
    }

    /// `issueSharedSkillDeliveryBatch(spec)`, in one write: drops the member's batches from another
    /// epoch or older than 24 hours; keeps the batch at the issued sequence with the same view and
    /// authority, or inserts the next one and records it on the member; keeps only the newest
    /// `retainedBatches` of the epoch; and marks the member seen (at most once a minute). Resolves
    /// `{ batch, created, issuedSequence }`; a new batch leaves without `installation_id` and
    /// `issued_at`, as the SQL engines return it.
    pub fn issue_shared_skill_delivery_batch(&self, spec: &SharedSkillBatchIssue) -> Result<Value> {
        let id = uuid(&spec.installation_id)?;
        let token = uuid(&spec.token)?;
        self.write(|tx| {
            let now_us = now(self);
            let mut batches = Vec::new();
            for b in member_batches(&*tx, &id)? {
                if b.epoch != spec.epoch || b.issued_at_us < now_us - DAY_US {
                    tx.delete(&batch_key(&id, &b.token))?;
                } else {
                    batches.push(b);
                }
            }
            let prior = batches
                .iter()
                .filter(|b| {
                    b.view_token == spec.view_token
                        && b.authority_digest == spec.authority_digest
                        && b.sequence == spec.issued_sequence
                })
                .max_by_key(|b| b.sequence)
                .cloned();
            let mkey = member_key(&id);
            let out = if let Some(prior) = prior {
                json!({ "batch": batch_json(&prior), "created": false, "issuedSequence": spec.issued_sequence })
            } else {
                let sequence = spec.issued_sequence + 1;
                let Some(mut member) = get_json::<MemberRecord>(&*tx, &mkey)? else {
                    return Err(refused(
                        "shared_skill_delivery_batches_installation_id_fkey",
                        format!(
                            "insert or update on table \"shared_skill_delivery_batches\" violates foreign key constraint \"shared_skill_delivery_batches_installation_id_fkey\": Key (installation_id)=({id}) is not present in table \"shared_skill_members\"."
                        ),
                    ));
                };
                if batches.iter().any(|b| b.sequence == sequence) {
                    return Err(refused(
                        "shared_skill_delivery_batches_installation_id_epoch_sequence_key",
                        format!(
                            "duplicate key value violates unique constraint \"shared_skill_delivery_batches_installation_id_epoch_sequence_key\": Key (installation_id, epoch, sequence)=({id}, {}, {sequence}) already exists.",
                            spec.epoch
                        ),
                    ));
                }
                if tx.get(&batch_key(&id, &token))?.is_some() {
                    return Err(refused(
                        "shared_skill_delivery_batches_pkey",
                        format!(
                            "duplicate key value violates unique constraint \"shared_skill_delivery_batches_pkey\": Key (token)=({token}) already exists."
                        ),
                    ));
                }
                // The delivery-lease trigger: every named revision is retained, and leased.
                crate::shared_skill_catalog::lease_delivery_revisions(
                    tx,
                    self.brain_id(),
                    &spec.revisions,
                    now_us,
                    now_us,
                )?;
                let batch = BatchRecord {
                    token: token.clone(),
                    installation_id: id.clone(),
                    epoch: spec.epoch,
                    sequence,
                    view_token: spec.view_token.clone(),
                    authority_digest: spec.authority_digest.clone(),
                    revisions: spec.revisions.clone(),
                    issued_at_us: now_us,
                    acknowledged_at_us: None,
                    evidence: None,
                };
                put_json(tx, &batch_key(&id, &token), &batch)?;
                batches.push(batch);
                member.issued_sequence = sequence;
                member.desired_view = Some(spec.view_token.clone());
                put_json(tx, &mkey, &member)?;
                json!({
                    "batch": {
                        "token": token, "epoch": spec.epoch, "sequence": sequence, "view_token": spec.view_token,
                        "authority_digest": spec.authority_digest, "revisions": spec.revisions,
                        "acknowledged_at": null, "evidence": null,
                    },
                    "created": true,
                    "issuedSequence": sequence,
                })
            };
            // Retention: the newest `retainedBatches` of the epoch by sequence; every other goes.
            batches.sort_by_key(|b| std::cmp::Reverse(b.sequence));
            let keep = usize::try_from(spec.retained_batches.max(0)).unwrap_or(usize::MAX);
            for b in batches.iter().skip(keep) {
                tx.delete(&batch_key(&id, &b.token))?;
            }
            if let Some(mut member) = get_json::<MemberRecord>(&*tx, &mkey)?
                && member.last_seen_at_us < now_us - MINUTE_US
            {
                member.last_seen_at_us = now_us;
                put_json(tx, &mkey, &member)?;
            }
            Ok(out)
        })
    }

    /// `readSharedSkillDeliveryBatch(token, installationId, epoch)`: the member's batch under this
    /// epoch issued within the last 24 hours, or null.
    pub fn read_shared_skill_delivery_batch(
        &self,
        token: &str,
        installation_id: &str,
        epoch: i64,
    ) -> Result<Value> {
        let key = batch_key(&uuid(installation_id)?, &uuid(token)?);
        let now_us = now(self);
        let found = get_json::<BatchRecord>(&*self.read()?, &key)?
            .filter(|b| b.epoch == epoch && b.issued_at_us >= now_us - DAY_US);
        Ok(found.as_ref().map(batch_json).unwrap_or(Value::Null))
    }

    /// `acknowledgeSharedSkillDeliveryBatch(spec)`, in one write: the batch's acknowledgment time
    /// and evidence and, with `advance`, the member's acknowledged sequence (never lowered) and
    /// view. An absent batch or member changes nothing.
    pub fn acknowledge_shared_skill_delivery_batch(
        &self,
        spec: &SharedSkillBatchAcknowledge,
    ) -> Result<()> {
        let id = uuid(&spec.installation_id)?;
        let bkey = batch_key(&id, &uuid(&spec.token)?);
        self.write(|tx| {
            let now_us = now(self);
            if let Some(mut b) = get_json::<BatchRecord>(&*tx, &bkey)? {
                b.acknowledged_at_us = Some(now_us);
                b.evidence = Some(spec.evidence.clone());
                put_json(tx, &bkey, &b)?;
            }
            if let Some(advance) = &spec.advance {
                let mkey = member_key(&id);
                if let Some(mut m) = get_json::<MemberRecord>(&*tx, &mkey)? {
                    m.acknowledged_sequence = m.acknowledged_sequence.max(advance.sequence);
                    m.acknowledged_view = Some(advance.view_token.clone());
                    put_json(tx, &mkey, &m)?;
                }
            }
            Ok(())
        })
    }

    /// `listSharedSkillFollowSources(allowed, sourceIds)`: `{ id, incarnation }` of each source
    /// that is not archived and is in both lists (a null list matches every source), by id in byte
    /// order, at most 65.
    pub fn list_shared_skill_follow_sources(
        &self,
        allowed: Option<&[String]>,
        source_ids: Option<&[String]>,
    ) -> Result<Value> {
        let read = self.read()?;
        let within =
            |list: Option<&[String]>, id: &str| list.is_none_or(|l| l.iter().any(|s| s == id));
        let mut sources = crate::sources::all_sources(&*read)?;
        sources.sort_by(|a, b| a.id.as_bytes().cmp(b.id.as_bytes()));
        let rows: Vec<Value> = sources
            .iter()
            .filter(|s| !s.archived && within(allowed, &s.id) && within(source_ids, &s.id))
            .take(65)
            .map(|s| json!({ "id": s.id, "incarnation": s.incarnation }))
            .collect();
        Ok(Value::Array(rows))
    }
}

#[cfg(test)]
mod tests {
    use super::uuid;

    #[test]
    fn uuid_input_follows_postgres() {
        let canonical = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
        for ok in [
            canonical,
            "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11",
            "a0eebc999c0b4ef8bb6d6bb9bd380a11",
            "a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11",
        ] {
            assert_eq!(uuid(ok).unwrap(), canonical, "{ok}");
        }
        for bad in [
            "",
            "-a0eebc999c0b4ef8bb6d6bb9bd380a11",
            "a0eebc999c0b4ef8bb6d6bb9bd380a11-",
            "a0e-ebc999c0b4ef8bb6d6bb9bd380a11",
            "a0ee--bc999c0b4ef8bb6d6bb9bd380a11",
            "a0eebc999c0b4ef8bb6d6bb9bd380a1",
            "------------------------------------",
            "g0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        ] {
            assert!(uuid(bad).is_err(), "{bad}");
        }
    }
}
