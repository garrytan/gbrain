//! A managed sync run's journal reads and the `sync.admission` stamp and probes
//! (`gbrain_store::persistence::sync_run_reads`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use gbrain_store::persistence::SyncAdmissionEffectsQuery;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readAdmittedWriteRequests(principal, requestIds, committedOnly)`: the principal's request rows
    /// under the named request ids, each once; only committed ones when `committedOnly`.
    #[napi]
    pub fn read_admitted_write_requests<'env>(
        &self,
        env: &'env Env,
        principal: Value,
        request_ids: Value,
        committed_only: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = required(request_ids, "readAdmittedWriteRequests requestIds")?;
            s.read_admitted_write_requests(
                &required(principal, "readAdmittedWriteRequests principal")?,
                &ids,
                committed_only,
            )
        })
    }

    /// `readPageRevisionWriter(pageId, sourceId)`: `{ revision, writer }` or `null`.
    #[napi]
    pub fn read_page_revision_writer<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: u64 = required(page_id, "readPageRevisionWriter pageId")?;
            s.read_page_revision_writer(page_id, &source_id)
        })
    }

    /// `readRevisionWriterRequest(id)`: `{ request_id, operation, kind, state, incarnation, page_id }`
    /// or `null`.
    #[napi]
    pub fn read_revision_writer_request<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_revision_writer_request(&id))
    }

    /// `writeSyncAdmissionStamp(op, fingerprint, value)`: the `set_at` it stored.
    #[napi]
    pub fn write_sync_admission_stamp<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        value: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_sync_admission_stamp(&op, &fingerprint, &value)
        })
    }

    /// `readSyncAdmissionEffects(input)`: `{ pinned, destructive }`.
    #[napi]
    pub fn read_sync_admission_effects<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: SyncAdmissionEffectsQuery = required(input, "readSyncAdmissionEffects input")?;
            s.read_sync_admission_effects(&q)
        })
    }
}
