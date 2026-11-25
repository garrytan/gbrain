//! The store snapshot and the copy verifier (`rust/docs/store/snapshot.md`).
//!
//! `Brain#snapshotTo` copies the open brain at one committed generation and resolves only when
//! the Rust call has returned: the read is released and, on a cancel or an error, what the call
//! wrote is removed. `Brain#snapshotCancel` is not queued behind other work: it flips the flag the
//! call checks. `Pool#verifyStoreDir` reads a brain directory that nothing has open, without
//! opening it the normal way.
//!
//! Arguments are one object with `v: 1`; any other `v` is `invalid_argument`. Unknown fields are
//! refused, so a caller written against a later layout fails instead of being half understood.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use gbrain_store::error::{INVALID_STATE, StoreError};
use gbrain_store::snapshot::{SnapshotManifest, SnapshotOp};
use gbrain_store::verify::verify_store_dir;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::Value;

use crate::binding::{Pool, spawn};
use crate::error::TaskError;
use crate::store_binding::{Brain, required, task_error};

/// The ABI of the argument objects below.
const ARGS_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotArgs {
    v: u32,
    #[serde(rename = "opId")]
    op_id: String,
    /// Test seams (`SnapshotOp`): a pause after every batch, and a small batch size.
    #[serde(rename = "batchDelayMs", default)]
    batch_delay_ms: Option<u64>,
    #[serde(rename = "batchBytes", default)]
    batch_bytes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyArgs {
    v: u32,
    #[serde(default)]
    expected: Option<SnapshotManifest>,
}

fn check_version(v: u32) -> Result<(), StoreError> {
    if v == ARGS_VERSION {
        return Ok(());
    }
    Err(StoreError::invalid(format!(
        "the argument object has version {v}; this addon reads version {ARGS_VERSION}"
    )))
}

/// The snapshots running in this process, by caller-chosen operation id.
fn running() -> &'static Mutex<HashMap<String, Arc<SnapshotOp>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Arc<SnapshotOp>>>> = OnceLock::new();
    RUNNING.get_or_init(Mutex::default)
}

/// An operation id's place in the registry. Dropping it, when the call ends or when the call was
/// queued and never ran, frees the id.
struct Registration {
    op_id: String,
    op: Arc<SnapshotOp>,
}

impl Registration {
    /// Takes `op_id` now, on the calling thread, so a cancel that arrives while the call still
    /// waits for a worker finds it.
    fn take(op_id: &str, op: SnapshotOp) -> Result<Registration, StoreError> {
        let valid = !op_id.is_empty()
            && op_id.len() <= 128
            && op_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
        if !valid {
            return Err(StoreError::invalid(
                "opId must be 1 to 128 letters, digits, '.', '_' or '-'",
            ));
        }
        let op = Arc::new(op);
        let mut table = running().lock().unwrap_or_else(|e| e.into_inner());
        if table.contains_key(op_id) {
            return Err(StoreError::new(
                INVALID_STATE,
                "a snapshot with this opId is already running",
            ));
        }
        table.insert(op_id.to_owned(), op.clone());
        Ok(Registration {
            op_id: op_id.to_owned(),
            op,
        })
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        running()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.op_id);
    }
}

#[napi]
impl Brain {
    /// `snapshotTo(target, { v: 1, opId })`: copies the open brain at its latest committed
    /// generation into the new directory `target` and resolves the manifest (`SnapshotManifest`:
    /// `brain_id`, `generation`, `engine_format_version`, `schema_version`, `keys`, `bytes`,
    /// `tags`, `relations?`, `created_at_us`). Writers are never blocked.
    ///
    /// Rejects `snapshot_cancelled` after `snapshotCancel(opId)`, `invalid_argument` for a target
    /// that exists, sits under a symbolic link or overlaps the brain directory, `invalid_state`
    /// for an `opId` already running, and `store_io`. A rejection and a resolution both mean the
    /// Rust call has returned and holds nothing.
    #[napi]
    pub fn snapshot_to<'env>(
        &self,
        env: &'env Env,
        target: String,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        let registered = required::<SnapshotArgs>(options, "snapshotTo options").and_then(|args| {
            check_version(args.v)?;
            let mut op = SnapshotOp::new();
            if let Some(ms) = args.batch_delay_ms {
                op = op.with_batch_delay_ms(ms);
            }
            if let Some(bytes) = args.batch_bytes {
                op = op.with_batch_bytes(bytes);
            }
            Registration::take(&args.op_id, op)
        });
        self.run(env, move |store| {
            let registration = registered?;
            store.snapshot_to(&PathBuf::from(target), &registration.op)
        })
    }

    /// `snapshotCancel(opId)`: asks the running snapshot to stop; `true` when one was running.
    /// It returns at once. The snapshot's own promise settles after it has removed what it wrote.
    #[napi]
    pub fn snapshot_cancel(&self, op_id: String) -> bool {
        let table = running().lock().unwrap_or_else(|e| e.into_inner());
        table.get(&op_id).is_some_and(|op| {
            op.cancel();
            true
        })
    }
}

#[napi]
impl Pool {
    /// `verifyStoreDir(dir, { v: 1, expected? })`: reads the brain directory `dir` (a snapshot
    /// target, or the copy of a stopped store) without opening it the normal way, so no upgrade,
    /// repair or index build can change it first, and resolves the report (`VerifyReport`:
    /// `verdict` of `ok`, `mismatch` or `integrity`, the identity, format, generation, digests
    /// and `mismatches` as codes). `expected` is a `SnapshotManifest`.
    ///
    /// Rejects `store_io` for a file that is missing or was not closed cleanly, `store_locked`,
    /// `format_unknown` and `invalid_argument`. A damaged file is a verdict, not a rejection.
    #[napi]
    pub fn verify_store_dir<'env>(
        &self,
        env: &'env Env,
        dir: String,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        spawn(env, &self.pool, move || {
            let args: VerifyArgs =
                required(options, "verifyStoreDir options").map_err(task_error)?;
            check_version(args.v).map_err(task_error)?;
            let report = verify_store_dir(&PathBuf::from(dir), args.expected.as_ref())
                .map_err(task_error)?;
            serde_json::to_value(report).map_err(|e| {
                TaskError::new(
                    gbrain_store::error::STORE_CORRUPT,
                    format!("a result could not be encoded: {e}"),
                )
            })
        })
    }
}
