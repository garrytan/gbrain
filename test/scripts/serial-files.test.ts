/**
 * Regression test (e): scripts/run-serial-tests.sh discovery + concurrency=1.
 *
 * Pins the contract that:
 *   1. Every *.serial.test.ts file IS picked up by run-serial-tests.sh.
 *   2. The script invokes `bun test` with `--max-concurrency=1` (the
 *      serial-pass guarantee — quarantined files MUST NOT run intra-file
 *      concurrent or they reintroduce the contention flakes that
 *      motivated quarantining them).
 *   3. The serial set is DISJOINT from run-unit-shard.sh's set (a file
 *      cannot run in both passes; the unit-shard test pins one half,
 *      this test pins the other).
 *
 * Without these guards, a refactor of either runner could silently let
 * .serial files run alongside the parallel pass (= contention flakes)
 * or be skipped entirely (= no test coverage at all).
 */

import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { checkSerialManifest } from '../../scripts/lib/serial-manifest.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SERIAL_SH = resolve(REPO_ROOT, 'scripts/run-serial-tests.sh');
const SHARD_SH = resolve(REPO_ROOT, 'scripts/run-unit-shard.sh');

function dryRunList(scriptPath: string): string[] {
  const out = execFileSync('bash', [scriptPath, '--dry-run-list'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SHARD: '' },
  });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

describe('run-serial-tests.sh contract', () => {
  it('discovers every *.serial.test.ts file', () => {
    const serialFiles = dryRunList(SERIAL_SH);
    // Every file the script lists must end in .serial.test.ts.
    const offenders = serialFiles.filter(f => !/\.serial\.test\.ts$/.test(f));
    expect(offenders).toEqual([]);

    // Every checked-in *.serial.test.ts must be listed by the script.
    // We cross-check by globbing through git ls-files (deterministic; doesn't
    // depend on filesystem state during the test run).
    const tracked = execFileSync('git', ['ls-files', 'test'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
      .split('\n')
      .map(s => s.trim())
      .filter(f => /\.serial\.test\.ts$/.test(f) && !f.startsWith('test/e2e/'));
    for (const f of tracked) {
      expect(serialFiles).toContain(f);
    }
  });

  it('passes --max-concurrency=1 to bun test', () => {
    const src = readFileSync(SERIAL_SH, 'utf-8');
    expect(src).toMatch(/bun test\s+--max-concurrency=1/);
  });

  it('disjoint from run-unit-shard.sh (a file is never in both passes)', () => {
    const serialFiles = new Set(dryRunList(SERIAL_SH));
    const unitFiles = new Set(dryRunList(SHARD_SH));
    const overlap = [...serialFiles].filter(f => unitFiles.has(f));
    expect(overlap).toEqual([]);
  });
});

describe('EXCLUSIVE_FILES (pooled-runner opt-out) guards', () => {
  const src = () => readFileSync(SERIAL_SH, 'utf-8');
  const entries = () =>
    [...src().matchAll(/^\s*"(test\/[^"]+\.serial\.test\.ts)"\s*$/gm)].map(m => m[1]);

  it('every exclusive entry exists on disk and is discovered by the runner', () => {
    const listed = dryRunList(SERIAL_SH);
    const e = entries();
    expect(e.length).toBeGreaterThan(0);
    for (const f of e) {
      expect(existsSync(resolve(REPO_ROOT, f))).toBe(true);
      expect(listed).toContain(f);
    }
  });

  it('the exclusive list does not silently grow (quarantine-growth guard)', () => {
    // Exclusivity re-serializes the runner one file at a time — the exact
    // 8.5-minute disease the pool removed. Each entry must carry a
    // justification comment; past 4 entries, stop and rethink the design
    // (per-file PATH shims are usually the right fix) instead of quarantining.
    // The fourth entry (#7409) pins a live serve's answer inside the hook's
    // 1 s IPC timeout, which pooled neighbours starve.
    expect(entries().length).toBeLessThanOrEqual(4);
  });

  it('a missing exit sentinel is a failure, never a silent pass', () => {
    expect(src()).toMatch(/missing exit sentinel/);
  });
});

describe('scripts/serial-files.tsv (serial lane manifest)', () => {
  const trackedSerial = () => execFileSync('git', ['ls-files', 'test'], { cwd: REPO_ROOT, encoding: 'utf-8' })
    .split('\n').map(f => f.trim()).filter(f => /\.serial\.test\.ts$/.test(f) && !f.startsWith('test/e2e/') && existsSync(resolve(REPO_ROOT, f)));
  const exclusive = () => [...readFileSync(SERIAL_SH, 'utf-8').matchAll(/^\s*"(test\/[^"]+\.serial\.test\.ts)"\s*$/gm)].map(m => m[1]);

  it('lists exactly the serial files on disk, each with a class and a real reason', () => {
    const errors = checkSerialManifest({
      manifest: readFileSync(resolve(REPO_ROOT, 'scripts/serial-files.tsv'), 'utf-8'),
      serialFiles: trackedSerial(),
      exclusiveFiles: exclusive(),
      read: path => readFileSync(resolve(REPO_ROOT, path), 'utf-8'),
    });
    expect(errors.join('\n\n')).toBe('');
  });

  const header = 'path\tclass\treason\n';
  const sources: Record<string, string> = {
    'test/env.serial.test.ts': ['process', "env.EXAMPLE_FLAG = '1';"].join('.'),
    'test/mock.serial.test.ts': ['mock', "module('../src/example.ts', () => ({}));"].join('.'),
    'test/plain.serial.test.ts': "import { test } from 'bun:test';",
  };
  const check = (manifest: string, serialFiles = Object.keys(sources), exclusiveFiles: string[] = []) =>
    checkSerialManifest({ manifest, serialFiles, exclusiveFiles, read: path => sources[path] ?? '' });
  const good = header
    + 'test/env.serial.test.ts\tR1\tR1: mutates process.env (EXAMPLE_FLAG)\n'
    + 'test/mock.serial.test.ts\tR2\tR2: module mock of ../src/example.ts replaces it for the process\n'
    + 'test/plain.serial.test.ts\tglobal-state\tglobal-state: binds a fixed local port for the fixture server\n';

  it('a complete manifest passes', () => {
    expect(check(good)).toEqual([]);
  });

  it('an unlisted serial file fails with the isolation check and the row to add', () => {
    const [error, ...rest] = check(good, [...Object.keys(sources), 'test/new.serial.test.ts']);
    expect(rest).toEqual([]);
    expect(error).toContain('test/new.serial.test.ts is a serial test file with no row');
    expect(error).toContain('Why: ');
    expect(error).toContain('Fix: bash scripts/check-test-isolation.sh --as-parallel test/new.serial.test.ts');
    expect(error).toContain('Docs: docs/TESTING.md#when-to-quarantine-instead-of-fix');
  });

  it('a listed file that no longer exists fails with the row to delete', () => {
    const [error] = check(good, ['test/env.serial.test.ts', 'test/mock.serial.test.ts']);
    expect(error).toContain('lists test/plain.serial.test.ts');
    expect(error).toContain('Fix: delete the row for test/plain.serial.test.ts');
  });

  it('boilerplate, empty and wrong-evidence rows fail', () => {
    for (const reason of ['flaky', 'R1: serial', 'TODO', '']) {
      const errors = check(good.replace('R1: mutates process.env (EXAMPLE_FLAG)', reason));
      expect(errors.some(e => e.includes('does not say what process-wide state'))).toBe(true);
    }
    expect(check(good.replace('test/plain.serial.test.ts\tglobal-state', 'test/plain.serial.test.ts\tR2')).join('\n'))
      .toContain('class R2 but the file no longer calls mock.module');
    expect(check(good.replace('test/plain.serial.test.ts\tglobal-state', 'test/plain.serial.test.ts\tslow')).join('\n'))
      .toContain('is not one of R1, R2, global-state, exclusive');
    expect(check(good, Object.keys(sources), ['test/plain.serial.test.ts']).join('\n'))
      .toContain('class exclusive must match EXCLUSIVE_FILES');
  });
});

