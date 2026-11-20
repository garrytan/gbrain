/**
 * Managed-worktree admission statements: one SQL implementation for both SQL engines (the Rust store answers the same
 * members from its own keyspace, rust/crates/gbrain-store/src/persistence/worktree_admission.rs).
 *
 * These are the statements `src/core/persistence/journal.ts` (assertWorktreeAdmission, assertWorktreeNotRefreshing,
 * deferralRoom, heldBehindImport) and `refresh-retry-hint.ts` sent through `executeRaw`. The text is unchanged, written
 * out as static strings (the refresh schema constants spelled in place; test/persistence-admission-sql.test.ts pins
 * them to persistence/worktree-refresh-schema.ts) so this module imports no persistence code.
 * Decisions (whether the write is admitted, deferred or refused, and what a refusal says) stay with the callers.
 */
/**
 * The engine's own executeRaw (inside the admission transaction, the transaction engine's), as journal.ts sent these
 * statements: a statement fault a test injects and the statement-deadline wrapper still reach them.
 */
export interface AdmissionRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** The active refresh of a worktree, as admission reads it. */
export interface ActiveRefresh { id: string; state: string; source_ids: string[] }
/** What admission reads about a worktree: its row (null when missing), its active refresh and whether the source is bound to it. */
export interface WorktreeAdmission { worktree: { state: string; owner_epoch: string } | null; refresh: ActiveRefresh | null; bound: boolean }
/** The source binding a write was resolved against. */
export interface WorktreeAdmissionKey { worktreeId: string; sourceId: string; sourceIncarnation: string; topologyGeneration: number | string | null | undefined }

/** Share-locks the worktree row (the refresh fence insert holds it FOR UPDATE). */
export const WORKTREE_SHARE_SQL = 'SELECT state,owner_epoch::text AS owner_epoch FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE';
/**
 * The worktree's active refresh (states `ACTIVE_REFRESH_STATES_SQL`) and whether the source binding holds; the barrier
 * variant locks the refresh (protocol.ts lock order). Static text, so the statement carries its own `$n`.
 */
export const WORKTREE_FENCE_SQL = `SELECT
      (SELECT row_to_json(f) FROM (SELECT id,state,source_ids FROM persistence_worktree_refreshes
        WHERE worktree_id=$3::uuid AND state IN ('draining','fenced','merged','syncing','recovery_required') LIMIT 1) f) AS refresh,
      EXISTS (SELECT 1 FROM persistence_source_bindings WHERE source_id=$1
        AND source_incarnation=$2::uuid AND worktree_id=$3::uuid AND topology_generation=$4) AS bound`;
export const WORKTREE_FENCE_LOCKED_SQL = `SELECT
      (SELECT row_to_json(f) FROM (SELECT id,state,source_ids FROM persistence_worktree_refreshes
        WHERE worktree_id=$3::uuid AND state IN ('draining','fenced','merged','syncing','recovery_required') LIMIT 1 FOR NO KEY UPDATE) f) AS refresh,
      EXISTS (SELECT 1 FROM persistence_source_bindings WHERE source_id=$1
        AND source_incarnation=$2::uuid AND worktree_id=$3::uuid AND topology_generation=$4) AS bound`;

/**
 * `readWorktreeAdmission`: the worktree row under a share lock, then its active refresh and the binding, sent back to
 * back on the transaction's connection so the server takes the share lock before it reads the fence and the binding.
 * Must run inside the admission transaction.
 */
export async function readWorktreeAdmission(exec: AdmissionRead, key: WorktreeAdmissionKey, opts: { lockRefresh?: boolean } = {}): Promise<WorktreeAdmission> {
  const calls = [
    () => exec.executeRaw<{ state: string; owner_epoch: string }>(WORKTREE_SHARE_SQL, [key.worktreeId]),
    () => exec.executeRaw<{ refresh: ActiveRefresh | string | null; bound: boolean }>(opts.lockRefresh ? WORKTREE_FENCE_LOCKED_SQL : WORKTREE_FENCE_SQL,
      [key.sourceId, key.sourceIncarnation, key.worktreeId, key.topologyGeneration]),
  ] as const;
  const [[worktree], [state]] = await pipelinedPair(exec, calls) as [
    Array<{ state: string; owner_epoch: string }>, Array<{ refresh: ActiveRefresh | string | null; bound: boolean }>];
  const refresh = typeof state?.refresh === 'string' ? JSON.parse(state.refresh) as ActiveRefresh : state?.refresh ?? null;
  return { worktree: worktree ? { state: worktree.state, owner_epoch: String(worktree.owner_epoch) } : null, refresh, bound: !!state?.bound };
}

/**
 * Postgres sends both statements before it waits (page-state/transactions.ts `pipelined`, written out here so this module
 * imports no page-state code); another engine runs them in order.
 */
async function pipelinedPair(exec: AdmissionRead, calls: ReadonlyArray<() => Promise<unknown[]>>): Promise<unknown[][]> {
  if ((exec as { kind?: unknown }).kind !== 'postgres') {
    const results: unknown[][] = [];
    for (const call of calls) results.push(await call());
    return results;
  }
  const settled = await Promise.allSettled(calls.map(call => { try { return call(); } catch (error) { return Promise.reject(error); } }));
  // A statement sent after the one that failed reports 25P02 (transaction aborted); the cause is the other one.
  const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  const failed = rejected.find(s => (s.reason as { code?: unknown } | null)?.code !== '25P02') ?? rejected[0];
  if (failed) throw failed.reason;
  return settled.map(s => (s as PromiseFulfilledResult<unknown[]>).value);
}

/** A `syncing` refresh whose member sources all reached its target head is completed (a later cycle converges a crashed refresh). */
export const COMPLETE_SYNCED_REFRESH_SQL = `UPDATE persistence_worktree_refreshes f SET state='completed',completed_at=now(),updated_at=now()
      WHERE f.id=$1::uuid AND f.state='syncing' AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id=ANY(f.source_ids)
        AND s.last_commit IS DISTINCT FROM f.target_head) RETURNING f.id`;
/** `completeSyncedRefresh(refreshId)`: true when the refresh was `syncing` with every member at its target and is now completed. */
export async function completeSyncedRefresh(exec: AdmissionRead, refreshId: string): Promise<boolean> {
  return (await exec.executeRaw(COMPLETE_SYNCED_REFRESH_SQL, [refreshId])).length > 0;
}

/** Whether a live consumer on the worktree's owner host lacks `capability`. */
export const DEFERRAL_ROOM_SQL = `SELECT
    EXISTS (SELECT 1 FROM persistence_consumers c JOIN persistence_worktrees w ON w.owner_host_id=c.host_id WHERE w.id=$1::uuid
      AND c.renewed_at>now()-($2::integer*interval '1 millisecond') AND NOT ($3=ANY(c.capabilities))) AS incapable`;
/** `hasDeferralRoom(worktreeId, capability, liveMs)`: every consumer renewed within `liveMs` on the worktree's owner host advertises `capability`. */
export async function hasDeferralRoom(exec: AdmissionRead, worktreeId: string, capability: string, liveMs: number): Promise<boolean> {
  const [row] = await exec.executeRaw<{ incapable: boolean }>(DEFERRAL_ROOM_SQL, [worktreeId, liveMs, capability]);
  return !!row && !row.incapable;
}

/** How long refresh `id` has run, and the median duration of its worktree's last 10 completed refreshes that kept no refusal. */
export const REFRESH_TIMING_SQL = `SELECT
    (EXTRACT(EPOCH FROM now()-f.created_at)*1000)::bigint AS elapsed_ms,
    (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY d.ms))::bigint FROM (SELECT EXTRACT(EPOCH FROM p.completed_at-p.created_at)*1000 AS ms
      FROM persistence_worktree_refreshes p WHERE p.worktree_id=f.worktree_id AND p.state='completed' AND p.completed_at IS NOT NULL AND p.outcome->'refusal' IS NULL
      ORDER BY p.completed_at DESC LIMIT 10) d) AS typical_ms
    FROM persistence_worktree_refreshes f WHERE f.id=$1::uuid`;
/** A refresh's running time and its worktree's typical refresh duration, in milliseconds (each null when unknown). */
export interface RefreshTiming { elapsed_ms: number | null; typical_ms: number | null }
/** `readRefreshTiming(refreshId)`: null when the refresh does not exist. */
export async function readRefreshTiming(exec: AdmissionRead, refreshId: string): Promise<RefreshTiming | null> {
  const [row] = await exec.executeRaw<{ elapsed_ms: number | string | null; typical_ms: number | string | null }>(REFRESH_TIMING_SQL, [refreshId]);
  if (!row) return null;
  return { elapsed_ms: row.elapsed_ms == null ? null : Number(row.elapsed_ms), typical_ms: row.typical_ms == null ? null : Number(row.typical_ms) };
}

/**
 * The writes of one principal (every principal when none is given) that wait in `deferred` on a source's managed sync:
 * held for its import, or deferred behind an unreleased refresh the source is a member of. The `NOT (…)` term is
 * `RELEASED_DEFERRED('r')` (persistence/worktree-refresh-schema.ts), written out so the statement is static text.
 */
export const HELD_BEHIND_IMPORT_SQL = `SELECT count(*) AS count,COALESCE(sum(r.intent_bytes),0) AS bytes
    FROM persistence_requests r WHERE r.state='deferred' AND NOT (r.state='deferred' AND (r.deferred_refresh_id IS NOT NULL OR r.deferred_import_from IS NOT NULL)
        AND (r.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=r.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (r.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=r.source_id AND COALESCE(imported.last_commit,'')<>r.deferred_import_from))) AND ((r.deferred_import_from IS NOT NULL AND r.source_id=$1)
      OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.id=r.deferred_refresh_id AND f.released_at IS NULL AND $1=ANY(f.source_ids)))`;
/** The same count for one principal. */
export const HELD_BEHIND_IMPORT_BY_PRINCIPAL_SQL = `SELECT count(*) AS count,COALESCE(sum(r.intent_bytes),0) AS bytes
    FROM persistence_requests r WHERE r.state='deferred' AND NOT (r.state='deferred' AND (r.deferred_refresh_id IS NOT NULL OR r.deferred_import_from IS NOT NULL)
        AND (r.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=r.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (r.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=r.source_id AND COALESCE(imported.last_commit,'')<>r.deferred_import_from))) AND ((r.deferred_import_from IS NOT NULL AND r.source_id=$1)
      OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.id=r.deferred_refresh_id AND f.released_at IS NULL AND $1=ANY(f.source_ids))) AND r.principal_kind=$2 AND r.principal_id=$3`;
/** `countHeldBehindImport(sourceId, principal)`: how many such writes there are and their intent bytes. */
export async function countHeldBehindImport(exec: AdmissionRead, sourceId: string, principal: { kind: string; id: string } | null): Promise<{ count: number; bytes: number }> {
  const [row] = await exec.executeRaw<{ count: number | string; bytes: number | string }>(principal ? HELD_BEHIND_IMPORT_BY_PRINCIPAL_SQL : HELD_BEHIND_IMPORT_SQL,
    principal ? [sourceId, principal.kind, principal.id] : [sourceId]);
  return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
}
