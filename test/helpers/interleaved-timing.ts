/**
 * Shape-ratio perf guards time a slow shape against a fast one. Timed in two
 * blocks, the fast block is only a few milliseconds long, so one short stall
 * (a GC pause, CPU steal on a shared runner) covers every one of its samples
 * and the median moves with it, while the slow block loses at most one sample.
 * Alternating the shapes leaves a stall that short on one sample of each.
 */
export function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export async function interleavedMedians(runs: number, first: () => Promise<number>, second: () => Promise<number>): Promise<{ first: number; second: number }> {
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < runs; i++) {
    a.push(await first());
    b.push(await second());
  }
  return { first: median(a), second: median(b) };
}
