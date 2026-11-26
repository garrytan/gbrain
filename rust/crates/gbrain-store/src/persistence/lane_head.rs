//! The lane head claim and the owner's reclaim of a released write (`claimNextLaneHead`, `reclaimReleasedWrite` in
//! `src/core/persistence/journal.ts`; the SQL is in `src/core/engine-sql/persistence-claims.ts`).
//!
//! `selectClaimableLaneHead` reads the head of the next admitted group of lane `run` on one worktree: the request that is
//! `queued`, past its backoff, whose intent names the lane and is its own group's head, on a worktree the host owns while
//! it is active (`write_claim_terms.rs`, `lane_head_open`). `stampLaneHeadClaim` claims it and returns the newest request
//! sequence as `seen_sequence`. `reclaimReleasedWrite` claims again, by id, a request the owner pass released to the queue
//! itself: queued, no recovery, backoff elapsed. `chargeTransientInterruption` counts one transient interruption on a claim still
//! held under its token and schedules the next claim (`next_attempt_at`) after a bounded exponential backoff. Each claim records its lease epoch beside it on a multi-user store, as the
//! FIFO claim does (`stamp_write_claim`).

use super::extra_i64;
use super::write_claim_terms::{WorktreeClaims, worktree_of};
use super::{
    ClaimStamp, ClaimableSpec, all_requests, extra_is_null, extra_time, foreground_priority,
    json_text, jsonb_param, lease_end, request_by_id, uuid_param,
};
use crate::Store;
use crate::env::{Env, iso};
use crate::error::Result;
use crate::journal::{max_sequence, write_request};
use crate::kv::{KvRead, KvWrite};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// `selectClaimableLaneHead(spec)`: `$1` the host, `$2` the worktree, `$3` the lane run, `$4` the newest sequence when the
/// process last claimed a head of the run, `$5` the consumer nonce, and the `foreground_priority` switch as the environment
/// set it (`None` reads the config row).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneHeadSpec {
    pub host_id: String,
    pub worktree_id: String,
    pub run: String,
    #[serde(default)]
    pub seen_sequence: Option<String>,
    pub nonce: String,
    #[serde(default)]
    pub priority: Option<bool>,
}

/// `chargeTransientInterruption({ id, token, baseMs, maxMs })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransientCharge {
    pub id: String,
    #[serde(default)]
    pub token: Option<String>,
    pub base_ms: f64,
    pub max_ms: f64,
}

/// The claimed request as the SQL `RETURNING *` gives it (no `passed_sync`), after running it under the claim.
fn claim_request(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    stamp: &ClaimStamp,
    queued_only: bool,
) -> Result<Option<crate::journal::RequestRecord>> {
    let token = uuid_param(&stamp.token, "token")?;
    let phase = jsonb_param(&stamp.phase_json, "phaseJson")?;
    let Some(mut record) = request_by_id(&*tx, &stamp.id)? else {
        return Ok(None);
    };
    let now = env.now_micros();
    if queued_only
        && !(record.state == "queued"
            && extra_is_null(&record, "recovery")
            && extra_time(&record, "next_attempt_at").is_none_or(|t| t <= now))
    {
        return Ok(None);
    }
    record.state = "running".into();
    record.updated_at_us = now;
    record.blocked_reason = None;
    record.extra.insert("execution_token".into(), json!(token));
    record.extra.insert(
        "claim_expires_at".into(),
        json!(iso(lease_end(now, stamp.lease_ms))),
    );
    record
        .extra
        .insert("claim_phase".into(), phase.unwrap_or(Value::Null));
    write_request(tx, &record)?;
    Ok(Some(record))
}

fn select_lane_head_in(
    read: &dyn KvRead,
    env: &dyn Env,
    spec: &LaneHeadSpec,
) -> Result<Option<Value>> {
    super::effect_scans::host_uuid(&spec.host_id)?;
    let host = spec.host_id.as_str();
    let worktree = uuid_param(&spec.worktree_id, "worktreeId")?;
    // `$4::bigint` is cast before any row is read.
    let seen = spec.seen_sequence.clone().map(Value::String);
    if let Some(v) = &seen {
        super::write_claim_terms::check_seen(v)?;
    }
    let priority = foreground_priority(read, spec.priority)?;
    let all = all_requests(read)?;
    let worktrees = WorktreeClaims::new(read, &all)?;
    let now = env.now_micros();
    let mut sync_seen = Map::new();
    if let Some(v) = seen {
        sync_seen.insert(worktree.clone(), v);
    }
    let claimable = ClaimableSpec {
        nonce: Some(spec.nonce.clone()),
        sync_seen,
        ..ClaimableSpec::default()
    };
    let mut best: Option<&crate::journal::RequestRecord> = None;
    for r in &all {
        if worktree_of(r).as_deref() != Some(worktree.as_str()) || r.state != "queued" {
            continue;
        }
        if extra_time(r, "next_attempt_at").is_some_and(|t| t > now) {
            continue;
        }
        if json_text(r.intent.get("lane")).as_deref() != Some(spec.run.as_str())
            || json_text(r.intent.get("group")).as_deref()
                != Some(r.request_id.to_lowercase().as_str())
        {
            continue;
        }
        if best.is_some_and(|b| b.sequence <= r.sequence) {
            continue;
        }
        if worktrees.lane_head_open(r, &worktree, host, &spec.run, &claimable, priority)? {
            best = Some(r);
        }
    }
    Ok(best.map(|r| r.to_row()))
}

/// `CHARGE_TRANSIENT_SQL`: only a request running under the token; the count after the charge, or `None`.
fn charge_transient_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    charge: &TransientCharge,
) -> Result<Option<i64>> {
    let id = uuid_param(&charge.id, "id")?;
    // A null token matches no row (`execution_token=NULL` is never true); a token that is not a uuid refuses as the cast does.
    let token = charge
        .token
        .as_deref()
        .map(|t| uuid_param(t, "token"))
        .transpose()?;
    let Some(mut record) = request_by_id(&*tx, &id)? else {
        return Ok(None);
    };
    let held = json_text(record.extra.get("execution_token")).map(|t| t.to_lowercase());
    if record.state != "running" || token.is_none() || held != token {
        return Ok(None);
    }
    let before = extra_i64(&record, "transient_interruptions");
    let delay_ms = (charge.base_ms * 2f64.powi(before.clamp(0, 30) as i32)).min(charge.max_ms);
    let now = env.now_micros();
    record
        .extra
        .insert("transient_interruptions".into(), json!(before + 1));
    record.extra.insert(
        "next_attempt_at".into(),
        json!(iso(now + (delay_ms * 1000.0).round() as i64)),
    );
    record.updated_at_us = now;
    write_request(tx, &record)?;
    Ok(Some(before + 1))
}

impl Store {
    /// `chargeTransientInterruption(charge)`: `{ transient_interruptions }`, or `None` when the claim is gone.
    pub fn charge_transient_interruption(&self, charge: &TransientCharge) -> Result<Option<Value>> {
        self.write(|tx| {
            Ok(charge_transient_in(tx, &*self.env, charge)?
                .map(|n| json!({ "transient_interruptions": n })))
        })
    }

    /// `selectClaimableLaneHead(spec)`: the lane head `claimNextLaneHead` claims next, or `None`.
    pub fn select_claimable_lane_head(&self, spec: &LaneHeadSpec) -> Result<Option<Value>> {
        let read = self.read()?;
        select_lane_head_in(&*read, &*self.env, spec)
    }

    /// `stampLaneHeadClaim(stamp)`: the claimed row with the newest request sequence as `seen_sequence`, or `None` for an
    /// unknown id.
    pub fn stamp_lane_head_claim(&self, stamp: &ClaimStamp) -> Result<Option<Value>> {
        self.write(|tx| {
            let Some(record) = claim_request(tx, &*self.env, stamp, false)? else {
                return Ok(None);
            };
            let mut row = record.to_row();
            row["seen_sequence"] = json!(max_sequence(&*tx)?.to_string());
            Ok(Some(row))
        })
    }

    /// `reclaimReleasedWrite(stamp)`: claims again request `id` while it is queued, holds no recovery and its backoff has
    /// elapsed; the claimed row, or `None`.
    pub fn reclaim_released_write(&self, stamp: &ClaimStamp) -> Result<Option<Value>> {
        self.write(|tx| {
            let Some(record) = claim_request(tx, &*self.env, stamp, true)? else {
                return Ok(None);
            };
            Ok(Some(record.to_row()))
        })
    }
}
