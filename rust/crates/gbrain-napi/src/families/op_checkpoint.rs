//! Resumable-op checkpoints (src/core/op-checkpoint.ts): one `#[napi] impl Brain` block over
//! `gbrain_store::persistence` (rust/docs/store/persistence.md, "Op checkpoints").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::persistence::{SyncImportPageQuery, SyncImportPageWindow};

/// One row of `writeOpCheckpointRecords(op, rows)`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordRow {
    fingerprint: String,
    record: Value,
}

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

    /// `readOpCheckpointRecords(op, fingerprints)`: each found parent's first completed key.
    #[napi]
    pub fn read_op_checkpoint_records<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprints: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fingerprints: Vec<String> =
                required(fingerprints, "readOpCheckpointRecords fingerprints")?;
            s.read_op_checkpoint_records(&op, &fingerprints)
        })
    }

    /// `writeOpCheckpointRecords(op, rows)`: each parent set to `[record]`.
    #[napi]
    pub fn write_op_checkpoint_records<'env>(
        &self,
        env: &'env Env,
        op: String,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<RecordRow> = required(rows, "writeOpCheckpointRecords rows")?;
            let rows: Vec<(String, Value)> = rows
                .into_iter()
                .map(|row| (row.fingerprint, row.record))
                .collect();
            s.write_op_checkpoint_records(&op, &rows)
        })
    }

    /// `readSyncImportPageRows(q, window)`: a sync pass's `I⋈P` rows for a window of page ids or a keyset page.
    #[napi]
    pub fn read_sync_import_page_rows<'env>(
        &self,
        env: &'env Env,
        query: Value,
        window: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: SyncImportPageQuery = required(query, "readSyncImportPageRows query")?;
            let window: SyncImportPageWindow = required(window, "readSyncImportPageRows window")?;
            s.read_sync_import_page_rows(&query, &window)
        })
    }

    /// `purgeStaleCheckpoints(ttlDays)`: how many stale checkpoints it deleted.
    #[napi]
    pub fn purge_stale_checkpoints<'env>(
        &self,
        env: &'env Env,
        ttl_days: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.purge_stale_checkpoints(ttl_days))
    }

    /// `readOpCheckpointRow(op, fingerprint)`: `{ fingerprint, completed_keys, updated_at }` or null.
    #[napi]
    pub fn read_op_checkpoint_row<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_op_checkpoint_row(&op, &fingerprint))
    }

    /// `putOpCheckpointRow(op, fingerprint, completedKeys)`: the row created or replaced.
    #[napi]
    pub fn put_op_checkpoint_row<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        completed_keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.put_op_checkpoint_row(&op, &fingerprint, completed_keys)
        })
    }

    /// `replaceOpCheckpointRow(op, fingerprint, expected, completedKeys)`: whether it landed.
    #[napi]
    pub fn replace_op_checkpoint_row<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        expected: Value,
        completed_keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.replace_op_checkpoint_row(&op, &fingerprint, &expected, completed_keys)
        })
    }

    /// `listOpCheckpointRows(op, fingerprintPrefix)`: the rows in fingerprint byte order.
    #[napi]
    pub fn list_op_checkpoint_rows<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint_prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_op_checkpoint_rows(&op, &fingerprint_prefix)
        })
    }
}
