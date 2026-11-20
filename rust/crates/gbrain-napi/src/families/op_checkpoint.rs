//! Resumable-op checkpoints (src/core/op-checkpoint.ts): one `#[napi] impl Brain` block over
//! `gbrain_store::persistence` (rust/docs/store/persistence.md, "Op checkpoints").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::persistence::GitHoldSummaryDelta;

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

    /// `swapGitHold(input)`: the hold at `path` replaced by `next` (null deletes it) when it still
    /// holds `prior` (null: no hold), with the summary counters `summary` moves; resolves whether it
    /// swapped.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn swap_git_hold<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
        path: String,
        prior: Value,
        next: Value,
        summary: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let summary: Option<GitHoldSummaryDelta> = required(summary, "swapGitHold summary")?;
            s.swap_git_hold(
                &source_id,
                &incarnation,
                &path,
                (!prior.is_null()).then_some(&prior),
                (!next.is_null()).then_some(&next),
                summary.as_ref(),
            )
        })
    }

    /// `readGitHoldRecord(sourceId, incarnation, path)`: `{ record, mirror_read_only }` or null.
    #[napi]
    pub fn read_git_hold_record<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
        path: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_git_hold_record(&source_id, &incarnation, &path)
        })
    }

    /// `requestGitHoldRetry(sourceId, incarnation, paths, requestedAt)`.
    #[napi]
    pub fn request_git_hold_retry<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
        paths: Vec<String>,
        requested_at: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.request_git_hold_retry(&source_id, &incarnation, &paths, &requested_at)
        })
    }

    /// `readRepairBusyRows(sourceId, incarnation)`.
    #[napi]
    pub fn read_repair_busy_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_repair_busy_rows(&source_id, &incarnation)
        })
    }
}
