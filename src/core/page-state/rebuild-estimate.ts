import type { BrainEngine } from '../engine.ts';

/**
 * Measured Markdown rebuild throughput of the same drain (no embedding): 2,000
 * queued notes of about 3 KB, 117 pages/s on PGLite and 87 pages/s on local
 * Postgres 16, same machine and day; the slower, rounded down.
 */
export const TEXT_REBUILD_PAGES_PER_SECOND = 80;

/**
 * #9192: database round trips one queued Markdown page's rebuild makes, fitted from a 50,000-page drain on Postgres 16
 * at a 0.1 ms and a 17.3 ms round trip (85 and 1.6 pages/s): the time behind a remote pooler is round trips, not work.
 */
export const TEXT_REBUILD_ROUND_TRIPS_PER_PAGE = 36;

/** How long a text rebuild of `pages` takes at a measured round trip of `rttMs`, `concurrency` pages at once, in words. */
export function textRebuildDuration(pages: number, rttMs: number, concurrency = 1): string {
  const minutes = Math.max(1, Math.ceil(pages * (1 / TEXT_REBUILD_PAGES_PER_SECOND + TEXT_REBUILD_ROUND_TRIPS_PER_PAGE * rttMs / 1000) / concurrency / 60));
  return minutes >= 120 ? `${Math.round(minutes / 60)} hour(s)` : `${minutes} minute(s)`;
}

/**
 * #9192: pages `gbrain projections drain` rebuilds at once. PGLite has one connection, so 1. On Postgres the ceiling
 * leaves two of the pool's connections free, and the default is at most 4 so a drain cannot take a small hosted
 * database's connections from a running server; `--concurrency` raises it to the ceiling.
 */
export const DEFAULT_DRAIN_CONCURRENCY = 4;
export function drainConcurrency(engine: Pick<BrainEngine, 'kind'>): { default: number; max: number } {
  if (engine.kind !== 'postgres') return { default: 1, max: 1 };
  const poolMax = (engine as { sql?: { options?: { max?: unknown } } }).sql?.options?.max;
  const max = Math.max(1, (typeof poolMax === 'number' && Number.isSafeInteger(poolMax) ? poolMax : 10) - 2);
  return { default: Math.min(DEFAULT_DRAIN_CONCURRENCY, max), max };
}

/** The median of five `SELECT 1` round trips to the engine, in milliseconds. */
export async function measuredRoundTripMs(engine: Pick<BrainEngine, 'executeRaw'>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    await engine.executeRaw('SELECT 1');
    samples.push(performance.now() - started);
  }
  return Math.round(samples.sort((a, b) => a - b)[2]! * 10) / 10;
}
