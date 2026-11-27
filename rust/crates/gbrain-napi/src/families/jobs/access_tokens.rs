//! Jobs: `access_tokens` (the mint insert, the active-token find, the live-token scope read, the read floor) (rust/docs/store/access-tokens.md).

use gbrain_store::jobs::TokenInsert;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Value, json};

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `insertAccessToken(row)`: `{ id }` of the new token.
    #[napi]
    pub fn insert_access_token<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: TokenInsert = required(row, "insertAccessToken row")?;
            Ok(json!({ "id": s.insert_access_token(&row)? }))
        })
    }

    /// `findActiveAccessTokens(target)`: `[{ id, name, min_trust }]`.
    #[napi]
    pub fn find_active_access_tokens<'env>(
        &self,
        env: &'env Env,
        target: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.find_active_access_tokens(&target))
    }

    /// `readAccessTokenNames(ids)`: `[{ id, name }]` of the tokens with those ids, revoked ones included, by id.
    #[napi]
    pub fn read_access_token_names<'env>(
        &self,
        env: &'env Env,
        ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_access_token_names(&ids))
    }

    /// `readLiveAccessTokenScope(id)`: a live token's `{ reads_unscoped, created_at }`, or null.
    #[napi]
    pub fn read_live_access_token_scope<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_live_access_token_scope(&id))
    }

    /// `setAccessTokenMinTrust(id, tier)`: whether a token had the id.
    #[napi]
    pub fn set_access_token_min_trust<'env>(
        &self,
        env: &'env Env,
        id: String,
        tier: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.set_access_token_min_trust(&id, tier.as_deref())
        })
    }
}
