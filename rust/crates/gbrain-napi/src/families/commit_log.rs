//! The commit log and commit positions for TypeScript (multi-user mode; rust/docs/store/commit-log.md):
//! `Brain#readCommitLog(after | null, limit)` and `Brain#lastCommitPosition()`, the store side of the
//! engine members of the same names (src/core/rust-engine/store-members/commit-log.ts).
//!
//! Positions cross as `{ sequence, index }` JavaScript numbers. A `sequence` must be a safe integer below
//! 2^53 and an `index` an integer from 0 to 2^32 - 1; anything else is refused with `invalid_argument`,
//! never truncated.

use gbrain_store::commit_log::CommitPosition;
use gbrain_store::{Store, StoreError};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Value, json};

use crate::store_binding::Brain;

const SAFE_LIMIT: f64 = 9_007_199_254_740_992.0;

fn invalid(why: String) -> StoreError {
    StoreError::new(gbrain_store::error::INVALID_ARGUMENT, why)
}

fn position_in(v: &Value, what: &str) -> Result<CommitPosition, StoreError> {
    let num = |name: &str| v.get(name).and_then(Value::as_f64);
    let (Some(s), Some(i)) = (num("sequence"), num("index")) else {
        return Err(invalid(format!("{what} must be {{ sequence, index }}")));
    };
    if !(s.fract() == 0.0 && (0.0..SAFE_LIMIT).contains(&s)) {
        return Err(invalid(format!(
            "{what}.sequence must be an integer from 0 to 2^53 - 1, not {s}"
        )));
    }
    if !(i.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(&i)) {
        return Err(invalid(format!(
            "{what}.index must be an integer from 0 to 2^32 - 1, not {i}"
        )));
    }
    Ok(CommitPosition::new(s as u64, i as u32))
}

fn position_out(p: CommitPosition) -> Result<Value, StoreError> {
    if p.sequence as f64 >= SAFE_LIMIT {
        return Err(StoreError::new(
            gbrain_store::error::INVALID_STATE,
            format!(
                "position {} is past what a JavaScript number holds",
                p.token()
            ),
        ));
    }
    Ok(json!({ "sequence": p.sequence, "index": p.index }))
}

fn read_page(
    store: &Store,
    after: Option<CommitPosition>,
    limit: usize,
) -> Result<Value, StoreError> {
    let page = store.read_commit_log(after, limit)?;
    let records: Result<Vec<Value>, StoreError> = page
        .records
        .iter()
        .map(|r| {
            Ok(json!({
                "position": position_out(r.position)?,
                "commit_time_us": r.commit_time,
                "origin": { "host_id": r.origin.host_id, "incarnation": r.origin.incarnation, "writer_id": r.origin.writer_id },
                "write_ids": r.write_ids,
                "op_count": r.ops.len(),
            }))
        })
        .collect();
    Ok(json!({
        "records": records?,
        "newest": page.newest.map(position_out).transpose()?,
        "oldest_retained": page.oldest_retained.map(position_out).transpose()?,
        "snapshot_required": page.snapshot_required,
    }))
}

#[napi]
impl Brain {
    /// `readCommitLog(after | null, limit)`: up to `limit` (at most 10,000) records after `after`
    /// (null: from where the log starts), one snapshot. `invalid_state` when the brain keeps no log.
    #[napi]
    pub fn read_commit_log<'env>(
        &self,
        env: &'env Env,
        after: Option<Value>,
        limit: Option<u32>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let after = after
                .filter(|a| !a.is_null())
                .map(|a| position_in(&a, "after"))
                .transpose()?;
            read_page(s, after, limit.unwrap_or(1000).min(10_000) as usize)
        })
    }

    /// `lastCommitPosition()`: the position this handle's newest finished write or transaction
    /// committed at, or null before the first.
    #[napi]
    pub fn last_commit_position<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| {
            s.last_commit_position().map(position_out).transpose()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn out_of_range_positions_are_refused_not_truncated() {
        assert!(position_in(&json!({"sequence": 3, "index": 1}), "p").is_ok());
        for bad in [
            json!({"sequence": SAFE_LIMIT, "index": 0}),
            json!({"sequence": -1, "index": 0}),
            json!({"sequence": 1.5, "index": 0}),
            json!({"sequence": 1, "index": u32::MAX as f64 + 1.0}),
            json!({"sequence": 1}),
        ] {
            assert_eq!(
                position_in(&bad, "p").unwrap_err().code,
                gbrain_store::error::INVALID_ARGUMENT,
                "{bad}"
            );
        }
    }
}
