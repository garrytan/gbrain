/**
 * Effect-journal statements: one SQL implementation for both engines (Rust engine persistence, effect journal).
 *
 * These are the statements `src/core/persistence/effect-journal.ts`, `effects.ts` and `effect-recovery.ts` sent
 * through `executeRaw` on a page write's path: the effect claim (select, then stamp), the queue insert, the abandoned
 * claim release, the brain-row share lock, the publishing-recovery probe, the withdrawal-mirror gate read, the
 * completion (one effect and a batch) and the re-arm probe. The text is unchanged, written out in full so this module
 * imports no persistence code (the persistence modules pull in most of the codebase, which an engine must not load):
 * the protocol predicate, `asciiLowerSql(edgeTrimSql('value'))` and `refreshFenceClear('e')` appear expanded.
 * `test/persistence-effects-statements.test.ts` checks each written-out statement against those builders.
 * Decisions (what to queue, whether a source still applies, what an outcome says) stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import type { PersistenceEffect } from '../persistence/effect-model.ts';

/** The protocol-2 declaration the effect-row trigger requires, set inside the same statement (protocol.ts). */
const PROTOCOL = "set_config('gbrain.persistence_protocol','2',true)='2'";

/** The config key that turns remote mention links off (effect-model.ts REMOTE_AUTO_LINKS_KEY). */
export const REMOTE_AUTO_LINKS_CONFIG_KEY = 'mcp.remote_auto_links';

/**
 * The next claimable effect, row-locked: queued, lease-expired or held by a dead owner ($2), due, on no worktree or one
 * this host ($1) owns with no refresh fence and no recovery, and not behind its request's unfinished withdrawal mirror.
 */
export const SELECT_CLAIMABLE_EFFECT_SQL = `SELECT e.* FROM persistence_effects e
      LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
      WHERE (e.state='queued' OR e.state='running' AND e.claim_expires_at<now() OR e.state='running' AND e.recovery IS NULL
  AND e.claim_owner->>'token'=e.execution_token::text AND concat_ws(':',e.claim_owner->'owner'->>'pid',e.claim_owner->'owner'->>'nonce',e.claim_owner->'owner'->>'start')=ANY($2::text[])) AND e.next_attempt_at<=now()
      AND (e.worktree_id IS NULL OR w.owner_host_id=$1::uuid) AND (e.worktree_id IS NULL OR NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=e.worktree_id
        AND fence.state IN ('fenced','merged','recovery_required')))
      AND e.recovery IS NULL AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked
        WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
      AND (e.kind='withdrawal-mirror' OR NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running')))
      ORDER BY e.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`;

/** Stamps the claim on effect $1: running, token $2, owner stamp $3, a 2-minute lease, one more attempt. */
export const CLAIM_EFFECT_SQL = `UPDATE persistence_effects SET state='running',execution_token=$2::uuid,claim_owner=$3::text::jsonb,
      claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *`;

/** Inserts the queued effects in order; a gated row is skipped while `auto_link` or $7 is off. Returns the inserted kinds. */
export const QUEUE_EFFECTS_SQL = `INSERT INTO persistence_effects (request_id,kind,revision,data,source_id,source_incarnation,worktree_id)
    SELECT $1::uuid,t.e->>'kind',$2::uuid,t.e->'data',$3,$4::uuid,$5::uuid FROM jsonb_array_elements($6::text::jsonb) WITH ORDINALITY AS t(e,n)
    WHERE NOT (COALESCE((t.e->>'gated')::boolean,false) AND EXISTS (SELECT 1 FROM config
      WHERE key IN ('auto_link',$7) AND translate(btrim(value, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('false','0','no','off')))
    ORDER BY t.n ON CONFLICT(request_id,kind) DO NOTHING RETURNING kind`;

/** Releases running effect claims (no recovery) last written before $1: queued again, due now at the latest. */
export const RELEASE_ABANDONED_EFFECT_CLAIMS_SQL = `UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,
    next_attempt_at=LEAST(next_attempt_at,now()) WHERE state='running' AND recovery IS NULL AND updated_at<$1::timestamptz
    AND ${PROTOCOL} RETURNING id`;

/** Share-locks the brain row (the lock order guardEffectSource keeps: brain row, then source row). */
export const LOCK_PERSISTENCE_BRAIN_SHARE_SQL = 'SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE';

/** Whether every request of worktree $1 holding a recovery record is still publishing; null when none holds one. */
export const REQUESTS_STILL_PUBLISHING_SQL = `SELECT bool_and(state='running' AND claim_expires_at>now()
            OR state IN ('committed','conflict','failed','cancelled')) AS publishing FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL`;

/** The withdrawal-mirror effects of requests $1 that have not committed, or committed with recorded publications. */
export const LIST_MIRROR_GATES_SQL = `SELECT request_id::text AS request_id,state,data FROM persistence_effects WHERE kind='withdrawal-mirror' AND (state<>'committed' OR data ? 'published')
      AND request_id=ANY($1::uuid[])`;

/** Completes effect $1 under token $2: failed (`targets_parked`) with parked targets, else committed; outcome $3. */
export const COMPLETE_EFFECT_SQL = `UPDATE persistence_effects SET
    state=CASE WHEN jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 THEN 'failed' ELSE 'committed' END,
    error_code=CASE WHEN jsonb_array_length(COALESCE(data->'parked','[]'::jsonb))>0 THEN 'targets_parked' END,
    data=data-'retry_slugs'-'target_failures'-'failing_target'-'busy_retries'-'busy_since'-'busy_at',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,
    outcome=$3::text::jsonb,updated_at=now() WHERE id=$1 AND execution_token=$2::uuid AND recovery IS NULL AND ${PROTOCOL} RETURNING id`;

/** COMPLETE_EFFECT_SQL over a batch: $1 is a JSON array of `{id, token}`, $2 the outcome every row gets. */
export const COMPLETE_EFFECTS_SQL = `UPDATE persistence_effects e SET
        state=CASE WHEN jsonb_array_length(COALESCE(e.data->'parked','[]'::jsonb))>0 THEN 'failed' ELSE 'committed' END,
        error_code=CASE WHEN jsonb_array_length(COALESCE(e.data->'parked','[]'::jsonb))>0 THEN 'targets_parked' END,
        data=e.data-'retry_slugs'-'target_failures'-'failing_target'-'busy_retries'-'busy_since'-'busy_at',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,
        outcome=$2::text::jsonb,updated_at=now()
        FROM jsonb_to_recordset($1::text::jsonb) AS t(id bigint,token uuid)
        WHERE e.id=t.id AND e.execution_token=t.token AND e.recovery IS NULL AND ${PROTOCOL} RETURNING e.id`;

/**
 * Whether requests $1 have an unclaimed Git or embedding effect with a target parked behind a committed withdrawal
 * mirror (error code $2), the effects rearmWithheldTargets re-arms. The predicate is effect-journal.ts REARMABLE.
 */
export const HAS_REARMABLE_EFFECTS_SQL = `SELECT 1 FROM persistence_effects e WHERE e.request_id=ANY($1::uuid[])
    AND e.kind IN ('git','embedding') AND e.state IN ('queued','failed') AND e.execution_token IS NULL AND e.recovery IS NULL AND NOT (e.data ? 'settled')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) AS p(target) WHERE p.target->>'error_code'=$2)
    AND EXISTS (SELECT 1 FROM persistence_effects m WHERE m.request_id=e.request_id AND m.kind='withdrawal-mirror' AND m.state='committed') LIMIT 1`;

/** The error code of a target parked behind its request's withdrawal mirror (effect-model.ts WITHHELD_BY_MIRROR). */
export const WITHHELD_BY_MIRROR_CODE = 'withdrawal_mirror_failed';

/** One effect `queueEffects` inserts; a `gated` one is skipped while mention auto-linking is off. */
export interface QueuedEffect { kind: string; data: Record<string, unknown>; gated?: boolean }
/** The effects one publication queues, with the request columns every row copies. */
export interface EffectQueue {
  requestId: string; revision: string | null; sourceId: string; sourceIncarnation: string; worktreeId: string | null;
  queued: readonly QueuedEffect[];
}
/** A withdrawal-mirror effect's gate row (`listMirrorGates`). */
export interface MirrorGateRow { request_id: string; state: PersistenceEffect['state']; data: PersistenceEffect['data'] }
/** One claimed effect `completeEffects` finishes: its id and the token of the claim. */
export interface EffectClaimRef { id: string | number; token: string | null }

/** The next claimable effect for host `hostId`, row-locked until the transaction ends, or null. */
export async function selectClaimableEffect(exec: SqlExecutor, hostId: string, deadOwners: readonly string[]): Promise<PersistenceEffect | null> {
  const [row] = await exec.executeRaw<PersistenceEffect>(SELECT_CLAIMABLE_EFFECT_SQL, [hostId, [...deadOwners]]);
  return row ?? null;
}

/** Stamps the claim minting `token` on effect `id`; returns the claimed row, or null for an unknown id. */
export async function claimEffect(exec: SqlExecutor, id: string | number, token: string, claimOwnerJson: string): Promise<PersistenceEffect | null> {
  const [row] = await exec.executeRaw<PersistenceEffect>(CLAIM_EFFECT_SQL, [id, token, claimOwnerJson]);
  return row ?? null;
}

/** Inserts a publication's effects in order (an existing kind for the request is kept); returns the kinds inserted. */
export async function queueEffects(exec: SqlExecutor, queue: EffectQueue): Promise<string[]> {
  if (!queue.queued.length) return [];
  const rows = await exec.executeRaw<{ kind: string }>(QUEUE_EFFECTS_SQL, [queue.requestId, queue.revision, queue.sourceId,
    queue.sourceIncarnation, queue.worktreeId, JSON.stringify(queue.queued), REMOTE_AUTO_LINKS_CONFIG_KEY]);
  return rows.map(row => row.kind);
}

/** Releases the running effect claims (no recovery record) last written before `cutoff`; returns how many. */
export async function releaseAbandonedEffectClaims(exec: SqlExecutor, cutoff: Date): Promise<number> {
  return (await exec.executeRaw(RELEASE_ABANDONED_EFFECT_CLAIMS_SQL, [cutoff.toISOString()])).length;
}

/** Share-locks the brain row until the transaction ends. */
export async function lockPersistenceBrainShare(exec: SqlExecutor): Promise<void> {
  await exec.executeRaw(LOCK_PERSISTENCE_BRAIN_SHARE_SQL);
}

/** For worktree `worktreeId`: whether its recovering requests are all still publishing, or null when none recovers. */
export async function requestsStillPublishing(exec: LegacyUnscopedRead, worktreeId: string): Promise<boolean | null> {
  const [row] = await exec.executeRaw<{ publishing: boolean | null }>(REQUESTS_STILL_PUBLISHING_SQL, [worktreeId]);
  return row?.publishing ?? null;
}

/** The withdrawal-mirror gate rows of these requests (deduplicated), in no particular order. */
export async function listMirrorGates(exec: LegacyUnscopedRead, requestIds: readonly string[]): Promise<MirrorGateRow[]> {
  if (!requestIds.length) return [];
  return exec.executeRaw<MirrorGateRow>(LIST_MIRROR_GATES_SQL, [[...new Set(requestIds)]]);
}

/** Completes the effect claimed with `token`; false when the claim moved or a recovery record holds it. */
export async function completeEffect(exec: SqlExecutor, id: string | number, token: string | null, outcome: Record<string, unknown>): Promise<boolean> {
  return (await exec.executeRaw(COMPLETE_EFFECT_SQL, [id, token, JSON.stringify(outcome)])).length === 1;
}

/** Completes each claimed effect with the same outcome; returns how many still held their claim. */
export async function completeEffects(exec: SqlExecutor, rows: readonly EffectClaimRef[], outcome: Record<string, unknown>): Promise<number> {
  if (!rows.length) return 0;
  return (await exec.executeRaw(COMPLETE_EFFECTS_SQL, [JSON.stringify(rows.map(row => ({ id: String(row.id), token: row.token }))), JSON.stringify(outcome)])).length;
}

/** Whether any of these requests has a target rearmWithheldTargets would re-arm. */
export async function hasRearmableEffects(exec: LegacyUnscopedRead, requestIds: readonly string[]): Promise<boolean> {
  if (!requestIds.length) return false;
  return (await exec.executeRaw(HAS_REARMABLE_EFFECTS_SQL, [[...new Set(requestIds)], WITHHELD_BY_MIRROR_CODE])).length > 0;
}
