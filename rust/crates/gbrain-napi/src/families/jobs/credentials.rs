//! Jobs: the credential members of `src/core/engine-sql/access-credentials.ts` over `access_tokens` and
//! `oauth_clients` (the token list and revokes, the client delete, the liveness checks, the token lifetime write)
//! (rust/docs/store/access-tokens.md, rust/docs/store/oauth-clients.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::json;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listAccessTokens()`: every token's listed row, newest first.
    #[napi]
    pub fn list_access_tokens<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_access_tokens())
    }

    /// `readActiveAccessTokenGrant(id)`: `{ permissions, private_pages }`, or null.
    #[napi]
    pub fn read_active_access_token_grant<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_active_access_token_grant(&id))
    }

    /// `readActiveAccessTokenByHash(hash)`: the active token's whole row without its hash, or null.
    #[napi]
    pub fn read_active_access_token_by_hash<'env>(
        &self,
        env: &'env Env,
        hash: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_active_access_token_by_hash(&hash))
    }

    /// `accessTokenLive(id)`: whether an active token has the id.
    #[napi]
    pub fn access_token_live<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.access_token_live(&id))
    }

    /// `revokeAccessTokensNamed(name)`: the revoked ids.
    #[napi]
    pub fn revoke_access_tokens_named<'env>(
        &self,
        env: &'env Env,
        name: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.revoke_access_tokens_named(&name))
    }

    /// `revokeAccessToken(id)`: the revoked token's name, or null.
    #[napi]
    pub fn revoke_access_token<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.revoke_access_token(&id))
    }

    /// `deleteOAuthClient(clientId)`: `{ client_id, client_name }` of the deleted client, or null.
    #[napi]
    pub fn delete_oauth_client<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            Ok(s.delete_oauth_client(&client_id)?
                .map(|(client_id, client_name)| json!({ "client_id": client_id, "client_name": client_name })))
        })
    }

    /// `oauthClientLive(clientId)`: whether a client not deleted has the id.
    #[napi]
    pub fn oauth_client_live<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.oauth_client_live(&client_id))
    }

    /// `setOauthClientTokenTtl(clientId, ttl)`: whether the client exists.
    #[napi]
    pub fn set_oauth_client_token_ttl<'env>(
        &self,
        env: &'env Env,
        client_id: String,
        ttl: i32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.set_oauth_client_token_ttl(&client_id, ttl))
    }
}
