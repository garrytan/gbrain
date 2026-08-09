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

import { afterEach, describe, it, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

describe('run-unit-shard.sh --isolate-files', () => {
  let fakeBin = '';

  afterEach(() => {
    if (fakeBin) rmSync(fakeBin, { recursive: true, force: true });
    fakeBin = '';
  });

  function setup(files: string[]) {
    fakeBin = mkdtempSync(join(tmpdir(), 'gbrain-unit-shard-bin-'));
    const log = join(fakeBin, 'bun.log');
    const fakeFind = join(fakeBin, 'find');
    const fakeBun = join(fakeBin, 'bun');
    writeFileSync(fakeFind, `#!/usr/bin/env bash\nprintf '%s\\n' ${files.map(f => JSON.stringify(f)).join(' ')}\n`);
    writeFileSync(fakeBun, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_BUN_LOG"\ncase "$*" in\n  *fail.test.ts*) exit 1 ;;\nesac\n`);
    chmodSync(fakeFind, 0o755);
    chmodSync(fakeBun, 0o755);
    return { log };
  }

  function run(args: string[], log: string) {
    return spawnSync('bash', [SHARD_SH, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        SHARD: '',
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_BUN_LOG: log,
      },
    });
  }

  it('runs each file in its own Bun process with the requested concurrency cap', () => {
    const { log } = setup(['test/fake-a.test.ts', 'test/fake-b.test.ts']);
    const result = run(['--isolate-files', '--max-concurrency=1'], log);
    expect(result.status).toBe(0);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'test --max-concurrency=1 --timeout=60000 test/fake-a.test.ts',
      'test --max-concurrency=1 --timeout=60000 test/fake-b.test.ts',
    ]);
  });

  it('omits the concurrency flag when no cap was requested', () => {
    const { log } = setup(['test/fake-a.test.ts']);
    const result = run(['--isolate-files'], log);
    expect(result.status).toBe(0);
    expect(readFileSync(log, 'utf8').trim()).toBe(
      'test --timeout=60000 test/fake-a.test.ts',
    );
  });

  it('continues after failures and reports every failed file with a nonzero exit', () => {
    const { log } = setup([
      'test/first-fail.test.ts',
      'test/later-pass.test.ts',
      'test/second-fail.test.ts',
    ]);
    const result = run(['--isolate-files'], log);
    expect(result.status).toBe(1);
    expect(readFileSync(log, 'utf8')).toContain('test/later-pass.test.ts');
    expect(result.stderr).toContain('2 file(s) failed');
    expect(result.stderr).toContain('test/first-fail.test.ts');
    expect(result.stderr).toContain('test/second-fail.test.ts');
  });
});
