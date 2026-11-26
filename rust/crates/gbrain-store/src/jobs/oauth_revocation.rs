//! Jobs: the revoke writes over `oauth_clients` and `oauth_tokens` that `OAuthGrants.revokeToken` and `revokeClient`
//! (and the client lifecycle) make, as the members of `src/core/engine-sql/oauth-revocation.ts` run them
//! (rust/docs/store/oauth-tokens.md, oauth-clients.md): delete one token of a client, delete every token of a client,
//! soft-delete a client, delete every authorization code of a client, and first consent's "holds an authorization" check. Each is one write, so inside a store transaction it joins that transaction.

use super::oauth_clients::{load_client, put_client};
use super::oauth_codes::{client_holds_code, delete_client_codes};
use super::oauth_tokens::{client_holds_token, delete_client_tokens, delete_token_of_client};
use super::*;

impl Store {
    /// `deleteOauthTokenByHash(hash, clientId)`: `DELETE FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2`.
    /// A token another client owns, or none, is left alone.
    pub fn delete_oauth_token_by_hash(&self, hash: &str, client_id: &str) -> Result<()> {
        self.write(|tx| delete_token_of_client(tx, hash, client_id))
    }

    /// `deleteOauthClientTokens(clientId)`: `DELETE FROM oauth_tokens WHERE client_id = $1`.
    pub fn delete_oauth_client_tokens(&self, client_id: &str) -> Result<()> {
        self.write(|tx| delete_client_tokens(tx, client_id))
    }

    /// `setOauthClientRevision(clientId, revision, revoke)`: `UPDATE oauth_clients SET grant_revision = $1` (with
    /// `deleted_at = COALESCE(deleted_at, now())` when `revoke`); whether the client exists.
    pub fn set_oauth_client_revision(
        &self,
        client_id: &str,
        revision: i32,
        revoke: bool,
    ) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = load_client(tx, client_id)? else {
                return Ok(false);
            };
            record.grant_revision = revision;
            if revoke && record.deleted_at.is_none() {
                record.deleted_at = Some(self.env.now_micros());
            }
            put_client(tx, &record)?;
            Ok(true)
        })
    }

    /// `setOauthClientReadSharedRevision(clientId, revision)`: `UPDATE oauth_clients SET read_shared_revision = $2
    /// WHERE client_id = $1` (GST-2898: the read-shared switch is on while it equals `grant_revision`; `None` clears
    /// it); whether a client has the id.
    pub fn set_oauth_client_read_shared_revision(
        &self,
        client_id: &str,
        revision: Option<i32>,
    ) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = load_client(tx, client_id)? else {
                return Ok(false);
            };
            record.read_shared_revision = revision;
            put_client(tx, &record)?;
            Ok(true)
        })
    }

    /// `softDeleteOauthClient(clientId)`: `UPDATE oauth_clients SET deleted_at = now() WHERE client_id = $1`; whether
    /// the client exists. A client already soft-deleted takes the new time (the statement has no guard).
    pub fn soft_delete_oauth_client(&self, client_id: &str) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = load_client(tx, client_id)? else {
                return Ok(false);
            };
            record.deleted_at = Some(self.env.now_micros());
            put_client(tx, &record)?;
            Ok(true)
        })
    }

    /// `deleteOauthClientCodes(clientId)`: `DELETE FROM oauth_codes WHERE client_id = $1`, so a revoked client keeps no
    /// code it could still exchange.
    pub fn delete_oauth_client_codes(&self, client_id: &str) -> Result<()> {
        self.write(|tx| delete_client_codes(tx, client_id))
    }

    /// `oauthClientHoldsAuthorization(clientId)`: `EXISTS (SELECT 1 FROM oauth_tokens WHERE client_id = $1) OR EXISTS
    /// (SELECT 1 FROM oauth_codes WHERE client_id = $2)`. Expired tokens and codes count, as on the SQL engines.
    pub fn oauth_client_holds_authorization(&self, client_id: &str) -> Result<bool> {
        let read = self.read()?;
        Ok(client_holds_token(&*read, client_id)? || client_holds_code(&*read, client_id)?)
    }
}
