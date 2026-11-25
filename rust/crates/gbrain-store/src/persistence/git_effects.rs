//! The managed Git effect runner's statements (`gitEffectStore()`,
//! `src/core/engine-sql/git-effects.ts`; rust/docs/store/managed-mode.md): the
//! checks a Git group makes against its worktree's requests before it commits, the yield to
//! publications still queued, and the plain outcome of a group whose root has no durability.
//!
//! Every write names its effects by id and claim token (`e.id=t.id AND e.execution_token=t.token`),
//! so an effect whose claim moved changes nothing. The store keeps no persistence protocol
//! setting, so the protocol predicate always holds.

use super::effect_worker::pg_uuid;
use super::effects::{effect_by_id, write_effect};
use super::write_claim_terms::worktree_of;
use super::{all_requests, extra_is_null, extra_time};
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite};
use serde::Deserialize;
use serde_json::{Value, json};

/// The data keys a plain outcome drops (`data-'retry_slugs'-...-'busy_at'`).
const PLAIN_DROPS: [&str; 6] = [
    "retry_slugs",
    "target_failures",
    "failing_target",
    "busy_retries",
    "busy_since",
    "busy_at",
];

/// One claimed effect a write names (`jsonb_to_recordset ... AS t(id bigint,token uuid)`).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitClaimRef {
    pub id: String,
    #[serde(default)]
    pub token: Option<String>,
}

/// One read of `gitEffectStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GitEffectRead {
    /// `GIT_PUBLICATIONS_PENDING_SQL`: a request on the worktree is queued or running.
    PublicationsPending { worktree_id: String },
    /// `GIT_RECOVERING_PUBLICATIONS_SQL`: `{ publishing }`, `bool_and` over the worktree's
    /// requests that hold a recovery record (null when none does).
    RecoveringPublications { worktree_id: String },
    /// `GIT_WORKTREE_RECOVERING_SQL`: a request on the worktree holds a recovery record.
    WorktreeRecovering { worktree_id: String },
}

/// One write of `gitEffectStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GitEffectWrite {
    /// `GIT_YIELD_SQL`: each claimed effect is queued again, `publication_pending`, due after
    /// `delay_ms`.
    YieldToPublications {
        claims: Vec<GitClaimRef>,
        delay_ms: f64,
    },
    /// `GIT_PLAIN_OUTCOME_SQL`: each claimed effect with no recovery settles with the outcome:
    /// `failed` `targets_parked` when it parked targets, else `committed`.
    RecordPlainOutcome {
        claims: Vec<GitClaimRef>,
        outcome_json: String,
    },
}

/// The request rows on worktree `w`, lower-case uuid.
fn on_worktree(read: &dyn KvRead, worktree: &str) -> Result<Vec<super::RequestRecord>> {
    let w = pg_uuid(worktree)?;
    Ok(all_requests(read)?
        .into_iter()
        .filter(|r| worktree_of(r).as_deref() == Some(w.as_str()))
        .collect())
}

fn git_effect_rows_in(read: &dyn KvRead, now: i64, what: &GitEffectRead) -> Result<Value> {
    match what {
        GitEffectRead::PublicationsPending { worktree_id } => Ok(json!(
            on_worktree(read, worktree_id)?
                .iter()
                .any(|r| r.state == "queued" || r.state == "running")
        )),
        GitEffectRead::RecoveringPublications { worktree_id } => {
            let recovering: Vec<_> = on_worktree(read, worktree_id)?
                .into_iter()
                .filter(|r| !extra_is_null(r, "recovery"))
                .collect();
            // `bool_and` over no rows is null; one row is always returned.
            let publishing = if recovering.is_empty() {
                Value::Null
            } else {
                json!(recovering.iter().all(|r| {
                    (r.state == "running"
                        && extra_time(r, "claim_expires_at").is_some_and(|t| t > now))
                        || matches!(
                            r.state.as_str(),
                            "committed" | "conflict" | "failed" | "cancelled"
                        )
                }))
            };
            Ok(json!({ "publishing": publishing }))
        }
        GitEffectRead::WorktreeRecovering { worktree_id } => Ok(json!(
            on_worktree(read, worktree_id)?
                .iter()
                .any(|r| !extra_is_null(r, "recovery"))
        )),
    }
}

/// `t(id bigint, token uuid)`: the claim's id and token as Postgres casts them.
fn claim_key(claim: &GitClaimRef) -> Result<(i64, Option<String>)> {
    let id = claim.id.trim().parse::<i64>().map_err(|_| {
        StoreError::invalid(format!(
            "invalid input syntax for type bigint: \"{}\"",
            claim.id
        ))
    })?;
    Ok((id, claim.token.as_deref().map(pg_uuid).transpose()?))
}

fn git_effect_write_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    what: &GitEffectWrite,
) -> Result<Value> {
    let now = env.now_micros();
    match what {
        GitEffectWrite::YieldToPublications { claims, delay_ms } => {
            let delay_us = (delay_ms * 1000.0).round() as i64;
            for claim in claims {
                let (id, token) = claim_key(claim)?;
                // `e.execution_token=t.token`: a null token matches no row.
                let Some(token) = token else { continue };
                let Some(mut e) = effect_by_id(&*tx, id)? else {
                    continue;
                };
                if e.execution_token.as_deref() != Some(token.as_str()) {
                    continue;
                }
                e.state = "queued".into();
                e.execution_token = None;
                e.claim_expires_at_us = None;
                e.claim_owner = None;
                e.error_code = Some("publication_pending".into());
                e.next_attempt_at_us = now + delay_us;
                e.updated_at_us = now;
                write_effect(tx, &e)?;
            }
            Ok(Value::Null)
        }
        GitEffectWrite::RecordPlainOutcome {
            claims,
            outcome_json,
        } => {
            let outcome: Value = serde_json::from_str(outcome_json).map_err(|e| {
                StoreError::invalid(format!("invalid input syntax for type json: {e}"))
            })?;
            for claim in claims {
                let (id, token) = claim_key(claim)?;
                let Some(token) = token else { continue };
                let Some(mut e) = effect_by_id(&*tx, id)? else {
                    continue;
                };
                if e.execution_token.as_deref() != Some(token.as_str()) || e.recovery.is_some() {
                    continue;
                }
                let parked = e
                    .data
                    .get("parked")
                    .and_then(Value::as_array)
                    .is_some_and(|a| !a.is_empty());
                e.state = if parked { "failed" } else { "committed" }.into();
                e.error_code = parked.then(|| "targets_parked".to_string());
                if let Value::Object(map) = &mut e.data {
                    for key in PLAIN_DROPS {
                        map.remove(key);
                    }
                }
                e.execution_token = None;
                e.claim_expires_at_us = None;
                e.claim_owner = None;
                e.outcome = Some(outcome.clone());
                e.updated_at_us = now;
                write_effect(tx, &e)?;
            }
            Ok(Value::Null)
        }
    }
}

impl crate::Store {
    /// One `gitEffectStore()` read (`GitEffectRead`) as JSON.
    pub fn git_effect_rows(&self, what: &GitEffectRead) -> Result<Value> {
        let now = self.env.now_micros();
        git_effect_rows_in(&*self.read()?, now, what)
    }

    /// One `gitEffectStore()` write (`GitEffectWrite`); its result as JSON.
    pub fn git_effect_write(&self, what: &GitEffectWrite) -> Result<Value> {
        self.write(|tx| git_effect_write_in(tx, &*self.env, what))
    }
}
