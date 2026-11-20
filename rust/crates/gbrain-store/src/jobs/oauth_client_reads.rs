//! Jobs: the reads of the `oauth_clients` table that callers once ran through `executeRaw`, as the members of
//! `src/core/engine-sql/collate-store-reads.ts` run them (rust/docs/store/oauth-clients.md). The rows are the
//! client records of `oauth_clients.rs` (sub-tag 0x2A); this file keeps nothing of its own.
//!
//! Members: listClientsReferencingSource, readOwnerCredentials.

use super::access_tokens::owner_credential_tokens;
use super::oauth_clients::all_clients;
use super::*;

impl Store {
    /// `listClientsReferencingSource(sourceId)`: every client whose `source_id` is this source, soft-deleted ones
    /// too (the foreign key is physical), as `{ clientId, clientName, deleted }`, by client id in byte order
    /// (`ORDER BY client_id COLLATE "C"`).
    pub fn list_clients_referencing_source(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        let mut clients: Vec<_> = all_clients(&*read)?
            .into_iter()
            .filter(|c| c.source_id.as_deref() == Some(source_id))
            .collect();
        clients.sort_by(|a, b| a.client_id.as_bytes().cmp(b.client_id.as_bytes()));
        Ok(Value::Array(
            clients
                .into_iter()
                .map(|c| {
                    json!({
                        "clientId": c.client_id,
                        "clientName": c.client_name,
                        "deleted": c.deleted_at.is_some(),
                    })
                })
                .collect(),
        ))
    }

    /// `readOwnerCredentials(memberId)`: `{ kind, id, name, row }` of every client not deleted and every token not revoked
    /// bound to this member, clients before tokens, then by name, then by id in byte order (`ORDER BY kind COLLATE "C", name
    /// COLLATE "C", id COLLATE "C"`). A client's row is the whole row less its secret hash (`to_jsonb(c) - 'client_secret_hash'`);
    /// a token's has its grant columns only.
    pub fn read_owner_credentials(&self, member_id: &str) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<(&'static str, String, String, Value)> = all_clients(&*read)?
            .into_iter()
            .filter(|c| c.deleted_at.is_none() && c.member_id.as_deref() == Some(member_id))
            .map(|c| {
                (
                    "client",
                    c.client_id.clone(),
                    c.client_name.clone(),
                    c.to_grant_json(),
                )
            })
            .collect();
        for (id, name, row) in owner_credential_tokens(&*read, member_id)? {
            rows.push(("token", id, name, row));
        }
        rows.sort_by(|a, b| {
            a.0.as_bytes()
                .cmp(b.0.as_bytes())
                .then_with(|| a.2.as_bytes().cmp(b.2.as_bytes()))
                .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
        });
        Ok(Value::Array(
            rows.into_iter()
                .map(|(kind, id, name, row)| json!({ "kind": kind, "id": id, "name": name, "row": row }))
                .collect(),
        ))
    }
}
