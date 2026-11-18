/**
 * Write-claim statements: one SQL implementation for both engines (Rust engine persistence, write journal lane).
 *
 * The statements `src/core/persistence/journal.ts`, `authority.ts` and `consumer.ts` sent through `executeRaw` around
 * admission and the claim: the source membership read, the topology-change probe, the claim check
 * (`hasClaimableWrite`), the lease renewal and the expired-claim release. As in `persistence-journal.ts`, the text is
 * written out in full so this module imports no persistence code; `test/persistence-journal-statements.test.ts`
 * checks each copy against the fragments the journal builds it from. Decisions stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { QueryOpts, SqlExecutor } from './executor.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/** `PERSISTENCE_PROTOCOL_PREDICATE` (protocol.ts): declares protocol 2 for the statement; always true. */
export const PROTOCOL_PREDICATE_SQL = "set_config('gbrain.persistence_protocol','2',true)='2'";

/**
 * `foregroundPrioritySql()` (journal.ts) with no environment override: the brain config row, on unless `0`/`false`.
 * `foregroundPriorityText` adds the override the caller read from the environment.
 */
export const FOREGROUND_PRIORITY_CONFIG_SQL = "NOT EXISTS (SELECT 1 FROM config WHERE key='sync.foreground_priority' AND lower(trim(value)) IN ('0','false'))";

/** The three texts the `foreground_priority` switch can take. */
const PRIORITY_SQL = { on: 'true', off: 'false', config: FOREGROUND_PRIORITY_CONFIG_SQL } as const;

function priorityKey(priority: boolean | null | undefined): keyof typeof PRIORITY_SQL {
  return priority === true ? 'on' : priority === false ? 'off' : 'config';
}

/** The `foreground_priority` switch as SQL: the environment override when the caller has one, otherwise the config row. */
export function foregroundPriorityText(priority: boolean | null | undefined): string {
  return PRIORITY_SQL[priorityKey(priority)];
}

/**
 * `claimableWriteSql(priority)` (journal.ts) with no lane roots: the rows `claimNextWrite` may claim. `hostId` and
 * `excludeRoots` bind as $1 and $2, the text the journal writes.
 */
export function claimableWriteFragment(priority: boolean | null | undefined, hostId: string, excludeRoots: string[]): SqlFragment {
  const p = trustedSql(PRIORITY_SQL[priorityKey(priority)]);
  return sqlFragment`(r.state='queued' OR (r.state='deferred' AND (r.deferred_refresh_id IS NOT NULL OR r.deferred_import_from IS NOT NULL)
        AND (r.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=r.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (r.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=r.source_id AND COALESCE(imported.last_commit,'')<>r.deferred_import_from)))) AND (r.worktree_id IS NULL OR (w.owner_host_id=${hostId}::uuid AND w.state='active'))
      AND (r.worktree_id IS NULL OR NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=r.worktree_id
        AND fence.state IN ('fenced','merged','recovery_required')))
      AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY(${excludeRoots}::text[]))
      AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror WHERE mirror.worktree_id=r.worktree_id
        AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running')
        AND (NOT (mirror.data ? 'targets') OR mirror.data->'targets' @> jsonb_build_array(jsonb_build_object('slug',r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=r.worktree_id AND blocked.recovery IS NOT NULL)
      AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now())
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NOT NULL AND earlier.worktree_id=r.worktree_id AND earlier.sequence<r.sequence
        AND earlier.state IN ('queued','running','recovering') AND NOT ((${p}) AND NOT COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
  AND (earlier.state='queued' OR (earlier.state='running' AND earlier.intent ? 'lane'
    AND earlier.worktree_id::text=ANY('{}'::text[])))
  AND earlier.recovery IS NULL AND COALESCE(earlier.intent->>'kind','') LIKE 'managed_sync_%' AND NOT (earlier.source_id=r.source_id AND (earlier.slug=r.slug
  OR earlier.page_id=r.page_id OR earlier.intent->'renameFrom'->>'slug'=r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NULL AND earlier.worktree_id IS NULL AND earlier.source_incarnation=r.source_incarnation
        AND earlier.sequence<r.sequence
        AND earlier.state IN ('queued','running','recovering') AND NOT ((${p}) AND NOT COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
  AND (earlier.state='queued' OR (earlier.state='running' AND earlier.intent ? 'lane'
    AND earlier.worktree_id::text=ANY('{}'::text[])))
  AND earlier.recovery IS NULL AND COALESCE(earlier.intent->>'kind','') LIKE 'managed_sync_%' AND NOT (earlier.source_id=r.source_id AND (earlier.slug=r.slug
  OR earlier.page_id=r.page_id OR earlier.intent->'renameFrom'->>'slug'=r.slug))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE r.worktree_id IS NOT NULL AND earlier.worktree_id=r.worktree_id AND earlier.sequence<r.sequence AND (earlier.state='deferred' AND (earlier.deferred_refresh_id IS NOT NULL OR earlier.deferred_import_from IS NOT NULL)
        AND (earlier.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=earlier.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (earlier.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=earlier.source_id AND COALESCE(imported.last_commit,'')<>earlier.deferred_import_from))))
      AND NOT ((${p}) AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND EXISTS (SELECT 1 FROM persistence_requests ahead
        WHERE ahead.worktree_id=r.worktree_id AND ahead.sequence>r.sequence AND ahead.state IN ('running','recovering') AND NOT COALESCE(ahead.intent->>'kind','') LIKE 'managed_sync_%'))`;
}

/** `hasClaimableWrite`: whether `claimNextWrite` would find a row now. */
export function hasClaimableWriteFragment(priority: boolean | null | undefined, hostId: string, excludeRoots: string[]): SqlFragment {
  return sqlFragment`SELECT EXISTS (SELECT 1 FROM persistence_requests r
      LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE ${claimableWriteFragment(priority, hostId, excludeRoots)} LIMIT 1) AS claimable`;
}

/** `renewWriteClaim` (the protocol predicate written out, see `PROTOCOL_PREDICATE_SQL`): extends the lease of a claim still held under its token, with the phase when one is given. */
export const RENEW_CLAIM_SQL = `UPDATE persistence_requests SET
    claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now(),claim_phase=COALESCE($4::text::jsonb,claim_phase)
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING id`;

/** The consumer's `expired_claims` statement (the protocol predicate and `EXPIRED_PREPARING_CHARGE_SQL('r')` written out): $1 = host id, $2 = charge a preparing claim, $3 = dead claim owners. */
export const EXPIRE_CLAIMS_SQL = `WITH expired AS (
        SELECT r.id FROM persistence_requests r WHERE r.state='running' AND r.recovery IS NULL
        AND r.publication_started=false AND set_config('gbrain.persistence_protocol','2',true)='2'
        AND (r.claim_expires_at<now() OR r.claim_phase->>'token'=r.execution_token::text
          AND concat_ws(':',r.claim_phase->'owner'->>'pid',r.claim_phase->'owner'->>'nonce',r.claim_phase->'owner'->>'start')=ANY($3::text[]))
        AND (r.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=r.worktree_id AND w.owner_host_id=$1::uuid))
        ORDER BY r.sequence LIMIT 100 FOR UPDATE OF r SKIP LOCKED)
        UPDATE persistence_requests r SET state='queued',execution_token=NULL,claim_expires_at=NULL,
          preparation_attempts=r.preparation_attempts+CASE WHEN $2::boolean THEN CASE WHEN r.claim_phase->>'phase'='preparing' AND r.claim_phase->>'token'=r.execution_token::text THEN 1 ELSE 0 END ELSE 0 END
        FROM expired WHERE r.id=expired.id`;

/** One source's membership: its incarnation and whether it is archived. */
export interface SourceMembership { incarnation: string; archived: boolean }

/** A claim renewal: request `id`, its claim `token`, the new lease and, optionally, the phase to record (claim-phase.ts `claimPhaseStamp`). */
export interface ClaimRenewal { id: string; token: string; leaseMs: number; phaseJson: string | null }

/** An expired-claim release: this consumer's host id, whether a claim that expired while preparing counts an attempt, and the dead owners. */
export interface ClaimExpiry { hostId: string; charge: boolean; deadOwners: string[] }

/** Source `sourceId`'s membership, or null; `lock` reads it FOR SHARE (admission holds it until the transaction ends). */
export async function readSourceMembership(exec: SqlExecutor, sourceId: string, opts: { lock?: boolean } = {}): Promise<SourceMembership | null> {
  const sql = opts.lock ? 'SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE' : 'SELECT incarnation,archived FROM sources WHERE id=$1';
  const [row] = await exec.executeRaw<SourceMembership>(sql, [sourceId]);
  return row ?? null;
}

/** The first of `requestIds` a topology change of local writer `principalId` already used (a lifecycle id), as `[{ request_id }]`, or []. */
export function findTopologyChanges(exec: LegacyUnscopedRead, principalId: string, requestIds: string[]): Promise<Array<{ request_id: string }>> {
  return exec.executeRaw<{ request_id: string }>('SELECT request_id FROM persistence_topology_changes WHERE principal_id=$1::uuid AND request_id=ANY($2::uuid[]) LIMIT 1',
    [principalId, requestIds]);
}

/** Whether a claim would find a row now (read-only: no lock and no claim); `priority` is the switch's environment override. */
export async function hasClaimableWrite(exec: LegacyUnscopedRead, hostId: string, excludeRoots: string[], opts: { priority?: boolean | null } & QueryOpts = {}): Promise<boolean> {
  const { priority, ...query } = opts;
  const { text, params } = renderFragment(hasClaimableWriteFragment(priority, hostId, excludeRoots));
  const [row] = await exec.executeRaw<{ claimable: boolean }>(text, params, query);
  return row?.claimable === true;
}

/** Extends a claim's lease; true while request `id` is still running under `token`. */
export async function renewWriteClaim(exec: SqlExecutor, renewal: ClaimRenewal, opts?: QueryOpts): Promise<boolean> {
  const rows = await exec.executeRaw(RENEW_CLAIM_SQL, [renewal.id, renewal.token, renewal.leaseMs, renewal.phaseJson], opts);
  return rows.length === 1;
}

/** Returns expired claims (and claims of dead owners) to queued, at most 100 per call. */
export async function expireStaleWriteClaims(exec: SqlExecutor, expiry: ClaimExpiry, opts?: QueryOpts): Promise<void> {
  await exec.executeRaw(EXPIRE_CLAIMS_SQL, [expiry.hostId, expiry.charge, expiry.deadOwners], opts);
}
