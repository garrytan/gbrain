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
 *     consecutive comparable pair (same metric, unit and period, strictly
 *     later; see comparablePairs) where the newer value is at least
 *     10% lower than the prior value. Threshold is configurable via the
 *     env var `GBRAIN_TRAJECTORY_REGRESSION_THRESHOLD` (default 0.10).
 *     Only points with `claim_value !== null` participate. A lower-is-better
 *     metric (the LOWER_IS_BETTER constant / isLowerIsBetter) flips it: a rise of at
 *     least the threshold is the regression and a drop is an improvement.
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

/**
 * The lower-is-better rule, in one place: for these metrics a rise is the regression and a drop is an improvement.
 * `metrics` are exact names; `words` make any metric lower-is-better when one of its parts is that whole word
 * (`lossless`, `costco`, `debtor` do not match); `exceptWords` take that back for a name that also holds one of
 * them, because it counts the good thing (`cost_savings`, `revenue_loss_recovered`) or a ratio that is higher-is-better
 * (`debt_service_coverage_ratio`), which is good news going up.
 * Change the list here and nowhere else.
 */
export const LOWER_IS_BETTER = {
  metrics: ['burn_rate', 'churn_rate', 'cac', 'burn', 'churn'],
  words: ['cost', 'costs', 'expense', 'expenses', 'loss', 'losses', 'latency', 'payback', 'debt', 'debts'],
  exceptWords: ['saving', 'savings', 'saved', 'recovered', 'recovery', 'reduction', 'reduced', 'avoided', 'coverage', 'ratio', 'ratios'],
} as const;

/**
 * True when a lower value of this metric is the good direction. The name is split on every run of
 * non-alphanumeric characters (`_`, `-`, spaces, ...) and each part lowercased; it matches when the
 * parts joined with `_` equal a LOWER_IS_BETTER.metrics name, or when any one part is a LOWER_IS_BETTER.words
 * word and no part is a LOWER_IS_BETTER.exceptWords word. Only whole parts count, never substrings.
 * A `ratio` part excepts the name: which way a ratio should move depends on what is on each side of it
 * (`benefit_cost_ratio` is better when higher), so it keeps the ordinary rule.
 */
export function isLowerIsBetter(metric: string): boolean {
  const parts = metric.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return false;
  const metrics: readonly string[] = LOWER_IS_BETTER.metrics;
  const words: readonly string[] = LOWER_IS_BETTER.words;
  const exceptWords: readonly string[] = LOWER_IS_BETTER.exceptWords;
  if (metrics.includes(parts.join('_'))) return true;
  return parts.some(p => words.includes(p)) && !parts.some(p => exceptWords.includes(p));
}

export interface TrajectoryRegression {
  metric: string;
  from_value: number;
  from_date: string;   // YYYY-MM-DD
  to_value: number;
  to_date: string;
  /**
   * Relative change over abs(from_value): negative for a drop, positive for a rise; may be < -1 across zero.
   * For a lower-is-better series whose first non-zero value is negative it is the change in magnitude, for every
   * pair of the series (-50000 -> -100000 is +1; -50000 -> 100000 is -3; 100000 -> -50000 is +1.5).
   */
  delta_pct: number;
  /**
   * Which way the metric moved: 'down' for a regression on an ordinary metric, 'up' for one on a
   * lower-is-better metric. Added within schema_version 1; older readers ignore it.
   */
  direction?: 'down' | 'up';
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

/** The series a point belongs to: same metric, unit and period. */
function seriesKey(p: TrajectoryPoint): string {
  return JSON.stringify([p.metric, p.unit?.trim().toLowerCase() ?? null, p.period?.trim().toLowerCase() ?? null]);
}

/**
 * Consecutive comparable observations, oldest first: the same metric, unit
 * and period (so a monthly figure never pairs with an annual one, nor USD
 * with EUR), the newer strictly later. Values that disagree at one
 * valid_from say nothing certain about that time, so that time is skipped
 * and the chain bridges it; equal ones count once. A point with no valid
 * date is left out.
 *
 * Pre-condition: caller passed points sorted by (valid_from ASC, fact_id ASC).
 * The engine's `findTrajectory` enforces this. No re-sort here.
 */
export function comparablePairs(points: TrajectoryPoint[]): Array<[TrajectoryPoint, TrajectoryPoint]> {
  const series = new Map<string, TrajectoryPoint[]>();
  for (const p of points) {
    if (p.metric === null || p.value === null || !Number.isFinite(p.value) || !Number.isFinite(p.valid_from.getTime())) continue;
    const key = seriesKey(p);
    const s = series.get(key);
    if (s) s.push(p);
    else series.set(key, [p]);
  }
  const pairs: Array<[TrajectoryPoint, TrajectoryPoint]> = [];
  for (const s of series.values()) {
    let prior: TrajectoryPoint | null = null;
    for (let i = 0; i < s.length;) {
      let j = i + 1;
      while (j < s.length && s[j].valid_from.getTime() === s[i].valid_from.getTime()) j++;
      if (s.slice(i, j).every(p => p.value === s[i].value)) {
        if (prior) pairs.push([prior, s[j - 1]]);
        prior = s[j - 1];
      }
      i = j;
    }
  }
  return pairs;
}

/** Float slack for the threshold comparison in detectRegressions. */
const THRESHOLD_EPSILON = 1e-9;

/**
 * Detect chronological regressions in a sorted trajectory: every
 * comparablePairs pair whose newer value is lower than the older one by at
 * least the threshold (higher by at least the threshold for a
 * lower-is-better metric, see isLowerIsBetter). The relative delta uses `abs(older)` as the
 * denominator so negative-valued metrics (net income, cash flow, etc.) do
 * not invert improvement and regression.
 */
export function detectRegressions(
  points: TrajectoryPoint[],
  threshold: number = DEFAULT_REGRESSION_THRESHOLD,
): TrajectoryRegression[] {
  const out: TrajectoryRegression[] = [];
  // The sign convention of a lower-is-better series, fixed once per series from its first non-zero value (pairs
  // come oldest first): a series that starts negative stores outflows as negative numbers.
  const signed = new Map<string, boolean>();
  for (const [older, newer] of comparablePairs(points)) {
    const oldVal = older.value!;
    const newVal = newer.value!;
    const lowerIsBetter = isLowerIsBetter(older.metric!);
    const key = seriesKey(older);
    if (lowerIsBetter && oldVal !== 0 && !signed.has(key)) signed.set(key, oldVal < 0);
    // Guard against division-by-zero: a metric starting at exactly 0
    // can't compute a relative delta. Skip.
    if (oldVal === 0) continue;
    // A lower-is-better series stored as negative outflows (a loss of -50000, a burn of -150) compares by
    // magnitude at every step, so -50000 -> -100000 is a +100% rise, a loss that turns into a profit
    // (-50000 -> 100000) is an improvement, and the return to a loss (100000 -> -50000) is a rise. A series that
    // starts positive uses the plain signed change throughout.
    const magnitude = lowerIsBetter && signed.get(key) === true;
    const delta = (magnitude ? oldVal - newVal : newVal - oldVal) / Math.abs(oldVal);
    // A tiny tolerance keeps a change of exactly the threshold from slipping under it through float
    // rounding ((0.055 - 0.05) / 0.05 is 0.09999999999999995).
    if (lowerIsBetter ? delta >= threshold - THRESHOLD_EPSILON : delta <= -threshold + THRESHOLD_EPSILON) {
      out.push({
        metric: older.metric!,
        from_value: oldVal,
        from_date: toISODate(older.valid_from),
        to_value: newVal,
        to_date: toISODate(newer.valid_from),
        delta_pct: delta,
        direction: lowerIsBetter ? 'up' : 'down',
      });
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
