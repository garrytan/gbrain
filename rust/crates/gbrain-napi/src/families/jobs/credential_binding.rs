//! Jobs: the credential binding members over `access_tokens` and `oauth_clients` (the binding read and writes, the
//! live credential read of readLiveMember and readMayActFor, and readAccessCredentials; rust/docs/store/access-members.md).

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
}
