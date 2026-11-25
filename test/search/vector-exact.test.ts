/**
 * search/vector-exact.ts: the setting's parse and read, its set-time
 * refusal, the size gate, the fail-open chunk count and the exact attempt's
 * accept / widen / fall-back rules. The Postgres behaviour itself is pinned
 * by test/e2e/vector-exact-scan-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  contentChunkCountCache, parseContentChunkCount, parseVectorExactMaxChunks, readVectorExactMaxChunks, searchExactFirst, searchExactWindow,
  vectorExactApplies, VECTOR_EXACT_ESCALATIONS, VECTOR_EXACT_MAX_CHUNKS_KEY,
} from '../../src/core/search/vector-exact.ts';
import { searchConfigValueRefusal } from '../../src/core/search/config-values.ts';
import type { VectorPoolAttempt, VectorPoolBatch } from '../../src/core/search/vector-pool.ts';

describe('the vector_exact_max_chunks setting', () => {
  test('parses whole numbers only; anything else is unreadable', () => {
    expect(parseVectorExactMaxChunks('300000')).toBe(300_000);
    expect(parseVectorExactMaxChunks(' 0 ')).toBe(0);
    expect(parseVectorExactMaxChunks(5)).toBe(5);
    for (const bad of ['-1', '1.5', 'on', '', '1e5', -3, 2.5, Number.NaN, null, undefined, true]) {
      expect(parseVectorExactMaxChunks(bad)).toBeUndefined();
    }
  });

  test('reads the config value; unset or unreadable is off', () => {
    expect(readVectorExactMaxChunks({ search: { vector_exact_max_chunks: 300_000 } })).toEqual({ maxChunks: 300_000, via: 'config' });
    expect(readVectorExactMaxChunks({ search: { vector_exact_max_chunks: '1200' as unknown as number } })).toEqual({ maxChunks: 1200, via: 'config' });
    expect(readVectorExactMaxChunks({ search: { vector_exact_max_chunks: 'lots' as unknown as number } })).toEqual({ maxChunks: 0, via: null });
    expect(readVectorExactMaxChunks({})).toEqual({ maxChunks: 0, via: null });
    expect(readVectorExactMaxChunks(null)).toEqual({ maxChunks: 0, via: null });
  });

  test('gbrain config set refuses a value the reader would ignore', () => {
    expect(searchConfigValueRefusal(VECTOR_EXACT_MAX_CHUNKS_KEY, '300000')).toBeNull();
    expect(searchConfigValueRefusal(VECTOR_EXACT_MAX_CHUNKS_KEY, '0')).toBeNull();
    const refusal = searchConfigValueRefusal(VECTOR_EXACT_MAX_CHUNKS_KEY, 'yes');
    expect(refusal?.message).toContain('whole number of chunks');
    expect(refusal?.example).toBe('150000');
  });

  test('applies only to a known chunk count at or below a positive ceiling', () => {
    expect(vectorExactApplies(300_000, 300_000)).toBe(true);
    expect(vectorExactApplies(300_000, 0)).toBe(true);
    expect(vectorExactApplies(300_000, 300_001)).toBe(false);
    expect(vectorExactApplies(0, 10)).toBe(false);
    expect(vectorExactApplies(undefined, 10)).toBe(false);
    expect(vectorExactApplies(300_000, undefined)).toBe(false);
  });
});

describe('the chunk count', () => {
  test('reads planner statistics; a never-analyzed or missing table is unknown', () => {
    expect(parseContentChunkCount([{ reltuples: 52_000.4 }])).toBe(52_000);
    expect(parseContentChunkCount([{ reltuples: '7' }])).toBe(7);
    expect(parseContentChunkCount([{ reltuples: 0 }])).toBe(0);
    expect(parseContentChunkCount([{ reltuples: -1 }])).toBeUndefined();
    expect(parseContentChunkCount([{ reltuples: null }])).toBeUndefined();
    expect(parseContentChunkCount([])).toBeUndefined();
  });

  test('concurrent searches share one read', async () => {
    let reads = 0;
    const count = contentChunkCountCache(async () => { reads++; return 10; });
    expect(await Promise.all([count(), count(), count()])).toEqual([10, 10, 10]);
    expect(await count()).toBe(10);
    expect(reads).toBe(1);
  });

  test('a failed read is unknown for that search and retried on the next', async () => {
    let reads = 0;
    const count = contentChunkCountCache(async () => { reads++; if (reads === 1) throw new Error('boom'); return 7; });
    expect(await count()).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await count()).toBe(7);
    expect(reads).toBe(2);
  });

  test('a read slower than the wait leaves the setting off for that search (fail open), and later searches use it', async () => {
    let release!: (n: number) => void;
    const count = contentChunkCountCache(() => new Promise<number>(resolve => { release = resolve; }), 20);
    const started = performance.now();
    expect(await count()).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
    release(42);
    expect(await count()).toBe(42);
  });
});

describe('searchExactWindow', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ page_id: i + 1 }));
  const runner = (batches: Array<VectorPoolBatch | Error>) => {
    const attempts: VectorPoolAttempt[] = [];
    const run = async (attempt: VectorPoolAttempt) => {
      attempts.push(attempt);
      const next = batches.shift();
      if (!next) throw new Error('unexpected attempt');
      if (next instanceof Error) throw next;
      return next;
    };
    return { attempts, run };
  };
  const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

  test('a full answer returns at once from one bounded exact attempt', async () => {
    const { attempts, run } = runner([{ rows: rows(10), candidatePool: 100 }]);
    expect(await searchExactWindow({ innerLimit: 100 }, 10, run)).toHaveLength(10);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ innerLimit: 100, exact: true, exactWindow: true });
  });

  test('a short window means every eligible chunk was seen: its rows answer, even when fewer than the limit or none', async () => {
    const short = runner([{ rows: rows(3), candidatePool: 40 }]);
    expect(await searchExactWindow({ innerLimit: 100 }, 10, short.run)).toHaveLength(3);
    const empty = runner([{ rows: [], candidatePool: 0 }]);
    expect(await searchExactWindow({ innerLimit: 100 }, 10, empty.run)).toEqual([]);
  });

  test('a full window whose pages fall short widens x4, then gives up to the index path', async () => {
    const { attempts, run } = runner(Array.from({ length: VECTOR_EXACT_ESCALATIONS + 1 }, (_, i) => ({ rows: rows(4), candidatePool: 100 * 4 ** i })));
    expect(await searchExactWindow({ innerLimit: 100 }, 10, run)).toBeNull();
    expect(attempts.map(a => a.innerLimit)).toEqual([100, 400, 1600]);
  });

  test('a widened window that fills the limit answers', async () => {
    const { attempts, run } = runner([{ rows: rows(4), candidatePool: 100 }, { rows: rows(10), candidatePool: 400 }]);
    expect(await searchExactWindow({ innerLimit: 100 }, 10, run)).toHaveLength(10);
    expect(attempts.map(a => a.innerLimit)).toEqual([100, 400]);
  });

  test('every attempt shares one budget: later attempts get less time', async () => {
    const { attempts, run } = runner([{ rows: rows(4), candidatePool: 100 }, { rows: rows(10), candidatePool: 400 }]);
    const slowRun = async (a: VectorPoolAttempt) => { await new Promise(r => setTimeout(r, 30)); return run(a); };
    await searchExactWindow({ innerLimit: 100 }, 10, slowRun, 1_000);
    expect(attempts[0]!.remainingMs).toBeLessThanOrEqual(1_000);
    expect(attempts[1]!.remainingMs).toBeLessThan(attempts[0]!.remainingMs);
  });

  test('a statement timeout or a spent budget falls back to the index path', async () => {
    const timedOut = runner([timeout()]);
    expect(await searchExactWindow({ innerLimit: 100 }, 10, timedOut.run)).toBeNull();
    const spent = runner([]);
    expect(await searchExactWindow({ innerLimit: 100 }, 10, spent.run, 0)).toBeNull();
    expect(spent.attempts).toHaveLength(0);
  });

  test('any other error propagates', async () => {
    const { run } = runner([new Error('relation does not exist')]);
    await expect(searchExactWindow({ innerLimit: 100 }, 10, run)).rejects.toThrow('relation does not exist');
  });
});

describe('searchExactFirst', () => {
  const full = async () => ({ rows: Array.from({ length: 10 }, (_, i) => ({ page_id: i })), candidatePool: 100 });

  test('off (0 or unset) or an unindexed column reads no count and runs nothing', async () => {
    let counts = 0, runs = 0;
    const count = async () => { counts++; return 5; };
    const run = async () => { runs++; return full(); };
    for (const max of [0, undefined]) expect(await searchExactFirst({ innerLimit: 100, indexed: true }, 10, max, count, run)).toBeNull();
    expect(await searchExactFirst({ innerLimit: 100, indexed: false }, 10, 1000, count, run)).toBeNull();
    expect([counts, runs]).toEqual([0, 0]);
  });

  test('runs the exact attempt only when the known count is at or below the ceiling', async () => {
    let runs = 0;
    const run = async () => { runs++; return full(); };
    expect(await searchExactFirst({ innerLimit: 100, indexed: true }, 10, 1000, async () => 1000, run)).toHaveLength(10);
    expect(await searchExactFirst({ innerLimit: 100, indexed: true }, 10, 1000, async () => 1001, run)).toBeNull();
    expect(await searchExactFirst({ innerLimit: 100, indexed: true }, 10, 1000, async () => undefined, run)).toBeNull();
    expect(runs).toBe(1);
  });
});
