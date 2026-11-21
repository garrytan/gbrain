//! Access members and groups: the `access_members`, `access_groups` and `access_group_members`
//! tables of the PGLite engine (schema migrations v282, v301, v305 and v308).
//!
//! Members: insertAccessMember, setAccessMemberDisabled, setAccessMemberEmail,
//! setAccessMemberKind, setAccessMemberLabelledOnly, tombstoneAccessMember, addAccessGroupMembers,
//! removeAccessGroupMembers, deleteAccessGroup, readAccessMembers, readAccessGroups and
//! listPagesNamingReader. The other member reads (listActiveAccessMembers, hasLabelledOnlyMember,
//! listAudienceAccessMembers, readAudiencePrincipals, readLiveMember by id or stdio config) filter
//! the rows of readAccessMembers and readAccessGroups in `store-members/access-members.ts`.
//!
//! Keys (every record starts with `keys::ACCESS_MEMBERS`, `x`):
//! - `x 0x01 <member id>` -> `MemberRecord` (JSON).
//! - `x 0x02 <group id>` -> `GroupRecord` (JSON).
//! - `x 0x03 <group id> 0x00 <member id>` -> empty. Ids never hold NUL (the id check), so a
//!   group's members are the prefix `x 0x03 <group id> 0x00`.
//!
//! A brain holds few members, so the email check, the group list of a member and the
//! enabled-member count scan these prefixes.
//!
//! What each write also does in the same `Store::write`, as the Postgres triggers do in the same
//! statement:
//! - A member insert sets config `access.restrictions_present` to `'1'`
//!   (`access_members_mark_restricted`, v282).
//! - A member insert, a disable or enable, and a tombstone refresh the serves keys
//!   (`access_members_refresh_serves`, v309 and v329; [`refresh_serves`]). A config write of
//!   `access.serves` or `access.serves_derived` refreshes them too (`config.rs`).
//! - A group delete deletes its group members (`ON DELETE CASCADE`).
//!
//! Not kept yet: the token binding of a member insert (`bindTokenId`). The store refuses it with
//! `invalid_argument`; the TypeScript member refuses it first (docs/designs/RUST_ENGINE.md, 32a-2).
//!
//! A refusal is `constraint_violation` with the Postgres message: the id check
//! (`access_members_id_check`, `access_groups_id_check`), the kind check
//! (`access_members_kind_check`), the primary key (`access_members_pkey`), the email index
//! (`access_members_email_key`) and the member reference of a group member
//! (`access_group_members_member_id_fkey`).

use crate::access_flag::RESTRICTIONS_PRESENT_KEY;
use crate::config::read_config;
use crate::env::{iso, transaction_clock};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::facts::access_readers;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::all_pages;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const MEMBER: u8 = 0x01;
const GROUP: u8 = 0x02;
const GROUP_MEMBER: u8 = 0x03;

const SERVES_KEY: &str = "access.serves";
const SERVES_DERIVED_KEY: &str = "access.serves_derived";
const SERVES_SINCE_KEY: &str = "access.serves_since";

fn key(kind: u8, parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::ACCESS_MEMBERS];
    key.extend(keys::text(kind, parts));
    key
}

fn config_key(name: &str) -> Vec<u8> {
    keys::text(keys::CONFIG, &[name])
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
struct GroupRecord {
    id: String,
    created_at_us: i64,
}

/// `insertAccessMember(spec)`: the member row and the groups it joins.
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
fn check_id(id: &str, table: &str) -> Result<()> {
    let b = id.as_bytes();
    let valid = !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c));
    if valid {
        return Ok(());
    }
    Err(check_refused(table, &format!("{table}_id_check")))
}

fn check_refused(table: &str, constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("new row for relation \"{table}\" violates check constraint \"{constraint}\""),
    )
}

fn unique_refused(constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("duplicate key value violates unique constraint \"{constraint}\""),
    )
}

fn check_kind(kind: &str) -> Result<()> {
    if kind == "person" || kind == "audience" {
        return Ok(());
    }
    Err(check_refused("access_members", "access_members_kind_check"))
}

/// `now()` of the write transaction.
fn now(store: &Store) -> i64 {
    transaction_clock::transaction_now().unwrap_or_else(|| store.env.now_micros())
}

pub(crate) fn all_members(read: &dyn KvRead) -> Result<Vec<MemberRecord>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, &[keys::ACCESS_MEMBERS, MEMBER], false, &mut |_, v| {
        match serde_json::from_slice::<MemberRecord>(v) {
            Ok(m) => out.push(m),
            Err(e) => bad = Some(e),
        }
        bad.is_none()
    })?;
    bad.map_or(Ok(out), |e| Err(e.into()))
}

/// Every group member as `(group id, member id)`, in key order.
fn all_group_members(read: &dyn KvRead) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    scan_prefix(
        read,
        &[keys::ACCESS_MEMBERS, GROUP_MEMBER],
        false,
        &mut |k, _| {
            let rest = &k[2..];
            if let Some(cut) = rest.iter().position(|&c| c == 0) {
                let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
                out.push((text(&rest[..cut]), text(&rest[cut + 1..])));
            }
            true
        },
    )?;
    Ok(out)
}

fn read_member(read: &dyn KvRead, id: &str) -> Result<Option<MemberRecord>> {
    get_json(read, &key(MEMBER, &[id]))
}

/// `EXISTS (SELECT 1 FROM access_members WHERE id = $1 AND tombstoned_at IS NULL)`: a member
/// with exactly this id that is not removed (a disabled member counts).
pub(crate) fn member_not_removed(read: &dyn KvRead, id: &str) -> Result<bool> {
    Ok(read_member(read, id)?.is_some_and(|m| m.tombstoned_at_us.is_none()))
}

/// `EXISTS (SELECT 1 FROM access_members WHERE labelled_only)`: any member, of any status.
pub(crate) fn any_labelled_only(read: &dyn KvRead) -> Result<bool> {
    Ok(all_members(read)?.iter().any(|m| m.labelled_only))
}

/// The unique index on `email`: no other member declares it.
fn check_email_free(read: &dyn KvRead, email: Option<&str>, member_id: &str) -> Result<()> {
    let Some(email) = email else { return Ok(()) };
    let taken = all_members(read)?
        .iter()
        .any(|m| m.id != member_id && m.email.as_deref() == Some(email));
    if taken {
        return Err(unique_refused("access_members_email_key"));
    }
    Ok(())
}

/// `gbrain_access_refresh_serves()` (v329) at read committed: `access.serves_derived` is
/// `several` while two or more members are enabled and `one` otherwise (written as `one` only when
/// the key exists); `access.serves_since` is set once, to the microsecond, when the explicit
/// `access.serves` (`one` or `several`, trimmed of spaces and lower-cased) or else the derived
/// value is `several`. Nothing clears it.
fn refresh_serves(tx: &mut dyn KvWrite, now_us: i64) -> Result<()> {
    let enabled = all_members(&*tx)?
        .iter()
        .filter(|m| m.disabled_at_us.is_none() && m.tombstoned_at_us.is_none())
        .count();
    let derived = if enabled >= 2 { "several" } else { "one" };
    let stored = read_config(&*tx, SERVES_DERIVED_KEY)?;
    if stored.as_deref() != Some(derived) && (derived == "several" || stored.is_some()) {
        tx.put(&config_key(SERVES_DERIVED_KEY), derived.as_bytes())?;
    }
    let explicit = read_config(&*tx, SERVES_KEY)?.map(|v| v.trim_matches(' ').to_lowercase());
    let serves = match explicit.as_deref() {
        Some(e @ ("one" | "several")) => e,
        _ => derived,
    };
    let since_key = config_key(SERVES_SINCE_KEY);
    if serves == "several" && tx.get(&since_key)?.is_none() {
        tx.put(&since_key, iso(now_us).as_bytes())?;
    }
    Ok(())
}

/// `config_serves_refresh` and `config_serves_refresh_delete` (v309): a config write or delete of
/// `access.serves` or `access.serves_derived` refreshes the serves keys in the same write.
pub(crate) fn config_serves_refresh(store: &Store, tx: &mut dyn KvWrite, name: &str) -> Result<()> {
    if name != SERVES_KEY && name != SERVES_DERIVED_KEY {
        return Ok(());
    }
    refresh_serves(tx, now(store))
}

/// `INSERT INTO access_groups (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`: true when created.
fn ensure_group(tx: &mut dyn KvWrite, id: &str, now_us: i64) -> Result<bool> {
    check_id(id, "access_groups")?;
    let k = key(GROUP, &[id]);
    if tx.get(&k)?.is_some() {
        return Ok(false);
    }
    let created_at_us = now_us;
    put_json(
        tx,
        &k,
        &GroupRecord {
            id: id.into(),
            created_at_us,
        },
    )?;
    Ok(true)
}

/// `INSERT INTO access_group_members ... ON CONFLICT DO NOTHING`; the member must exist.
fn add_group_member(tx: &mut dyn KvWrite, group_id: &str, member_id: &str) -> Result<()> {
    if read_member(&*tx, member_id)?.is_none() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "insert or update on table \"access_group_members\" violates foreign key constraint \"access_group_members_member_id_fkey\"",
        ));
    }
    tx.put(&key(GROUP_MEMBER, &[group_id, member_id]), b"")
}

/// Drops every group member `drop` accepts.
fn drop_group_members(tx: &mut dyn KvWrite, drop: impl Fn(&str, &str) -> bool) -> Result<()> {
    for (group, member) in all_group_members(&*tx)? {
        if drop(&group, &member) {
            tx.delete(&key(GROUP_MEMBER, &[&group, &member]))?;
        }
    }
    Ok(())
}

impl Store {
    /// Rewrites a member that is not removed (`WHERE id = $1 AND tombstoned_at IS NULL`); false
    /// when no such member exists.
    fn update_live_member(
        &self,
        id: &str,
        edit: impl Fn(&dyn KvRead, &mut MemberRecord) -> Result<()>,
    ) -> Result<bool> {
        self.write(|tx| {
            let Some(mut m) = read_member(&*tx, id)?.filter(|m| m.tombstoned_at_us.is_none())
            else {
                return Ok(false);
            };
            edit(&*tx, &mut m)?;
            m.updated_at_us = now(self);
            put_json(tx, &key(MEMBER, &[id]), &m)?;
            Ok(true)
        })
    }

    /// `insertAccessMember(spec)`: inserts the member (kind `person` when unset), creates the groups
    /// it names that are missing and adds it to each, in one write. Resolves `{ groupsCreated }`, the
    /// groups this call created, in the order named.
    pub fn insert_access_member(&self, spec: &AccessMemberInsert) -> Result<Value> {
        if spec.bind_token_id.is_some() {
            let what = "insertAccessMember: the store keeps no token binding yet (bindTokenId)";
            return Err(StoreError::new(INVALID_ARGUMENT, what));
        }
        let kind = spec.kind.as_deref().unwrap_or("person");
        check_id(&spec.id, "access_members")?;
        check_kind(kind)?;
        self.write(|tx| {
            let now_us = now(self);
            let k = key(MEMBER, &[&spec.id]);
            if tx.get(&k)?.is_some() {
                return Err(unique_refused("access_members_pkey"));
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
            put_json(tx, &k, &record)?;
            if tx.get(&config_key(RESTRICTIONS_PRESENT_KEY))?.as_deref() != Some(b"1".as_slice()) {
                tx.put(&config_key(RESTRICTIONS_PRESENT_KEY), b"1")?;
            }
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
                put_json(tx, &key(MEMBER, &[id]), &m)?;
            }
            refresh_serves(tx, now_us)
        })
    }

    /// `setAccessMemberEmail(id, email)`: sets or (with null) clears the email of a member that is
    /// not removed. Resolves true when a row changed. Refuses an email another member declares.
    pub fn set_access_member_email(&self, id: &str, email: Option<&str>) -> Result<bool> {
        self.update_live_member(id, |read, m| {
            check_email_free(read, email, id)?;
            m.email = email.map(str::to_string);
            Ok(())
        })
    }

    /// `setAccessMemberKind(id, kind)`: sets the kind of a member that is not removed.
    pub fn set_access_member_kind(&self, id: &str, kind: &str) -> Result<()> {
        check_kind(kind)?;
        self.update_live_member(id, |_, m| {
            m.kind = kind.to_string();
            Ok(())
        })
        .map(drop)
    }

    /// `setAccessMemberLabelledOnly(id, labelledOnly)`: sets or clears the grant of a member that
    /// is not removed. No serves key moves: the serves trigger fires only on `disabled_at` and
    /// `tombstoned_at`.
    pub fn set_access_member_labelled_only(&self, id: &str, labelled_only: bool) -> Result<()> {
        self.update_live_member(id, |_, m| {
            m.labelled_only = labelled_only;
            Ok(())
        })
        .map(drop)
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
                put_json(tx, &key(MEMBER, &[id]), &m)?;
            }
            refresh_serves(tx, now_us)?;
            drop_group_members(tx, |_, member| member == id)
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
            drop_group_members(tx, |g, m| g == group_id && members.iter().any(|x| x == m))
        })
    }

    /// `deleteAccessGroup(id)`: deletes the group and its group members.
    pub fn delete_access_group(&self, id: &str) -> Result<()> {
        self.write(|tx| {
            tx.delete(&key(GROUP, &[id]))?;
            drop_group_members(tx, |group, _| group == id)
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
        let members: Vec<MemberRecord> = match (&lookup.id, &lookup.email) {
            (Some(id), _) if id.contains('\0') => Vec::new(),
            (Some(id), _) => read_member(&*read, id)?.into_iter().collect(),
            (None, email) => all_members(&*read)?
                .into_iter()
                .filter(|m| match email {
                    Some(email) => m.email.as_deref() == Some(email.as_str()),
                    None => lookup.include_removed || m.tombstoned_at_us.is_none(),
                })
                .collect(),
        };
        let rows = members.iter().map(|m| {
            let mut g = groups.remove(&m.id).unwrap_or_default();
            g.sort();
            json!({
                "id": m.id, "display_name": m.display_name, "email": m.email, "kind": m.kind,
                "labelled_only": m.labelled_only, "disabled_at": m.disabled_at_us.map(iso),
                "tombstoned_at": m.tombstoned_at_us.map(iso), "created_at": iso(m.created_at_us),
                "groups": g,
            })
        });
        Ok(Value::Array(rows.collect()))
    }

    /// `readAccessGroups(id)`: every group with its member ids, or the one group `id` names
    /// (exactly that id), each `{ id, members }`; groups and members in byte order.
    pub fn read_access_groups(&self, id: Option<&str>) -> Result<Value> {
        let read = self.read()?;
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        scan_prefix(
            &*read,
            &[keys::ACCESS_MEMBERS, GROUP],
            false,
            &mut |k, _| {
                let group = String::from_utf8_lossy(&k[2..]).into_owned();
                if id.is_none_or(|id| id == group) {
                    groups.insert(group, Vec::new());
                }
                true
            },
        )?;
        for (group, member) in all_group_members(&*read)? {
            if let Some(members) = groups.get_mut(&group) {
                members.push(member);
            }
        }
        let rows = groups.into_iter().map(|(id, mut members)| {
            members.sort();
            json!({ "id": id, "members": members })
        });
        Ok(Value::Array(rows.collect()))
    }

    /// `listPagesNamingReader(principal, { live })`: the pages of every source whose normalized
    /// readers (`gbrain_access_readers`) name exactly `principal`, by source id then slug bytes, at
    /// most 51; with `live` soft-deleted pages are left out and at most 201 return.
    pub fn list_pages_naming_reader(&self, principal: &str, live: bool) -> Result<Value> {
        let mut pages: Vec<(String, String)> = all_pages(&*self.read()?)?
            .into_iter()
            .filter(|p| !live || p.deleted_at_us.is_none())
            .filter(|p| {
                access_readers(&p.frontmatter).is_some_and(|r| r.iter().any(|x| x == principal))
            })
            .map(|p| (p.source_id, p.slug))
            .collect();
        pages.sort();
        pages.truncate(if live { 201 } else { 51 });
        let rows = pages
            .into_iter()
            .map(|(source_id, slug)| json!({ "slug": slug, "source_id": source_id }));
        Ok(Value::Array(rows.collect()))
    }
}
