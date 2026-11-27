//! The head-blocker probe (`readHeadBlockerRows`, `src/core/engine-sql/head-blocker.ts`;
//! rust/docs/store/persistence.md, "Head-blocker probe"): for each queued request asked about,
//! whether a consumer may claim it now and, when it may not, the facts that name why.
//!
//! Every worktree on this engine is null (no worktree binding exists here), so each column of the
//! Postgres statement that joins on the request's worktree (the worktree owner and state, the
//! refresh fence, effect recoveries, withdrawal mirrors, request recoveries and the running rows
//! ahead of a sync row) finds no row and is null, as Postgres answers it for a null worktree. What
//! is left is the claim test itself, the transient backoff and the earlier rows of the same
//! source incarnation that hold the head.

use super::{
    ClaimableSpec, all_requests, claimable, extra_bool, extra_is_null, extra_time,
    foreground_priority, json_text, passes_queued_sync, pending, uuid_param,
};
use crate::Store;
use crate::env::Env;
use crate::error::Result;
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use serde::Deserialize;
use serde_json::{Value, json};

/// `HeadBlockerSpec`: the queued requests asked about (internal ids) and the
/// `foreground_priority` switch as the environment set it, or `None` to read the config row.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HeadBlockerSpec {
    pub ids: Vec<String>,
    pub priority: Option<bool>,
}

/// `REF(alias)`: what the probe names of a blocking request.
fn request_ref(e: &RequestRecord, now: i64) -> Value {
    json!({
        "request_id": e.request_id,
        "state": e.state,
        "claim_phase": e.extra.get("claim_phase").cloned().unwrap_or(Value::Null),
        "execution_token": json_text(e.extra.get("execution_token")),
        "claim_lapsed": extra_time(e, "claim_expires_at").is_some_and(|t| t < now),
        "publication_started": extra_bool(e, "publication_started"),
        "recovery": !extra_is_null(e, "recovery"),
        "principal_kind": e.principal_kind,
        "principal_id": e.principal_id,
    })
}

pub(crate) fn read_head_blocker_rows_in(
    read: &dyn KvRead,
    env: &dyn Env,
    spec: &HeadBlockerSpec,
) -> Result<Vec<Value>> {
    let mut ids = Vec::with_capacity(spec.ids.len());
    for id in &spec.ids {
        ids.push(uuid_param(id, "ids")?);
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let priority = foreground_priority(read, spec.priority)?;
    let all = all_requests(read)?;
    let pending = pending(&all);
    let now = env.now_micros();
    let worktrees = super::write_claim_terms::WorktreeClaims::new(read, &all)?;
    let claim = ClaimableSpec::default();
    let mut out = Vec::new();
    for r in all
        .iter()
        .filter(|r| r.state == "queued" && ids.contains(&r.id.to_lowercase()))
    {
        // `EARLIER_HEAD`: a pending row of the same root ahead of `r` that the head may not pass.
        // `EARLIER_DEFERRED` needs a refresh or import hold, which no row here has.
        let mut earlier: Vec<&RequestRecord> = if extra_is_null(r, "worktree_id") {
            pending
                .iter()
                .copied()
                .filter(|e| {
                    e.sequence < r.sequence
                        && e.source_incarnation == r.source_incarnation
                        && passes_queued_sync(e, r, priority, &[]) == Some(false)
                })
                .collect()
        } else {
            Vec::new()
        };
        earlier.sort_by_key(|e| e.sequence);
        let backoff = extra_time(r, "next_attempt_at")
            .filter(|t| *t > now)
            .and_then(|_| r.extra.get("next_attempt_at").cloned());
        out.push(json!({
            "id": r.id,
            "request_id": r.request_id,
            "worktree_id": json_text(r.extra.get("worktree_id")),
            "owner_host_id": Value::Null,
            "worktree_state": Value::Null,
            "backoff_until": backoff.unwrap_or(Value::Null),
            "claimable": claimable(r, &pending, &worktrees, priority, &claim, &[], now)?,
            "fence": Value::Null,
            "effect_recovery": Value::Null,
            "mirrors": Value::Null,
            "request_recovery": Value::Null,
            "earlier": if earlier.is_empty() {
                Value::Null
            } else {
                Value::Array(earlier.iter().map(|e| request_ref(e, now)).collect())
            },
            "ahead": Value::Null,
        }));
    }
    Ok(out)
}

impl Store {
    /// `readHeadBlockerRows(ids, hostId, { priority })`: one probe row per queued request asked
    /// about. The host id decides only worktree ownership, and no request here has a worktree.
    pub fn read_head_blocker_rows(&self, spec: &HeadBlockerSpec) -> Result<Vec<Value>> {
        read_head_blocker_rows_in(&*self.read()?, &*self.env, spec)
    }
}
