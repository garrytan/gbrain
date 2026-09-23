import { describe, expect, test } from 'bun:test';
import { readVectorPool, searchVectorPool, type VectorPoolAttempt } from '../../src/core/search/vector-pool.ts';
import { supportsHnswIterativeScan } from '../../src/core/vector-index.ts';
import type { SearchOpts } from '../../src/core/types.ts';

type PoolMeta = Parameters<NonNullable<SearchOpts['onVectorPoolMeta']>>[0];

describe('bounded vector candidate safety', () => {
  test('extension capability comes from the installed version, including older releases', () => {
    for (const version of [undefined, '', 'invalid', '0.7.4', '0.6.2']) expect(supportsHnswIterativeScan(version)).toBe(false);
    for (const version of ['0.8.0', '0.8.1', '0.10.0', '1.0.0']) expect(supportsHnswIterativeScan(version)).toBe(true);
  });

  test('empty OFFSET pages preserve the candidate count without exposing a sentinel result', () => {
    expect(readVectorPool([{ page_id: null, candidate_pool: 375 }])).toEqual({ rows: [], candidatePool: 375 });
    expect(readVectorPool([{ page_id: 2, candidate_pool: 8 }])).toEqual({ rows: [{ page_id: 2, candidate_pool: 8 }], candidatePool: 8 });
  });

  test('a filtered short ANN pool is not mistaken for corpus exhaustion', async () => {
    const attempts: VectorPoolAttempt[] = [];
    const events: PoolMeta[] = [];
    const rows = await searchVectorPool(75, 375, true, true, 'pglite', async attempt => {
      attempts.push(attempt);
      return { rows: Array.from({ length: attempts.length === 1 ? 8 : 75 }, (_, page_id) => ({ page_id })), candidatePool: attempts.length === 1 ? 8 : 375 };
    }, async () => true, meta => events.push(meta));
    expect(rows).toHaveLength(75);
    expect(attempts.map(a => a.innerLimit)).toEqual([375, 1500]);
    expect(attempts.every(a => !a.exact)).toBe(true);
    expect(events).toEqual([]);
  });

  test('a zero-row ANN pool remains visibly incomplete when eligible rows exist', async () => {
    const events: PoolMeta[] = [];
    const attempts: VectorPoolAttempt[] = [];
    const rows = await searchVectorPool(10, 1100, true, true, 'pglite', async attempt => {
      attempts.push(attempt);
      return { rows: [], candidatePool: 0 };
    }, async () => true, meta => events.push(meta));
    expect(rows).toEqual([]);
    expect(attempts).toHaveLength(4);
    expect(attempts.every(a => a.maxScanTuples <= 20_000 && !a.exact)).toBe(true);
    expect(events).toEqual([{ underfilled: true, incomplete: true, reason: 'candidate_budget', escalations: 3, innerLimit: 20_000, candidatePool: 0, exactFallback: false }]);
  });

  test('proved empty and small corpora do not emit degraded metadata', async () => {
    for (const candidatePool of [0, 2]) {
      const events: PoolMeta[] = [];
      let calls = 0;
      await searchVectorPool(10, 100, true, true, 'pglite', async () => {
        calls++;
        return { rows: [], candidatePool };
      }, async () => false, meta => events.push(meta));
      expect(calls).toBe(1);
      expect(events).toEqual([]);
    }
  });

  test('older pgvector on PGLite reports capability limits without an exact fallback', async () => {
    const events: PoolMeta[] = [];
    const attempts: VectorPoolAttempt[] = [];
    await searchVectorPool(10, 100, false, true, 'pglite', async attempt => {
      attempts.push(attempt);
      return { rows: [], candidatePool: 0 };
    }, async () => true, meta => events.push(meta));
    expect(attempts).toHaveLength(1);
    expect(events[0].reason).toBe('iterative_scan_unavailable');
    expect(events[0].exactFallback).toBe(false);
  });

  test('Postgres allows one exact fallback with a remaining server budget', async () => {
    const events: PoolMeta[] = [];
    const attempts: VectorPoolAttempt[] = [];
    const result = await searchVectorPool(10, 100, false, true, 'postgres', async attempt => {
      attempts.push(attempt);
      return { rows: attempt.exact ? [{ page_id: 7 }] : [], candidatePool: attempt.exact ? 1 : 0, exhausted: attempt.exact };
    }, async () => true, meta => events.push(meta));
    expect(result).toEqual([{ page_id: 7 }]);
    expect(attempts.map(a => a.exact)).toEqual([false, true]);
    expect(attempts[1].remainingMs).toBeGreaterThan(0);
    expect(attempts[1].remainingMs).toBeLessThanOrEqual(attempts[0].remainingMs);
    expect(events).toEqual([]);
  });

  test('an exact fallback with a still-capped dense pool cannot claim completeness', async () => {
    const events: PoolMeta[] = [];
    const rows = await searchVectorPool(10, 100, false, true, 'postgres', async () => ({ rows: [{ page_id: 1 }], candidatePool: 100 }), async () => true, meta => events.push(meta));
    expect(rows).toEqual([{ page_id: 1 }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'candidate_budget', incomplete: true, exactFallback: true, candidatePool: 100 });
  });

  test('server cancellation preserves prior rows and reports the deadline', async () => {
    const events: PoolMeta[] = [];
    await searchVectorPool(10, 100, false, true, 'postgres', async attempt => {
      if (attempt.exact) throw Object.assign(new Error('query canceled'), { code: '57014' });
      return { rows: [{ page_id: 4 }], candidatePool: 1 };
    }, async () => true, meta => events.push(meta));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'deadline', candidatePool: 1, incomplete: true, exactFallback: true });
  });
});
