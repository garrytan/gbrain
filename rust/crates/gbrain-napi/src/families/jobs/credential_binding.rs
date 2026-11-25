//! Jobs: the credential binding members over `access_tokens` and `oauth_clients` (the binding read and writes, the
//! live credential read of readLiveMember and readMayActFor, readAccessCredentials and the two write grant reads;
//! rust/docs/store/access-tokens.md, oauth-clients.md).

use gbrain_store::jobs::{CredentialBinding, CredentialKind, CredentialLookup};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Value, json};

use crate::store_binding::{Brain, required};

fn kind(text: String) -> Result<CredentialKind, gbrain_store::StoreError> {
    required(json!(text), "credential kind")
}

#[napi]
impl Brain {
    /// `readCredentialBindingForUpdate(target, { readsUnscoped })`: the binding columns of the token or client, or null.
    #[napi]
    pub fn read_credential_binding<'env>(
        &self,
        env: &'env Env,
        target_kind: String,
        id: String,
        reads_unscoped: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_credential_binding(kind(target_kind)?, &id, reads_unscoped)
        })
    }

    /// `writeCredentialBinding(target, binding)`: resolves null.
    #[napi]
    pub fn write_credential_binding<'env>(
        &self,
        env: &'env Env,
        target_kind: String,
        id: String,
        binding: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let binding: CredentialBinding = required(binding, "writeCredentialBinding binding")?;
            s.write_credential_binding(kind(target_kind)?, &id, &binding)
        })
    }

    /// `writeCredentialReadsUnscoped(target, readsUnscoped)`: resolves null.
    #[napi]
    pub fn write_credential_reads_unscoped<'env>(
        &self,
        env: &'env Env,
        target_kind: String,
        id: String,
        reads_unscoped: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_credential_reads_unscoped(kind(target_kind)?, &id, reads_unscoped)
        })
    }

    /// The token and client halves of readLiveMember and readMayActFor: `{ member_id, may_act_for }`, or null.
    #[napi]
    pub fn read_live_credential<'env>(
        &self,
        env: &'env Env,
        via: String,
        key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_live_credential(&via, &key))
    }

    /// `listCredentialMemberBindings(names)`: `[{ name, member_id }]` of the live tokens and clients named.
    #[napi]
    pub fn list_credential_member_bindings<'env>(
        &self,
        env: &'env Env,
        names: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_credential_member_bindings(&names))
    }

    /// `readAccessTokenAttest(id)` and `readOauthClientAttest(clientId)`: the attest row of the token or client
    /// (revoked or deleted too), or null.
    #[napi]
    pub fn read_credential_attest<'env>(
        &self,
        env: &'env Env,
        target_kind: String,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_credential_attest(kind(target_kind)?, &id)
        })
    }

    /// `readAccessCredentials(by)`: `[{ kind, id, name }]`.
    #[napi]
    pub fn read_access_credentials<'env>(
        &self,
        env: &'env Env,
        by: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let by: CredentialLookup = required(by, "readAccessCredentials by")?;
            s.read_access_credentials(&by)
        })
    }

    /// `listOwnerCredentialRows(memberId)`: `[{ kind, id, name, row }]`.
    #[napi]
    pub fn list_owner_credential_rows<'env>(
        &self,
        env: &'env Env,
        member_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_owner_credential_rows(&member_id))
    }

    /// `readOAuthClientWriteGrant(clientId)`: the client's write grant columns, or null.
    #[napi]
    pub fn read_oauth_client_write_grant<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_oauth_client_write_grant(&client_id))
    }

    /// `readAccessTokenWriteGrant(tokenId)`: the token's write grant columns, or null.
    #[napi]
    pub fn read_access_token_write_grant<'env>(
        &self,
        env: &'env Env,
        token_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_access_token_write_grant(&token_id))
    }
}
