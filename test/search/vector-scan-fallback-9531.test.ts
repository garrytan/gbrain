import { describe, expect, test } from 'bun:test';
import { buildVectorSearchStatement } from '../../src/core/search/vector-statement.ts';
import { searchIndexWalk, type VectorPoolAttempt } from '../../src/core/search/vector-pool.ts';

const opts = { sourceId: 'scoped', embeddingColumn: { name: 'embedding', type: 'vector' as const, dimensions: 1024, embeddingModel: 'voyage:voyage-4' } };
const statement = (share = 0.16, chunks = 23_502) => buildVectorSearchStatement({
  dialect: 'postgres', embedding: new Float32Array(1024), limit: 20, offset: 0, opts, scope: { share, chunks },
});
const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
const rows = Array.from({ length: 20 }, (_, page_id) => ({ page_id }));

describe('#9531: scan-first scopes retain a bounded index fallback', () => {
  test('small scopes retain the same walk as larger scopes, but try the scan first', () => {
    const small = statement();
    expect(small.scopeScanSql).toBeDefined();
    expect(small.indexWalkSql).toBeDefined();
    expect(small.indexWalkSql).toBe(statement(0.16, 30_000).indexWalkSql);
  });

  test('a successful exact scan answers without walking', async () => {
    const attempts: VectorPoolAttempt[] = [];
    const result = await searchIndexWalk(statement(), 20, async attempt => {
      attempts.push(attempt);
      return { rows, candidatePool: 100 };
    });
    expect(result).toEqual(rows);
    expect(attempts.map(a => a.scopeScan ? 'scan' : 'walk')).toEqual(['scan']);
  });

  for (const failure of ['timeout', 'short'] as const) {
    test(`a ${failure} scan runs the walk next and never repeats the scan`, async () => {
      const attempts: VectorPoolAttempt[] = [];
      const result = await searchIndexWalk(statement(), 20, async attempt => {
        attempts.push(attempt);
        if (attempt.scopeScan) {
          if (failure === 'timeout') throw timeout();
          return { rows: [], candidatePool: 100, eligiblePool: 80 };
        }
        return { rows, candidatePool: attempt.innerLimit };
      });
      expect(result).toEqual(rows);
      expect(attempts.map(a => a.scopeScan ? 'scan' : 'walk')).toEqual(['scan', 'walk']);
      expect(attempts.every(a => a.remainingMs === 2_000 && !a.exact)).toBe(true);
    });
  }

  test('a failed scan retains walk widening and then falls to the joined pool', async () => {
    const attempts: VectorPoolAttempt[] = [];
    const result = await searchIndexWalk(statement(), 20, async attempt => {
      attempts.push(attempt);
      if (attempt.scopeScan) throw timeout();
      return { rows: [], candidatePool: attempt.innerLimit, eligiblePool: attempt.innerLimit };
    });
    expect(result).toBeNull();
    expect(attempts.map(a => [a.scopeScan ? 'scan' : 'walk', a.innerLimit])).toEqual([
      ['scan', 100], ['walk', 100], ['walk', 400], ['walk', 1_600],
    ]);
  });

  test('true scan exhaustion answers and unrelated errors still propagate', async () => {
    const attempts: VectorPoolAttempt[] = [];
    expect(await searchIndexWalk(statement(), 20, async a => {
      attempts.push(a);
      return { rows: [], candidatePool: 0 };
    })).toEqual([]);
    expect(attempts).toHaveLength(1);
    await expect(searchIndexWalk(statement(), 20, async () => { throw new Error('storage unavailable'); })).rejects.toThrow('storage unavailable');
  });

  test('narrow scopes and type/date/legacy-guard searches do not gain a walk', () => {
    expect(statement(0.01).indexWalkSql).toBeUndefined();
    for (const filter of [{ type: 'note' }, { afterDate: '2026-01-01' }, { vectorLegacyGuard: true }]) {
      expect(buildVectorSearchStatement({ dialect: 'postgres', embedding: new Float32Array(1024), limit: 20, offset: 0,
        opts: { ...opts, ...filter }, scope: { share: 0.16, chunks: 20_000 } }).indexWalkSql).toBeUndefined();
    }
  });
});
