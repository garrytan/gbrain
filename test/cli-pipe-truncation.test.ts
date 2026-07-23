/**
 * v0.43 (#2084) — real-CLI pipe completeness pin (the incident #1959 class).
 *
 * The synthetic flush-mechanism coverage lives in
 * test/flush-then-exit-harness.test.ts (4MB late-reader byte-complete pin).
 * This file keeps the IMPLEMENTATION-AGNOSTIC check: the actual CLI, run the
 * way agents run it (piped stdout), produces complete, parseable, byte-stable
 * output and exits deliberately — well under the teardown backstop.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');

describe('cli pipe completeness — deliberate exit never truncates piped stdout (#2084)', () => {
  test('real CLI: --tools-json over a pipe is complete, parseable, byte-stable, and prompt', () => {
    const run = () => {
      const t0 = Date.now();
      const res = spawnSync('bun', [CLI, '--tools-json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status, ms: Date.now() - t0 };
    };
    const first = run();
    expect(first.status).toBe(0);
    expect(Buffer.byteLength(first.stdout, 'utf-8')).toBeGreaterThan(16 * 1024);
    // Truncated JSON does not parse — the strongest single-run completeness check.
    const parsed = JSON.parse(first.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    // Deliberate exit, not the teardown backstop. A wall-clock bound is flaky
    // on cold CI (bun parse alone runs 10-20s there) — the backstop's banner
    // is the truthful signal, same assertion the pgbouncer e2e uses.
    expect(first.stderr).not.toContain('force-exiting');
    expect(first.stderr).not.toContain('did not return within');

    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  }, 180_000);
});
