import { describe, expect, test } from 'bun:test';
import { failingFiles, planShard, reproduceCommand } from '../../scripts/order-hunt.ts';

const files = Array.from({ length: 40 }, (_, i) => `test/e2e/f${String(i).padStart(2, '0')}.test.ts`);

describe('order hunt plan', () => {
  test('shards partition the corpus exactly once, deterministically per seed', () => {
    const shards = [1, 2, 3, 4].map(k => planShard(files, 7, k, 4));
    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(new Set(shards.flat()).size).toBe(files.length);
    expect(planShard(files, 7, 2, 4)).toEqual(shards[1]);
    expect(planShard([...files].reverse(), 7, 2, 4)).toEqual(shards[1]);
  });

  test('a different seed gives a different order', () => {
    expect(planShard(files, 1, 1, 1)).not.toEqual(planShard(files, 2, 1, 1));
    expect(planShard(files, 1, 1, 1)).not.toEqual([...files].sort());
  });
});

describe('order hunt classify helpers', () => {
  test('reads run-e2e.sh failing-file block', () => {
    const log = 'noise\n\nFailing files:\n  - a.test.ts\n  - b.test.ts\n\ntrailer\n';
    expect(failingFiles(log)).toEqual(['a.test.ts', 'b.test.ts']);
    expect(failingFiles('all green\n')).toEqual([]);
  });

  test('the reproduce command replays the exact order up to the failing file', () => {
    expect(reproduceCommand(['test/e2e/x.test.ts', 'test/e2e/y.test.ts', 'test/e2e/z.test.ts'], 'test/e2e/y.test.ts'))
      .toBe('bash scripts/run-e2e.sh test/e2e/x.test.ts test/e2e/y.test.ts');
  });
});
