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
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
