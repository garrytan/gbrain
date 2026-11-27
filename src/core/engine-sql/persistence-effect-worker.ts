/** `stampEffectClaim`: claims effect `id` under `token`; `ownerJson` is the `claim_owner` stamp (`effectClaimStamp`). */
export interface EffectClaim { id: EffectId; token: string; ownerJson: string }
/** `stampEffectClaim`: $1 id, $2 token, $3 the owner stamp. The text `claimPersistenceEffect` has always sent. */
export const STAMP_EFFECT_CLAIM_SQL = `UPDATE persistence_effects SET state='running',execution_token=$2::uuid,claim_owner=$3::text::jsonb,
      claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *`;

/** The engine an effect worker statement runs on: its own `executeRaw` (or the direct lane's). */
export interface EffectExec { executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> }

/** An effect id as the drivers return it (bigint text on Postgres, a number or text on PGLite). */
export type EffectId = string | number;
/** A held claim: the effect's id and the claim's execution token (null matches no claim). */
export interface EffectClaimRef { id: EffectId; token: string | null }

/** `renewEffectClaim`: $1 id, $2 token. The text `renewPersistenceEffectClaim` has always sent. */
export const RENEW_EFFECT_CLAIM_SQL = `UPDATE persistence_effects SET claim_expires_at=now()+interval '2 minutes',updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND state='running' AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING id`;

/** `completeEffectRow`: $1 id, $2 token, $3 the outcome. The text `completeEffect` has always sent. */
export const COMPLETE_EFFECT_SQL = `UPDATE persistence_effects SET
    state=CASE WHEN jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 THEN 'failed' ELSE 'committed' END,
    error_code=CASE WHEN jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 THEN 'targets_parked' END,
    data=data-'retry_slugs'-'target_failures'-'failing_target'-'busy_retries'-'busy_since'-'busy_at',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,
    outcome=$3::text::jsonb,updated_at=now() WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `failEffectRow`: $1 id, $2 token, $3 the reason. The text `failEffect` has always sent. */
export const FAIL_EFFECT_SQL = `UPDATE persistence_effects SET state='failed',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,error_code=$3,updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `lockEffectGuard`: share-locks the brain row before the source row (the #6007 lock order). The text `guardEffectSource` has always sent. */
export const EFFECT_GUARD_BRAIN_SQL = 'SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE';
/** `lockEffectGuard`: $1 the effect's worktree id. The text `guardEffectSource` has always sent. */
export const EFFECT_GUARD_WORKTREE_SQL = 'SELECT owner_host_id,state FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE';

/** The owner of an effect's worktree as the guard reads it under a share lock. */
export interface EffectWorktreeOwner { owner_host_id: string; state: string }

/** Extends an effect claim's lease; true while the effect is still running under the token with no recovery. */
export async function renewEffectClaim(exec: EffectExec, claim: EffectClaimRef): Promise<boolean> {
  const rows = await exec.executeRaw(RENEW_EFFECT_CLAIM_SQL, [claim.id, claim.token]);
  return rows.length === 1;
}

/** Finishes a claimed effect with `outcomeJson`: committed, or failed `targets_parked` when it parked targets. */
export async function completeEffectRow(exec: EffectExec, claim: EffectClaimRef & { outcomeJson: string }): Promise<void> {
  await exec.executeRaw(COMPLETE_EFFECT_SQL, [claim.id, claim.token, claim.outcomeJson]);
}

/** Fails a claimed effect with error code `reason`. */
export async function failEffectRow(exec: EffectExec, claim: EffectClaimRef & { reason: string }): Promise<void> {
  await exec.executeRaw(FAIL_EFFECT_SQL, [claim.id, claim.token, claim.reason]);
}

/**
 * Share-locks the brain row, then (for an effect bound to a worktree) the worktree row: the worktree's owner and
 * state, or null when the effect has no worktree or the worktree row is gone.
 */
export async function lockEffectGuard(exec: EffectExec, worktreeId: string | null): Promise<EffectWorktreeOwner | null> {
  await exec.executeRaw(EFFECT_GUARD_BRAIN_SQL);
  if (!worktreeId) return null;
  const [owner] = await exec.executeRaw<EffectWorktreeOwner>(EFFECT_GUARD_WORKTREE_SQL, [worktreeId]);
  return owner ?? null;
}

/** Claims effect `id` under `token`: the claimed row, or null when no effect has the id. */
export async function stampEffectClaim<R = Record<string, unknown>>(exec: EffectExec, claim: EffectClaim): Promise<R | null> {
  const [row] = await exec.executeRaw<R>(STAMP_EFFECT_CLAIM_SQL, [claim.id, claim.token, claim.ownerJson]);
  return row ?? null;
}
