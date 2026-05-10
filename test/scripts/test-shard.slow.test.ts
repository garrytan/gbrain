/**
 * Regression test: scripts/test-shard.sh exclusion symmetry.
 *
 * Pins the contract that CI's hash-bucketed shard script EXCLUDES
 * *.serial.test.ts and test/e2e/ from every shard. Serial files share
 * file-wide state (top-level mock.module, module singletons) that leaks
 * across files in the same `bun test` shard process. Before v0.31.4.1
 * they were hashed into the same buckets as parallel files, which broke
 * the quarantine — `eval-takes-quality-runner.serial.test.ts` stubbed
 * `gateway.ts` and broke every `gateway.embedMultimodal` test in
 * `voyage-multimodal.test.ts` on shard 2.
 *
 * Without this guard, a future refactor that drops the `-not -name
 * '*.serial.test.ts'` clause from test-shard.sh would silently undo the
 * fix and re-introduce the contention flake.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/test-shard.sh');

// Pure-bash FNV-1a per shard takes ~4s on a M-series Mac because the script
// computes a hash for every test file. Compute all 4 shards once in beforeAll
// and reuse across cases so the suite finishes in one shell-out per shard.
const shardCache: Record<number, string[]> = {};

function dryRunList(shard: number, total: number): string[] {
  if (shardCache[shard]) return shardCache[shard];
  const out = execFileSync('bash', [SHARD_SH, '--dry-run-list', String(shard), String(total)], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  shardCache[shard] = out.split('\n').map(s => s.trim()).filter(Boolean);
  return shardCache[shard];
}

describe('test-shard.sh exclusion symmetry', () => {
  beforeAll(() => {
    for (const shard of [1, 2, 3, 4]) dryRunList(shard, 4);
  }, 60_000);
  it('includes plain *.test.ts files in at least one shard', () => {
    const allFiles = [1, 2, 3, 4].flatMap(s => dryRunList(s, 4));
    expect(allFiles.length).toBeGreaterThan(0);
    expect(allFiles.some(f => /\.test\.ts$/.test(f) && !/\.serial\.test\.ts$/.test(f))).toBe(true);
  });

  it('excludes every *.serial.test.ts file from every shard', () => {
    for (const shard of [1, 2, 3, 4]) {
      const files = dryRunList(shard, 4);
      const leaks = files.filter(f => /\.serial\.test\.ts$/.test(f));
      expect(leaks, `shard ${shard} contains serial files`).toEqual([]);
    }
  });

  it('excludes the test/e2e/ subtree from every shard', () => {
    for (const shard of [1, 2, 3, 4]) {
      const files = dryRunList(shard, 4);
      const leaks = files.filter(f => f.startsWith('test/e2e/'));
      expect(leaks, `shard ${shard} contains e2e files`).toEqual([]);
    }
  });

  it('partitions plain files across shards without overlap', () => {
    const seen = new Map<string, number>();
    for (const shard of [1, 2, 3, 4]) {
      for (const f of dryRunList(shard, 4)) {
        if (seen.has(f)) {
          throw new Error(`file ${f} appears in shard ${seen.get(f)} AND shard ${shard}`);
        }
        seen.set(f, shard);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});
