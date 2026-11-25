//! Jobs: the credential members of `src/core/engine-sql/access-credentials.ts` over `access_tokens` and
//! `oauth_clients` (the token list and revokes, the client delete, the liveness checks, the token lifetime write)
//! and the OAuth token insert and bearer read (rust/docs/store/access-tokens.md, oauth-clients.md, oauth-tokens.md).

use gbrain_store::jobs::{OauthCodeInsert, OauthTokenInsert, TokenGrantColumns};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Value, json};

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listActiveAccessTokenRows()`: every token not revoked, whole with its hash, oldest first (doctor).
    #[napi]
    pub fn list_active_access_token_rows<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_active_access_token_rows())
    }

    /// `listActiveOauthClientRows()`: every client not deleted, whole, by client id (doctor).
    #[napi]
    pub fn list_active_oauth_client_rows<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_active_oauth_client_rows())
    }

    /// `listAttestCredentialRows()`: `[{ kind, id, name, row }]` of the live credentials with an attest actor (doctor).
    #[napi]
    pub fn list_attest_credential_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_attest_credential_rows())
    }

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

    /// `readJobPrincipal` for a legacy token: the token's whole row without its hash, revoked or not, or null.
    #[napi]
    pub fn read_access_token<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_access_token(&id))
    }

    /// `lockActiveAccessTokens({ id } | { name })`: the whole rows of the active tokens it names, without their hashes.
    #[napi]
    pub fn lock_active_access_tokens<'env>(
        &self,
        env: &'env Env,
        id: Option<String>,
        name: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.lock_active_access_tokens(id.as_deref(), name.as_deref())
        })
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

    /// `writeAccessTokenGrant(id, { columns, scopes, permissions })`: the token's new grant revision, or null.
    #[napi]
    pub fn write_access_token_grant<'env>(
        &self,
        env: &'env Env,
        id: String,
        columns: Value,
        scopes: Option<Vec<String>>,
        permissions: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let columns: TokenGrantColumns = required(columns, "writeAccessTokenGrant columns")?;
            s.write_access_token_grant(&id, &columns, scopes, permissions)
        })
    }

    /// `writeAccessTokenPrivateGrant(id, axis, value)`: sets `private_pages` or `private_facts` of one token.
    #[napi]
    pub fn write_access_token_private_grant<'env>(
        &self,
        env: &'env Env,
        id: String,
        axis: String,
        value: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_access_token_private_grant(&id, &axis, &value)
        })
    }

    /// `setAccessTokenReadSharedRevision(id, revision)`: stamps one token's read-shared switch; a null revision clears it.
    #[napi]
    pub fn set_access_token_read_shared_revision<'env>(
        &self,
        env: &'env Env,
        id: String,
        revision: Option<i32>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_access_token_read_shared_revision(&id, revision)
        })
    }

    /// `lockLegacyAccessTokens()`: the whole rows of the active tokens with no source grant, oldest first, without hashes.
    #[napi]
    pub fn lock_legacy_access_tokens<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.lock_legacy_access_tokens())
    }

    /// `countOauthAccessTokens(from, to)`: how many access tokens expire from `from` to `to` (epoch seconds, inclusive),
    /// or after `from` when `to` is null.
    #[napi]
    pub fn count_oauth_access_tokens<'env>(
        &self,
        env: &'env Env,
        from: i64,
        to: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_oauth_access_tokens(from, to))
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

    /// `listUnboundTokenNames()`: the names of the live tokens bound to no member, in byte order.
    #[napi]
    pub fn list_unbound_token_names<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_unbound_token_names())
    }

    /// `listUnboundClientIds()`: the ids of the live OAuth clients bound to no member, in byte order.
    #[napi]
    pub fn list_unbound_client_ids<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_unbound_client_ids())
    }

    /// `readLiveAccessToken(name)`: the member-key setup's row of the live token with this name, or null.
    #[napi]
    pub fn read_live_access_token<'env>(
        &self,
        env: &'env Env,
        name: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_live_access_token(&name))
    }

    /// `recordTokenSetupReads(name, reads)`: keeps `reads` as `setup_reads` in the live token's permissions.
    #[napi]
    pub fn record_token_setup_reads<'env>(
        &self,
        env: &'env Env,
        name: String,
        reads: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.record_token_setup_reads(&name, &reads))
    }

    /// `listKeysReadingSource(sourceId)`: the live member-bound keys whose read list holds another write source's id.
    #[napi]
    pub fn list_keys_reading_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_keys_reading_source(&source_id))
    }

    /// `issueOauthTokens(rows)`: null. The tokens of one grant in one write; a refused row leaves none.
    #[napi]
    pub fn issue_oauth_tokens<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<OauthTokenInsert> = required(rows, "issueOauthTokens rows")?;
            s.issue_oauth_tokens(&rows)
        })
    }

    /// `insertOauthCode(row)`: null.
    #[napi]
    pub fn insert_oauth_code<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: OauthCodeInsert = required(row, "insertOauthCode row")?;
            s.insert_oauth_code(&row)
        })
    }

    /// `readOauthCodeForUpdate(hash, clientId)`: the code's whole row, or null.
    #[napi]
    pub fn read_oauth_code_for_update<'env>(
        &self,
        env: &'env Env,
        hash: String,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_oauth_code_for_update(&hash, &client_id)
        })
    }

    /// `deleteOauthCode(hash, clientId)`: null.
    #[napi]
    pub fn delete_oauth_code<'env>(
        &self,
        env: &'env Env,
        hash: String,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_oauth_code(&hash, &client_id))
    }

    /// `readOauthRefreshTokenForUpdate(hash, clientId)`: the refresh token's whole row, or null.
    #[napi]
    pub fn read_oauth_refresh_token_for_update<'env>(
        &self,
        env: &'env Env,
        hash: String,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_oauth_refresh_token_for_update(&hash, &client_id)
        })
    }

    /// `deleteOauthRefreshToken(hash, clientId)`: null.
    #[napi]
    pub fn delete_oauth_refresh_token<'env>(
        &self,
        env: &'env Env,
        hash: String,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_oauth_refresh_token(&hash, &client_id)
        })
    }

    /// `readOauthCodeChallenge(hash, clientId, now)`: the PKCE challenge of an unexpired code of a live client, or null.
    #[napi]
    pub fn read_oauth_code_challenge<'env>(
        &self,
        env: &'env Env,
        hash: String,
        client_id: String,
        now: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_oauth_code_challenge(&hash, &client_id, now)
        })
    }

    /// `clientHoldsOauthCode(clientId)`: whether the client holds an authorization code (expired ones count).
    #[napi]
    pub fn client_holds_oauth_code<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.client_holds_oauth_code(&client_id))
    }

    /// `deleteExpiredOauthCredentials(now)`: how many OAuth tokens and codes with `expires_at` before `now` it deleted, in one write.
    #[napi]
    pub fn delete_expired_oauth_credentials<'env>(
        &self,
        env: &'env Env,
        now: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_expired_oauth_credentials(now))
    }

    /// `expireAllOauthCredentials()`: every OAuth token and code expires (`expires_at = 0`), in one write.
    #[napi]
    pub fn expire_all_oauth_credentials<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.expire_all_oauth_credentials())
    }
}
