import { describe, expect, test } from 'bun:test';
import { buildShardSpecs, resolveWorkerCount } from '../scripts/run-unit-tests.ts';

describe('run-unit-tests', () => {
  test('defaults to bounded local parallelism', () => {
    expect(resolveWorkerCount({}, 12)).toBe(4);
    expect(resolveWorkerCount({}, 2)).toBe(2);
    expect(resolveWorkerCount({}, 1)).toBe(1);
  });

  test('accepts TEST_WORKERS override', () => {
    expect(resolveWorkerCount({ TEST_WORKERS: '3' }, 12)).toBe(3);
    expect(resolveWorkerCount({ TEST_WORKERS: '8' }, 12)).toBe(8);
  });

  test('rejects invalid TEST_WORKERS override', () => {
    expect(() => resolveWorkerCount({ TEST_WORKERS: '0' }, 12)).toThrow(/TEST_WORKERS/);
    expect(() => resolveWorkerCount({ TEST_WORKERS: 'nope' }, 12)).toThrow(/TEST_WORKERS/);
  });

  test('builds one-based shard specs', () => {
    expect(buildShardSpecs(3)).toEqual([
      { shard: 1, total: 3 },
      { shard: 2, total: 3 },
      { shard: 3, total: 3 },
    ]);
  });
});
