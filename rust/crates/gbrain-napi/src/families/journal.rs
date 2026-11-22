//! The write journal: brain identity, local writers, write admission and receipts.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `getBrainIdentity()`: `{ brain_id }`.
    #[napi]
    pub fn get_brain_identity<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_brain_identity())
    }

    /// `registerLocalWriter({ id, lane, credentialHash, grantCeiling? })`: the writer row.
    /// Idempotent; `writer_rejected` for a revoked row or a lane or credential mismatch.
    #[napi]
    pub fn register_local_writer<'env>(
        &self,
        env: &'env Env,
        writer: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.register_local_writer(&required(writer, "registerLocalWriter writer")?)
        })
    }

    /// `readLocalWriter(id)`: the writer row or `null`.
    #[napi]
    pub fn read_local_writer<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_local_writer(&id))
    }

    /// `revokeLocalWriter(id)`: `true` when the registration exists.
    #[napi]
    pub fn revoke_local_writer<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.revoke_local_writer(&id))
    }

    /// `admitWrite(admission, limits?)`: the stored `WriteRequest`, state `queued` when new.
    #[napi]
    pub fn admit_write<'env>(
        &self,
        env: &'env Env,
        admission: Value,
        limits: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let limits = match limits {
                None | Some(Value::Null) => None,
                Some(v) => Some(required(v, "admitWrite limits")?),
            };
            s.admit_write(&required(admission, "admitWrite admission")?, limits)
        })
    }

    /// `getWriteRequest(principal, requestId)`: the stored `WriteRequest` or `null`.
    #[napi]
    pub fn get_write_request<'env>(
        &self,
        env: &'env Env,
        principal: Value,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_write_request(
                &required(principal, "getWriteRequest principal")?,
                &request_id,
            )
        })
    }

    /// `getWriteReceipt(principal, requestId)`: `receiptFor` of the stored request or `null`.
    #[napi]
    pub fn get_write_receipt<'env>(
        &self,
        env: &'env Env,
        principal: Value,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_write_receipt(
                &required(principal, "getWriteReceipt principal")?,
                &request_id,
            )
        })
    }

    /// `finishWrite(principal, requestId, { state, outcome?, errorCode?, errorMessage?,
    /// blockedReason? })`: ends a request in a terminal state and resolves its receipt.
    #[napi]
    pub fn finish_write<'env>(
        &self,
        env: &'env Env,
        principal: Value,
        request_id: String,
        finish: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.finish_write(
                &required(principal, "finishWrite principal")?,
                &request_id,
                &required(finish, "finishWrite finish")?,
            )
        })
    }

    /// `journalOutstanding()`: `{ brain, principals }`, counts of unfinished requests.
    #[napi]
    pub fn journal_outstanding<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.journal_outstanding())
    }

    /// `submitPageMutation({ principal, requestId?, clientRequestId?, sourceIncarnation?, slug,
    /// page, options?, authority? }, limits?)`: admits, applies and commits a page write in one
    /// transaction and resolves its receipt.
    #[napi]
    pub fn submit_page_mutation<'env>(
        &self,
        env: &'env Env,
        mutation: Value,
        limits: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let limits = match limits {
                None | Some(Value::Null) => None,
                Some(v) => Some(required(v, "submitPageMutation limits")?),
            };
            s.submit_page_mutation(&required(mutation, "submitPageMutation mutation")?, limits)
        })
    }
}
