//! The operation checkpoint statements (`src/core/engine-sql/op-checkpoint.ts`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readOpCheckpoint(op, fingerprint)`: `{ keys, corruptParent }`.
    #[napi]
    pub fn read_op_checkpoint<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_op_checkpoint(&op, &fingerprint))
    }

    /// `writeOpCheckpointKeys(op, fingerprint, keys)`: replace the parent's completed keys.
    #[napi]
    pub fn write_op_checkpoint_keys<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        keys: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_op_checkpoint_keys(&op, &fingerprint, &keys)
        })
    }

    /// `appendOpCheckpointPaths(op, fingerprint, paths)`: bank new paths under the parent.
    #[napi]
    pub fn append_op_checkpoint_paths<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        paths: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.append_op_checkpoint_paths(&op, &fingerprint, &paths)
        })
    }

    /// `deleteOpCheckpoint(op, fingerprint)`: drop the parent and its paths.
    #[napi]
    pub fn delete_op_checkpoint<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_op_checkpoint(&op, &fingerprint))
    }
}
