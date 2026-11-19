//! Jobs: the revoke members of `src/core/engine-sql/oauth-revocation.ts` over `oauth_tokens` and `oauth_clients`
//! (rust/docs/store/oauth-tokens.md, oauth-clients.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

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

    /// `softDeleteOauthClient(clientId)`: whether a client has the id.
    #[napi]
    pub fn soft_delete_oauth_client<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.soft_delete_oauth_client(&client_id))
    }
}
