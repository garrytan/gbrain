//! Resumable-op checkpoints (src/core/op-checkpoint.ts): one `#[napi] impl Brain` block over
//! `gbrain_store::persistence` (rust/docs/store/persistence.md, "Op checkpoints").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readOpCheckpointKeys(op, fingerprint)`: `{ keys, corruptParent }`.
    #[napi]
    pub fn read_op_checkpoint_keys<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_op_checkpoint_keys(&op, &fingerprint))
    }

    /// `writeOpCheckpointKeys(op, fingerprint, keys)`: the parent's keys replaced.
    #[napi]
    pub fn write_op_checkpoint_keys<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let keys: Vec<String> = required(keys, "writeOpCheckpointKeys keys")?;
            s.write_op_checkpoint_keys(&op, &fingerprint, &keys)
        })
    }

    /// `appendOpCheckpointPaths(op, fingerprint, paths)`: the paths not yet banked added.
    #[napi]
    pub fn append_op_checkpoint_paths<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        paths: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let paths: Vec<String> = required(paths, "appendOpCheckpointPaths paths")?;
            s.append_op_checkpoint_paths(&op, &fingerprint, &paths)
        })
    }

    /// `deleteOpCheckpoint(op, fingerprint)`: the parent and its paths.
    #[napi]
    pub fn delete_op_checkpoint<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_op_checkpoint(&op, &fingerprint))
    }

    /// `deleteOpCheckpointPaths(op, fingerprint)`: the paths only.
    #[napi]
    pub fn delete_op_checkpoint_paths<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_op_checkpoint_paths(&op, &fingerprint)
        })
    }

    /// `readOpCheckpointRecord(op, fingerprint, freshWithinDays)`: `{ completed_keys, updated_at,
    /// fresh }` or null.
    #[napi]
    pub fn read_op_checkpoint_record<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        fresh_within_days: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_op_checkpoint_record(&op, &fingerprint, fresh_within_days)
        })
    }

    /// `listOpCheckpointRecords(op)`: every parent of `op` as `{ fingerprint, completed_keys,
    /// updated_at, updated_at_us }`, in fingerprint byte order.
    #[napi]
    pub fn list_op_checkpoint_records<'env>(
        &self,
        env: &'env Env,
        op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_op_checkpoint_records(&op))
    }

    /// `writeOpCheckpointRecord(op, fingerprint, completedKeys)`: the records replaced; null
    /// deletes the parent and its paths.
    #[napi]
    pub fn write_op_checkpoint_record<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        completed_keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let completed = (!completed_keys.is_null()).then_some(&completed_keys);
            s.write_op_checkpoint_record(&op, &fingerprint, completed)
        })
    }
}
