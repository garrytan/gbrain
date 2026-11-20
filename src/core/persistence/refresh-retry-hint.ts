/**
 * GST-1582: when a write or managed sync refused by an active `gbrain sources refresh` (`worktree_refreshing`) should
 * retry, from the refresh's actual state instead of a fixed second. A refresh tick takes minutes, so a fixed 1 s hint
 * sent an obedient caller back into the same tick to be refused again. The estimate is the median duration of the
 * worktree's last completed refreshes minus how long this one has run, never below its phase's floor: a refresh with no
 * history, or already past its typical duration, is retried in floor-sized steps. A refresh that stopped in
 * recovery_required (its outcome keeps the refusal) is left out, since its duration includes the wait for an operator.
 */
import type { BrainEngine } from '../engine.ts';

const PHASE_FLOOR_MS: Record<string, number> = { draining: 2_000, fenced: 2_000, merged: 2_000, syncing: 15_000 };
const MAX_RETRY_AFTER_MS = 10 * 60_000;

export interface RefreshRetryHint { retryAfterMs: number; phase: string; elapsedMs: number | null; typicalMs: number | null }

export async function refreshRetryHint(engine: Pick<BrainEngine, 'readRefreshTiming'>, refresh: { id: string; state: string }): Promise<RefreshRetryHint> {
  const timing = await engine.readRefreshTiming(refresh.id).catch(() => null);
  const elapsedMs = timing?.elapsed_ms ?? null;
  const typicalMs = timing?.typical_ms ?? null;
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
