//! Jobs: the credential binding of `access_tokens` and `oauth_clients`, as the members of
//! `src/core/engine-sql/access-members.ts`, `access-control.ts` and `persistence-journal.ts` run them
//! (rust/docs/store/access-tokens.md, rust/docs/store/oauth-clients.md).
//!
//! Members: readCredentialBindingForUpdate, writeCredentialBinding and writeCredentialReadsUnscoped (the binding
//! `gbrain access member bind` and `gbrain auth` write); the token and client reads of readLiveMember and readMayActFor
//! (read_live_credential); readAccessCredentials; and the write re-check reads readOAuthClientWriteGrant and
//! readAccessTokenWriteGrant.
//!
//! No keys of its own: it reads and writes the token records of `access_tokens.rs` (`m 0x2B id`) and the client records
//! of `oauth_clients.rs` (`m 0x2A client_id`); a client write goes through `put_client`, which holds the row to the
//! table's constraints. A token is found by its id text exactly (`id::text = $1`), except by the write grant read,
//! which compares a UUID (`id = $1`, so any case). The `FOR UPDATE` and `FOR SHARE` locks have nothing to wait for
//! here: the store runs one write transaction at a time.

use super::access_tokens::{TokenRecord, all_tokens, token_key};
use super::oauth_clients::{all_clients, load_client, put_client};
use super::*;
use crate::env::transaction_clock;

/// Which credential a binding names: an access token (by id text) or an OAuth client (by client_id).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialKind {
    Token,
    Client,
}

/// `writeCredentialBinding(target, binding)`: the six columns the write sets (None is NULL).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CredentialBinding {
    pub member: Option<String>,
    pub may_act_for: Option<Vec<String>>,
    pub attest_actor: Option<String>,
    pub attest_ops: Option<Vec<String>>,
    pub attest_sources: Option<Vec<String>>,
    pub attest_read: Option<String>,
}

/// `readAccessCredentials(by)`: the active tokens with exactly this name, or the live credentials bound to exactly
/// this member.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CredentialLookup {
    pub token_name: Option<String>,
    pub member_id: Option<String>,
}

fn load_token(read: &dyn KvRead, id: &str) -> Result<Option<TokenRecord>> {
    get_json(read, &token_key(id))
}

/// `now()` of the write transaction.
fn now(store: &Store) -> i64 {
    transaction_clock::transaction_now().unwrap_or_else(|| store.env.now_micros())
}

impl Store {
    /// `readCredentialBindingForUpdate(target, { readsUnscoped })`: `{ member_id, may_act_for, attest_actor,
    /// attest_ops, attest_sources, attest_read }` of the token or client, with `grant_types` and `confidential` (a
    /// secret hash is stored) for a client, and `reads_unscoped` (ISO text or NULL) when asked; None when no row has
    /// the id.
    pub fn read_credential_binding(
        &self,
        kind: CredentialKind,
        id: &str,
        reads_unscoped: bool,
    ) -> Result<Option<Value>> {
        let read = self.read()?;
        let (mut row, unscoped) = match kind {
            CredentialKind::Token => {
                let Some(t) = load_token(&*read, id)? else {
                    return Ok(None);
                };
                (
                    json!({
                        "member_id": t.member_id, "may_act_for": t.may_act_for, "attest_actor": t.attest_actor,
                        "attest_ops": t.attest_ops, "attest_sources": t.attest_sources, "attest_read": t.attest_read,
                    }),
                    t.reads_unscoped,
                )
            }
            CredentialKind::Client => {
                let Some(c) = load_client(&*read, id)? else {
                    return Ok(None);
                };
                (
                    json!({
                        "member_id": c.member_id, "may_act_for": c.may_act_for, "attest_actor": c.attest_actor,
                        "attest_ops": c.attest_ops, "attest_sources": c.attest_sources, "attest_read": c.attest_read,
                        "grant_types": c.grant_types, "confidential": c.client_secret_hash.is_some(),
                    }),
                    c.reads_unscoped,
                )
            }
        };
        if reads_unscoped && let Some(map) = row.as_object_mut() {
            map.insert(
                "reads_unscoped".into(),
                unscoped.map_or(Value::Null, |m| json!(iso(m))),
            );
        }
        Ok(Some(row))
    }

    /// `writeCredentialBinding(target, binding)`: sets the member, may_act_for and attest columns of the token or
    /// client, in one write; nothing changes when no row has the id.
    pub fn write_credential_binding(
        &self,
        kind: CredentialKind,
        id: &str,
        binding: &CredentialBinding,
    ) -> Result<()> {
        let b = binding.clone();
        self.write(|tx| match kind {
            CredentialKind::Token => {
                let Some(mut t) = load_token(&*tx, id)? else {
                    return Ok(());
                };
                t.member_id = b.member.clone();
                t.may_act_for = b.may_act_for.clone();
                t.attest_actor = b.attest_actor.clone();
                t.attest_ops = b.attest_ops.clone();
                t.attest_sources = b.attest_sources.clone();
                t.attest_read = b.attest_read.clone();
                put_json(tx, &token_key(id), &t)
            }
            CredentialKind::Client => {
                let Some(mut c) = load_client(&*tx, id)? else {
                    return Ok(());
                };
                c.member_id = b.member.clone();
                c.may_act_for = b.may_act_for.clone();
                c.attest_actor = b.attest_actor.clone();
                c.attest_ops = b.attest_ops.clone();
                c.attest_sources = b.attest_sources.clone();
                c.attest_read = b.attest_read.clone();
                put_client(tx, &c)
            }
        })
    }

    /// `writeCredentialReadsUnscoped(target, readsUnscoped)`: sets `reads_unscoped` to the transaction's time (true)
    /// or clears it (false), in one write; nothing changes when no row has the id.
    pub fn write_credential_reads_unscoped(
        &self,
        kind: CredentialKind,
        id: &str,
        reads_unscoped: bool,
    ) -> Result<()> {
        self.write(|tx| {
            let stamp = reads_unscoped.then(|| now(self));
            match kind {
                CredentialKind::Token => {
                    let Some(mut t) = load_token(&*tx, id)? else {
                        return Ok(());
                    };
                    t.reads_unscoped = stamp;
                    put_json(tx, &token_key(id), &t)
                }
                CredentialKind::Client => {
                    let Some(mut c) = load_client(&*tx, id)? else {
                        return Ok(());
                    };
                    c.reads_unscoped = stamp;
                    put_client(tx, &c)
                }
            }
        })
    }

    /// The token and client halves of readLiveMember and readMayActFor: `{ member_id, may_act_for }` of the token not
    /// revoked whose id text is exactly `key` (`via` `legacy_token`), or of the client not deleted with this client id
    /// (`oauth_client`); None for a revoked, deleted or absent credential. `invalid_argument` for any other `via`.
    pub fn read_live_credential(&self, via: &str, key: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        match via {
            "legacy_token" => Ok(load_token(&*read, key)?
                .filter(|t| t.revoked_at.is_none())
                .map(|t| json!({ "member_id": t.member_id, "may_act_for": t.may_act_for }))),
            "oauth_client" => Ok(load_client(&*read, key)?
                .filter(|c| c.deleted_at.is_none())
                .map(|c| json!({ "member_id": c.member_id, "may_act_for": c.may_act_for }))),
            other => Err(StoreError::invalid(format!(
                "read_live_credential: \"{other}\" is not legacy_token or oauth_client"
            ))),
        }
    }

    /// `listCredentialMemberBindings(names)` (the brain-audience heuristic): `[{ name, member_id }]` for every token not
    /// revoked whose name is one of `names`, then every client not deleted whose client id is one of them. Tokens come
    /// in key order, then clients in key order (the SQL `UNION ALL` has no set order). An empty list reads nothing.
    pub fn list_credential_member_bindings(&self, names: &[String]) -> Result<Value> {
        if names.is_empty() {
            return Ok(Value::Array(Vec::new()));
        }
        let wanted: std::collections::BTreeSet<&str> = names.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut out = Vec::new();
        for t in all_tokens(&*read)? {
            if t.revoked_at.is_none() && wanted.contains(t.name.as_str()) {
                out.push(json!({ "name": t.name, "member_id": t.member_id }));
            }
        }
        for c in all_clients(&*read)? {
            if c.deleted_at.is_none() && wanted.contains(c.client_id.as_str()) {
                out.push(json!({ "name": c.client_id, "member_id": c.member_id }));
            }
        }
        Ok(Value::Array(out))
    }

    /// `readAccessTokenAttest(id)` and `readOauthClientAttest(clientId)`: `{ attest_actor, attest_ops, attest_sources,
    /// attest_read, member_id }` of the token whose id text is exactly `id` with its `revoked_at`, or of the client with
    /// this client id with `client_id`, `deleted_at`, `grant_types` and `confidential` (a secret hash is stored); a
    /// revoked token and a deleted client are read too. None when no row has the id.
    pub fn read_credential_attest(&self, kind: CredentialKind, id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(match kind {
            CredentialKind::Token => load_token(&*read, id)?.map(|t| {
                json!({
                    "revoked_at": t.revoked_at.map(iso), "attest_actor": t.attest_actor, "attest_ops": t.attest_ops,
                    "attest_sources": t.attest_sources, "attest_read": t.attest_read, "member_id": t.member_id,
                })
            }),
            CredentialKind::Client => load_client(&*read, id)?.map(|c| {
                json!({
                    "client_id": c.client_id, "deleted_at": c.deleted_at.map(iso), "attest_actor": c.attest_actor,
                    "attest_ops": c.attest_ops, "attest_sources": c.attest_sources, "attest_read": c.attest_read,
                    "member_id": c.member_id, "grant_types": c.grant_types,
                    "confidential": c.client_secret_hash.is_some(),
                })
            }),
        })
    }

    /// `readAccessCredentials(by)`: `[{ kind, id, name }]`. By token name: the tokens not revoked with exactly that
    /// name, oldest first (a tie by id). By member: the tokens not revoked bound to exactly that member, by name in
    /// byte order (a tie by id), then the clients not deleted bound to it, by client id in byte order.
    pub fn read_access_credentials(&self, by: &CredentialLookup) -> Result<Value> {
        let read = self.read()?;
        let row =
            |kind: &str, id: String, name: String| json!({ "kind": kind, "id": id, "name": name });
        if let Some(name) = &by.token_name {
            let mut tokens: Vec<TokenRecord> = all_tokens(&*read)?
                .into_iter()
                .filter(|t| t.revoked_at.is_none() && &t.name == name)
                .collect();
            tokens.sort_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.id.cmp(&b.id))
            });
            return Ok(Value::Array(
                tokens
                    .into_iter()
                    .map(|t| row("token", t.id, t.name))
                    .collect(),
            ));
        }
        let Some(member) = &by.member_id else {
            return Err(StoreError::invalid(
                "readAccessCredentials: name a tokenName or a memberId",
            ));
        };
        let mut tokens: Vec<TokenRecord> = all_tokens(&*read)?
            .into_iter()
            .filter(|t| t.revoked_at.is_none() && t.member_id.as_ref() == Some(member))
            .collect();
        tokens.sort_by(|a, b| {
            a.name
                .as_bytes()
                .cmp(b.name.as_bytes())
                .then_with(|| a.id.cmp(&b.id))
        });
        let mut clients: Vec<_> = all_clients(&*read)?
            .into_iter()
            .filter(|c| c.deleted_at.is_none() && c.member_id.as_ref() == Some(member))
            .collect();
        clients.sort_by(|a, b| a.client_id.as_bytes().cmp(b.client_id.as_bytes()));
        Ok(Value::Array(
            tokens
                .into_iter()
                .map(|t| row("token", t.id, t.name))
                .chain(
                    clients
                        .into_iter()
                        .map(|c| row("client", c.client_id, c.client_name)),
                )
                .collect(),
        ))
    }

    /// `listOwnerCredentialRows(memberId)`: `[{ kind, id, name, row }]`, the live credentials bound to `memberId` as
    /// guests/owner-credentials.ts read them: each token that is not revoked (its row the grant columns and `min_trust`,
    /// as `jsonb_build_object` builds them) and each client that is not deleted (its row as `to_jsonb(c) -
    /// 'client_secret_hash'`, its name the client name). Ordered by kind, name and id, each by byte, as `COLLATE "C"`.
    pub fn list_owner_credential_rows(&self, member_id: &str) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<(String, String, String, Value)> = Vec::new();
        for t in all_tokens(&*read)? {
            if t.revoked_at.is_some() || t.member_id.as_deref() != Some(member_id) {
                continue;
            }
            let row = json!({
                "id": t.id, "scopes": t.scopes, "permissions": t.permissions, "private_pages": t.private_pages,
                "private_facts": t.private_facts, "grant_revision": t.grant_revision,
                "read_shared_revision": t.read_shared_revision, "source_grant": t.source_grant,
                "source_id": t.source_id, "federated_read": t.federated_read,
                "allowed_operations": t.allowed_operations, "takes_holders": t.takes_holders,
                "min_trust": t.min_trust,
            });
            rows.push(("token".into(), t.name.clone(), t.id.clone(), row));
        }
        for c in all_clients(&*read)? {
            if c.deleted_at.is_some() || c.member_id.as_deref() != Some(member_id) {
                continue;
            }
            rows.push((
                "client".into(),
                c.client_name.clone(),
                c.client_id.clone(),
                c.to_grant_json(),
            ));
        }
        rows.sort_by(|a, b| {
            a.0.as_bytes()
                .cmp(b.0.as_bytes())
                .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
                .then_with(|| a.2.as_bytes().cmp(b.2.as_bytes()))
        });
        Ok(Value::Array(
            rows.into_iter()
                .map(|(kind, name, id, row)| json!({ "kind": kind, "id": id, "name": name, "row": row }))
                .collect(),
        ))
    }

    /// `readOAuthClientWriteGrant(clientId)`: the columns the write re-check reads, of the client with this client id,
    /// deleted or not (the caller reads `deleted_at`, ISO text or NULL), or None.
    pub fn read_oauth_client_write_grant(&self, client_id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(load_client(&*read, client_id)?.map(|c| {
            json!({
                "deleted_at": c.deleted_at.map(iso), "scope": c.scope, "source_id": c.source_id,
                "source_grant": c.source_grant, "allowed_operations": c.allowed_operations,
                "bound_slug_prefixes": c.bound_slug_prefixes, "bound_tools": c.bound_tools,
                "delegated_namespace": c.delegated_namespace, "delegated_slug_prefixes": c.delegated_slug_prefixes,
            })
        }))
    }

    /// `readAccessTokenWriteGrant(tokenId)`: the token grant columns (`TOKEN_GRANT_ROW_COLUMNS`) and `revoked_at` (ISO
    /// text or NULL) of the token with this id (a UUID, so any case), revoked or not, or None.
    pub fn read_access_token_write_grant(&self, token_id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(
            load_token(&*read, &token_id.to_ascii_lowercase())?.map(|t| {
                json!({
                    "id": t.id, "scopes": t.scopes, "permissions": t.permissions, "private_pages": t.private_pages,
                    "private_facts": t.private_facts, "grant_revision": t.grant_revision, "source_grant": t.source_grant,
                    "source_id": t.source_id, "federated_read": t.federated_read,
                    "allowed_operations": t.allowed_operations, "takes_holders": t.takes_holders,
                    "revoked_at": t.revoked_at.map(iso),
                })
            }),
        )
    }
}
