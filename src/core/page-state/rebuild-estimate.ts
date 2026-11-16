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

/** How long a text rebuild of `pages` takes at a measured round trip of `rttMs`, in words. */
export function textRebuildDuration(pages: number, rttMs: number): string {
  const minutes = Math.max(1, Math.ceil(pages * (1 / TEXT_REBUILD_PAGES_PER_SECOND + TEXT_REBUILD_ROUND_TRIPS_PER_PAGE * rttMs / 1000) / 60));
  return minutes >= 120 ? `${Math.round(minutes / 60)} hour(s)` : `${minutes} minute(s)`;
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
