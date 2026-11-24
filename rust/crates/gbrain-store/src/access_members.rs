//! Access members and groups: the `access_members`, `access_groups` and `access_group_members`
//! tables of the PGLite engine (schema migrations v282, v301, v305 and v308).
//!
//! Members: insertAccessMember (with the token it binds, written to the token record of
//! `jobs/access_tokens.rs` in the same write), setAccessMemberDisabled, setAccessMemberEmail,
//! setAccessMemberKind, setAccessMemberLabelledOnly, tombstoneAccessMember, addAccessGroupMembers, removeAccessGroupMembers,
//! deleteAccessGroup, readAccessMembers, readAccessGroupIds, readAccessGroups, listActiveAccessMembers.
//!
//! Keys (every record starts with `keys::ACCESS_MEMBERS`, `x`):
//! - `x 0x01 <member id>` -> `MemberRecord` (JSON).
//! - `x 0x02 <group id>` -> `GroupRecord` (JSON).
//! - `x 0x03 <group id> 0x00 <member id>` -> empty. Ids never hold NUL (the id check), so a
//!   group's members are the prefix `x 0x03 <group id> 0x00`.
//! - `x 0x04 <system> 0x00 <external id>` -> a member link (`access_member_links`, v286); the
//!   module `access_member_links` reads and writes these.
//!
//! A brain holds few members, so the email uniqueness check, the group list of a member and the
//! enabled-member count scan these prefixes.
//!
//! What each write also does in the same `Store::write`, as the Postgres triggers do in the same
//! statement:
//! - A member insert sets config `access.restrictions_present` to `'1'`
//!   (`access_members_mark_restricted`, v282).
//! - A member insert, a disable or enable, and a tombstone refresh the serves keys
//!   (`access_members_refresh_serves`, v309; `refresh_serves` below).
//! - A group delete deletes its group members (`ON DELETE CASCADE`).
//!
//! Refusals carry `constraint_violation` with the Postgres constraint name in the message: the
//! id check (`access_members_id_check`, `access_groups_id_check`), the kind check
//! (`access_members_kind_check`), the primary key (`access_members_pkey`), the email index
//! (`access_members_email_key`) and the member reference of a group member
//! (`access_group_members_member_id_fkey`).

use crate::access_flag::RESTRICTIONS_PRESENT_KEY;
use crate::config::read_config;
use crate::env::{iso, transaction_clock};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const MEMBER: u8 = 0x01;
const GROUP: u8 = 0x02;
const GROUP_MEMBER: u8 = 0x03;

const SERVES_KEY: &str = "access.serves";
const SERVES_DERIVED_KEY: &str = "access.serves_derived";
const SERVES_SINCE_KEY: &str = "access.serves_since";

pub(crate) fn member_key(id: &str) -> Vec<u8> {
    let mut key = vec![keys::ACCESS_MEMBERS, MEMBER];
    key.extend_from_slice(id.as_bytes());
    key
}

fn group_key(id: &str) -> Vec<u8> {
    let mut key = vec![keys::ACCESS_MEMBERS, GROUP];
    key.extend_from_slice(id.as_bytes());
    key
}

fn group_members_prefix(group_id: &str) -> Vec<u8> {
    let mut key = vec![keys::ACCESS_MEMBERS, GROUP_MEMBER];
    key.extend_from_slice(group_id.as_bytes());
    key.push(0);
    key
}

fn group_member_key(group_id: &str, member_id: &str) -> Vec<u8> {
    let mut key = group_members_prefix(group_id);
    key.extend_from_slice(member_id.as_bytes());
    key
}

fn config_key(key: &str) -> Vec<u8> {
    keys::text(keys::CONFIG, &[key])
}

/// One `access_members` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MemberRecord {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub labelled_only: bool,
    #[serde(default)]
    pub disabled_at_us: Option<i64>,
    #[serde(default)]
    pub tombstoned_at_us: Option<i64>,
    pub created_at_us: i64,
    pub updated_at_us: i64,
}

/// One `access_groups` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct GroupRecord {
    pub id: String,
    pub created_at_us: i64,
}

/// `insertAccessMember(spec)`: the member row, the groups it joins and the token it binds (`bindTokenId`, the token
/// whose id text is exactly that).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AccessMemberInsert {
    pub id: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub kind: Option<String>,
    pub groups: Vec<String>,
    pub bind_token_id: Option<String>,
}

/// `readAccessMembers(lookup)`: one member by exact id (any status); every member that declares
/// exactly `email` (any status), by id; or every member, removed ones only with `includeRemoved`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AccessMemberLookup {
    pub id: Option<String>,
    pub email: Option<String>,
    pub include_removed: bool,
}

/// The `CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$')` of `access_members` and `access_groups`.
fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

pub(crate) fn refused(constraint: &str, message: String) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("{message} (constraint {constraint})"),
    )
}

fn check_id(id: &str, table: &str) -> Result<()> {
    if valid_id(id) {
        return Ok(());
    }
    Err(refused(
        &format!("{table}_id_check"),
        format!("new row for relation \"{table}\" violates check constraint \"{table}_id_check\""),
    ))
}

fn check_kind(kind: &str) -> Result<()> {
    if kind == "person" || kind == "audience" {
        return Ok(());
    }
    Err(refused(
        "access_members_kind_check",
        "new row for relation \"access_members\" violates check constraint \"access_members_kind_check\"".into(),
    ))
}

/// `now()` of the write transaction.
pub(crate) fn now(store: &Store) -> i64 {
    transaction_clock::transaction_now().unwrap_or_else(|| store.env.now_micros())
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

/// Every group member as `(group id, member id)`, in key order.
pub(crate) fn all_group_members(read: &dyn KvRead) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    scan_prefix(
        read,
        &[keys::ACCESS_MEMBERS, GROUP_MEMBER],
        false,
        &mut |k, _| {
            let rest = &k[2..];
            if let Some(cut) = rest.iter().position(|&c| c == 0) {
                out.push((
                    String::from_utf8_lossy(&rest[..cut]).into_owned(),
                    String::from_utf8_lossy(&rest[cut + 1..]).into_owned(),
                ));
            }
            true
        },
    )?;
    Ok(out)
}

pub(crate) fn read_member(read: &dyn KvRead, id: &str) -> Result<Option<MemberRecord>> {
    get_json(read, &member_key(id))
}

/// `EXISTS (SELECT 1 FROM access_members WHERE id = $1 AND tombstoned_at IS NULL)`: a member
/// with exactly this id that is not removed (a disabled member counts).
pub(crate) fn member_not_removed(read: &dyn KvRead, id: &str) -> Result<bool> {
    Ok(read_member(read, id)?.is_some_and(|m| m.tombstoned_at_us.is_none()))
}

/// The member that declares `email`, other than `except`.
fn email_owner(read: &dyn KvRead, email: &str, except: &str) -> Result<Option<String>> {
    Ok(all_members(read)?
        .into_iter()
        .find(|m| m.id != except && m.email.as_deref() == Some(email))
        .map(|m| m.id))
}

fn check_email_free(read: &dyn KvRead, email: Option<&str>, member_id: &str) -> Result<()> {
    let Some(email) = email else { return Ok(()) };
    if email_owner(read, email, member_id)?.is_some() {
        return Err(refused(
            "access_members_email_key",
            format!(
                "duplicate key value violates unique constraint \"access_members_email_key\": Key (email)=({email}) already exists."
            ),
        ));
    }
    Ok(())
}

/// Sets `access.restrictions_present` to `'1'` unless it already is (`gbrain_access_mark_restricted`).
fn mark_restricted(tx: &mut dyn KvWrite) -> Result<()> {
    let key = config_key(RESTRICTIONS_PRESENT_KEY);
    if tx.get(&key)?.as_deref() == Some(b"1".as_slice()) {
        return Ok(());
    }
    tx.put(&key, b"1")
}

/// `gbrain_access_refresh_serves()` (v309) at read committed: `access.serves_derived` is
/// `several` while two or more members are enabled and `one` otherwise (written as `one` only when
/// the key exists); `access.serves_since` is set once (to the microsecond, v329), when the explicit `access.serves` (`one` or
/// `several`, trimmed and lower-cased) or else the derived value is `several`.
fn refresh_serves(tx: &mut dyn KvWrite, now_us: i64) -> Result<()> {
    let enabled = all_members(&*tx)?
        .iter()
        .filter(|m| m.disabled_at_us.is_none() && m.tombstoned_at_us.is_none())
        .count();
    let derived = if enabled >= 2 { "several" } else { "one" };
    let derived_key = config_key(SERVES_DERIVED_KEY);
    let stored = read_config(&*tx, SERVES_DERIVED_KEY)?;
    if stored.as_deref() != Some(derived) && (derived == "several" || stored.is_some()) {
        tx.put(&derived_key, derived.as_bytes())?;
    }
    let explicit = read_config(&*tx, SERVES_KEY)?.map(|v| v.trim().to_lowercase());
    let serves = match explicit.as_deref() {
        Some(e @ ("one" | "several")) => e,
        _ => derived,
    };
    let since_key = config_key(SERVES_SINCE_KEY);
    if serves == "several" && tx.get(&since_key)?.is_none() {
        // to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') (v329): microseconds.
        tx.put(&since_key, iso(now_us).as_bytes())?;
    }
    Ok(())
}

fn ensure_group(tx: &mut dyn KvWrite, id: &str, now_us: i64) -> Result<bool> {
    check_id(id, "access_groups")?;
    let key = group_key(id);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    put_json(
        tx,
        &key,
        &GroupRecord {
            id: id.to_string(),
            created_at_us: now_us,
        },
    )?;
    Ok(true)
}

fn add_group_member(tx: &mut dyn KvWrite, group_id: &str, member_id: &str) -> Result<()> {
    if read_member(&*tx, member_id)?.is_none() {
        return Err(refused(
            "access_group_members_member_id_fkey",
            format!(
                "insert or update on table \"access_group_members\" violates foreign key constraint \"access_group_members_member_id_fkey\": Key (member_id)=({member_id}) is not present in table \"access_members\"."
            ),
        ));
    }
    tx.put(&group_member_key(group_id, member_id), b"")
}

fn row_json(m: &MemberRecord, groups: Vec<String>) -> Value {
    json!({
        "id": m.id,
        "display_name": m.display_name,
        "email": m.email,
        "kind": m.kind,
        "labelled_only": m.labelled_only,
        "disabled_at": m.disabled_at_us.map(iso),
        "tombstoned_at": m.tombstoned_at_us.map(iso),
        "created_at": iso(m.created_at_us),
        "groups": groups,
    })
}

impl Store {
    /// `insertAccessMember(spec)`: inserts the member (kind `person` when unset), creates the groups
    /// it names that are missing, adds it to each and binds the token `bindTokenId` names to it (no
    /// token has the id: nothing is bound), in one write. Resolves `{ groupsCreated }`, the groups
    /// this call created, in the order named.
    pub fn insert_access_member(&self, spec: &AccessMemberInsert) -> Result<Value> {
        let kind = spec.kind.as_deref().unwrap_or("person");
        check_id(&spec.id, "access_members")?;
        check_kind(kind)?;
        self.write(|tx| {
            let now_us = now(self);
            let key = member_key(&spec.id);
            if tx.get(&key)?.is_some() {
                return Err(refused(
                    "access_members_pkey",
                    format!(
                        "duplicate key value violates unique constraint \"access_members_pkey\": Key (id)=({}) already exists.",
                        spec.id
                    ),
                ));
            }
            check_email_free(&*tx, spec.email.as_deref(), &spec.id)?;
            let record = MemberRecord {
                id: spec.id.clone(),
                display_name: spec.display_name.clone(),
                email: spec.email.clone(),
                kind: kind.to_string(),
                labelled_only: false,
                disabled_at_us: None,
                tombstoned_at_us: None,
                created_at_us: now_us,
                updated_at_us: now_us,
            };
            put_json(tx, &key, &record)?;
            mark_restricted(tx)?;
            refresh_serves(tx, now_us)?;
            let mut created = Vec::new();
            for group in &spec.groups {
                if ensure_group(tx, group, now_us)? {
                    created.push(group.clone());
                }
            }
            for group in &spec.groups {
                add_group_member(tx, group, &spec.id)?;
            }
            if let Some(token_id) = &spec.bind_token_id {
                crate::jobs::bind_token_member(tx, token_id, &spec.id)?;
            }
            Ok(json!({ "groupsCreated": created }))
        })
    }

    /// `setAccessMemberDisabled(id, disabled)`: disabling keeps an earlier disable time; enabling
    /// clears it. Either way `updated_at` moves and the serves keys refresh, even for an absent id.
    pub fn set_access_member_disabled(&self, id: &str, disabled: bool) -> Result<()> {
        self.write(|tx| {
            let now_us = now(self);
            if let Some(mut m) = read_member(&*tx, id)? {
                m.disabled_at_us = if disabled {
                    m.disabled_at_us.or(Some(now_us))
                } else {
                    None
                };
                m.updated_at_us = now_us;
                put_json(tx, &member_key(id), &m)?;
            }
            refresh_serves(tx, now_us)
        })
    }

    /// `setAccessMemberEmail(id, email)`: sets or (with null) clears the email of a member that is
    /// not removed. Resolves true when a row changed. Refuses an email another member declares.
    pub fn set_access_member_email(&self, id: &str, email: Option<&str>) -> Result<bool> {
        self.write(|tx| {
            let Some(mut m) = read_member(&*tx, id)?.filter(|m| m.tombstoned_at_us.is_none())
            else {
                return Ok(false);
            };
            check_email_free(&*tx, email, id)?;
            m.email = email.map(str::to_string);
            m.updated_at_us = now(self);
            put_json(tx, &member_key(id), &m)?;
            Ok(true)
        })
    }

    /// `setAccessMemberKind(id, kind)`: sets the kind of a member that is not removed.
    pub fn set_access_member_kind(&self, id: &str, kind: &str) -> Result<()> {
        check_kind(kind)?;
        self.write(|tx| {
            let Some(mut m) = read_member(&*tx, id)?.filter(|m| m.tombstoned_at_us.is_none())
            else {
                return Ok(());
            };
            m.kind = kind.to_string();
            m.updated_at_us = now(self);
            put_json(tx, &member_key(id), &m)
        })
    }

    /// `setAccessMemberLabelledOnly(id, labelled_only)`: sets or clears the labelled-only grant of
    /// a member that is not removed. No serves key moves: the Postgres serves trigger fires only on
    /// `disabled_at` and `tombstoned_at`.
    pub fn set_access_member_labelled_only(&self, id: &str, labelled_only: bool) -> Result<()> {
        self.write(|tx| {
            let Some(mut m) = read_member(&*tx, id)?.filter(|m| m.tombstoned_at_us.is_none())
            else {
                return Ok(());
            };
            m.labelled_only = labelled_only;
            m.updated_at_us = now(self);
            put_json(tx, &member_key(id), &m)
        })
    }

    /// `tombstoneAccessMember(id)`: marks the member removed (and disabled, keeping an earlier
    /// disable time), clears its email and drops its group members, in one write.
    pub fn tombstone_access_member(&self, id: &str) -> Result<()> {
        self.write(|tx| {
            let now_us = now(self);
            if let Some(mut m) = read_member(&*tx, id)? {
                m.tombstoned_at_us = Some(now_us);
                m.disabled_at_us = m.disabled_at_us.or(Some(now_us));
                m.email = None;
                m.updated_at_us = now_us;
                put_json(tx, &member_key(id), &m)?;
            }
            refresh_serves(tx, now_us)?;
            for (group, member) in all_group_members(&*tx)? {
                if member == id {
                    tx.delete(&group_member_key(&group, &member))?;
                }
            }
            Ok(())
        })
    }

    /// `addAccessGroupMembers(groupId, memberIds)`: creates the group when missing and adds each
    /// member (already there is kept), in one write. Resolves true when the group was created.
    pub fn add_access_group_members(&self, group_id: &str, members: &[String]) -> Result<bool> {
        self.write(|tx| {
            let created = ensure_group(tx, group_id, now(self))?;
            for member in members {
                add_group_member(tx, group_id, member)?;
            }
            Ok(created)
        })
    }

    /// `removeAccessGroupMembers(groupId, memberIds)`: drops each named member from the group.
    pub fn remove_access_group_members(&self, group_id: &str, members: &[String]) -> Result<()> {
        self.write(|tx| {
            for member in members {
                tx.delete(&group_member_key(group_id, member))?;
            }
            Ok(())
        })
    }

    /// `deleteAccessGroup(id)`: deletes the group and its group members.
    pub fn delete_access_group(&self, id: &str) -> Result<()> {
        self.write(|tx| {
            tx.delete(&group_key(id))?;
            for (group, member) in all_group_members(&*tx)? {
                if group == id {
                    tx.delete(&group_member_key(&group, &member))?;
                }
            }
            Ok(())
        })
    }

    /// `readAccessMembers(lookup)`: `AccessMemberRow[]` by id (byte order), each with its group ids
    /// in byte order; timestamps leave as ISO text.
    pub fn read_access_members(&self, lookup: &AccessMemberLookup) -> Result<Value> {
        let read = self.read()?;
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (group, member) in all_group_members(&*read)? {
            groups.entry(member).or_default().push(group);
        }
        // By email every match is listed, as `ACCESS_MEMBER_SQL.by_email` does: the caller refuses an
        // email several members declare, so the lookup never picks one of them.
        let members = match (&lookup.id, &lookup.email) {
            (Some(id), _) => read_member(&*read, id)?.into_iter().collect(),
            (None, Some(email)) => all_members(&*read)?
                .into_iter()
                .filter(|m| m.email.as_deref() == Some(email.as_str()))
                .collect::<Vec<_>>(),
            (None, None) => all_members(&*read)?
                .into_iter()
                .filter(|m| lookup.include_removed || m.tombstoned_at_us.is_none())
                .collect::<Vec<_>>(),
        };
        let rows: Vec<Value> = members
            .iter()
            .map(|m| {
                let mut g = groups.remove(&m.id).unwrap_or_default();
                g.sort();
                row_json(m, g)
            })
            .collect();
        Ok(Value::Array(rows))
    }

    /// `readAccessGroups(id)`: every group with its member ids, or the one group `id` names
    /// (exactly that id), each `{ id, members }`; groups and members in byte order.
    pub fn read_access_groups(&self, id: Option<&str>) -> Result<Value> {
        let read = self.read()?;
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        match id {
            Some(id) => {
                if !id.contains('\0') && read.get(&group_key(id))?.is_some() {
                    groups.insert(id.to_owned(), Vec::new());
                }
            }
            None => scan_prefix(
                &*read,
                &[keys::ACCESS_MEMBERS, GROUP],
                false,
                &mut |k, _| {
                    groups.insert(String::from_utf8_lossy(&k[2..]).into_owned(), Vec::new());
                    true
                },
            )?,
        }
        for (group, member) in all_group_members(&*read)? {
            if let Some(members) = groups.get_mut(&group) {
                members.push(member);
            }
        }
        Ok(Value::Array(
            groups
                .into_iter()
                .map(|(id, mut members)| {
                    members.sort();
                    json!({ "id": id, "members": members })
                })
                .collect(),
        ))
    }

    /// `readAccessGroupIds(ids)`: which of `ids` name an existing group, each once, in byte order.
    pub fn read_access_group_ids(&self, ids: &[String]) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut found = BTreeSet::new();
        for id in ids {
            if !id.contains('\0') && read.get(&group_key(id))?.is_some() {
                found.insert(id.clone());
            }
        }
        Ok(found.into_iter().collect())
    }

    /// `listActiveAccessMembers()`: the ids of the members neither disabled nor removed, by id.
    pub fn list_active_access_members(&self) -> Result<Vec<String>> {
        Ok(all_members(&*self.read()?)?
            .into_iter()
            .filter(|m| m.disabled_at_us.is_none() && m.tombstoned_at_us.is_none())
            .map(|m| m.id)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    fn plant(store: &Store, id: &str, email: &str) {
        // The email index refuses a second declaring member, so the record is written past it, as a
        // row a pre-index brain could hold.
        store
            .write(|tx| {
                put_json(
                    tx,
                    &member_key(id),
                    &MemberRecord {
                        id: id.into(),
                        display_name: None,
                        email: Some(email.into()),
                        kind: "person".into(),
                        labelled_only: false,
                        disabled_at_us: None,
                        tombstoned_at_us: None,
                        created_at_us: 1,
                        updated_at_us: 1,
                    },
                )
            })
            .unwrap();
    }

    #[test]
    fn read_access_members_by_email_lists_every_member_that_declares_it() {
        let store = store();
        plant(&store, "bob", "shared@example.test");
        plant(&store, "alice", "shared@example.test");
        plant(&store, "carol", "other@example.test");
        let lookup = AccessMemberLookup {
            email: Some("shared@example.test".into()),
            ..Default::default()
        };
        let rows = store.read_access_members(&lookup).unwrap();
        let ids: Vec<&str> = rows
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["alice", "bob"]);
        let none = AccessMemberLookup {
            email: Some("Shared@example.test".into()),
            ..Default::default()
        };
        assert_eq!(store.read_access_members(&none).unwrap(), json!([]));
    }
}
