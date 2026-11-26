//! The Git sync hold retry request: the statement of `src/core/engine-sql/git-holds.ts`
//! (rust/docs/store/repair-bookkeeping.md, "Git holds").
//!
//! A retry request is one `sync-hold-retry` op checkpoint per (source, incarnation) naming the paths the next sync
//! re-screens. The hold rows and summary counters are the hold store's (`src/core/engine-sql/sync-hold-store.ts`),
//! served over the op checkpoint row members.

use super::op_checkpoint::{op_checkpoint_completed_keys, write_op_checkpoint_record_in};
use crate::Store;
use crate::env::Env;
use crate::error::Result;
use crate::kv::KvWrite;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const GIT_HOLD_RETRY_OP: &str = "sync-hold-retry";

fn summary_fingerprint(source_id: &str, incarnation: &str) -> String {
    format!("{source_id}:{incarnation}")
}

/// `requestGitHoldRetry`: the source's retry request holds the union of its paths and `paths`, once each in byte order,
/// stamped `requested_at`.
pub(crate) fn request_git_hold_retry_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    source_id: &str,
    incarnation: &str,
    paths: &[String],
    requested_at: &str,
) -> Result<()> {
    let fingerprint = summary_fingerprint(source_id, incarnation);
    let mut all: BTreeSet<String> = paths.iter().cloned().collect();
    let keys = op_checkpoint_completed_keys(&*tx, GIT_HOLD_RETRY_OP, &fingerprint)?;
    if let Some(Value::Array(prior)) = keys
        .as_ref()
        .and_then(|keys| keys.get(0))
        .and_then(|record| record.get("paths"))
    {
        all.extend(
            prior
                .iter()
                .map(|p| p.as_str().map_or_else(|| p.to_string(), str::to_owned)),
        );
    }
    let record = json!([{
        "version": 1,
        "source_id": source_id,
        "incarnation": incarnation,
        "paths": all.into_iter().collect::<Vec<_>>(),
        "requested_at": requested_at,
    }]);
    write_op_checkpoint_record_in(tx, env, GIT_HOLD_RETRY_OP, &fingerprint, Some(&record))
}

impl Store {
    /// `requestGitHoldRetry(sourceId, incarnation, paths, requestedAt)`.
    pub fn request_git_hold_retry(
        &self,
        source_id: &str,
        incarnation: &str,
        paths: &[String],
        requested_at: &str,
    ) -> Result<()> {
        self.write(|tx| {
            request_git_hold_retry_in(tx, &*self.env, source_id, incarnation, paths, requested_at)
        })
    }
}
