//! The fence-repair checkpoint members (rust/docs/store/fence-checkpoints.md): a candidate part
//! stored beside the part already there, the candidate records of live sources and an op's
//! checkpoint records.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use gbrain_store::error::StoreError;
use gbrain_store::fence_checkpoints::FenceCandidatePartWrite;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `upsertFenceCandidatePart({ op, fingerprint, sourceId, incarnation, key, part, finding })`.
    #[napi]
    pub fn upsert_fence_candidate_part<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: FenceCandidatePartWrite = serde_json::from_value(spec)
                .map_err(|e| StoreError::invalid(format!("upsertFenceCandidatePart spec: {e}")))?;
            s.upsert_fence_candidate_part(&spec)
        })
    }

    /// `readFenceCandidateRecords(op, sourceIds)`: the records of live source incarnations.
    #[napi]
    pub fn read_fence_candidate_records<'env>(
        &self,
        env: &'env Env,
        op: String,
        source_ids: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Option<Vec<String>> = arg(source_ids, "readFenceCandidateRecords sourceIds")?;
            s.read_fence_candidate_records(&op, ids.as_deref())
        })
    }

    /// `readOpCheckpointRecords(op, sourceIds)`: `[{ fingerprint, record }]` by fingerprint byte.
    #[napi]
    pub fn read_op_checkpoint_records<'env>(
        &self,
        env: &'env Env,
        op: String,
        source_ids: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Option<Vec<String>> = arg(source_ids, "readOpCheckpointRecords sourceIds")?;
            s.read_op_checkpoint_records(&op, ids.as_deref())
        })
    }
}
