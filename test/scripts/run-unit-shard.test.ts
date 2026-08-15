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
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

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

describe('run-unit-shard.sh bounded batches', () => {
  it('starts a fresh Bun process for each requested file batch', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-unit-batches-'));
    try {
      const scriptsDir = join(root, 'scripts');
      const testsDir = join(root, 'test');
      const binDir = join(root, 'bin');
      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(testsDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      copyFileSync(SHARD_SH, join(scriptsDir, 'run-unit-shard.sh'));

      const testFiles = ['a', 'b', 'c', 'd', 'e'].map(name => `test/${name}.test.ts`);
      for (const file of testFiles) writeFileSync(join(root, file), '');

      const invocationLog = join(root, 'bun-invocations.log');
      const fakeBun = join(binDir, 'bun');
      writeFileSync(fakeBun, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BUN_LOG"\n');
      chmodSync(fakeBun, 0o755);

      execFileSync('bash', [join(scriptsDir, 'run-unit-shard.sh'), '--batch-size=2', '--max-concurrency=1'], {
        cwd: root,
        env: { ...process.env, BUN_LOG: invocationLog, PATH: `${binDir}:${process.env.PATH}`, SHARD: '' },
      });

      const invocations = readFileSync(invocationLog, 'utf-8').trim().split('\n');
      expect(invocations).toHaveLength(3);
      expect(invocations.map(line => line.match(/test\/[a-e]\.test\.ts/g)?.length)).toEqual([2, 2, 1]);
      expect(invocations.every(line => line.startsWith('test --max-concurrency=1 --timeout=60000 '))).toBe(true);
      expect(invocations.flatMap(line => line.match(/test\/[a-e]\.test\.ts/g) ?? [])).toEqual(testFiles);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
