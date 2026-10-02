/**
 * Calibration and qualification math (pure).
 *
 * - Threshold search over labelled answers (target precision, recall or F1).
 * - Reliability table and expected calibration error (10 equal-width bins).
 * - Stability: retest_sd (same item re-asked) and repack_sd (re-asked with
 *   resampled co-packed neighbours), each the mean per-item standard deviation.
 * - Qualification: the harmful action's precision over INDEPENDENT FAMILIES
 *   (query, transcript or fact family), after the production action reducer;
 *   Wilson 95% lower bound; `insufficient_n` when even an all-correct result
 *   could not reach the gate (35 of 35 is the minimum at 0.90).
 */

export interface LabelledValue {
  value: number;
  /** True when the item truly satisfies the question (e.g. the candidate IS evidence). */
  label: boolean;
}

export type CalibrationTarget = 'precision' | 'recall' | 'f1';

export interface ThresholdChoice {
  threshold: number;
  metric: CalibrationTarget;
  metric_value: number;
  precision: number;
  recall: number;
  f1: number;
}

function counts(items: readonly LabelledValue[], t: number) {
  let tp = 0, fp = 0, fn = 0;
  for (const it of items) {
    const predicted = it.value >= t;
    if (predicted && it.label) tp++;
    else if (predicted) fp++;
    else if (it.label) fn++;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/**
 * Pick the threshold (`value >= threshold` predicts positive). With `min`,
 * precision/recall targets choose the threshold that meets `min` while
 * maximizing the other side; F1 maximizes F1. Ties take the lower threshold
 * (keeps more, the fail-open direction).
 */
export function searchThreshold(items: readonly LabelledValue[], target: CalibrationTarget = 'f1', min?: number): ThresholdChoice | null {
  if (items.length === 0) return null;
  const candidates = [...new Set(items.map((i) => i.value))].sort((a, b) => a - b);
  let best: ThresholdChoice | null = null;
  for (const t of candidates) {
    const c = counts(items, t);
    const metricValue = c[target];
    if (min !== undefined && metricValue < min) continue;
    const score = min === undefined ? metricValue : target === 'precision' ? c.recall : target === 'recall' ? c.precision : c.f1;
    const bestScore = !best ? -1 : min === undefined ? best.metric_value : target === 'precision' ? best.recall : target === 'recall' ? best.precision : best.f1;
    if (score > bestScore) best = { threshold: t, metric: target, metric_value: metricValue, ...c };
  }
  return best;
}

export interface ReliabilityBin { lo: number; hi: number; n: number; mean_p: number; observed: number }

export function reliability(items: readonly LabelledValue[], bins = 10): { table: ReliabilityBin[]; ece: number } {
  const table: ReliabilityBin[] = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, mean_p: 0, observed: 0 }));
  for (const it of items) {
    const b = table[Math.min(bins - 1, Math.max(0, Math.floor(it.value * bins)))]!;
    b.n++;
    b.mean_p += it.value;
    b.observed += it.label ? 1 : 0;
  }
  let ece = 0;
  for (const b of table) {
    if (b.n === 0) continue;
    b.mean_p /= b.n;
    b.observed /= b.n;
    ece += (b.n / Math.max(1, items.length)) * Math.abs(b.mean_p - b.observed);
  }
  return { table, ece };
}

function sd(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1));
}

/** Mean per-item standard deviation across repeated answers (retest_sd or repack_sd). */
export function meanItemSd(repeats: ReadonlyMap<string, readonly number[]>): number {
  const sds = [...repeats.values()].filter((v) => v.length >= 2).map(sd);
  return sds.length === 0 ? 0 : sds.reduce((a, b) => a + b, 0) / sds.length;
}

/** Wilson score lower bound (95% by default). */
export function wilsonLowerBound(successes: number, n: number, z = 1.959964): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/** Smallest n for which n-of-n correct reaches `minPrecision`. */
export function requiredN(minPrecision: number): number {
  for (let n = 1; n <= 100_000; n++) if (wilsonLowerBound(n, n) >= minPrecision) return n;
  return Infinity;
}

export interface HarmfulAction {
  family: string;
  /** The harmful action was correct (e.g. the pruned candidate truly was not evidence). */
  correct: boolean;
  slice?: string;
}

export interface Qualification {
  action_precision_lb: number | null;
  families: number;
  correct_families: number;
  actions: number;
  status: 'qualified' | 'action_precision_low' | 'insufficient_n';
  required_n: number;
  slices: Record<string, { families: number; correct: number; lb: number }>;
}

/**
 * Family-level action precision: a family counts as correct only when every
 * harmful action in it was correct (conservative; related items are not
 * independent). Gates on the pooled bound; per-slice numbers are advisory.
 */
export function qualifyActions(actions: readonly HarmfulAction[], minPrecision: number): Qualification {
  const byFamily = new Map<string, { correct: boolean; slice?: string }>();
  for (const a of actions) {
    const f = byFamily.get(a.family);
    byFamily.set(a.family, { correct: (f?.correct ?? true) && a.correct, slice: f?.slice ?? a.slice });
  }
  const families = byFamily.size;
  const correct = [...byFamily.values()].filter((f) => f.correct).length;
  const need = requiredN(minPrecision);
  const slices: Qualification['slices'] = {};
  for (const f of byFamily.values()) {
    const key = f.slice ?? 'all';
    const s = (slices[key] ??= { families: 0, correct: 0, lb: 0 });
    s.families++;
    if (f.correct) s.correct++;
  }
  for (const s of Object.values(slices)) s.lb = wilsonLowerBound(s.correct, s.families);
  const lb = families > 0 ? wilsonLowerBound(correct, families) : null;
  const status: Qualification['status'] = families < need ? 'insufficient_n' : (lb ?? 0) >= minPrecision ? 'qualified' : 'action_precision_low';
  return { action_precision_lb: lb, families, correct_families: correct, actions: actions.length, status, required_n: need, slices };
}
