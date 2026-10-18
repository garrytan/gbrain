/**
 * Linearity bounds over deterministic work counters (`@internal` objects of
 * integer counts the code under test increments in its scanning loops), for
 * tests that would otherwise compare CPU time across input sizes. A count does
 * not depend on the machine, so a co-tenant that slows one size cannot move it.
 */

/** Doubling the input must less than this many times each counter (linear 2, quadratic 4). */
export const MAX_DOUBLING_RATIO = 2.1;

/**
 * A counter needs this many counts at the small size before its doubling ratio
 * is checked; its per-byte bound always applies. Below it a counter visits the
 * bookkeeping of a handful of segments or cuts (a 1 MiB fence is one segment,
 * 2 MiB two), so its ratio reads how many segments each size happens to cut
 * (3 entries against 13), not growth per byte.
 */
export const MIN_RATIO_COUNT = 10_000;

export type Counters = Record<string, Record<string, number>>;
export type Work = Record<string, number>;

/** Zero every counter, run `fn`, and return each count as `group.field`. */
export function countWork(counters: Counters, fn: () => unknown): Work {
  for (const group of Object.values(counters)) for (const k of Object.keys(group)) group[k] = 0;
  fn();
  const work: Work = {};
  for (const [name, group] of Object.entries(counters)) for (const [k, v] of Object.entries(group)) work[`${name}.${k}`] = v;
  return work;
}

/** countWork for an async `fn`: nothing else that counts may run while it is awaited. */
export async function countWorkAsync(counters: Counters, fn: () => Promise<unknown>): Promise<Work> {
  countWork(counters, () => {});
  await fn();
  const work: Work = {};
  for (const [name, group] of Object.entries(counters)) for (const [k, v] of Object.entries(group)) work[`${name}.${k}`] = v;
  return work;
}

export interface Sample { bytes: number; work: Work }

/**
 * Every bound a linear run at `small` and twice the input at `large` breaks:
 * a count above `perByte[key]` times its input bytes, or a count at least
 * MIN_RATIO_COUNT at the small size that grows MAX_DOUBLING_RATIO times or more.
 */
export function linearityViolations(small: Sample, large: Sample, perByte: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [key, limit] of Object.entries(perByte)) {
    for (const [side, s] of [['small', small], ['large', large]] as const) {
      const per = s.work[key]! / s.bytes;
      if (!(per <= limit)) out.push(`${key}: ${per.toFixed(3)} per byte at the ${side} size exceeds ${limit}`);
    }
    const ratio = large.work[key]! / small.work[key]!;
    if (small.work[key]! >= MIN_RATIO_COUNT && !(ratio < MAX_DOUBLING_RATIO)) out.push(`${key}: doubling ratio ${ratio.toFixed(3)} reaches ${MAX_DOUBLING_RATIO}`);
  }
  return out;
}

/** `key: count (per byte)` for each counter, and the doubling ratio, for the test log. */
export function describeWork(small: Sample, large: Sample): string {
  return Object.keys(small.work).map(key => {
    const ratio = small.work[key] ? (large.work[key]! / small.work[key]!).toFixed(3) : '-';
    return `${key} ${small.work[key]}/${large.work[key]} (${(small.work[key]! / small.bytes).toFixed(3)}/B, x${ratio})`;
  }).join(', ');
}

/**
 * Run `fn`, then burn `extra` times its thread CPU time on the same thread: a
 * stand-in for a co-tenant on a sibling vCPU that slows one size's run (CI read
 * 1.06-1.65x). Returns the thread CPU of `fn` and of the whole call, in ms.
 */
export function withCpuInflation(fn: () => unknown, extra: number): { workMs: number; totalMs: number } {
  const start = process.threadCpuUsage();
  const ms = () => {
    const used = process.threadCpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  fn();
  const workMs = ms();
  let spin = 0;
  while (ms() < workMs * (1 + extra)) spin = (spin * 31 + 7) >>> 0;
  return { workMs, totalMs: ms() + (spin & 0) };
}
