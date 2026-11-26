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
    /// `readAtomGeneration(pageId, contentHash)`: the generation, a number.
    #[napi]
    pub fn read_atom_generation<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        content_hash: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_atom_generation(page_id, &content_hash))
    }

    /// `recordAtomGenerationBump({ sourceId, incarnation, pageId, keepContentHash, keepGeneration })`: resolves null.
    #[napi]
    pub fn record_atom_generation_bump<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: gbrain_store::persistence::AtomGenerationBump =
                required(args, "recordAtomGenerationBump args")?;
            s.record_atom_generation_bump(&a)
        })
    }

    /// `releasePartialAtomDispositions(sourceId, maxInputChars)`: resolves null.
    #[napi]
    pub fn release_partial_atom_dispositions<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        max_input_chars: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.release_partial_atom_dispositions(&source_id, max_input_chars)
        })
    }

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

    /// `insertOpCheckpointIfAbsent(op, fingerprint, completedKeys)`: true when this call stored it.
    #[napi]
    pub fn insert_op_checkpoint_if_absent<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        completed_keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_op_checkpoint_if_absent(&op, &fingerprint, &completed_keys)
        })
    }

    /// `upsertFenceTrendRunRecord(op, fingerprint, record)`: stores a sync run's fence trend row,
    /// or rewrites it keeping the `day` of its first write.
    #[napi]
    pub fn upsert_fence_trend_run_record<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        record: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.upsert_fence_trend_run_record(&op, &fingerprint, &record)
        })
    }

    /// `addSoakCounterEvent(op, day, kind, n)`: adds `n` to one soak counter of the day's row; resolves null.
    #[napi]
    pub fn add_soak_counter_event<'env>(
        &self,
        env: &'env Env,
        op: String,
        day: String,
        kind: String,
        n: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.add_soak_counter_event(&op, &day, &kind, n))
    }

    /// `replaceOpCheckpointAtVersion(op, fingerprint, completedKeys, expected)`: true when this
    /// call replaced the records at version `expected`.
    #[napi]
    pub fn replace_op_checkpoint_at_version<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        completed_keys: Value,
        expected: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.replace_op_checkpoint_at_version(&op, &fingerprint, &completed_keys, expected)
        })
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

    /// `recordConnectorSyncAttempt(sourceId, at, seed)`: resolves false for an unknown source; stamps
    /// the source's first connector sync attempt once.
    #[napi]
    pub fn record_connector_sync_attempt<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        at: String,
        seed: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.record_connector_sync_attempt(&source_id, &at, &seed)
        })
    }

    /// `writeConnectorDbCursor(key, record)`: writes an unmanaged connector's cursor row.
    #[napi]
    pub fn write_connector_db_cursor<'env>(
        &self,
        env: &'env Env,
        key: String,
        record: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.write_connector_db_cursor(&key, &record))
    }

    /// `recordSyncConversion(sourceId, incarnation, conversion, keep)`: the conversion first in the
    /// source incarnation's log, keeping the newest `keep`.
    #[napi]
    pub fn record_sync_conversion<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
        conversion: Value,
        keep: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.record_sync_conversion(&source_id, &incarnation, &conversion, keep as usize)
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
