/**
 * Eval-only candidate pool depth (System One recall experiment). Production
 * caps every retrieval arm at MAX_SEARCH_LIMIT (100) and derives the per-arm
 * pool from the request limit. `gbrain eval longmemeval --eval-pool-depth N`
 * sets a process-wide depth for that run only: every arm fetches at least N
 * candidates and the cap rises to N, so a fused pool of N (at most
 * EVAL_POOL_DEPTH_MAX) is reachable and can be reranked with top_n_in N.
 *
 * Nothing outside eval commands calls setEvalPoolDepth, so production depth is
 * unchanged (pinned by test/eval-pool-depth.test.ts).
 */
import { MAX_SEARCH_LIMIT } from '../engine.ts';

export const EVAL_POOL_DEPTH_MAX = 300;

let depth: number | null = null;

/** Set (or clear with null) the eval pool depth for this process. */
export function setEvalPoolDepth(n: number | null): void {
  if (n !== null && (!Number.isInteger(n) || n < 1 || n > EVAL_POOL_DEPTH_MAX)) {
    throw new Error(`eval pool depth must be an integer from 1 to ${EVAL_POOL_DEPTH_MAX} (got ${n})`);
  }
  depth = n;
}

export function evalPoolDepth(): number | null {
  return depth;
}

/** Per-arm result cap: MAX_SEARCH_LIMIT, raised to the eval pool depth when one is set. */
export function searchLimitCap(): number {
  return Math.max(MAX_SEARCH_LIMIT, depth ?? 0);
}

/** Candidates each retrieval arm fetches before fusion (hybrid/request.ts). */
export function perArmPoolLimit(limit: number, offset: number, floor: number): number {
  return Math.min(Math.max(limit * 2, floor, offset + limit, depth ?? 0), searchLimitCap());
}
