/**
 * bootstrap.ts — seeded percentile-bootstrap confidence interval over a
 * per-question numeric vector (typically 0/1 correctness). Pure and
 * deterministic (mulberry32 PRNG, fixed seed), no I/O, dataset-agnostic.
 *
 * INVARIANT: the interval quantifies QUESTION-SAMPLING uncertainty only —
 * "how much would the number move if a different set of questions had been
 * drawn from the same distribution". It says nothing about reader/judge
 * nondeterminism, dataset revision or prompt drift, so every block carries
 * `label: 'question-sampling only'` and a receipt reader cannot mistake it
 * for a run-to-run interval (plan D8/D17).
 */

export interface BootstrapCi {
  /** Point estimate (mean of `xs`); null on an empty vector. */
  mean: number | null;
  lower: number | null;
  upper: number | null;
  n: number;
  resamples: number;
  seed: number;
  /** Two-sided confidence level, e.g. 0.95. */
  confidence: number;
  method: 'percentile';
  label: 'question-sampling only';
}

export interface BootstrapOpts {
  /** Default 10,000 (the eval-compare discipline). */
  resamples?: number;
  /** Default 42 — fixed so a receipt is byte-reproducible. */
  seed?: number;
  /** Default 0.05 → 95% interval. */
  alpha?: number;
}

/** mulberry32 — small, fast, seedable 32-bit PRNG (uniform in [0, 1)). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap of the mean. Resamples `xs` with replacement
 * `resamples` times, sorts the resample means, and reads the alpha/2 and
 * 1-alpha/2 quantiles. n = 0 → nulls; n = 1 → a degenerate [x, x] interval.
 */
export function bootstrapMeanCi(xs: readonly number[], opts: BootstrapOpts = {}): BootstrapCi {
  const resamples = opts.resamples ?? 10_000;
  const seed = opts.seed ?? 42;
  const alpha = opts.alpha ?? 0.05;
  const n = xs.length;
  const base: Omit<BootstrapCi, 'mean' | 'lower' | 'upper'> = {
    n, resamples, seed, confidence: 1 - alpha, method: 'percentile', label: 'question-sampling only',
  };
  if (n === 0) return { mean: null, lower: null, upper: null, ...base };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, lower: mean, upper: mean, ...base };
  const rand = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += xs[Math.floor(rand() * n)];
    means[r] = sum / n;
  }
  means.sort();
  const lo = Math.min(resamples - 1, Math.max(0, Math.floor((alpha / 2) * resamples)));
  const hi = Math.min(resamples - 1, Math.max(0, Math.ceil((1 - alpha / 2) * resamples) - 1));
  return { mean, lower: means[lo], upper: means[hi], ...base };
}
