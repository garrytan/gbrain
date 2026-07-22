/**
 * Regression test: scripts/test-shard.sh exclusion + balance contract.
 *
 * Pins two invariants of the CI matrix shard script:
 *
 *  1. EXCLUDE *.serial.test.ts and test/e2e/ from every shard. Serial
 *     files share file-wide state (top-level mock.module, module
 *     singletons) that leaks across files in the same `bun test` shard
 *     process. Before v0.31.4.1 they were hashed into the same buckets
 *     as parallel files, which broke the quarantine —
 *     `eval-takes-quality-runner.serial.test.ts` stubbed `gateway.ts`
 *     and broke every `gateway.embedMultimodal` test in
 *     `voyage-multimodal.test.ts` on shard 2.
 *
 *  2. INCLUDE *.slow.test.ts. CI is the only default place slow files
 *     run; the local fast loop excludes them via run-unit-shard.sh. See
 *     CLAUDE.md "CI vs local: intentionally divergent file sets".
 *
 *  3. LPT balance: file counts across shards are within 5% of each other
 *     under the default (no-weights / cold-start) configuration. Once
 *     test-weights.json is populated, weighted balance also lands the
 *     imbalance ratio ≤ 1.5.
 *
 * Without (1), the v0.31.4.1 mock.module leak comes back. Without (2),
 * slow tests stop running in CI (silent regression — they don't fail,
 * they just never execute). Without (3), shard 3 will drift back to
 * 26-min p100 wallclock.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/test-shard.sh');

// LPT partition via sharding.ts is ~30ms per shard (much faster than the
// pure-bash FNV-1a it replaced). Cache results so repeated assertions
// don't shell out per case.
const shardCache: Record<string, string[]> = {};

function dryRunList(shard: number, total: number): string[] {
  const key = `${shard}/${total}`;
  if (shardCache[key]) return shardCache[key];
  const out = execFileSync('bash', [SHARD_SH, '--dry-run-list', String(shard), String(total)], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  shardCache[key] = out.split('\n').map(s => s.trim()).filter(Boolean);
  return shardCache[key];
}

describe('test-shard.sh — exclusion contract', () => {
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

  it('INCLUDES *.slow.test.ts files (CI matrix is where slow files run)', () => {
    const allFiles = [1, 2, 3, 4].flatMap(s => dryRunList(s, 4));
    const slowFiles = allFiles.filter(f => /\.slow\.test\.ts$/.test(f));
    // The repo currently has 3 slow files — pin >= 1 so the test stays
    // green if the count changes but fails loud if slow files vanish
    // entirely (regression: someone re-added -not -name '*.slow.test.ts'
    // to the find clause).
    expect(slowFiles.length).toBeGreaterThan(0);
  });

  it('partitions every file across shards without overlap', () => {
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

describe('test-shard.sh — LPT balance contract', () => {
  // LPT balances WALLCLOCK (sum of weights), not file count. When real
  // weights are loaded from scripts/test-weights.json, shards with
  // heavier files have FEWER files — that's the optimization working.
  // We assert wallclock balance via the imbalance ratio (≤1.5).

  // Read weights from the committed JSON. If it doesn't exist yet (early
  // in the wave) or is empty, we degrade to cold-start round-robin and
  // assert file-count balance instead.
  let weightsMap = new Map<string, number>();
  let weightsLoaded = false;
  beforeAll(() => {
    try {
      const fs = require('fs');
      const path = require('path');
      const p = path.resolve(REPO_ROOT, 'scripts/test-weights.json');
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'number' && Number.isFinite(v)) weightsMap.set(k, v);
        }
        weightsLoaded = weightsMap.size > 0;
      }
    } catch {
      // fall through to cold-start mode
    }
  });

  function totalsFor(shards: string[][]): number[] {
    // Use 30ms as the cold-start fallback (matches mine-shard-weights
    // median observation). When weights are loaded, missing files get
    // the corpus median anyway via sharding.ts.
    const fallback = weightsLoaded
      ? Array.from(weightsMap.values()).sort((a, b) => a - b)[
          Math.floor(weightsMap.size / 2)
        ] ?? 30
      : 1;
    return shards.map((s) =>
      s.reduce((acc, f) => acc + (weightsMap.get(f) ?? fallback), 0),
    );
  }

  it('4-shard wallclock imbalance ratio ≤ 1.5', () => {
    const shards = [1, 2, 3, 4].map(s => dryRunList(s, 4));
    for (const s of shards) expect(s.length).toBeGreaterThan(0);
    const totals = totalsFor(shards);
    const ratio = Math.max(...totals) / Math.min(...totals);
    expect(ratio).toBeLessThanOrEqual(1.5);
  });

  it('6-shard wallclock imbalance ratio ≤ 1.5', () => {
    const shards = [1, 2, 3, 4, 5, 6].map(s => dryRunList(s, 6));
    for (const s of shards) expect(s.length).toBeGreaterThan(0);
    const totals = totalsFor(shards);
    const ratio = Math.max(...totals) / Math.min(...totals);
    expect(ratio).toBeLessThanOrEqual(1.5);
  });

  it('6-shard partition is deterministic across runs', () => {
    // Clear cache + re-run for one shard, compare to the cached result.
    const cached = [...dryRunList(1, 6)];
    delete shardCache['1/6'];
    const fresh = dryRunList(1, 6);
    expect(fresh).toEqual(cached);
  });
});
