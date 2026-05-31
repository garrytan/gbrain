import { describe, expect, test } from 'bun:test';
import { parseShardEnv, selectShardFiles, stableShardIndex } from '../scripts/ci-test-shard.ts';

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
      expect(selectShardFiles(files, { shard: stableShardIndex(file, 4) + 1, total: 4 })).toContain(file);
      expect(selectShardFiles(reversed, { shard: stableShardIndex(file, 4) + 1, total: 4 })).toContain(file);
    }
  });

  test('rejects invalid shard environment values', () => {
    expect(() => parseShardEnv({ TEST_SHARD_INDEX: '0', TEST_SHARD_TOTAL: '4' })).toThrow(/TEST_SHARD_INDEX/);
    expect(() => parseShardEnv({ TEST_SHARD_INDEX: '5', TEST_SHARD_TOTAL: '4' })).toThrow(/TEST_SHARD_INDEX/);
    expect(() => parseShardEnv({ TEST_SHARD_INDEX: '1', TEST_SHARD_TOTAL: '0' })).toThrow(/TEST_SHARD_TOTAL/);
    expect(() => parseShardEnv({ TEST_SHARD_INDEX: 'one', TEST_SHARD_TOTAL: '4' })).toThrow(/TEST_SHARD_INDEX/);
  });
});
