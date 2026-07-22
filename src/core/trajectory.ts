/**
 * v0.35.4 — trajectory derived metrics.
 *
 * Pure functions over `TrajectoryPoint[]` (engine output). Both the
 * `find_trajectory` MCP op and the `gbrain eval trajectory` CLI consume
 * this module so the regression + drift_score definitions stay in one
 * place.
 *
 * Locked specs from the plan:
 *
 *   - Regression detection (D-ENG-2): a regression fires for every
 *     consecutive (metric, value) pair where the newer value is at least
 *     10% lower than the prior value. Threshold is configurable via the
 *     env var `GBRAIN_TRAJECTORY_REGRESSION_THRESHOLD` (default 0.10).
 *     Only points with `claim_value !== null` participate.
 *
 *   - Drift score (D-ENG-3): `1 - mean(cosine(emb[i], emb[i-1]))` over
 *     points with non-null embeddings. Clamped to [0, 1]. Returns null
 *     when fewer than 3 points have embeddings (graceful degradation
 *     for pre-v0.35.4 facts that arrived without one).
 */

import type { TrajectoryPoint } from './engine.ts';

/** Default regression threshold (10% drop). Locked decision D-ENG-2. */
export const DEFAULT_REGRESSION_THRESHOLD = 0.10;

/** Schema version for the trajectory + scorecard JSON contract. Additive-only across releases. */
export const TRAJECTORY_SCHEMA_VERSION = 1;

export interface TrajectoryRegression {
  metric: string;
  from_value: number;
  from_date: string;   // YYYY-MM-DD
  to_value: number;
  to_date: string;
  delta_pct: number;   // negative for a drop; range typically [-1, 0)
}

export interface TrajectoryStats {
  regressions: TrajectoryRegression[];
  drift_score: number | null;
}

/**
 * Read the regression threshold from `GBRAIN_TRAJECTORY_REGRESSION_THRESHOLD`
 * with fallback to the locked default. Invalid input falls back silently —
 * the threshold is a soft tuning knob, not a correctness gate.
 */
export function resolveRegressionThreshold(): number {
  const raw = process.env.GBRAIN_TRAJECTORY_REGRESSION_THRESHOLD;
  if (!raw) return DEFAULT_REGRESSION_THRESHOLD;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return DEFAULT_REGRESSION_THRESHOLD;
  return n;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute cosine similarity between two equal-length vectors. Returns 0
 * when either vector has length zero (defensive — never throws).
 */
function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Detect chronological regressions in a sorted trajectory.
 *
 * Iterates per-metric (so trajectories that interleave mrr + arr + team_size
 * don't trip false regressions across metric boundaries). Within each metric,
 * walks consecutive value pairs; a pair fires when
 * `(newer - older) / older <= -threshold`.
 *
 * Pre-condition: caller passed points sorted by (valid_from ASC, fact_id ASC).
 * The engine's `findTrajectory` enforces this. No re-sort here.
 */
export function detectRegressions(
  points: TrajectoryPoint[],
  threshold: number = DEFAULT_REGRESSION_THRESHOLD,
): TrajectoryRegression[] {
  const out: TrajectoryRegression[] = [];
  // Group by metric so each metric's regression detection is independent.
  const byMetric = new Map<string, TrajectoryPoint[]>();
  for (const p of points) {
    if (p.metric === null || p.value === null) continue;
    if (!Number.isFinite(p.value)) continue;
    if (!byMetric.has(p.metric)) byMetric.set(p.metric, []);
    byMetric.get(p.metric)!.push(p);
  }

  for (const [metric, series] of byMetric) {
    for (let i = 1; i < series.length; i++) {
      const older = series[i - 1];
      const newer = series[i];
      const oldVal = older.value!;
      const newVal = newer.value!;
      // Guard against division-by-zero: a metric starting at exactly 0
      // can't compute a relative delta. Skip.
      if (oldVal === 0) continue;
      const delta = (newVal - oldVal) / oldVal;
      if (delta <= -threshold) {
        out.push({
          metric,
          from_value: oldVal,
          from_date: toISODate(older.valid_from),
          to_value: newVal,
          to_date: toISODate(newer.valid_from),
          delta_pct: delta,
        });
      }
    }
  }
  return out;
}

/**
 * Compute drift score over the trajectory's existing embeddings.
 *
 * `1 - mean(cosine(emb[i], emb[i-1]))` clamped to [0, 1]. Range
 * interpretation: 0 = narrative stable text-wise; 1 = every consecutive
 * claim is unrelated to the prior.
 *
 * Returns null when fewer than 3 points have non-null embeddings — the
 * statistic is meaningless on tiny samples.
 */
export function computeDriftScore(points: TrajectoryPoint[]): number | null {
  const withEmb = points.filter(p => p.embedding !== null && p.embedding.length > 0);
  if (withEmb.length < 3) return null;
  let sumCos = 0;
  let pairs = 0;
  for (let i = 1; i < withEmb.length; i++) {
    sumCos += cosineSim(withEmb[i - 1].embedding!, withEmb[i].embedding!);
    pairs += 1;
  }
  if (pairs === 0) return null;
  const meanCos = sumCos / pairs;
  const drift = 1 - meanCos;
  if (drift < 0) return 0;
  if (drift > 1) return 1;
  return drift;
}

/**
 * Compose the two derived metrics into a single TrajectoryStats. The MCP
 * op + CLI both call this so the JSON shape stays consistent.
 */
export function computeTrajectoryStats(
  points: TrajectoryPoint[],
  opts: { threshold?: number } = {},
): TrajectoryStats {
  const threshold = opts.threshold ?? resolveRegressionThreshold();
  return {
    regressions: detectRegressions(points, threshold),
    drift_score: computeDriftScore(points),
  };
}
