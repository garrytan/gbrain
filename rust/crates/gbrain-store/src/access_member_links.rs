//! Member links: the `access_member_links` table of the PGLite engine (schema migration v286). A
//! link names one person of a trusted system (`system`, `external_id`) as one access member.
//!
//! Members: readAccessMemberLink, insertAccessMemberLink, deleteAccessMemberLink,
//! listAccessMemberLinks.
//!
//! Key: `x 0x04 <system> 0x00 <external id>` -> `LinkRecord` (JSON), under `keys::ACCESS_MEMBERS`.
//! The system check refuses NUL, so a system's links are the prefix `x 0x04 <system> 0x00`.
//!
//! Refusals carry `constraint_violation` with the Postgres constraint name in the message: the
//! primary key (`access_member_links_pkey`), the two column checks
//! (`access_member_links_system_check`, `access_member_links_external_id_check`) and the member
//! reference (`access_member_links_member_id_fkey`). Members are never deleted (a removal is a
//! tombstone), so the `ON DELETE CASCADE` of the member reference has nothing to do here.

use crate::access_members::{all_group_members, member_key, now, read_member, refused};
use crate::env::iso;
use crate::error::Result;
use crate::kv::{KvRead, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const LINK: u8 = 0x04;

/// One `access_member_links` row, less the key columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LinkRecord {
    member_id: String,
    created_at_us: i64,
}

fn link_key(system: &str, external_id: &str) -> Vec<u8> {
    let mut key = vec![keys::ACCESS_MEMBERS, LINK];
    key.extend_from_slice(system.as_bytes());
    key.push(0);
    key.extend_from_slice(external_id.as_bytes());
    key
}

/// `CHECK (system ~ '^[a-z][a-z0-9_-]{0,31}$')`.
fn valid_system(system: &str) -> bool {
    let b = system.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'_' | b'-'))
}

/// `CHECK (length(external_id) >= 1 AND length(external_id) <= 256 AND external_id ~ '^[!-~]+$')`.
fn valid_external_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty() && b.len() <= 256 && b.iter().all(|c| (b'!'..=b'~').contains(c))
}

fn check(ok: bool, column: &str) -> Result<()> {
    if ok {
        return Ok(());
    }
    let constraint = format!("access_member_links_{column}_check");
    Err(refused(
        &constraint,
        format!(
            "new row for relation \"access_member_links\" violates check constraint \"{constraint}\""
        ),
    ))
}

fn link_json(system: &str, external_id: &str, link: &LinkRecord) -> Value {
    json!({
        "system": system, "external_id": external_id, "member_id": link.member_id,
        "created_at": iso(link.created_at_us),
    })
}

fn read_link(read: &dyn KvRead, system: &str, external_id: &str) -> Result<Option<LinkRecord>> {
    if system.contains('\0') {
        return Ok(None);
    }
    get_json(read, &link_key(system, external_id))
}

impl Store {
    /// `readAccessMemberLink(system, externalId)`: the link, matched exactly, or None.
    pub fn read_access_member_link(
        &self,
        system: &str,
        external_id: &str,
    ) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(read_link(&*read, system, external_id)?.map(|l| link_json(system, external_id, &l)))
    }

    /// `readLinkedMember(system, externalId)`: `{ id, groups }` of the member the link names when that member
    /// is neither disabled nor removed, its groups in byte order; None for no link or a member not enabled.
    /// Mirrors the join in engine-sql/access-members.ts `readLinkedMember`, whose groups sort with `COLLATE "C"`.
    pub fn read_linked_member(&self, system: &str, external_id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        let Some(link) = read_link(&*read, system, external_id)? else {
            return Ok(None);
        };
        let Some(member) = read_member(&*read, &link.member_id)?
            .filter(|m| m.disabled_at_us.is_none() && m.tombstoned_at_us.is_none())
        else {
            return Ok(None);
        };
        let mut groups: Vec<String> = all_group_members(&*read)?
            .into_iter()
            .filter(|(_, m)| *m == member.id)
            .map(|(g, _)| g)
            .collect();
        groups.sort();
        Ok(Some(json!({ "id": member.id, "groups": groups })))
    }

    /// `insertAccessMemberLink(system, externalId, memberId)`: adds the link. Refuses an invalid
    /// system or id, a link that exists and a member id with no member row.
    pub fn insert_access_member_link(
        &self,
        system: &str,
        external_id: &str,
        member_id: &str,
    ) -> Result<()> {
        check(valid_system(system), "system")?;
        check(valid_external_id(external_id), "external_id")?;
        self.write(|tx| {
            let key = link_key(system, external_id);
            if tx.get(&key)?.is_some() {
                return Err(refused(
                    "access_member_links_pkey",
                    format!(
                        "duplicate key value violates unique constraint \"access_member_links_pkey\": Key (system, external_id)=({system}, {external_id}) already exists."
                    ),
                ));
            }
            if tx.get(&member_key(member_id))?.is_none() {
                return Err(refused(
                    "access_member_links_member_id_fkey",
                    format!(
                        "insert or update on table \"access_member_links\" violates foreign key constraint \"access_member_links_member_id_fkey\": Key (member_id)=({member_id}) is not present in table \"access_members\"."
                    ),
                ));
            }
            let record = LinkRecord { member_id: member_id.to_owned(), created_at_us: now(self) };
            put_json(tx, &key, &record)
        })
    }

    /// `deleteAccessMemberLink(system, externalId)`: removes the link; nothing for no such link.
    pub fn delete_access_member_link(&self, system: &str, external_id: &str) -> Result<()> {
        if system.contains('\0') {
            return Ok(());
        }
        self.write(|tx| tx.delete(&link_key(system, external_id)))
    }

    /// `listAccessMemberLinks(memberId)`: every link, or the links of one member (exactly that id),
    /// by member id, system and external id, each in byte order.
    pub fn list_access_member_links(&self, member_id: Option<&str>) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<(String, String, LinkRecord)> = Vec::new();
        let mut bad = None;
        scan_prefix(&*read, &[keys::ACCESS_MEMBERS, LINK], false, &mut |k, v| {
            let rest = &k[2..];
            let Some(cut) = rest.iter().position(|&c| c == 0) else {
                return true;
            };
            match serde_json::from_slice::<LinkRecord>(v) {
                Ok(link) => {
                    if member_id.is_none_or(|m| m == link.member_id) {
                        rows.push((
                            String::from_utf8_lossy(&rest[..cut]).into_owned(),
                            String::from_utf8_lossy(&rest[cut + 1..]).into_owned(),
                            link,
                        ));
                    }
                }
                Err(e) => bad = Some(e),
            }
            bad.is_none()
        })?;
        if let Some(e) = bad {
            return Err(e.into());
        }
        rows.sort_by(|a, b| (&a.2.member_id, &a.0, &a.1).cmp(&(&b.2.member_id, &b.0, &b.1)));
        Ok(Value::Array(
            rows.iter().map(|(s, e, l)| link_json(s, e, l)).collect(),
        ))
    }
}
