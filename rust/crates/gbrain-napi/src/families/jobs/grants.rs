//! Jobs: the grant members of `src/core/engine-sql/client-grants.ts` over `oauth_clients`, the grant audit and the
//! source config (rust/docs/store/oauth-clients.md).

use gbrain_store::jobs::{ClientInsert, GrantPersist, RegisterAudit};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Map, Value};

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `persistOauthClientGrant(input)`: whether the client held the expected revision (false: nothing written).
    #[napi]
    pub fn persist_oauth_client_grant<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: GrantPersist = required(input, "persistOauthClientGrant input")?;
            s.persist_oauth_client_grant(&input)
        })
    }

    /// `insertOauthClientGrant(row, audit)`: null. The client and its register audit row, in one write.
    #[napi]
    pub fn insert_oauth_client_grant<'env>(
        &self,
        env: &'env Env,
        row: Value,
        audit: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: ClientInsert = required(row, "insertOauthClientGrant row")?;
            let audit: RegisterAudit = required(audit, "insertOauthClientGrant audit")?;
            s.insert_oauth_client_grant(&row, &audit)
        })
    }

    /// `listOauthGrantAudit(clientId)`: the client's audit rows, oldest first.
    #[napi]
    pub fn list_oauth_grant_audit<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_oauth_grant_audit(&client_id))
    }

    /// `readLatestCatalogProvenanceAudit(clientId)`: the newest audit `after_grant` that has a catalog provenance, or null.
    #[napi]
    pub fn read_latest_catalog_provenance_audit<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_latest_catalog_provenance_audit(&client_id)
        })
    }

    /// `readLiveOauthClients()`: every client not deleted, whole rows.
    #[napi]
    pub fn read_live_oauth_clients<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_live_oauth_clients())
    }

    /// `readLiveAccessTokenRows()`: every token not revoked, whole rows.
    #[napi]
    pub fn read_live_access_token_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_live_access_token_rows())
    }

    /// `listAccessTokenRows()`: every token, revoked ones too, whole rows newest first.
    #[napi]
    pub fn list_access_token_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_access_token_rows())
    }

    /// `readSourceGrantState(id)`: `{ archived, config }` of the source, or null.
    #[napi]
    pub fn read_source_grant_state<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_grant_state(&id))
    }

    /// `replaceSourceConfig(id, config)`: whether the source exists.
    #[napi]
    pub fn replace_source_config<'env>(
        &self,
        env: &'env Env,
        id: String,
        config: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let config: Map<String, Value> = required(config, "replaceSourceConfig config")?;
            s.replace_source_config(&id, &config)
        })
    }
}
