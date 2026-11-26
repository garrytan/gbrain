//! The effect worker's statements: the claim of the next due effect and the updates that settle a
//! claim (`src/core/engine-sql/persistence-effect-worker.ts`; rust/docs/store/persistence.md,
//! "Effect worker").
//!
//! Every statement here names its effect by id and, once claimed, by the claim's execution token,
//! as the Postgres statements do (`WHERE id=$1 AND execution_token=$2::uuid`). An effect on a
//! worktree is claimed only by the worktree's owner host, while no refresh fences the worktree and
//! no effect or request there carries a recovery (`write_claim_terms.rs`); a recovery on a
//! worktree never blocks an effect without one.

use super::effects::{EffectRecord, all_effects, effect_by_id, write_effect};
use super::worktree_admission::all_refreshes;
use super::write_claim_terms::effect_claimable_on_worktree;
use super::{all_requests, is_uuid, json_text};
use crate::Store;
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// A `::uuid` parameter, lower-cased; anything else refuses with the Postgres cast's own words.
pub(super) fn pg_uuid(text: &str) -> Result<String> {
    if is_uuid(text) {
        Ok(text.to_lowercase())
    } else {
        Err(StoreError::invalid(format!(
            "invalid input syntax for type uuid: \"{text}\""
        )))
    }
}

/// The claim lease: `claim_expires_at=now()+interval '2 minutes'`.
const CLAIM_LEASE_US: i64 = 120_000_000;

/// The data keys a completed claim drops (`data-'retry_slugs'-'target_failures'-...`).
const COMPLETED_DROPS: [&str; 6] = [
    "retry_slugs",
    "target_failures",
    "failing_target",
    "busy_retries",
    "busy_since",
    "busy_at",
];

/// `$1` as Postgres casts an effect id to bigint: surrounding whitespace and a sign are accepted.
pub(super) fn effect_id(text: &str) -> Result<i64> {
    text.trim().parse::<i64>().map_err(|_| {
        StoreError::invalid(format!("invalid input syntax for type bigint: \"{text}\""))
    })
}

/// `$N::double precision*interval '1 millisecond'`, in microseconds.
fn delay_us(ms: f64) -> Result<i64> {
    if !ms.is_finite() {
        return Err(StoreError::invalid(format!(
            "interval out of range: {ms} milliseconds"
        )));
    }
    Ok((ms * 1000.0).round() as i64)
}

/// `jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0`: a `parked` that is no array
/// refuses, as `jsonb_array_length` does.
fn has_parked(data: &Value) -> Result<bool> {
    match data.get("parked") {
        None => Ok(false),
        Some(Value::Array(items)) => Ok(!items.is_empty()),
        Some(Value::Object(_)) => Err(StoreError::invalid(
            "cannot get array length of a non-array",
        )),
        Some(_) => Err(StoreError::invalid("cannot get array length of a scalar")),
    }
}

/// `data - key - key ...` on an object; any other value is returned as it is (`-` on a scalar
/// refuses on Postgres, and the worker stores objects only).
pub(super) fn without(data: &Value, drop: &[&str]) -> Value {
    match data {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, _)| !drop.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `jsonb_set(data, '{key}', value)`: sets a top-level key of an object.
fn with_key(data: Value, key: &str, value: Value) -> Value {
    match data {
        Value::Object(mut map) => {
            map.insert(key.into(), value);
            Value::Object(map)
        }
        other => other,
    }
}

/// `data || patch` for two objects: the patch's keys win.
fn merged(data: &Value, patch: &Value) -> Value {
    match (data, patch) {
        (Value::Object(base), Value::Object(extra)) => {
            let mut map: Map<String, Value> = base.clone();
            for (k, v) in extra {
                map.insert(k.clone(), v.clone());
            }
            Value::Object(map)
        }
        _ => patch.clone(),
    }
}

/// The owner key a claim stamp names: `concat_ws(':', pid, nonce, start)` of `claim_owner->'owner'`.
fn owner_key(stamp: Option<&Value>) -> String {
    let owner = stamp.and_then(|s| s.get("owner"));
    ["pid", "nonce", "start"]
        .iter()
        .filter_map(|k| json_text(owner.and_then(|o| o.get(*k))))
        .collect::<Vec<_>>()
        .join(":")
}

/// `DEAD_OWNER_EFFECT_SQL`: a running effect with no recovery whose stamp of its current token names
/// an owner in `dead`.
fn dead_owner_claim(e: &EffectRecord, dead: &[String]) -> bool {
    e.state == "running"
        && e.recovery.is_none()
        && json_text(e.claim_owner.as_ref().and_then(|s| s.get("token")))
            .is_some_and(|t| e.execution_token.as_deref() == Some(t.as_str()))
        && dead.contains(&owner_key(e.claim_owner.as_ref()))
}

/// `CLAIMABLE_EFFECT_SQL` without its row lock: the next effect host `host_id` may claim.
pub(crate) fn select_claimable_effect_in(
    read: &dyn KvRead,
    now: i64,
    host_id: &str,
    dead_owners: &[String],
) -> Result<Option<EffectRecord>> {
    let host = pg_uuid(host_id)?;
    let effects = all_effects(read)?;
    let mirror_pending = |e: &EffectRecord| {
        effects.iter().any(|m| {
            m.request_id == e.request_id
                && m.kind == "withdrawal-mirror"
                && (m.state == "queued" || m.state == "running")
        })
    };
    let due: Vec<&EffectRecord> = effects
        .iter()
        .filter(|e| {
            let due_state = e.state == "queued"
                || (e.state == "running" && e.claim_expires_at_us.is_some_and(|t| t < now))
                || dead_owner_claim(e, dead_owners);
            due_state
                && e.next_attempt_at_us <= now
                && e.recovery.is_none()
                && (e.kind == "withdrawal-mirror" || !mirror_pending(e))
        })
        .collect();
    // A due effect on a worktree is claimable only by its owner host, while no refresh fences the
    // worktree and nothing there is in recovery (`write_claim_terms.rs`).
    let requests = all_requests(read)?;
    let refreshes = all_refreshes(read)?;
    let mut claimable = Vec::new();
    for e in due {
        let ok = match &e.worktree_id {
            None => true,
            Some(w) => {
                effect_claimable_on_worktree(read, w, &host, &effects, &requests, &refreshes)?
            }
        };
        if ok {
            claimable.push(e);
        }
    }
    Ok(claimable
        .into_iter()
        .min_by_key(|e| (e.next_attempt_at_us, e.id))
        .cloned())
}

/// `claimCoalescedGitEffects(input)`'s input: the host, its worktree, how many, the owner keys
/// proved dead, and the `claim_owner` owner as JSON text (`$5::text::jsonb`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoalescedGitClaim {
    pub host_id: String,
    pub worktree_id: String,
    pub limit: i64,
    #[serde(default)]
    pub dead_owners: Vec<String>,
    pub owner_json: String,
}

/// `CLAIM_COALESCED_GIT_EFFECTS_SQL`: up to `limit` ready single-file Git effects of the worktree
/// (a `relative_path` key and no `targets`, `source_scan` or `version` key), oldest due first, each
/// claimed under a fresh token with `claim_owner = { token, owner }`, a 2-minute lease and one more
/// attempt. The worktree must be owned by the host, unfenced and free of recoveries
/// (`effect_claimable_on_worktree`, the statement's InitPlan); an effect behind an unsettled
/// withdrawal mirror of its request is skipped. The claimed rows, in claim order.
///
/// Guarantee (no row lock): the statement's `FOR UPDATE ... SKIP LOCKED` keeps two claimers from
/// taking one effect. Here the read of every candidate and its stamp run in one store write
/// transaction, so no other commit interleaves (an explicit transaction is Serialized today); under
/// optimistic transactions the stamped rows are in the read set and a racing claim aborts with
/// `write_conflict` instead of claiming twice.
pub(crate) fn claim_coalesced_git_effects_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    input: &CoalescedGitClaim,
) -> Result<Vec<Value>> {
    let host = pg_uuid(&input.host_id)?;
    let worktree = pg_uuid(&input.worktree_id)?;
    let limit = usize::try_from(input.limit)
        .map_err(|_| StoreError::invalid("LIMIT must not be negative".to_string()))?;
    let owner: Value = serde_json::from_str(&input.owner_json)
        .map_err(|e| StoreError::invalid(format!("invalid input syntax for type json: {e}")))?;
    let now = env.now_micros();
    let effects = all_effects(&*tx)?;
    let requests = all_requests(&*tx)?;
    let refreshes = all_refreshes(&*tx)?;
    if limit == 0
        || !effect_claimable_on_worktree(&*tx, &worktree, &host, &effects, &requests, &refreshes)?
    {
        return Ok(Vec::new());
    }
    let mirror_pending = |e: &EffectRecord| {
        effects.iter().any(|m| {
            m.request_id == e.request_id
                && m.kind == "withdrawal-mirror"
                && (m.state == "queued" || m.state == "running")
        })
    };
    let has = |e: &EffectRecord, key: &str| e.data.get(key).is_some();
    let mut ready: Vec<&EffectRecord> = effects
        .iter()
        .filter(|e| {
            let due_state = e.state == "queued"
                || (e.state == "running" && e.claim_expires_at_us.is_some_and(|t| t < now))
                || dead_owner_claim(e, &input.dead_owners);
            e.worktree_id.as_deref() == Some(worktree.as_str())
                && e.kind == "git"
                && has(e, "relative_path")
                && !has(e, "targets")
                && !has(e, "source_scan")
                && !has(e, "version")
                && due_state
                && e.next_attempt_at_us <= now
                && e.recovery.is_none()
                && !mirror_pending(e)
        })
        .collect();
    ready.sort_by_key(|e| (e.next_attempt_at_us, e.id));
    let mut claimed = Vec::new();
    for e in ready.into_iter().take(limit) {
        let mut e = e.clone();
        let token = env.new_uuid();
        e.state = "running".into();
        e.execution_token = Some(token.clone());
        e.claim_owner = Some(json!({ "token": token, "owner": owner.clone() }));
        e.claim_expires_at_us = Some(now + CLAIM_LEASE_US);
        e.attempts += 1;
        e.updated_at_us = now;
        write_effect(tx, &e)?;
        claimed.push(e.to_row());
    }
    Ok(claimed)
}

/// The effect a settle statement names: `WHERE id=$1 AND execution_token=$2::uuid`, plus
/// `recovery IS NULL` when `no_recovery` is set.
fn claimed(
    read: &dyn KvRead,
    id: &str,
    token: Option<&str>,
    no_recovery: bool,
) -> Result<Option<EffectRecord>> {
    let id = effect_id(id)?;
    // A null token matches no row (`execution_token=NULL` is never true).
    let Some(token) = token.map(pg_uuid).transpose()? else {
        return Ok(None);
    };
    Ok(effect_by_id(read, id)?.filter(|e| {
        e.execution_token.as_deref() == Some(token.as_str())
            && (!no_recovery || e.recovery.is_none())
    }))
}

/// `stampEffectClaim(claim)`: claims effect `id` with `token`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectClaim {
    pub id: String,
    pub token: String,
    /// The `claim_owner` stamp as JSON text (`$3::text::jsonb`).
    pub owner_json: String,
}

pub(crate) fn stamp_effect_claim_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    claim: &EffectClaim,
) -> Result<Option<Value>> {
    let id = effect_id(&claim.id)?;
    let token = pg_uuid(&claim.token)?;
    let owner: Value = serde_json::from_str(&claim.owner_json)
        .map_err(|e| StoreError::invalid(format!("invalid input syntax for type json: {e}")))?;
    let Some(mut e) = effect_by_id(&*tx, id)? else {
        return Ok(None);
    };
    let now = env.now_micros();
    e.state = "running".into();
    e.execution_token = Some(token);
    e.claim_owner = Some(owner);
    e.claim_expires_at_us = Some(now + CLAIM_LEASE_US);
    e.attempts += 1;
    e.updated_at_us = now;
    write_effect(tx, &e)?;
    Ok(Some(e.to_row()))
}

/// One claimed effect a settle statement names: its id and its claim's execution token.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectSettle {
    pub id: String,
    /// The claim's execution token; null matches no claim.
    #[serde(default)]
    pub token: Option<String>,
    /// `advanceEffectRow`: the slug the cursor moves to.
    #[serde(default)]
    pub slug: Option<String>,
    /// `completeEffectRow`: the outcome as JSON text.
    #[serde(default)]
    pub outcome_json: Option<String>,
    /// `requeueEffectRow` / `parkEffectRow`: the new data, `retryBusyEffectRow`: the patch, as JSON text.
    #[serde(default)]
    pub data_json: Option<String>,
    /// `retryEffectRow` / `requeueEffectRow` / `failEffectRow`: the error code.
    #[serde(default)]
    pub reason: Option<String>,
    /// `retryEffectRow` / `retryBusyEffectRow` / `requeueEffectRow`: the wait before the next claim.
    #[serde(default)]
    pub delay_ms: Option<f64>,
}

fn json_param(text: Option<&str>, what: &str) -> Result<Value> {
    let Some(text) = text else {
        return Err(StoreError::invalid(format!("{what} is required")));
    };
    serde_json::from_str(text)
        .map_err(|e| StoreError::invalid(format!("invalid input syntax for type json: {e}")))
}

/// Clears the claim: `execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL`.
fn release(e: &mut EffectRecord, now: i64) {
    e.execution_token = None;
    e.claim_expires_at_us = None;
    e.claim_owner = None;
    e.updated_at_us = now;
}

/// Which settle statement runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settle {
    Renew,
    Advance,
    Complete,
    Retry,
    RetryBusy,
    Requeue,
    Park,
    Fail,
}

/// Runs one settle statement; `true` when it matched the claim.
pub(crate) fn settle_effect_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    action: Settle,
    spec: &EffectSettle,
) -> Result<bool> {
    // retryEffect and retryBusyEffect also settle a claim that holds a recovery record.
    let no_recovery = !matches!(action, Settle::Retry | Settle::RetryBusy);
    // Parameters are cast before any row is read, as Postgres binds them.
    let delay = match action {
        Settle::Retry | Settle::RetryBusy | Settle::Requeue => {
            Some(delay_us(spec.delay_ms.unwrap_or(0.0))?)
        }
        _ => None,
    };
    let payload = match action {
        Settle::Complete => Some(json_param(spec.outcome_json.as_deref(), "outcome")?),
        Settle::RetryBusy | Settle::Requeue | Settle::Park => {
            Some(json_param(spec.data_json.as_deref(), "data")?)
        }
        _ => None,
    };
    let Some(mut e) = claimed(&*tx, &spec.id, spec.token.as_deref(), no_recovery)? else {
        return Ok(false);
    };
    let now = env.now_micros();
    match action {
        Settle::Renew => {
            if e.state != "running" {
                return Ok(false);
            }
            e.claim_expires_at_us = Some(now + CLAIM_LEASE_US);
            e.updated_at_us = now;
        }
        Settle::Advance => {
            let slug = spec
                .slug
                .clone()
                .ok_or_else(|| StoreError::invalid("slug is required"))?;
            let base = if e.kind == "embedding" {
                with_key(e.data.clone(), "embedding_attempt_base", json!(e.attempts))
            } else {
                without(&e.data, &["target_failures", "failing_target"])
            };
            e.data = with_key(base, "after_slug", Value::String(slug));
            e.state = "queued".into();
            e.next_attempt_at_us = now;
            e.error_code = None;
            release(&mut e, now);
        }
        Settle::Complete => {
            let parked = has_parked(&e.data)?;
            e.state = if parked { "failed" } else { "committed" }.into();
            e.error_code = parked.then(|| "targets_parked".to_string());
            e.data = without(&e.data, &COMPLETED_DROPS);
            e.outcome = payload;
            release(&mut e, now);
        }
        Settle::Retry => {
            e.state = "queued".into();
            e.error_code = spec.reason.clone();
            e.next_attempt_at_us = now + delay.unwrap_or(0);
            release(&mut e, now);
        }
        Settle::RetryBusy => {
            e.state = "queued".into();
            e.error_code = Some("writer_busy".into());
            e.data = merged(&e.data, payload.as_ref().unwrap_or(&Value::Null));
            e.next_attempt_at_us = now + delay.unwrap_or(0);
            release(&mut e, now);
        }
        Settle::Requeue => {
            e.state = "queued".into();
            e.data = payload.unwrap_or(Value::Null);
            e.error_code = spec.reason.clone();
            e.next_attempt_at_us = now + delay.unwrap_or(0);
            release(&mut e, now);
        }
        Settle::Park => {
            e.state = "failed".into();
            e.data = payload.unwrap_or(Value::Null);
            e.error_code = Some("targets_parked".into());
            release(&mut e, now);
        }
        Settle::Fail => {
            e.state = "failed".into();
            e.error_code = spec.reason.clone();
            release(&mut e, now);
        }
    }
    if e.data.is_null() {
        return Err(super::violation(
            "null value in column \"data\" of relation \"persistence_effects\" violates not-null constraint",
        ));
    }
    write_effect(tx, &e)?;
    Ok(true)
}

/// `readMirrorGateRows(requestIds)`: every withdrawal mirror of these requests that has not
/// committed, or committed with its publications recorded, as `{ request_id, state, data }`.
pub(crate) fn read_mirror_gate_rows_in(
    read: &dyn KvRead,
    request_ids: &[String],
) -> Result<Vec<Value>> {
    let ids = request_ids
        .iter()
        .map(|id| pg_uuid(id))
        .collect::<Result<Vec<_>>>()?;
    Ok(all_effects(read)?
        .into_iter()
        .filter(|e| {
            e.kind == "withdrawal-mirror"
                && (e.state != "committed" || e.data.get("published").is_some())
                && ids.contains(&e.request_id)
        })
        .map(|e| json!({ "request_id": e.request_id, "state": e.state, "data": e.data }))
        .collect())
}

/// `jsonb_array_elements(COALESCE(data->'parked','[]'))` holds a target whose `error_code` is
/// `code`; a `parked` that is not an array refuses as `jsonb_array_elements` does.
fn parked_with(data: &Value, code: &str) -> Result<bool> {
    match data.get("parked") {
        None => Ok(false),
        Some(Value::Array(items)) => Ok(items
            .iter()
            .any(|t| t.get("error_code").and_then(Value::as_str) == Some(code))),
        Some(Value::Object(_)) => Err(StoreError::invalid(
            "cannot extract elements from an object",
        )),
        Some(_) => Err(StoreError::invalid("cannot extract elements from a scalar")),
    }
}

/// `hasRearmableTargets(requestIds, code)`: a Git or embedding effect of one of the requests,
/// unclaimed and not recovering, not settled, with a target parked under `code`, whose request's
/// withdrawal mirror has committed.
pub(crate) fn has_rearmable_targets_in(
    read: &dyn KvRead,
    request_ids: &[String],
    code: &str,
) -> Result<bool> {
    let ids = request_ids
        .iter()
        .map(|id| pg_uuid(id))
        .collect::<Result<Vec<_>>>()?;
    let effects = all_effects(read)?;
    for e in &effects {
        if !ids.contains(&e.request_id)
            || !matches!(e.kind.as_str(), "git" | "embedding")
            || !matches!(e.state.as_str(), "queued" | "failed")
            || e.execution_token.is_some()
            || e.recovery.is_some()
            || e.data.get("settled").is_some()
            || !parked_with(&e.data, code)?
        {
            continue;
        }
        if effects.iter().any(|m| {
            m.request_id == e.request_id && m.kind == "withdrawal-mirror" && m.state == "committed"
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Store {
    /// `readMirrorGateRows(requestIds)`.
    pub fn read_mirror_gate_rows(&self, request_ids: &[String]) -> Result<Vec<Value>> {
        read_mirror_gate_rows_in(&*self.read()?, request_ids)
    }

    /// `hasRearmableTargets(requestIds, code)`.
    pub fn has_rearmable_targets(&self, request_ids: &[String], code: &str) -> Result<bool> {
        has_rearmable_targets_in(&*self.read()?, request_ids, code)
    }

    /// `selectClaimableEffect(hostId, deadOwners)`: the next effect to claim as its row, or null.
    pub fn select_claimable_effect(&self, host_id: &str, dead_owners: &[String]) -> Result<Value> {
        let now = self.env.now_micros();
        Ok(
            select_claimable_effect_in(&*self.read()?, now, host_id, dead_owners)?
                .map_or(Value::Null, |e| e.to_row()),
        )
    }

    /// `lockEffectClaimRow(effectId)`: the effect's `{ state, execution_token }`, or null when no
    /// effect has the id. The store write is exclusive, so the row lock PGLite takes is the read.
    pub fn lock_effect_claim_row(&self, effect_id: i64) -> Result<Value> {
        Ok(effect_by_id(&*self.read()?, effect_id)?.map_or(
            Value::Null,
            |e| json!({ "state": e.state, "execution_token": e.execution_token }),
        ))
    }

    /// `stampEffectClaim(claim)`: the claimed row, or null when no effect has the id.
    pub fn stamp_effect_claim(&self, claim: &EffectClaim) -> Result<Option<Value>> {
        self.write(|tx| stamp_effect_claim_in(tx, &*self.env, claim))
    }

    /// `claimCoalescedGitEffects(input)`: the claimed rows, in claim order.
    pub fn claim_coalesced_git_effects(&self, input: &CoalescedGitClaim) -> Result<Vec<Value>> {
        self.write(|tx| claim_coalesced_git_effects_in(tx, &*self.env, input))
    }

    /// One settle statement (`renewEffectClaim`, `advanceEffectRow`, `completeEffectRow`, ...):
    /// `true` when it matched the claim.
    pub fn settle_effect(&self, action: Settle, spec: &EffectSettle) -> Result<bool> {
        self.write(|tx| settle_effect_in(tx, &*self.env, action, spec))
    }
}

/// `rearmLinksEffects`'s spec: the source, the requests whose `links` effects re-arm, and optionally their slugs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinksRearm {
    pub source_id: String,
    pub request_ids: Vec<String>,
    #[serde(default)]
    pub slugs: Option<Vec<String>>,
}

impl Store {
    /// `rearmLinksEffects(opts)`: queues again, unclaimed and due now, each `links` effect of the
    /// requests in the source (of the slugs when given) that carries no `batch_reconciled` and no
    /// recovery, and marks it re-armed. Returns how many re-armed. The store keeps no persistence
    /// protocol setting, so the protocol predicate always holds.
    pub fn rearm_links_effects(&self, spec: &LinksRearm) -> Result<u64> {
        if spec.request_ids.is_empty() {
            return Ok(0);
        }
        let ids: Vec<String> = spec
            .request_ids
            .iter()
            .map(|id| pg_uuid(id))
            .collect::<Result<_>>()?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut rearmed = 0u64;
            for mut e in all_effects(&*tx)? {
                let slug_ok = match &spec.slugs {
                    None => true,
                    Some(slugs) => e
                        .data
                        .get("slug")
                        .and_then(Value::as_str)
                        .is_some_and(|s| slugs.iter().any(|w| w == s)),
                };
                if e.kind != "links"
                    || e.source_id.as_deref() != Some(spec.source_id.as_str())
                    || !ids.iter().any(|id| *id == e.request_id.to_lowercase())
                    || !slug_ok
                    || e.data.get("batch_reconciled").is_some()
                    || e.recovery.is_some()
                {
                    continue;
                }
                e.state = "queued".into();
                release(&mut e, now);
                e.next_attempt_at_us = now;
                e.error_code = None;
                e.outcome = None;
                e.data = with_key(e.data, "batch_reconciled", Value::Bool(true));
                write_effect(tx, &e)?;
                rearmed += 1;
            }
            Ok(rearmed)
        })
    }
}
