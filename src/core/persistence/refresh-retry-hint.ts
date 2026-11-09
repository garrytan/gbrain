/**
 * GST-1582: when a write or managed sync refused by an active `gbrain sources refresh` (`worktree_refreshing`) should
 * retry, from the refresh's actual state instead of a fixed second. A refresh tick takes minutes, so a fixed 1 s hint
 * sent an obedient caller back into the same tick to be refused again. The estimate is the median duration of the
 * worktree's last completed refreshes minus how long this one has run, never below its phase's floor: a refresh with no
 * history, or already past its typical duration, is retried in floor-sized steps. A refresh that stopped in
 * recovery_required (its outcome keeps the refusal) is left out, since its duration includes the wait for an operator.
 */
import type { SqlEngine } from './model.ts';

const PHASE_FLOOR_MS: Record<string, number> = { draining: 2_000, fenced: 2_000, merged: 2_000, syncing: 15_000 };
const MAX_RETRY_AFTER_MS = 10 * 60_000;
const HISTORY = 10;

export interface RefreshRetryHint { retryAfterMs: number; phase: string; elapsedMs: number | null; typicalMs: number | null }

export async function refreshRetryHint(engine: SqlEngine, refresh: { id: string; state: string }): Promise<RefreshRetryHint> {
  const [row] = await engine.executeRaw<{ elapsed_ms: number | string | null; typical_ms: number | string | null }>(`SELECT
    (EXTRACT(EPOCH FROM now()-f.created_at)*1000)::bigint AS elapsed_ms,
    (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY d.ms))::bigint FROM (SELECT EXTRACT(EPOCH FROM p.completed_at-p.created_at)*1000 AS ms
      FROM persistence_worktree_refreshes p WHERE p.worktree_id=f.worktree_id AND p.state='completed' AND p.completed_at IS NOT NULL AND p.outcome->'refusal' IS NULL
      ORDER BY p.completed_at DESC LIMIT ${HISTORY}) d) AS typical_ms
    FROM persistence_worktree_refreshes f WHERE f.id=$1::uuid`, [refresh.id]).catch(() => []);
  const elapsedMs = row?.elapsed_ms == null ? null : Number(row.elapsed_ms);
  const typicalMs = row?.typical_ms == null ? null : Number(row.typical_ms);
  const floor = PHASE_FLOOR_MS[refresh.state] ?? PHASE_FLOOR_MS.syncing!;
  const left = typicalMs !== null && elapsedMs !== null ? typicalMs - elapsedMs : 0;
  return { retryAfterMs: Math.min(MAX_RETRY_AFTER_MS, Math.max(floor, Math.round(left))), phase: refresh.state, elapsedMs, typicalMs };
}

/** The refresh's progress for a refusal message: `syncing, running 20 s, typically 220 s`. */
export function refreshProgress(hint: RefreshRetryHint): string {
  return [hint.phase, ...(hint.elapsedMs !== null ? [`running ${seconds(hint.elapsedMs)} s`] : []),
    ...(hint.typicalMs !== null ? [`typically ${seconds(hint.typicalMs)} s`] : [])].join(', ');
}

export const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));
