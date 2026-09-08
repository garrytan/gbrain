/**
 * Regression test (b): scripts/run-unit-shard.sh exclusion symmetry.
 *
 * Pins the contract that the local fast-loop unit-shard script:
 *   1. EXCLUDES *.slow.test.ts (those run via scripts/run-slow-tests.sh).
 *   2. EXCLUDES *.serial.test.ts (those run via scripts/run-serial-tests.sh
 *      after the parallel pass).
 *   3. Includes plain *.test.ts files (the fast-loop unit set).
 *
 * Without this guard, a future refactor that drops one of the `-not -name`
 * clauses from the find expression would cause slow OR serial files to
 * run inside the parallel pass — silently undoing the quarantine and
 * re-introducing the contention flakes that motivated v0.26.4.
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');

function dryRunList(): string[] {
  const out = execFileSync('bash', [SHARD_SH, '--dry-run-list'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '' },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

describe('run-unit-shard.sh exclusion symmetry', () => {
  it('lists at least one plain *.test.ts file', () => {
    const files = dryRunList();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => /\.test\.ts$/.test(f) && !/\.(slow|serial)\.test\.ts$/.test(f))).toBe(true);
  });

  it('excludes every *.slow.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.slow\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes every *.serial.test.ts file', () => {
    const files = dryRunList();
    const leaks = files.filter(f => /\.serial\.test\.ts$/.test(f));
    expect(leaks).toEqual([]);
  });

  it('excludes the test/e2e/ subtree', () => {
    const files = dryRunList();
    const leaks = files.filter(f => f.startsWith('test/e2e/'));
    expect(leaks).toEqual([]);
  });
});

describe('run-unit-shard.sh timeout multiplier reach', () => {
  // GBRAIN_TEST_TIMEOUT_MULTIPLIER scales bun's `--timeout`, which only sets
  // the DEFAULT per-test ceiling — an explicit `test(name, fn, N)` third
  // argument overrides it and stays fixed under 4-way container contention.
  // Files that spawn the CLI through test/helpers/cli-spawn.ts are the ones
  // the multiplier exists for (a full `bun src/cli.ts` boot, often a PGLite
  // cold start), and cli-spawn's own kill timer already reaps a hung child,
  // so a hand-pinned ceiling below the runner default only hides the file
  // from the multiplier (#4659). Pins at/above the default are left alone.
  it('cli-spawn consumers pin no per-test timeout below the bunfig default', () => {
    const bunfig = readFileSync(resolve(REPO_ROOT, 'bunfig.toml'), 'utf-8');
    const defaultMs = Number(/^timeout\s*=\s*([\d_]+)/m.exec(bunfig)![1].replace(/_/g, ''));
    const offenders: string[] = [];
    for (const file of dryRunList()) {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
      if (!src.includes('helpers/cli-spawn')) continue;
      // Trailing numeric literal (>= 4 digits) as a call's last argument.
      for (const m of src.matchAll(/,\s*(\d[\d_]{3,})\s*\)\s*;/g)) {
        const ms = Number(m[1].replace(/_/g, ''));
        if (ms < defaultMs) offenders.push(`${file}: ${m[0].trim()} (< ${defaultMs})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
