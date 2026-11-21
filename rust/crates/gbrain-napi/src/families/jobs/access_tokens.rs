//! Jobs: `access_tokens` (the mint insert, the active-token find, the read floor) (rust/docs/store/access-tokens.md).

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

    /// `listAccessTokens()`: every token, revoked ones too, newest first, with every column.
    #[napi]
    pub fn list_access_tokens<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.list_access_tokens())
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

    /// `readActiveAccessTokenByHash(hash)`: the whole row of the live token with this hash, or null.
    #[napi]
    pub fn read_active_access_token_by_hash<'env>(
        &self,
        env: &'env Env,
        hash: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_active_access_token_by_hash(&hash))
    }

    /// `touchAccessTokenLastUsed(id, unified)`: null; the debounced last-use stamp.
    #[napi]
    pub fn touch_access_token_last_used<'env>(
        &self,
        env: &'env Env,
        id: String,
        unified: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.touch_access_token_last_used(&id, unified))
    }
}
