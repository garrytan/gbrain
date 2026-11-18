/** Latency summaries in the gbrain-bakeoff-result/1 shape. */

export interface Metric {
  n: number;
  p50_ms: number;
  p99_ms: number;
  ops_per_s: number;
  [extra: string]: unknown;
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

const round = (x: number, digits = 4) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : null);

/** `latenciesMs`: one entry per completed operation. `wallMs`: elapsed time of the whole loop. */
export function summarize(latenciesMs: number[], wallMs: number, extra: Record<string, unknown> = {}): Metric {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50_ms: round(percentile(sorted, 50)) as number,
    p99_ms: round(percentile(sorted, 99)) as number,
    ops_per_s: round(wallMs > 0 ? (sorted.length / wallMs) * 1000 : NaN, 2) as number,
    ...extra,
  };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor((s.length - 1) / 2)]!;
}

/** Deterministic PRNG (mulberry32) so two engines see the same operation sequence. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const nowMs = () => performance.now();
export const r2 = (x: number) => Math.round(x * 100) / 100;
