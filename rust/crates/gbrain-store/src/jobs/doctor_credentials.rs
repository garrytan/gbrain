//! Jobs: doctor's three credential reads (`src/core/engine-sql/doctor-acc.ts`) over the token and OAuth client records
//! (rust/docs/store/cli-reads-doctor-acc.md): the active tokens and live clients as `SELECT *` returns them, and the
//! attest credentials as `to_jsonb` rows. The grant, legacy-token and attest-read doctor checks read them. Also the
//! member handover preview's bound-credential count (`countMemberBoundCredentials`).

use super::access_tokens::all_tokens;
use super::oauth_clients::all_clients;
use super::*;

impl Store {
    /// `listActiveAccessTokenRows()`: every token not revoked, whole with its hash, oldest first (a tie by id), as
    /// `SELECT * FROM access_tokens WHERE revoked_at IS NULL ORDER BY created_at, id` returns them.
    pub fn list_active_access_token_rows(&self) -> Result<Value> {
        let read = self.read()?;
        let mut tokens: Vec<_> = all_tokens(&*read)?
            .into_iter()
            .filter(|t| t.revoked_at.is_none())
            .collect();
        tokens
            .sort_by(|a, b| (a.created_at, a.id.as_bytes()).cmp(&(b.created_at, b.id.as_bytes())));
        Ok(Value::Array(
            tokens.iter().map(|t| t.row_with_hash()).collect(),
        ))
    }

    /// `listActiveOauthClientRows()`: every client not deleted, whole (its secret hash too), by client id in byte
    /// order, as `SELECT * FROM oauth_clients WHERE deleted_at IS NULL ORDER BY client_id COLLATE "C"` returns them.
    pub fn list_active_oauth_client_rows(&self) -> Result<Value> {
        let read = self.read()?;
        let mut clients: Vec<_> = all_clients(&*read)?
            .into_iter()
            .filter(|c| c.deleted_at.is_none())
            .collect();
        clients.sort_by(|a, b| a.client_id.as_bytes().cmp(b.client_id.as_bytes()));
        Ok(Value::Array(clients.iter().map(|c| c.to_row()).collect()))
    }

    /// `listAttestCredentialRows()`: `[{ kind, id, name, row }]` of the tokens not revoked and the clients not deleted
    /// that carry an attest actor. A token's row is `to_jsonb(t)`; a client's is `to_jsonb(c) - 'client_secret_hash'`
    /// and its name is the client name. By kind, then name, in byte order (the SQL sets no further order; a tie goes
    /// by id here).
    pub fn list_attest_credential_rows(&self) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<(String, String, String, Value)> = Vec::new();
        for t in all_tokens(&*read)? {
            if t.revoked_at.is_none() && t.attest_actor.is_some() {
                rows.push((
                    "token".into(),
                    t.name.clone(),
                    t.id.clone(),
                    t.to_jsonb_row(),
                ));
            }
        }
        for c in all_clients(&*read)? {
            if c.deleted_at.is_none() && c.attest_actor.is_some() {
                rows.push((
                    "client".into(),
                    c.client_name.clone(),
                    c.client_id.clone(),
                    c.to_grant_json(),
                ));
            }
        }
        rows.sort_by(|a, b| {
            (a.0.as_bytes(), a.1.as_bytes(), a.2.as_bytes()).cmp(&(
                b.0.as_bytes(),
                b.1.as_bytes(),
                b.2.as_bytes(),
            ))
        });
        Ok(Value::Array(
            rows.into_iter()
                .map(|(kind, name, id, row)| json!({ "kind": kind, "id": id, "name": name, "row": row }))
                .collect(),
        ))
    }

    /// `countMemberBoundCredentials(memberId)`: the member's tokens not revoked plus every OAuth client bound to it
    /// (a deleted client still counts, as the SQL's `oauth_clients WHERE member_id = $1` does).
    pub fn count_member_bound_credentials(&self, member_id: &str) -> Result<u64> {
        let read = self.read()?;
        let tokens = all_tokens(&*read)?
            .into_iter()
            .filter(|t| t.revoked_at.is_none() && t.member_id.as_deref() == Some(member_id))
            .count();
        let clients = all_clients(&*read)?
            .into_iter()
            .filter(|c| c.member_id.as_deref() == Some(member_id))
            .count();
        Ok((tokens + clients) as u64)
    }
}
