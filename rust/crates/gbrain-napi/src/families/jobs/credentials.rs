//! Jobs: the credential members of `src/core/engine-sql/access-credentials.ts` over `access_tokens` and
//! `oauth_clients` (the token list and revokes, the client delete, the liveness checks, the token lifetime write)
//! and the OAuth token insert and bearer read (rust/docs/store/access-tokens.md, oauth-clients.md, oauth-tokens.md).

use gbrain_store::jobs::{OauthTokenInsert, TokenGrantColumns};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Value, json};

use crate::store_binding::{Brain, required};

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

    /// `insertOauthToken(row)`: null.
    #[napi]
    pub fn insert_oauth_token<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: OauthTokenInsert = required(row, "insertOauthToken row")?;
            s.insert_oauth_token(&row)
        })
    }

    /// `readOauthAccessTokenRows(hash, rung)`: `[row]` of the bearer check's OAuth token read, or `[]`.
    #[napi]
    pub fn read_oauth_access_token_rows<'env>(
        &self,
        env: &'env Env,
        hash: String,
        rung: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_oauth_access_token_rows(&hash, u8::try_from(rung).unwrap_or(u8::MAX))
        })
    }

    /// `touchAccessTokenLastUsed(id, unified)`: null.
    #[napi]
    pub fn touch_access_token_last_used<'env>(
        &self,
        env: &'env Env,
        id: String,
        unified: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.touch_access_token_last_used(&id, unified))
    }

    /// `convertLegacyAccessTokenGrant(id, columns)`: the converted token's whole row, or null.
    #[napi]
    pub fn convert_legacy_access_token_grant<'env>(
        &self,
        env: &'env Env,
        id: String,
        columns: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let columns: TokenGrantColumns =
                required(columns, "convertLegacyAccessTokenGrant columns")?;
            s.convert_legacy_access_token_grant(&id, &columns)
        })
    }

    /// `delete_expired_oauth_tokens(now)`: how many tokens with `expires_at` before `now` (epoch seconds) it deleted.
    #[napi]
    pub fn delete_expired_oauth_tokens<'env>(
        &self,
        env: &'env Env,
        now: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_expired_oauth_tokens(now))
    }
}
