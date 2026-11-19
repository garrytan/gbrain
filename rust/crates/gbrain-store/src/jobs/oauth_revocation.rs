//! Jobs: the revoke writes over `oauth_clients` and `oauth_tokens` that `OAuthGrants.revokeToken` and `revokeClient`
//! (and the client lifecycle) make, as the members of `src/core/engine-sql/oauth-revocation.ts` run them
//! (rust/docs/store/oauth-tokens.md, oauth-clients.md): delete one token of a client, delete every token of a client,
//! soft-delete a client. Each is one write, so inside a store transaction it joins that transaction.

use super::oauth_clients::{load_client, put_client};
use super::oauth_tokens::{delete_client_tokens, delete_token_of_client};
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
}
