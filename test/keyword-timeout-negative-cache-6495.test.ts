/**
 * #6495: the Postgres keyword timeout negative cache.
 *
 * Contract protected: after hybrid search's keyword statement hits the
 * statement timeout (a genuine 57014 timeout diagnostic, never a user
 * cancel), the same statement with the same parameters and scope is skipped
 * for `search.keyword_timeout_negative_cache_seconds` (default 600, 0 = off)
 * and the keyword arm reports `keyword_arm_failed: skipped_after_timeout`
 * instead of waiting for the timeout again. A narrower or differently scoped
 * query, another brain, a fresh search (`useCache: false`) and every caller
 * that did not opt in still run. A search that never times out costs no extra
 * statement; each timeout writes one bounded counter row that doctor
 * `keyword_plan` reads. Regression that fails it: master re-runs the timed-out
 * statement on every search and holds a backend for the whole bound again.
 *
 * Unit arm: the real engine method over an injected executor (the scoped
 * read transaction yields a recording handle whose keyword statement can be
 * made to time out). Postgres arm (DATABASE_URL): a session holding ACCESS
 * EXCLUSIVE on the searched tables makes the keyword statement wait until
 * Postgres cancels it, and the counter upsert runs on a real config table.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import {
  KEYWORD_TIMEOUT_NEGATIVE_CACHE_DEFAULT_S,
  KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY,
  KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_ENTRIES,
  KEYWORD_TIMEOUT_STATS_KEY,
  KeywordSkippedAfterTimeoutError,
  KeywordTimeoutNegativeCache,
  isGenuineStatementTimeout,
  keywordTimeoutNegativeCacheValueProblem,
  parseKeywordTimeoutStats,
} from '../src/core/postgres-engine/keyword-timeout-cache.ts';
import { KEYWORD_STATEMENT_TIMEOUT_KEY } from '../src/core/postgres-engine/keyword-statement-timeout.ts';
import { runLexicalArms } from '../src/core/search/hybrid/arms.ts';
import { UNTIMED } from '../src/core/search/stage-timings.ts';
import { degradedRecallNotice } from '../src/core/interop-notices.ts';
import { keywordPlanCheck, type KeywordPlanProbe } from '../src/commands/doctor/checks/keyword-plan.ts';
import { CODES } from '../src/core/error-registry.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import type { DegradedStageEntry, SearchOpts, SearchResult } from '../src/core/types.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const TIMEOUT = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
const USER_CANCEL = Object.assign(new Error('canceling statement due to user request'), { code: '57014' });
const CACHE: SearchOpts = { keywordTimeoutCache: true };

interface Harness {
  engine: PostgresEngine;
  /** Keyword statements that reached the executor. */
  statements: () => number;
  /** Every statement and config read/write, in order. */
  all: string[];
  /** The next keyword statement(s) fail with this error; relaxed-only when `relaxedOnly`. */
  failNext: (error: Error | null, opts?: { relaxedOnly?: boolean }) => void;
  setClock: (ms: number) => void;
}

/** A PostgresEngine whose scoped read transactions run over a recording handle; the keyword statement can be made to fail. */
function harness(opts: { ttl?: string | null } = {}): Harness {
  const engine = new PostgresEngine();
  const all: string[] = [];
  let keywordStatements = 0;
  let failure: Error | null = null;
  let relaxedOnly = false;
  let clock = 1_000_000;
  let inRelaxed = false;
  const tx = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings.join('$');
      all.push(sql);
      return /SHOW enable_seqscan/i.test(sql) ? [{ enable_seqscan: 'on' }] : [];
    },
    {
      unsafe: async (sql: string) => {
        all.push(sql);
        keywordStatements++;
        const relaxed = inRelaxed;
        inRelaxed = false;
        if (failure && (!relaxedOnly || relaxed)) throw failure;
        return [];
      },
    },
  );
  const priv = engine as unknown as {
    withScopedReadTransaction: (ids: unknown, id: unknown, cb: (tx: unknown) => Promise<unknown>, o?: { settings?: Record<string, string> }) => Promise<unknown>;
    executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>;
    _savedConfig: Record<string, unknown> | undefined;
    _pageTransaction: boolean;
    keywordTimeouts: KeywordTimeoutNegativeCache;
  };
  priv.withScopedReadTransaction = (_ids, _id, cb, o) => {
    if (o?.settings?.enable_seqscan === 'off') inRelaxed = true;
    return cb(tx);
  };
  priv.executeRaw = async (sql) => {
    all.push(sql);
    if (sql.includes(KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY)) return opts.ttl == null ? [] : [{ value: opts.ttl }];
    if (sql.includes(KEYWORD_STATEMENT_TIMEOUT_KEY)) return [];
    return [];
  };
  priv._savedConfig = { keyword_statement_timeout_ms: 8000 };
  priv._pageTransaction = true;
  priv.keywordTimeouts = new KeywordTimeoutNegativeCache(() => clock);
  return {
    engine,
    all,
    statements: () => keywordStatements,
    failNext: (error, o) => { failure = error; relaxedOnly = o?.relaxedOnly ?? false; },
    setClock: (ms) => { clock = ms; },
  };
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ran';
  } catch (error) {
    return error instanceof KeywordSkippedAfterTimeoutError ? 'skipped' : String((error as { code?: string }).code ?? (error as Error).message);
  }
}

describe('keyword timeout negative cache: the engine runner', () => {
  test('after a recorded statement timeout the same statement is skipped without running', async () => {
    const h = harness();
    h.failNext(TIMEOUT);
    expect(await outcome(() => h.engine.searchKeyword('contract terms', CACHE))).toBe('57014');
    expect(h.statements()).toBe(1);
    expect(await outcome(() => h.engine.searchKeyword('contract terms', CACHE))).toBe('skipped');
    expect(h.statements()).toBe(1);
    const error = await h.engine.searchKeyword('contract terms', CACHE).catch((e: unknown) => e) as KeywordSkippedAfterTimeoutError;
    expect(error.code).toBe('keyword_skipped_after_timeout');
    expect(error.retryAfterSeconds).toBe(KEYWORD_TIMEOUT_NEGATIVE_CACHE_DEFAULT_S);
  });

  test('a narrower or differently scoped query after an unscoped timeout still runs', async () => {
    const h = harness();
    h.failNext(TIMEOUT);
    await outcome(() => h.engine.searchKeyword('contract terms', CACHE));
    h.failNext(null);
    expect(await outcome(() => h.engine.searchKeyword('contract terms', { ...CACHE, sourceId: 'alpha' }))).toBe('ran');
    expect(await outcome(() => h.engine.searchKeyword('contract terms', { ...CACHE, sourceIds: ['alpha', 'beta'] }))).toBe('ran');
    expect(await outcome(() => h.engine.searchKeyword('contract terms', { ...CACHE, types: ['person'] }))).toBe('ran');
    expect(await outcome(() => h.engine.searchKeyword('contract terms', { ...CACHE, afterDate: '2026-01-01' }))).toBe('ran');
    expect(await outcome(() => h.engine.searchKeyword('contract terms', { ...CACHE, excludePrivate: true }))).toBe('ran');
    expect(await outcome(() => h.engine.searchKeyword('contract terms acme', CACHE))).toBe('ran');
    expect(h.statements()).toBe(7);
  });

  test('a second brain is unaffected', async () => {
    const a = harness();
    const b = harness();
    a.failNext(TIMEOUT);
    await outcome(() => a.engine.searchKeyword('contract terms', CACHE));
    expect(await outcome(() => a.engine.searchKeyword('contract terms', CACHE))).toBe('skipped');
    expect(await outcome(() => b.engine.searchKeyword('contract terms', CACHE))).toBe('ran');
  });

  test('a user or admin cancel is never cached; callers that did not opt in always run', async () => {
    const h = harness();
    h.failNext(USER_CANCEL);
    await outcome(() => h.engine.searchKeyword('contract terms', CACHE));
    expect(await outcome(() => h.engine.searchKeyword('contract terms', CACHE))).toBe('57014');
    expect(h.statements()).toBe(2);
    h.failNext(TIMEOUT);
    await outcome(() => h.engine.searchKeyword('contract terms', CACHE));
    h.failNext(null);
    expect(await outcome(() => h.engine.searchKeyword('contract terms'))).toBe('ran');
    expect(isGenuineStatementTimeout(TIMEOUT)).toBe(true);
    expect(isGenuineStatementTimeout(USER_CANCEL)).toBe(false);
    expect(isGenuineStatementTimeout(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }))).toBe(false);
  });

  test('entries expire at the TTL, so a transient spike recovers on its own; TTL 0 turns the skip off', async () => {
    const h = harness({ ttl: '60' });
    h.failNext(TIMEOUT);
    await outcome(() => h.engine.searchKeyword('contract terms', CACHE));
    h.failNext(null);
    h.setClock(1_000_000 + 59_000);
    expect(await outcome(() => h.engine.searchKeyword('contract terms', CACHE))).toBe('skipped');
    h.setClock(1_000_000 + 60_000);
    expect(await outcome(() => h.engine.searchKeyword('contract terms', CACHE))).toBe('ran');

    const off = harness({ ttl: '0' });
    off.failNext(TIMEOUT);
    await outcome(() => off.engine.searchKeyword('contract terms', CACHE));
    expect(await outcome(() => off.engine.searchKeyword('contract terms', CACHE))).toBe('57014');
  });

  test('the strict statement and the relaxed (OR) retry are cached separately', async () => {
    const h = harness();
    h.failNext(TIMEOUT, { relaxedOnly: true });
    expect(await outcome(() => h.engine.searchKeyword('contract terms', { ...CACHE, orFallback: true }))).toBe('57014');
    expect(h.statements()).toBe(2);
    expect(await outcome(() => h.engine.searchKeyword('contract terms', { ...CACHE, orFallback: true }))).toBe('skipped');
    expect(h.statements()).toBe(3);
    expect(await outcome(() => h.engine.searchKeyword('contract terms', CACHE))).toBe('ran');
  });

  test('zero extra statements per search; one TTL read and one counter write per timeout', async () => {
    const h = harness();
    await h.engine.searchKeyword('contract terms', CACHE);
    const perSearch = h.all.length;
    await h.engine.searchKeyword('contract terms', CACHE);
    await h.engine.searchKeyword('contract terms');
    expect(h.all.length).toBe(perSearch * 3);
    expect(h.all.filter(sql => sql.includes('search.keyword_timeout'))).toEqual([]);

    h.failNext(TIMEOUT);
    await outcome(() => h.engine.searchKeyword('contract terms', CACHE));
    await outcome(() => h.engine.searchKeyword('contract terms', CACHE));
    await outcome(() => h.engine.searchKeyword('contract terms', CACHE));
    await outcome(() => h.engine.searchKeyword('broad words', CACHE));
    const cacheSql = h.all.filter(sql => sql.includes('search.keyword_timeout'));
    expect(cacheSql.filter(sql => sql.includes(KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY))).toHaveLength(1);
    expect(cacheSql.filter(sql => sql.includes(KEYWORD_TIMEOUT_STATS_KEY))).toHaveLength(2);
  });

  test('the entry count is bounded', async () => {
    const cache = new KeywordTimeoutNegativeCache(() => 0);
    const db = { executeRaw: async () => [] as never[] };
    for (let i = 0; i < KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_ENTRIES + 50; i++) {
      await cache.run(true, db, [i], () => Promise.reject(TIMEOUT)).catch(() => {});
    }
    expect((cache as unknown as { entries: Map<string, number> }).entries.size).toBe(KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_ENTRIES);
    expect(await cache.run(true, db, [0], async () => 'ran')).toBe('ran');
    await expect(cache.run(true, db, [KEYWORD_TIMEOUT_NEGATIVE_CACHE_MAX_ENTRIES + 49], async () => 'ran')).rejects.toBeInstanceOf(KeywordSkippedAfterTimeoutError);
  });
});

describe('keyword timeout negative cache: the hybrid keyword arm', () => {
  function arm(searchKeyword: (q: string, o: SearchOpts) => Promise<SearchResult[]>, opts: Record<string, unknown> = {}) {
    const seen: SearchOpts[] = [];
    const engine = {
      searchKeyword: (q: string, o: SearchOpts) => { seen.push(o); return searchKeyword(q, o); },
      searchTitles: async () => [],
    } as unknown as BrainEngine;
    const degraded: DegradedStageEntry[] = [];
    const req = { engine, query: 'contract terms', opts, searchOpts: { limit: 10 }, identityTierOpts: {}, degraded, timer: UNTIMED };
    return { run: () => runLexicalArms(req as never, 'text'), degraded, seen };
  }

  test('a skipped statement reports keyword_arm_failed: skipped_after_timeout and the search goes on', async () => {
    const { run, degraded, seen } = arm(async () => { throw new KeywordSkippedAfterTimeoutError(42); });
    const lexical = await run();
    expect(lexical.keywordResults).toEqual([]);
    expect(degraded).toEqual([{ stage: 'keyword_arm_failed', reason: 'skipped_after_timeout' }]);
    expect(seen[0]?.keywordTimeoutCache).toBe(true);
  });

  test('a fresh search (useCache: false) does not consult the cache; a real timeout still reports timeout', async () => {
    const fresh = arm(async () => [], { useCache: false });
    await fresh.run();
    expect(fresh.seen[0]?.keywordTimeoutCache).toBeUndefined();
    const timedOut = arm(async () => { throw TIMEOUT; });
    await timedOut.run();
    expect(timedOut.degraded).toEqual([{ stage: 'keyword_arm_failed', reason: 'timeout' }]);
  });

  test('the degraded_recall notice names the skip, its TTL key and the keyword_plan check', () => {
    const notice = degradedRecallNotice([{ stage: 'keyword_arm_failed', reason: 'skipped_after_timeout' }], { transport: 'stdio' })!;
    expect(notice.why).toContain('keyword_arm_failed: skipped_after_timeout');
    expect(notice.why).toContain(KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY);
    expect(notice.fix?.argv).toEqual(['gbrain', 'doctor', '--only', 'keyword_plan', '--json']);
    expect(notice.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'keyword_plan', '--json']);
    const plain = degradedRecallNotice([{ stage: 'keyword_arm_failed', reason: 'timeout' }], { transport: 'stdio' })!;
    expect(plain.why).not.toContain('skipped');
    expect(plain.fix?.argv).toEqual(['gbrain', 'doctor', '--json']);
  });
});

describe('keyword timeout negative cache: config, registry and doctor', () => {
  test('the key is registered with a config set validator (integer seconds, 0 = off, cap 86400)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain(KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY);
    for (const ok of ['0', '600', '86400']) expect(keywordTimeoutNegativeCacheValueProblem(ok)).toBeNull();
    for (const bad of ['-1', '86401', '10m', '1.5', '']) {
      expect(keywordTimeoutNegativeCacheValueProblem(bad)).toBe(
        `${KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY} must be an integer number of seconds from 0 (off) to 86400 (got '${bad}'). Nothing was written.`);
    }
    expect(CODES.keyword_skipped_after_timeout.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'keyword_plan', '--json']);
  });

  test('doctor keyword_plan reads the counter row into details.negative_cache and names it', async () => {
    const config: Record<string, string> = {
      [KEYWORD_TIMEOUT_STATS_KEY]: JSON.stringify({ timeouts: 3, skips: 7, last_timeout_at: '2026-10-15T10:00:00.000Z' }),
    };
    const engine = { kind: 'postgres', getConfig: async (k: string) => config[k] ?? null } as unknown as BrainEngine;
    const probe: KeywordPlanProbe = { chunkEstimate: async () => 100, canary: async () => null, explain: async () => [], count: async () => ({ outcome: 'counted', pages: 0, ms: 1 }) };
    const check = await keywordPlanCheck(engine, probe);
    expect(check.details?.negative_cache).toEqual({ ttl_seconds: 600, timeouts: 3, skips: 7, last_timeout_at: '2026-10-15T10:00:00.000Z' });
    expect(check.message).toContain('hit this bound 3 time(s)');
    expect(check.message).toContain(`${KEYWORD_TIMEOUT_NEGATIVE_CACHE_KEY}; 0 turns it off`);
    const quiet = await keywordPlanCheck({ kind: 'postgres', getConfig: async () => null } as unknown as BrainEngine, probe);
    expect(quiet.details?.negative_cache).toEqual({ ttl_seconds: 600, timeouts: 0, skips: 0, last_timeout_at: null });
    expect(quiet.message).not.toContain('hit this bound');
  });
});

if (testBackends().includes('postgres')) {
  describe('postgres: a real statement timeout is skipped next time and counted', () => {
    let engine: PostgresEngine;
    let databaseUrl: string;
    let close: () => Promise<void>;
    let locker: ReturnType<typeof postgres>;
    let releaseLock: () => Promise<void>;

    beforeAll(async () => {
      ({ engine, databaseUrl, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      await engine.putPage('notes/alpha', { type: 'note', title: 'Alpha beta', compiled_truth: 'alpha beta gamma' });
      await installFixtureChunks(engine, 'notes/alpha', [{ chunk_index: 0, chunk_text: 'alpha beta gamma', chunk_source: 'compiled_truth' }]);
      locker = postgres(databaseUrl, { max: 1, prepare: false });
    }, 120_000);
    afterAll(async () => {
      await releaseLock?.().catch(() => {});
      await locker?.end({ timeout: 5 }).catch(() => {});
      await close?.();
    });

    async function holdLock(): Promise<void> {
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const lockedUp = new Promise<void>(resolve => { locked = resolve; });
      const held = locker.begin(async tx => {
        await tx.unsafe('LOCK TABLE content_chunks, pages IN ACCESS EXCLUSIVE MODE');
        locked();
        await released;
      }).catch(() => {});
      releaseLock = async () => { release(); await held; };
      await lockedUp;
    }

    test('the second identical search returns at once with the skip; a scoped one still waits; the counter row is written', async () => {
      await engine.setConfig(KEYWORD_STATEMENT_TIMEOUT_KEY, '1000');
      const bounded = new PostgresEngine();
      await bounded.connect({ database_url: databaseUrl, poolSize: 2 });
      try {
        await holdLock();
        let started = performance.now();
        expect(await outcome(() => bounded.searchKeyword('alpha beta', CACHE))).toBe('57014');
        expect(performance.now() - started).toBeGreaterThanOrEqual(900);
        started = performance.now();
        expect(await outcome(() => bounded.searchKeyword('alpha beta', CACHE))).toBe('skipped');
        expect(performance.now() - started).toBeLessThan(500);
        expect(await outcome(() => bounded.searchKeyword('alpha beta', { ...CACHE, sourceId: 'default' }))).toBe('57014');
        await releaseLock();
        const stats = parseKeywordTimeoutStats(await engine.getConfig(KEYWORD_TIMEOUT_STATS_KEY));
        expect(stats?.timeouts).toBe(2);
        expect(stats?.skips).toBe(1);
        expect(stats?.last_timeout_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(await outcome(() => bounded.searchKeyword('alpha beta', { ...CACHE, sourceId: 'default' }))).toBe('skipped');
        expect((await bounded.searchKeyword('alpha beta')).map(r => r.slug)).toEqual(['notes/alpha']);
        expect((await bounded.searchKeyword('alpha', CACHE)).map(r => r.slug)).toEqual(['notes/alpha']);
      } finally {
        await releaseLock();
        await bounded.disconnect();
        await engine.unsetConfig(KEYWORD_STATEMENT_TIMEOUT_KEY);
        await engine.unsetConfig(KEYWORD_TIMEOUT_STATS_KEY);
      }
    }, 120_000);

    test('the counter upsert survives a malformed row and stays bounded', async () => {
      await engine.setConfig(KEYWORD_TIMEOUT_STATS_KEY, 'not json');
      const cache = new KeywordTimeoutNegativeCache();
      await cache.run(true, engine, ['malformed'], () => Promise.reject(TIMEOUT)).catch(() => {});
      expect(parseKeywordTimeoutStats(await engine.getConfig(KEYWORD_TIMEOUT_STATS_KEY))).toMatchObject({ timeouts: 1, skips: 0 });
      await engine.setConfig(KEYWORD_TIMEOUT_STATS_KEY, JSON.stringify({ timeouts: 999_999_999_999, skips: 5 }));
      await cache.run(true, engine, ['bounded'], () => Promise.reject(TIMEOUT)).catch(() => {});
      expect(parseKeywordTimeoutStats(await engine.getConfig(KEYWORD_TIMEOUT_STATS_KEY))).toMatchObject({ timeouts: 1_000_000_000, skips: 5 });
      await engine.unsetConfig(KEYWORD_TIMEOUT_STATS_KEY);
    });
  });
}
