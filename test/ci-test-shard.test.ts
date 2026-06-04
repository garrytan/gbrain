import { describe, expect, test } from 'bun:test';
import {
  partitionTestFiles,
  parseShardEnv,
  selectShardFiles,
  stableShardIndex,
  toBunTestFileArg,
} from '../scripts/ci-test-shard.ts';

describe('ci-test-shard', () => {
  test('partitions every file into exactly one stable shard', () => {
    const files = [
      'test/a.test.ts',
      'test/b.test.ts',
      'test/c.test.ts',
      'test/nested/d.test.ts',
      'test/nested/e.test.ts',
      'test/nested/f.test.ts',
    ];

    const selected = new Set<string>();
    for (let shard = 1; shard <= 3; shard++) {
      const shardFiles = selectShardFiles(files, { shard, total: 3 });
      expect(shardFiles.length).toBeGreaterThan(0);
      for (const file of shardFiles) {
        expect(selected.has(file)).toBe(false);
        selected.add(file);
      }
    }

    expect([...selected].sort()).toEqual([...files].sort());
  });

  test('keeps shard assignment independent of input order', () => {
    const files = [
      'test/slow-memory-inbox-engine.test.ts',
      'test/context-map-engine.test.ts',
      'test/e2e/local-sqlite-cli.test.ts',
      'test/scenarios/s07-supersession-cross-engine.test.ts',
    ];
    const reversed = [...files].reverse();

    for (const file of files) {
      expect(stableShardIndex(file, 4)).toBe(stableShardIndex(file, 4));
    }

    for (let shard = 1; shard <= 4; shard++) {
      expect(selectShardFiles(files, { shard, total: 4 })).toEqual(
        selectShardFiles(reversed, { shard, total: 4 }),
      );
    }
  });

  test('balances weighted files while keeping deterministic assignments', () => {
    const files = [
      'test/tiny-a.test.ts',
      'test/tiny-b.test.ts',
      'test/large-a.test.ts',
      'test/large-b.test.ts',
      'test/medium.test.ts',
    ];
    const weights = new Map([
      ['test/large-a.test.ts', 20],
      ['test/large-b.test.ts', 20],
      ['test/medium.test.ts', 10],
      ['test/tiny-a.test.ts', 1],
      ['test/tiny-b.test.ts', 1],
    ]);

    const partitions = partitionTestFiles([...files].reverse(), 2, {
      weightForFile: file => weights.get(file) ?? 1,
    });

    expect(partitions).toHaveLength(2);
    expect(new Set(partitions.flat())).toEqual(new Set(files));
    expect(partitions[0]).toContain('test/large-a.test.ts');
    expect(partitions[1]).toContain('test/large-b.test.ts');
    expect(selectShardFiles(files, { shard: 1, total: 2 }, {
      weightForFile: file => weights.get(file) ?? 1,
    })).toEqual(partitions[0]);
  });

  test('rejects invalid shard environment values', () => {
    expect(() => parseShardEnv({ TEST_SHARD_INDEX: '0', TEST_SHARD_TOTAL: '4' })).toThrow(/TEST_SHARD_INDEX/);
    expect(() => parseShardEnv({ TEST_SHARD_INDEX: '5', TEST_SHARD_TOTAL: '4' })).toThrow(/TEST_SHARD_INDEX/);
    expect(() => parseShardEnv({ TEST_SHARD_INDEX: '1', TEST_SHARD_TOTAL: '0' })).toThrow(/TEST_SHARD_TOTAL/);
    expect(() => parseShardEnv({ TEST_SHARD_INDEX: 'one', TEST_SHARD_TOTAL: '4' })).toThrow(/TEST_SHARD_INDEX/);
  });

  test('formats shard files as explicit relative paths for Bun exact matching', () => {
    expect(toBunTestFileArg('test/doctor.test.ts')).toBe('./test/doctor.test.ts');
    expect(toBunTestFileArg('./test/doctor.test.ts')).toBe('./test/doctor.test.ts');
  });
});
