/**
 * Paired, clustered comparison statistics for per-query eval rows.
 *
 * Ported from the gbrain-evals situation-recall comparator
 * (`eval/runner/situation-recall-regression.ts`: cluster bootstrap,
 * sign-swap randomization test, Holm step-down) so a before/after receipt
 * computed here and one computed there mean the same thing. Differences:
 * this port is mean-aggregation only and its p-value is two-sided (eval
 * compare asks "do these differ?", not "did the candidate improve?").
 *
 *   pairs (cluster, baseline, candidate)
 *     ├── delta      = mean(candidate) − mean(baseline) over all pairs
 *     ├── 95% CI     = percentile interval of `draws` cluster-bootstrap
 *     │                resamples (whole clusters drawn with replacement)
 *     └── p_value    = sign-flip randomization over clusters: exact
 *                      enumeration at ≤16 clusters, else `draws` Monte
 *                      Carlo flips with the (k+1)/(n+1) correction
 *
 * Deterministic: a seeded mulberry32 generator drives every draw.
 */

export interface PairedObservation {
  cluster: string;
  baseline: number;
  candidate: number;
}

export interface PairedStatistics {
  n: number;
  clusters: number;
  baseline_mean: number;
  candidate_mean: number;
  delta: number;
  lower95: number;
  upper95: number;
  p_value: number;
  /** Pairs where the candidate scored higher / lower / the same. */
  wins: number;
  losses: number;
  ties: number;
}

/** mulberry32 — the same generator the gbrain-evals comparator uses. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function pairedClusterStatistics(pairs: PairedObservation[], opts: { seed: number; draws: number }): PairedStatistics {
  if (!pairs.length) throw new Error('paired statistics need at least one pair');
  if (!Number.isInteger(opts.draws) || opts.draws < 1000) throw new Error('paired statistics need at least 1000 draws');
  if (!pairs.every(p => Number.isFinite(p.baseline) && Number.isFinite(p.candidate))) throw new Error('paired observations must be finite');

  const n = pairs.length;
  const baselineMean = pairs.reduce((s, p) => s + p.baseline, 0) / n;
  const candidateMean = pairs.reduce((s, p) => s + p.candidate, 0) / n;
  const delta = candidateMean - baselineMean;
  const wins = pairs.filter(p => p.candidate > p.baseline).length;
  const losses = pairs.filter(p => p.candidate < p.baseline).length;
  const byCluster = new Map<string, { sum: number; count: number }>();
  for (const p of pairs) {
    const c = byCluster.get(p.cluster) ?? { sum: 0, count: 0 };
    c.sum += p.candidate - p.baseline;
    c.count++;
    byCluster.set(p.cluster, c);
  }
  const clusters = [...byCluster.keys()].sort().map(k => byCluster.get(k)!);
  const base = { n, clusters: clusters.length, baseline_mean: baselineMean, candidate_mean: candidateMean, delta, wins, losses, ties: n - wins - losses };

  if (wins + losses === 0) return { ...base, lower95: 0, upper95: 0, p_value: 1 };
  if (clusters.length < 2) return { ...base, lower95: -Infinity, upper95: Infinity, p_value: 1 };

  const rng = seededRandom(opts.seed);
  const boot = new Float64Array(opts.draws);
  for (let i = 0; i < opts.draws; i++) {
    let sum = 0, count = 0;
    for (let j = 0; j < clusters.length; j++) {
      const c = clusters[Math.floor(rng() * clusters.length)];
      sum += c.sum;
      count += c.count;
    }
    boot[i] = sum / count;
  }
  boot.sort();

  const exact = clusters.length <= 16;
  const flips = exact ? 2 ** clusters.length : opts.draws;
  const observed = Math.abs(delta) - 1e-12;
  let extreme = 0;
  for (let i = 0; i < flips; i++) {
    let sum = 0;
    for (let j = 0; j < clusters.length; j++) {
      const flip = exact ? ((i >>> j) & 1) === 1 : rng() < 0.5;
      sum += flip ? -clusters[j].sum : clusters[j].sum;
    }
    if (Math.abs(sum / n) >= observed) extreme++;
  }
  return {
    ...base,
    lower95: boot[Math.floor(opts.draws * 0.025)],
    upper95: boot[Math.ceil(opts.draws * 0.975) - 1],
    p_value: exact ? extreme / flips : (extreme + 1) / (flips + 1),
  };
}

/** Holm step-down adjustment across one family of comparisons. */
export function holmAdjusted(pValues: number[]): number[] {
  if (!pValues.every(p => Number.isFinite(p) && p >= 0 && p <= 1)) throw new Error('invalid Holm p-value');
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(pValues.length);
  let previous = 0;
  order.forEach(({ p, index }, rank) => {
    previous = Math.max(previous, Math.min(1, p * (order.length - rank)));
    adjusted[index] = previous;
  });
  return adjusted;
}
