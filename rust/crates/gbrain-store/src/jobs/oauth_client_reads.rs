//! Jobs: the reads of the `oauth_clients` table that callers once ran through `executeRaw`, as the members of
//! `src/core/engine-sql/collate-store-reads.ts` run them (rust/docs/store/oauth-clients.md). The rows are the
//! client records of `oauth_clients.rs` (sub-tag 0x2A); this file keeps nothing of its own.
//!
//! Members: listClientsReferencingSource.

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
}
