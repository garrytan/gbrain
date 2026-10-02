/**
 * #5809 / #5832 on real Postgres: the drain's hard stop cancels a blocked
 * backlog count server-side and releases the cycle lock, and a lease taken
 * over mid-batch comes back as `stopped: 'lock_lost'` through the real lock
 * helper. PGLite cannot show either (no server-side cancel, one connection).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { withRefreshingLock } from '../../src/core/db-lock.ts';
import { runExtractAtomsDrain } from '../../src/core/cycle/extract-atoms-drain.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('extract_atoms drain stops on Postgres', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    engine = new PostgresEngine();
    await engine.connect({ database_url: url, poolSize: 4 });
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  const sleepers = async () => Number((await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE state = 'active' AND pid <> pg_backend_pid() AND query LIKE 'SELECT pg_sleep(30)%'`,
  ))[0].n);

  test('a job abort during a blocked final recount cancels the query and releases the cycle lock', async () => {
    const lockId = 'gbrain-cycle:e2e-drain-bound';
    const job = new AbortController();
    let calls = 0;
    const started = Date.now();
    const result = await runExtractAtomsDrain(
      {
        withLock: (work) => withRefreshingLock(engine, lockId, (signal) => work(signal), { ttlMinutes: 5 }),
        countRemaining: async (signal) => {
          calls++;
          if (calls === 1) return 9;
          setTimeout(() => job.abort(new Error('timeout')), 300);
          await engine.executeRaw('SELECT pg_sleep(30)', [], { signal });
          return 0;
        },
        runBatch: async () => ({ extracted: 1, skipped: 0 }),
        now: Date.now,
      },
      { windowMs: 1_000_000, maxBatches: 1, signal: job.signal },
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ stopped: 'aborted', remaining: 9, batches: 1, extracted: 1 });
    expect(await engine.executeRaw('SELECT id FROM gbrain_cycle_locks WHERE id = $1', [lockId])).toEqual([]);
    let left = await sleepers();
    for (let i = 0; i < 30 && left > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      left = await sleepers();
    }
    expect(left).toBe(0);
  }, 30_000);

  test('a lease taken over mid-batch returns lock_lost with the partial counters', async () => {
    const lockId = 'gbrain-cycle:e2e-drain-lease';
    let reason: unknown = null;
    try {
      const result = await runExtractAtomsDrain(
        {
          withLock: (work) => withRefreshingLock(engine, lockId, (signal) => work(signal), { ttlMinutes: 0.02, refreshIntervalMs: 100 }),
          countRemaining: async () => 6,
          runBatch: async ({ signal }) => {
            await engine.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token = gen_random_uuid() WHERE id = $1', [lockId]);
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            reason = signal.reason;
            return { extracted: 2, skipped: 0 };
          },
          now: Date.now,
        },
        { windowMs: 1_000_000 },
      );
      expect(result).toMatchObject({ stopped: 'lock_lost', batches: 1, extracted: 2, remaining: 6 });
      expect((reason as Error).name).toBe('LockStolenError');
    } finally {
      await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id = $1', [lockId]);
    }
  }, 30_000);
});
