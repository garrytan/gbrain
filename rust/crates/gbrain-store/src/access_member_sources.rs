//! Personal sources: the `access_member_sources` table of the PGLite engine (schema migration
//! v299). A row binds a source to the member it belongs to; a source with at least one binding is
//! personal (src/core/access/member-sources.ts).
//!
//! Members: readAccessMemberSource, insertAccessMemberSource, deleteAccessMemberSource,
//! listAccessMemberSources, listAccessMemberSourceOwners, readMemberSourceBindings.
//!
//! Key: `x 0x10 <member id> 0x00 <source id>` -> `BindingRecord` (JSON), under
//! `keys::ACCESS_MEMBERS`. Member ids never hold NUL (the member id check), so a member's bindings
//! are the prefix `x 0x10 <member id> 0x00`. A brain holds few bindings, so the reads by source scan
//! the prefix. Sub-keys 0x05-0x0c of `x` are taken on other lanes; 0x10 is clear of them.
//!
//! Every list is in byte order of the member id, then the source id, as PGLite and Postgres sort
//! (the SQL sort keys carry COLLATE "C", so every Postgres locale sorts by byte). Refusals carry `constraint_violation` with the Postgres constraint name in the
//! message: the member reference (`access_member_sources_member_id_fkey`). `source_id` has no
//! foreign key, as on Postgres. A source id holding NUL is refused by name, as Postgres refuses NUL
//! in text. Members are never deleted (a removal is a tombstone), so the `ON DELETE CASCADE` of the
//! member reference has nothing to do here.

use crate::access_members::{member_key, now, refused};
use crate::env::iso;
use crate::error::Result;
use crate::kv::{KvRead, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const BINDING: u8 = 0x10;

/// One `access_member_sources` row, less the key columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BindingRecord {
    created_at_us: i64,
}

fn binding_key(member_id: &str, source_id: &str) -> Vec<u8> {
    let mut key = vec![keys::ACCESS_MEMBERS, BINDING];
    key.extend_from_slice(member_id.as_bytes());
    key.push(0);
    key.extend_from_slice(source_id.as_bytes());
    key
}

fn binding_json(member_id: &str, source_id: &str, b: &BindingRecord) -> Value {
    json!({ "member_id": member_id, "source_id": source_id, "created_at": iso(b.created_at_us) })
}

/// Every binding as (member id, source id, record), in byte order of the key, which is byte order
/// of the member id and then the source id (NUL sorts first, and no id holds it).
fn all_bindings(read: &dyn KvRead) -> Result<Vec<(String, String, BindingRecord)>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        &[keys::ACCESS_MEMBERS, BINDING],
        false,
        &mut |k, v| {
            let rest = &k[2..];
            let Some(cut) = rest.iter().position(|&c| c == 0) else {
                return true;
            };
            match serde_json::from_slice::<BindingRecord>(v) {
                Ok(b) => rows.push((
                    String::from_utf8_lossy(&rest[..cut]).into_owned(),
                    String::from_utf8_lossy(&rest[cut + 1..]).into_owned(),
                    b,
                )),
                Err(e) => bad = Some(e),
            }
            bad.is_none()
        },
    )?;
    if let Some(e) = bad {
        return Err(e.into());
    }
    rows.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    Ok(rows)
}

fn has_nul(a: &str, b: &str) -> bool {
    a.contains('\0') || b.contains('\0')
}

impl Store {
    /// `readAccessMemberSource(memberId, sourceId)`: the binding, matched exactly, or None.
    pub fn read_access_member_source(
        &self,
        member_id: &str,
        source_id: &str,
    ) -> Result<Option<Value>> {
        if has_nul(member_id, source_id) {
            return Ok(None);
        }
        let read = self.read()?;
        let row: Option<BindingRecord> = get_json(&*read, &binding_key(member_id, source_id))?;
        Ok(row.map(|b| binding_json(member_id, source_id, &b)))
    }

    /// `insertAccessMemberSource(memberId, sourceId)`: binds the source to the member; nothing when
    /// the binding exists (`ON CONFLICT DO NOTHING`). Refuses a member id with no member row and a
    /// source id holding NUL.
    pub fn insert_access_member_source(&self, member_id: &str, source_id: &str) -> Result<()> {
        if source_id.contains('\0') {
            return Err(refused(
                "access_member_sources_source_id",
                "invalid byte sequence for encoding \"UTF8\": 0x00 in access_member_sources.source_id".to_owned(),
            ));
        }
        self.write(|tx| {
            if member_id.contains('\0') || tx.get(&member_key(member_id))?.is_none() {
                return Err(refused(
                    "access_member_sources_member_id_fkey",
                    format!(
                        "insert or update on table \"access_member_sources\" violates foreign key constraint \"access_member_sources_member_id_fkey\": Key (member_id)=({member_id}) is not present in table \"access_members\"."
                    ),
                ));
            }
            let key = binding_key(member_id, source_id);
            if tx.get(&key)?.is_some() {
                return Ok(());
            }
            put_json(tx, &key, &BindingRecord { created_at_us: now(self) })
        })
    }

    /// `deleteAccessMemberSource(memberId, sourceId)`: removes the binding; nothing for no such binding.
    pub fn delete_access_member_source(&self, member_id: &str, source_id: &str) -> Result<()> {
        if has_nul(member_id, source_id) {
            return Ok(());
        }
        self.write(|tx| tx.delete(&binding_key(member_id, source_id)))
    }

    /// `listAccessMemberSources(memberId)`: every binding, or the bindings of one member (exactly
    /// that id), by member id and source id in byte order.
    pub fn list_access_member_sources(&self, member_id: Option<&str>) -> Result<Value> {
        let read = self.read()?;
        Ok(Value::Array(
            all_bindings(&*read)?
                .iter()
                .filter(|(m, _, _)| member_id.is_none_or(|want| want == m))
                .map(|(m, s, b)| binding_json(m, s, b))
                .collect(),
        ))
    }

    /// `listAccessMemberSourceOwners(sourceId)`: the member ids bound to the source, in byte order.
    pub fn list_access_member_source_owners(&self, source_id: &str) -> Result<Vec<String>> {
        let read = self.read()?;
        Ok(all_bindings(&*read)?
            .into_iter()
            .filter(|(_, s, _)| s == source_id)
            .map(|(m, _, _)| m)
            .collect())
    }

    /// `readMemberSourceBindings(sourceIds)`: `{ source_id, member_id }` of every binding of the named
    /// sources, by source id and then member id in byte order.
    pub fn read_member_source_bindings(&self, source_ids: &[String]) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<(String, String)> = all_bindings(&*read)?
            .into_iter()
            .filter(|(_, s, _)| source_ids.iter().any(|want| want == s))
            .map(|(m, s, _)| (s, m))
            .collect();
        rows.sort();
        Ok(Value::Array(
            rows.into_iter()
                .map(|(s, m)| json!({ "source_id": s, "member_id": m }))
                .collect(),
        ))
    }
}
