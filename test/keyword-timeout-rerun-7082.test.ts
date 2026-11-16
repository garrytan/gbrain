/**
 * #7082: the keyword timeout skip ends once a serve's background re-run of the same statement succeeds.
 *
 * Contract protected: after a keyword statement hits the statement timeout, foreground searches still skip it
 * (`keyword_arm_failed: skipped_after_timeout`). In a serving process only, the cache re-runs that exact
 * statement in the background 30 s later, then after 60 s, 120 s and so on while each re-run fails, never past
 * the entry's TTL (`search.keyword_timeout_negative_cache_seconds`, still the longest skip). A re-run whose
 * statement answers ends the skip, so the next search runs the keyword statement again. At most one re-run is
 * in flight per engine, a re-run starts only when the gate reports an idle connection (otherwise it waits for
 * the next step instead of queueing), none starts once shutdown begins, its rows are thrown away, it writes no timeout counter row, and it runs
 * outside the async context of the search that recorded the timeout. Regression that fails it: master keeps
 * the skip for the whole TTL even when the statement would now answer, so a cold-cache timeout costs every
 * search its keyword results for ten minutes.
 *
 * Unit arm: the cache over a manual scheduler and clock, and the engine's pool gate. Postgres arm (DATABASE_URL): a held lock makes the
 * real keyword statement time out; once the lock is released the re-run answers through the real pool gate.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import {
  KEYWORD_TIMEOUT_RERUN_FIRST_MS,
  KEYWORD_TIMEOUT_STATS_KEY,
  KeywordSkippedAfterTimeoutError,
  KeywordTimeoutNegativeCache,
  keywordRerunPoolIdle,
  setKeywordTimeoutReruns,
  type KeywordRerunScheduler,
} from '../src/core/postgres-engine/keyword-timeout-cache.ts';
import { KEYWORD_STATEMENT_TIMEOUT_KEY } from '../src/core/postgres-engine/keyword-statement-timeout.ts';
import type { SearchOpts } from '../src/core/types.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const TIMEOUT = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
const CACHE: SearchOpts = { keywordTimeoutCache: true };

/** A scheduler that runs nothing until the test fires it; `pending` lists each scheduled delay. */
function manualScheduler() {
  const jobs: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const schedule: KeywordRerunScheduler = (fn, ms) => {
    const job = { fn, ms, cancelled: false };
    jobs.push(job);
    return () => { job.cancelled = true; };
  };
  const live = () => jobs.filter(j => !j.cancelled);
  return {
    schedule,
    pending: () => live().map(j => j.ms),
    /** Runs every live job once (removing it) and waits for the re-runs they start to settle. */
    fire: async () => {
      const due = live();
      jobs.splice(0, jobs.length);
      for (const job of due) job.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
    },
  };
}

function setup(opts: { ttlSeconds?: number; canRerun?: () => boolean; serving?: boolean } = {}) {
  let clock = 1_000_000;
  const sched = manualScheduler();
  const cache = new KeywordTimeoutNegativeCache(() => clock, sched.schedule, opts.canRerun ?? (() => true));
  const writes: string[] = [];
  const db = { executeRaw: async (sql: string) => { writes.push(sql); return sql.includes('SELECT value FROM config') ? [{ value: String(opts.ttlSeconds ?? 600) }] : []; } };
  setKeywordTimeoutReruns(opts.serving !== false);
  const run = <T>(key: string, exec: () => Promise<T>) => cache.run(true, db as never, [key], exec);
  const outcome = async (key: string, exec: () => Promise<unknown>) => {
    try { await run(key, exec); return 'ran'; } catch (e) { return e instanceof KeywordSkippedAfterTimeoutError ? 'skipped' : 'failed'; }
  };
  return { cache, sched, run, outcome, writes, advance: (ms: number) => { clock += ms; } };
}

afterEach(() => setKeywordTimeoutReruns(false));

describe('keyword timeout re-run (#7082): serving process', () => {
  test('a successful background re-run ends the skip, and its rows reach no caller', async () => {
    const s = setup();
    let calls = 0;
    let answers = false;
    const exec = async () => { calls++; if (!answers) throw TIMEOUT; return ['row from call ' + calls]; };
    expect(await s.outcome('q', exec)).toBe('failed');
    expect(await s.outcome('q', exec)).toBe('skipped');
    expect(s.sched.pending()).toEqual([KEYWORD_TIMEOUT_RERUN_FIRST_MS]);
    answers = true;
    s.advance(KEYWORD_TIMEOUT_RERUN_FIRST_MS);
    await s.sched.fire();
    expect(calls).toBe(2);
    expect(s.sched.pending()).toEqual([]);
    expect(await s.run('q', exec)).toEqual(['row from call 3']);
  });

  test('a re-run that times out doubles the wait, never schedules past the TTL, and writes no counter row', async () => {
    const s = setup({ ttlSeconds: 300 });
    let calls = 0;
    const exec = async () => { calls++; throw TIMEOUT; };
    await s.outcome('q', exec);
    const counterWrites = () => s.writes.filter(sql => sql.includes(KEYWORD_TIMEOUT_STATS_KEY)).length;
    expect(counterWrites()).toBe(1);
    const delays: number[] = [];
    for (let i = 0; i < 6 && s.sched.pending().length; i++) {
      const [ms] = s.sched.pending();
      delays.push(ms!);
      s.advance(ms!);
      await s.sched.fire();
    }
    expect(delays).toEqual([30_000, 60_000, 120_000]);
    expect(calls).toBe(4);
    expect(counterWrites()).toBe(1);
    expect(await s.outcome('q', exec)).toBe('skipped');
    s.advance(300_000);
    expect(await s.outcome('q', exec)).toBe('failed');
  });

  test('no idle connection: the re-run is skipped, not queued, and the next one waits twice as long', async () => {
    let idle = false;
    const s = setup({ canRerun: () => idle });
    let calls = 0;
    const exec = async () => { calls++; if (calls === 1) throw TIMEOUT; return []; };
    await s.outcome('q', exec);
    await s.sched.fire();
    expect(calls).toBe(1);
    expect(s.sched.pending()).toEqual([60_000]);
    idle = true;
    await s.sched.fire();
    expect(calls).toBe(2);
    expect(await s.outcome('q', exec)).toBe('ran');
  });

  test('at most one re-run is in flight per engine', async () => {
    const s = setup();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reruns = 0;
    let first = true;
    const slow = async () => { if (first) { first = false; throw TIMEOUT; } reruns++; await held; return []; };
    let firstB = true;
    const other = async () => { if (firstB) { firstB = false; throw TIMEOUT; } reruns++; return []; };
    await s.outcome('a', slow);
    await s.outcome('b', other);
    await s.sched.fire();
    expect(reruns).toBe(1);
    expect(s.sched.pending()).toEqual([60_000]);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    await s.sched.fire();
    expect(reruns).toBe(2);
  });

  test('once shutdown begins no scheduled re-run starts and none is scheduled', async () => {
    const s = setup();
    let calls = 0;
    const exec = async () => { calls++; throw TIMEOUT; };
    await s.outcome('q', exec);
    expect(s.sched.pending()).toHaveLength(1);
    setKeywordTimeoutReruns(false);
    await s.sched.fire();
    expect(calls).toBe(1);
    await s.outcome('other', exec);
    expect(s.sched.pending()).toEqual([]);
    expect(calls).toBe(2);
  });

  test('the re-run runs outside the async context of the search that recorded the timeout', async () => {
    const request = new AsyncLocalStorage<string>();
    const s = setup();
    const seen: Array<string | undefined> = [];
    let calls = 0;
    const exec = async () => { calls++; seen.push(request.getStore()); if (calls === 1) throw TIMEOUT; return []; };
    await request.run('user request', () => s.outcome('q', exec));
    await request.run('later request', () => s.sched.fire());
    expect(seen).toEqual(['user request', undefined]);
  });
});

describe('keyword timeout re-run (#7082): one-shot processes', () => {
  test('without a serve turning re-runs on, nothing is scheduled and the skip lasts the TTL as before', async () => {
    const s = setup({ serving: false, ttlSeconds: 60 });
    await s.outcome('q', async () => { throw TIMEOUT; });
    expect(s.sched.pending()).toEqual([]);
    s.advance(59_000);
    expect(await s.outcome('q', async () => [])).toBe('skipped');
    s.advance(1_000);
    expect(await s.outcome('q', async () => [])).toBe('ran');
  });

  test('the engine gate needs an open pool that keeps a connection free and has no waiting query', () => {
    const pool = (checked_out: number, waiters: number, max = 3) => ({ checked_out, max, waiters, inflight_oldest_ms: 0, completed: 0 });
    expect(keywordRerunPoolIdle(null, null)).toBe(false);
    expect(keywordRerunPoolIdle(pool(0, 0), null)).toBe(true);
    expect(keywordRerunPoolIdle(pool(1, 0), null)).toBe(true);
    expect(keywordRerunPoolIdle(pool(0, 0), Promise.resolve())).toBe(false);
    expect(keywordRerunPoolIdle(pool(2, 0), null)).toBe(false);
    expect(keywordRerunPoolIdle(pool(0, 0, 1), null)).toBe(false);
    expect(keywordRerunPoolIdle(pool(1, 2), null)).toBe(false);
  });
});

if (testBackends().includes('postgres')) {
  describe('postgres: a timed-out keyword statement answers again after a background re-run', () => {
    let engine: PostgresEngine;
    let databaseUrl: string;
    let close: () => Promise<void>;
    let locker: ReturnType<typeof postgres>;

    beforeAll(async () => {
      ({ engine, databaseUrl, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'module'));
      await engine.putPage('notes/alpha', { type: 'note', title: 'Alpha beta', compiled_truth: 'alpha beta gamma' });
      await installFixtureChunks(engine, 'notes/alpha', [{ chunk_index: 0, chunk_text: 'alpha beta gamma', chunk_source: 'compiled_truth' }]);
      locker = postgres(databaseUrl, { max: 1, prepare: false });
    }, 120_000);
    afterAll(async () => {
      await locker?.end({ timeout: 5 }).catch(() => {});
      await close?.();
    });

    test('skipped while the statement times out, answering after the re-run once the lock is gone', async () => {
      await engine.setConfig(KEYWORD_STATEMENT_TIMEOUT_KEY, '1000');
      const serving = engine;
      const sched = manualScheduler();
      const priv = serving as unknown as { keywordTimeouts: KeywordTimeoutNegativeCache };
      priv.keywordTimeouts = new KeywordTimeoutNegativeCache(Date.now, sched.schedule, (priv.keywordTimeouts as unknown as { canRerun: () => boolean }).canRerun);
      setKeywordTimeoutReruns(true);
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const lockedUp = new Promise<void>(resolve => { locked = resolve; });
      const held = locker.begin(async tx => {
        await tx.unsafe('LOCK TABLE content_chunks, pages IN ACCESS EXCLUSIVE MODE');
        locked();
        await released;
      }).catch(() => {});
      try {
        await lockedUp;
        await expect(serving.searchKeyword('alpha beta', CACHE)).rejects.toMatchObject({ code: '57014' });
        await expect(serving.searchKeyword('alpha beta', CACHE)).rejects.toBeInstanceOf(KeywordSkippedAfterTimeoutError);
        expect(sched.pending()).toEqual([KEYWORD_TIMEOUT_RERUN_FIRST_MS]);
        release();
        await held;
        await sched.fire();
        for (let i = 0; i < 50 && sched.pending().length === 0; i++) {
          try { expect((await serving.searchKeyword('alpha beta', CACHE)).map(r => r.slug)).toEqual(['notes/alpha']); return; } catch (e) { if (!(e instanceof KeywordSkippedAfterTimeoutError)) throw e; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('the keyword statement was still skipped after its background re-run');
      } finally {
        release();
        await held;
        await engine.unsetConfig(KEYWORD_STATEMENT_TIMEOUT_KEY);
        await engine.unsetConfig(KEYWORD_TIMEOUT_STATS_KEY);
      }
    }, 120_000);
  });
}
