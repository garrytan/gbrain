/**
 * Effect worker statements: one SQL implementation for both engines (Rust engine persistence, effect worker lane).
 *
 * The statements `src/core/persistence/effect-journal.ts` and `effects.ts` sent through `executeRaw` to claim an effect
 * and to settle the claim: the claim stamp, the lease renewal, the cursor advance, completion, retry (plain and
 * `writer_busy`), requeue, park and fail, and the withdrawal-mirror gate read. Each text is the one its caller has
 * always sent, byte for byte (the protocol predicate written out, as `PROTOCOL_PREDICATE_SQL` in persistence-claims.ts). Every settle
 * statement names its effect by id and the claim's execution token, so a claim that moved changes nothing. Decisions
 * stay with the callers.
 *
 * `exec` is the engine itself (its own `executeRaw`, or `executeRawDirect` on the Postgres direct lane), so each
 * statement reaches the connection it reached before, a transaction's clone included.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/** The engine an effect worker statement runs on: its own `executeRaw` (or the direct lane's). */
export interface EffectExec { executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> }

/** An effect id as the drivers return it (bigint text on Postgres, a number or text on PGLite). */
export type EffectId = string | number;

/** `stampEffectClaim`: claims effect `id` under `token`; `ownerJson` is the `claim_owner` stamp (`effectClaimStamp`). */
export interface EffectClaim { id: EffectId; token: string; ownerJson: string }
/** `claimCoalescedGitEffects`: the host, its worktree, how many, the owners proved dead, and the `claim_owner` owner (`claimOwner()` as JSON). */
export interface CoalescedGitClaim { hostId: string; worktreeId: string; limit: number; deadOwners: readonly string[]; ownerJson: string }
/** A held claim: the effect's id and the claim's execution token (null matches no claim). */
export interface EffectClaimRef { id: EffectId; token: string | null }

/** `stampEffectClaim`: $1 id, $2 token, $3 the owner stamp. The text `claimPersistenceEffect` has always sent. */
export const STAMP_EFFECT_CLAIM_SQL = `UPDATE persistence_effects SET state='running',execution_token=$2::uuid,claim_owner=$3::text::jsonb,
      claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *`;

/**
 * `claimEffectRecovery` (the protocol predicate written out): claims effect $1 for its recovery under token $2 with owner
 * stamp $3, only while it still holds a recovery record. The text `claimAndRecoverEffect` (persistence/effects.ts) has always sent.
 */
export const CLAIM_EFFECT_RECOVERY_SQL = `UPDATE persistence_effects SET state='running',execution_token=$2::uuid,claim_owner=$3::text::jsonb,
      claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1 AND recovery IS NOT NULL AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING *`;

/**
 * `claimCoalescedGitEffects`: $1 host id, $2 worktree id, $3 limit, $4 the owner keys proved dead, $5 the owner stamp.
 * The text `claimCoalescedGitEffects` (persistence/effect-journal.ts) has always sent, with `refreshFenceClear('w', 'id')`
 * and `DEAD_OWNER_EFFECT_SQL('e', '$4')` written out; test/persistence-journal-statements.test.ts checks it against those
 * fragments.
 */
export const CLAIM_COALESCED_GIT_EFFECTS_SQL = `WITH ready AS (SELECT e.id,gen_random_uuid() AS token FROM persistence_effects e
      WHERE EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=$2::uuid AND w.owner_host_id=$1::uuid
        AND NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=w.id
        AND fence.state IN ('fenced','merged','recovery_required'))
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=w.id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=w.id AND blocked.recovery IS NOT NULL))
      AND e.worktree_id=$2::uuid AND e.kind='git' AND e.data ? 'relative_path'
      AND NOT (e.data ? 'targets') AND NOT (e.data ? 'source_scan') AND NOT (e.data ? 'version')
      AND (e.state='queued' OR e.state='running' AND e.claim_expires_at<now() OR e.state='running' AND e.recovery IS NULL
  AND e.claim_owner->>'token'=e.execution_token::text AND concat_ws(':',e.claim_owner->'owner'->>'pid',e.claim_owner->'owner'->>'nonce',e.claim_owner->'owner'->>'start')=ANY($4::text[])) AND e.next_attempt_at<=now()
      AND e.recovery IS NULL
      AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running'))
      ORDER BY e.next_attempt_at,e.id LIMIT $3 FOR UPDATE OF e SKIP LOCKED)
      UPDATE persistence_effects p SET state='running',execution_token=ready.token,
      claim_owner=jsonb_build_object('token',ready.token::text,'owner',$5::text::jsonb),
      claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
      FROM ready WHERE p.id=ready.id RETURNING p.*`;

/** `renewEffectClaim`: $1 id, $2 token. The text `renewPersistenceEffectClaim` has always sent. */
export const RENEW_EFFECT_CLAIM_SQL = `UPDATE persistence_effects SET claim_expires_at=now()+interval '2 minutes',updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND state='running' AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING id`;

/** `advanceEffectRow`: $1 id, $2 token, $3 the slug the cursor moves to. The text `advanceEffectCursor` has always sent. */
export const ADVANCE_EFFECT_SQL = `UPDATE persistence_effects SET state='queued',data=jsonb_set(
    CASE WHEN kind='embedding' THEN jsonb_set(data,'{embedding_attempt_base}',to_jsonb(attempts)) ELSE data-'target_failures'-'failing_target' END,'{after_slug}',to_jsonb($3::text)),
    execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,next_attempt_at=now(),error_code=NULL,
    updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `completeEffectRow`: $1 id, $2 token, $3 the outcome. The text `completeEffect` has always sent. */
export const COMPLETE_EFFECT_SQL = `UPDATE persistence_effects SET
    state=CASE WHEN jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 THEN 'failed' ELSE 'committed' END,
    error_code=CASE WHEN jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 THEN 'targets_parked' END,
    data=data-'retry_slugs'-'target_failures'-'failing_target'-'busy_retries'-'busy_since'-'busy_at',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,
    outcome=$3::text::jsonb,updated_at=now() WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `retryEffectRow`: $1 id, $2 token, $3 the reason, $4 the delay in ms. The text `retryEffect` has always sent. */
export const RETRY_EFFECT_SQL = `UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,error_code=$3,
    next_attempt_at=now()+($4::double precision*interval '1 millisecond'),updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `retryBusyEffectRow`: $1 id, $2 token, $3 the busy streak patch, $4 the delay in ms. The text `retryBusyEffect` has always sent. */
export const RETRY_BUSY_EFFECT_SQL = `UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,error_code='writer_busy',
    data=data||$3::text::jsonb,next_attempt_at=now()+($4::double precision*interval '1 millisecond'),updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `requeueEffectRow`: $1 id, $2 token, $3 the data, $4 the reason, $5 the delay in ms. The text `requeueEffect` has always sent. */
export const REQUEUE_EFFECT_SQL = `UPDATE persistence_effects SET state='queued',data=$3::text::jsonb,execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,error_code=$4,
    next_attempt_at=now()+($5::double precision*interval '1 millisecond'),updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `parkEffectRow`: $1 id, $2 token, $3 the data. The text `parkEffect` has always sent. */
export const PARK_EFFECT_SQL = `UPDATE persistence_effects SET state='failed',data=$3::text::jsonb,execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,
    error_code='targets_parked',updated_at=now() WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `failEffectRow`: $1 id, $2 token, $3 the reason. The text `failEffect` has always sent. */
export const FAIL_EFFECT_SQL = `UPDATE persistence_effects SET state='failed',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,error_code=$3,updated_at=now()
    WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `readMirrorGateRows`: $1 the request ids. The text `mirrorGates` has always sent. */
export const MIRROR_GATE_ROWS_SQL = `SELECT request_id::text AS request_id,state,data FROM persistence_effects WHERE kind='withdrawal-mirror' AND (state<>'committed' OR data ? 'published')
      AND request_id=ANY($1::uuid[])`;

/** `lockEffectGuard`: share-locks the brain row before the source row (the #6007 lock order). The text `guardEffectSource` has always sent. */
export const EFFECT_GUARD_BRAIN_SQL = 'SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE';
/** `lockEffectGuard`: $1 the effect's worktree id. The text `guardEffectSource` has always sent. */
export const EFFECT_GUARD_WORKTREE_SQL = 'SELECT owner_host_id,state FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE';

/** The owner of an effect's worktree as the guard reads it under a share lock. */
export interface EffectWorktreeOwner { owner_host_id: string; state: string }

/**
 * The effects `rearmWithheldTargets` re-arms (alias `e`): $1 the request ids, $2 the parked error code. A Git or
 * embedding effect, unclaimed and not recovering, not settled, with a target parked under $2, whose request's
 * withdrawal mirror has committed.
 */
export const REARMABLE_SQL = `e.request_id=ANY($1::uuid[])
    AND e.kind IN ('git','embedding') AND e.state IN ('queued','failed') AND e.execution_token IS NULL AND e.recovery IS NULL AND NOT (e.data ? 'settled')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) AS p(target) WHERE p.target->>'error_code'=$2)
    AND EXISTS (SELECT 1 FROM persistence_effects m WHERE m.request_id=e.request_id AND m.kind='withdrawal-mirror' AND m.state='committed')`;

/** `hasRearmableTargets`: $1 the request ids, $2 the parked error code. The text `hasRearmableTargets` has always sent. */
export const HAS_REARMABLE_SQL = `SELECT 1 FROM persistence_effects e WHERE ${REARMABLE_SQL} LIMIT 1`;

/** One withdrawal mirror that gates its request (`mirrorGates`). */
export interface MirrorGateRow { request_id: string; state: string; data: Record<string, unknown> }

/** Claims effect `id` under `token`: the claimed row, or null when no effect has the id. */
export async function stampEffectClaim<R = Record<string, unknown>>(exec: EffectExec, claim: EffectClaim): Promise<R | null> {
  const [row] = await exec.executeRaw<R>(STAMP_EFFECT_CLAIM_SQL, [claim.id, claim.token, claim.ownerJson]);
  return row ?? null;
}

/** Claims effect `id` for its recovery under `token`: the claimed row, or null when no effect with that id holds a recovery record. */
export async function claimEffectRecovery<R = Record<string, unknown>>(exec: EffectExec, claim: EffectClaim): Promise<R | null> {
  const [row] = await exec.executeRaw<R>(CLAIM_EFFECT_RECOVERY_SQL, [claim.id, claim.token, claim.ownerJson]);
  return row ?? null;
}

/**
 * Claims up to `limit` more ready single-file Git effects of worktree `worktreeId` for host `hostId` (#5530), each under a
 * fresh token with `ownerJson` as its stamp's owner, under the readiness, recovery and withdrawal-mirror rules of
 * `selectClaimableEffect`, so the runner commits them together. The claimed rows, in the order the statement returns them.
 */
export async function claimCoalescedGitEffects<R = Record<string, unknown>>(exec: EffectExec, input: CoalescedGitClaim): Promise<R[]> {
  return exec.executeRaw<R>(CLAIM_COALESCED_GIT_EFFECTS_SQL, [input.hostId, input.worktreeId, input.limit, [...input.deadOwners], input.ownerJson]);
}

/** Extends an effect claim's lease; true while the effect is still running under the token with no recovery. */
export async function renewEffectClaim(exec: EffectExec, claim: EffectClaimRef): Promise<boolean> {
  const rows = await exec.executeRaw(RENEW_EFFECT_CLAIM_SQL, [claim.id, claim.token]);
  return rows.length === 1;
}

/** Requeues a claimed effect with its scan cursor at `slug`. */
export async function advanceEffectRow(exec: EffectExec, claim: EffectClaimRef & { slug: string }): Promise<void> {
  await exec.executeRaw(ADVANCE_EFFECT_SQL, [claim.id, claim.token, claim.slug]);
}

/** Finishes a claimed effect with `outcomeJson`: committed, or failed `targets_parked` when it parked targets. */
export async function completeEffectRow(exec: EffectExec, claim: EffectClaimRef & { outcomeJson: string }): Promise<void> {
  await exec.executeRaw(COMPLETE_EFFECT_SQL, [claim.id, claim.token, claim.outcomeJson]);
}

/** Requeues a claimed effect after `delayMs` with error code `reason` (a claim under recovery too). */
export async function retryEffectRow(exec: EffectExec, claim: EffectClaimRef & { reason: string; delayMs: number }): Promise<void> {
  await exec.executeRaw(RETRY_EFFECT_SQL, [claim.id, claim.token, claim.reason, claim.delayMs]);
}

/** Requeues a claimed effect as `writer_busy` after `delayMs`, merging the busy streak `dataJson` into its data. */
export async function retryBusyEffectRow(exec: EffectExec, claim: EffectClaimRef & { dataJson: string; delayMs: number }): Promise<void> {
  await exec.executeRaw(RETRY_BUSY_EFFECT_SQL, [claim.id, claim.token, claim.dataJson, claim.delayMs]);
}

/** Requeues a claimed effect with replacement data `dataJson`, error code `reason` and a wait of `delayMs`. */
export async function requeueEffectRow(exec: EffectExec, claim: EffectClaimRef & { dataJson: string; reason: string | null; delayMs: number }): Promise<void> {
  await exec.executeRaw(REQUEUE_EFFECT_SQL, [claim.id, claim.token, claim.dataJson, claim.reason, claim.delayMs]);
}

/** Fails a claimed effect as `targets_parked` with data `dataJson`. */
export async function parkEffectRow(exec: EffectExec, claim: EffectClaimRef & { dataJson: string }): Promise<void> {
  await exec.executeRaw(PARK_EFFECT_SQL, [claim.id, claim.token, claim.dataJson]);
}

/** Fails a claimed effect with error code `reason`. */
export async function failEffectRow(exec: EffectExec, claim: EffectClaimRef & { reason: string }): Promise<void> {
  await exec.executeRaw(FAIL_EFFECT_SQL, [claim.id, claim.token, claim.reason]);
}

/** The withdrawal mirrors that gate these requests: each one not committed, or committed with its publications. */
export async function readMirrorGateRows(exec: LegacyUnscopedRead, requestIds: readonly string[]): Promise<MirrorGateRow[]> {
  return exec.executeRaw<MirrorGateRow>(MIRROR_GATE_ROWS_SQL, [[...requestIds]]);
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

/** Whether one of these requests has a target parked under `code` that its committed withdrawal mirror re-arms. */
export async function hasRearmableTargets(exec: LegacyUnscopedRead, requestIds: readonly string[], code: string): Promise<boolean> {
  return (await exec.executeRaw(HAS_REARMABLE_SQL, [[...requestIds], code])).length > 0;
}
