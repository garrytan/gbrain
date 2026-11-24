//! Jobs: the revoke members of `src/core/engine-sql/oauth-revocation.ts` over `oauth_tokens` and `oauth_clients`
//! (rust/docs/store/oauth-tokens.md, oauth-clients.md).

use gbrain_store::jobs::GrantAuditInsert;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `deleteOauthTokenByHash(hash, clientId)`: null.
    #[napi]
    pub fn delete_oauth_token_by_hash<'env>(
        &self,
        env: &'env Env,
        hash: String,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_oauth_token_by_hash(&hash, &client_id)
        })
    }

    /// `deleteOauthClientTokens(clientId)`: null.
    #[napi]
    pub fn delete_oauth_client_tokens<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_oauth_client_tokens(&client_id))
    }

    /// `deleteOauthClientCodes(clientId)`: null.
    #[napi]
    pub fn delete_oauth_client_codes<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_oauth_client_codes(&client_id))
    }

    /// `oauthClientHoldsAuthorization(clientId)`: whether the client holds an OAuth token or an authorization code.
    #[napi]
    pub fn oauth_client_holds_authorization<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.oauth_client_holds_authorization(&client_id))
    }

    /// `softDeleteOauthClient(clientId)`: whether a client has the id.
    #[napi]
    pub fn soft_delete_oauth_client<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.soft_delete_oauth_client(&client_id))
    }

    /// `setOauthClientRevision(clientId, revision, revoke)`: whether a client has the id.
    #[napi]
    pub fn set_oauth_client_revision<'env>(
        &self,
        env: &'env Env,
        client_id: String,
        revision: i32,
        revoke: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_oauth_client_revision(&client_id, revision, revoke)
        })
    }

    /// `setOauthClientReadSharedRevision(clientId, revision)`: whether a client has the id; a null revision clears it.
    #[napi]
    pub fn set_oauth_client_read_shared_revision<'env>(
        &self,
        env: &'env Env,
        client_id: String,
        revision: Option<i32>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_oauth_client_read_shared_revision(&client_id, revision)
        })
    }

    /// `insertOauthGrantAudit(row)`: null.
    #[napi]
    pub fn insert_oauth_grant_audit<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: GrantAuditInsert = required(row, "insertOauthGrantAudit row")?;
            s.insert_oauth_grant_audit(&row)
        })
    }
}
