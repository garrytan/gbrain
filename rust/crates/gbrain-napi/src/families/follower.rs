//! The follower's addon methods (multi-user mode; `gbrain_store::follower`,
//! rust/docs/store/commit-log.md "Followers and promotion"), for lane L3's follower frames
//! (`src/core/rust-engine/served/follower-frames.ts`):
//!
//! - `Follower#open(dir)`, `#close()`, `#cursor()`;
//! - `Follower#applyRaw(brainId, lineage, [{ sequence, index, bytes }])` ->
//!   `{ applied, skipped, cursor }`; `lineage` is `[{ id, from: { sequence, index } }]`;
//! - `Follower#installSnapshot(dir, manifest | null)` -> the cursor (`manifest` is `SNAPSHOT.json`'s form);
//! - `Brain#readCommitLogRaw(after | null, max)`: the primary's records as the bytes it stores,
//!   unchanged (I-4.v2): TypeScript never parses one.
//!
//! Positions cross as JavaScript numbers: a `sequence` must be a safe integer below 2^53 and an
//! `index` an integer from 0 to 2^32 - 1 (which covers `CommitPosition::end_of`); anything else is
//! refused with `invalid_argument`, never truncated. Store refusals keep their codes
//! (`snapshot_required`, `invalid_state`, ...).

use std::sync::{Arc, Mutex};

use gbrain_store::commit_log::{CommitPosition, Timeline};
use gbrain_store::follower::Follower as StoreFollower;
use gbrain_store::snapshot::SnapshotManifest;
use napi::Env;
use napi::bindgen_prelude::{Buffer, Object};
use napi_derive::napi;
use serde_json::{Value, json};

use crate::binding::{Pool, spawn};
use crate::error::TaskError;
use crate::pool;
use crate::store_binding::{Brain, task_error};

const INVALID_ARGUMENT: &str = gbrain_store::error::INVALID_ARGUMENT;
/// 2^53: the first integer a JavaScript number cannot hold exactly next to its neighbour.
const SAFE_LIMIT: f64 = 9_007_199_254_740_992.0;

fn invalid(why: impl Into<String>) -> TaskError {
    TaskError::new(INVALID_ARGUMENT, why)
}

/// A position from JavaScript numbers, refused (never truncated) when out of range.
fn position(sequence: f64, index: f64, what: &str) -> Result<CommitPosition, TaskError> {
    if !(sequence.is_finite() && sequence.fract() == 0.0 && (0.0..SAFE_LIMIT).contains(&sequence)) {
        return Err(invalid(format!(
            "{what}.sequence must be an integer from 0 to 2^53 - 1, not {sequence}"
        )));
    }
    if !(index.is_finite() && index.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(&index)) {
        return Err(invalid(format!(
            "{what}.index must be an integer from 0 to 2^32 - 1, not {index}"
        )));
    }
    Ok(CommitPosition::new(sequence as u64, index as u32))
}

fn position_of_value(v: &Value, what: &str) -> Result<CommitPosition, TaskError> {
    let field = |name: &str| -> Result<f64, TaskError> {
        v.get(name)
            .and_then(Value::as_f64)
            .ok_or_else(|| invalid(format!("{what}.{name} must be a number")))
    };
    position(field("sequence")?, field("index")?, what)
}

/// A position as JavaScript receives it; `invalid_state` for one a JavaScript number cannot hold.
fn position_out(p: CommitPosition) -> Result<Value, TaskError> {
    if p.sequence as f64 >= SAFE_LIMIT {
        return Err(TaskError::new(
            gbrain_store::error::INVALID_STATE,
            format!(
                "position {} is past what a JavaScript number holds",
                p.token()
            ),
        ));
    }
    Ok(json!({ "sequence": p.sequence, "index": p.index }))
}

fn lineage_in(v: &Value) -> Result<Vec<Timeline>, TaskError> {
    let items = v
        .as_array()
        .ok_or_else(|| invalid("lineage must be an array"))?;
    items
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let id = t
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid(format!("lineage[{i}].id must be a string")))?;
            let from = t
                .get("from")
                .ok_or_else(|| invalid(format!("lineage[{i}].from is missing")))?;
            Ok(Timeline {
                id: id.to_string(),
                from: position_of_value(from, &format!("lineage[{i}].from"))?,
            })
        })
        .collect()
}

fn lineage_out(lineage: &[Timeline]) -> Result<Value, TaskError> {
    let items: Result<Vec<Value>, TaskError> = lineage
        .iter()
        .map(|t| Ok(json!({ "id": t.id, "from": position_out(t.from)? })))
        .collect();
    Ok(Value::Array(items?))
}

/// The helpers above with store errors, for `replica_acks.rs`.
fn to_store(e: TaskError) -> gbrain_store::StoreError {
    gbrain_store::StoreError::new(e.code, e.message)
}

pub(super) fn position_in_store(
    v: &Value,
    what: &str,
) -> Result<CommitPosition, gbrain_store::StoreError> {
    position_of_value(v, what).map_err(to_store)
}

pub(super) fn position_out_store(p: CommitPosition) -> Result<Value, gbrain_store::StoreError> {
    position_out(p).map_err(to_store)
}

pub(super) fn lineage_in_store(v: &Value) -> Result<Vec<Timeline>, gbrain_store::StoreError> {
    lineage_in(v).map_err(to_store)
}

/// One record `applyRaw` takes: its position and the bytes the primary stores.
#[napi(object)]
pub struct RawRecordInput {
    pub sequence: f64,
    pub index: f64,
    pub bytes: Buffer,
}

/// One record `readCommitLogRaw` returns.
#[napi(object)]
pub struct RawRecordOutput {
    pub sequence: f64,
    pub index: u32,
    pub bytes: Buffer,
}

/// What `readCommitLogRaw` returns: one page, from one snapshot of the primary.
#[napi(object)]
pub struct RawLogPage {
    pub brain_id: String,
    /// `[{ id, from: { sequence, index } }]`.
    pub lineage: Value,
    /// `{ sequence, index }` or null.
    pub newest: Value,
    pub oldest_retained: Value,
    pub snapshot_required: bool,
    pub records: Vec<RawRecordOutput>,
}

type Slot = Arc<Mutex<Option<Arc<StoreFollower>>>>;

/// A follower handle (module docs). Its calls run on the pool it was made with.
#[napi]
pub struct Follower {
    pool: pool::Pool,
    slot: Slot,
}

fn encode(v: Value) -> Result<Value, TaskError> {
    Ok(v)
}

#[napi]
impl Follower {
    #[napi(constructor)]
    pub fn new(pool: &Pool) -> Self {
        Self {
            pool: pool.pool.clone(),
            slot: Arc::new(Mutex::new(None)),
        }
    }

    fn run<'env>(
        &self,
        env: &'env Env,
        work: impl FnOnce(&StoreFollower) -> Result<Value, TaskError> + Send + 'static,
    ) -> napi::Result<Object<'env>> {
        let follower = self.slot.lock().unwrap_or_else(|e| e.into_inner()).clone();
        spawn(env, &self.pool, move || {
            let follower = follower.ok_or_else(|| {
                TaskError::new(
                    gbrain_store::error::STORE_CLOSED,
                    "the follower is not open",
                )
            })?;
            work(&follower)
        })
    }

    /// `run` for work that returns store errors (`replica_acks.rs`).
    pub(super) fn run_store<'env>(
        &self,
        env: &'env Env,
        work: impl FnOnce(&StoreFollower) -> Result<Value, gbrain_store::StoreError>
        + Send
        + 'static,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |f| work(f).map_err(task_error))
    }

    /// `open(dir)`: opens (or creates) the follower in `dir`; resolves `{ cursor }`.
    #[napi]
    pub fn open<'env>(&self, env: &'env Env, dir: String) -> napi::Result<Object<'env>> {
        let slot = self.slot.clone();
        spawn(env, &self.pool, move || {
            let follower = StoreFollower::open(std::path::Path::new(&dir)).map_err(task_error)?;
            let cursor = follower.cursor().map(position_out).transpose()?;
            *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(follower));
            encode(json!({ "cursor": cursor }))
        })
    }

    /// `close()`: releases the follower's record file once its running calls end.
    #[napi]
    pub fn close<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        let slot = self.slot.clone();
        spawn(env, &self.pool, move || {
            slot.lock().unwrap_or_else(|e| e.into_inner()).take();
            encode(Value::Null)
        })
    }

    /// `cursor()`: `{ sequence, index }` or null while the follower is empty.
    #[napi]
    pub fn cursor<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |f| match f.cursor() {
            Some(c) => position_out(c),
            None => Ok(Value::Null),
        })
    }

    /// `applyRaw(brainId, lineage, records)`: module docs.
    #[napi]
    pub fn apply_raw<'env>(
        &self,
        env: &'env Env,
        brain_id: String,
        lineage: Value,
        records: Vec<RawRecordInput>,
    ) -> napi::Result<Object<'env>> {
        // The bytes are copied off the JavaScript buffers on this thread.
        let parsed: Result<Vec<(CommitPosition, Vec<u8>)>, TaskError> = records
            .iter()
            .enumerate()
            .map(|(i, r)| {
                Ok((
                    position(r.sequence, r.index, &format!("records[{i}]"))?,
                    r.bytes.to_vec(),
                ))
            })
            .collect();
        let lineage = lineage_in(&lineage);
        self.run(env, move |f| {
            let lineage = lineage?;
            let records = parsed?;
            let applied = f
                .apply_raw(&brain_id, &lineage, &records)
                .map_err(task_error)?;
            Ok(json!({
                "applied": applied.applied,
                "skipped": applied.skipped,
                "cursor": position_out(applied.cursor)?,
            }))
        })
    }

    /// `installSnapshot(dir, manifest | null)`: resolves the follower's cursor after the install.
    #[napi]
    pub fn install_snapshot<'env>(
        &self,
        env: &'env Env,
        dir: String,
        manifest: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        let manifest: Result<Option<SnapshotManifest>, TaskError> = manifest
            .filter(|m| !m.is_null())
            .map(|m| {
                serde_json::from_value(m)
                    .map_err(|e| invalid(format!("manifest is not a SNAPSHOT.json: {e}")))
            })
            .transpose();
        self.run(env, move |f| {
            let manifest = manifest?;
            let cursor = f
                .install_snapshot(std::path::Path::new(&dir), manifest.as_ref())
                .map_err(task_error)?;
            position_out(cursor)
        })
    }
}

#[napi]
impl Brain {
    /// `readCommitLogRaw(after | null, max)`: up to `max` records after `after` (null: from the
    /// log's start), as the bytes the store holds, with the brain id and history a follower checks.
    #[napi]
    pub fn read_commit_log_raw<'env>(
        &self,
        env: &'env Env,
        after: Option<Value>,
        max: Option<u32>,
    ) -> napi::Result<Object<'env>> {
        let after = after
            .filter(|a| !a.is_null())
            .map(|a| position_of_value(&a, "after"))
            .transpose();
        let store = self.current();
        spawn(env, &self.pool_handle(), move || {
            let after = after?;
            let store = store.ok_or_else(|| {
                TaskError::new(gbrain_store::error::STORE_CLOSED, "the brain is not open")
            })?;
            let (page, raw) = store
                .read_commit_log_raw(after, max.unwrap_or(1000) as usize)
                .map_err(task_error)?;
            let records: Result<Vec<RawRecordOutput>, TaskError> = raw
                .into_iter()
                .map(|(p, bytes)| {
                    position_out(p)?;
                    Ok(RawRecordOutput {
                        sequence: p.sequence as f64,
                        index: p.index,
                        bytes: Buffer::from(bytes),
                    })
                })
                .collect();
            Ok(RawLogPage {
                brain_id: page.brain_id.clone(),
                lineage: lineage_out(&page.lineage)?,
                newest: page
                    .newest
                    .map(position_out)
                    .transpose()?
                    .unwrap_or(Value::Null),
                oldest_retained: page
                    .oldest_retained
                    .map(position_out)
                    .transpose()?
                    .unwrap_or(Value::Null),
                snapshot_required: page.snapshot_required,
                records: records?,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_out_of_range_are_refused_not_truncated() {
        assert!(position(0.0, 0.0, "p").is_ok());
        assert!(position(SAFE_LIMIT - 1.0, u32::MAX as f64, "p").is_ok());
        for (s, i) in [
            (SAFE_LIMIT, 0.0),
            (-1.0, 0.0),
            (1.5, 0.0),
            (f64::NAN, 0.0),
            (f64::INFINITY, 0.0),
            (1.0, u32::MAX as f64 + 1.0),
            (1.0, -1.0),
            (1.0, 0.5),
        ] {
            let err = position(s, i, "p").unwrap_err();
            assert_eq!(err.code, INVALID_ARGUMENT, "{s} {i}");
        }
        assert!(position_out(CommitPosition::new(1 << 53, 0)).is_err());
    }
}
