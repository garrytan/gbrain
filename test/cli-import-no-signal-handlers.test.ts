/**
 * Regression pins for the local-lane green wave's two harness contracts.
 *
 * 1. Importing src/cli.ts as a MODULE must not install process-cleanup's
 *    SIGTERM/SIGHUP→exit handlers. The install lives inside the
 *    `import.meta.main` seam; at module load it leaked a process-wide
 *    SIGTERM→exit(143) handler into any importer — in a bun test runner,
 *    one test's synthetic `process.emit('SIGTERM')` then killed the whole
 *    shard, which the parallel runner misread as an external kill. The
 *    one test that used to die on this (run-child-entry) now shields
 *    itself by stripping foreign listeners, so THIS pin is the only
 *    thing that fails if the install moves back to module scope.
 *
 * 2. test/helpers/gbrain-home-preload.ts sets GBRAIN_HOME to per-run
 *    scratch when unset and respects a pre-set value. Every unit test's
 *    isolation from the operator's real ~/.gbrain depends on it.
 *
 * Both pins spawn a fresh bun process: the contracts are about
 * process-start module-load behavior, which can't be observed in-process.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

const REPO = join(import.meta.dir, '..');

function runBunEval(script: string, env: Record<string, string | undefined>): string {
  const res = spawnSync('bun', ['-e', script], {
    encoding: 'utf-8',
    timeout: 60_000,
    cwd: REPO,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
  });
  return (res.stdout ?? '').trim();
}

describe('cli.ts module-import signal-handler contract', () => {
  test('importing cli.ts does NOT install SIGTERM/SIGHUP handlers (import.meta.main seam)', () => {
    const script = [
      `await import(${JSON.stringify(join(REPO, 'src', 'cli.ts'))});`,
      // Give any microtask-deferred module init a tick before counting.
      `await new Promise((r) => setTimeout(r, 50));`,
      `console.log(JSON.stringify({ sigterm: process.listenerCount('SIGTERM'), sighup: process.listenerCount('SIGHUP') }));`,
    ].join('\n');
    const out = runBunEval(script, {});
    const lines = out.split('\n').filter((l) => l.trim().startsWith('{'));
    const counts = JSON.parse(lines[lines.length - 1]) as { sigterm: number; sighup: number };
    // zombie-reap's SIGCHLD handler is expected at module scope (tracked as a
    // TODOS follow-up); SIGTERM/SIGHUP from process-cleanup must NOT be.
    expect(counts.sigterm).toBe(0);
    expect(counts.sighup).toBe(0);
  });
});

describe('gbrain-home-preload contract', () => {
  const PRELOAD = join(REPO, 'test', 'helpers', 'gbrain-home-preload.ts');

  test('sets GBRAIN_HOME to per-run scratch when unset', () => {
    const script = [
      `await import(${JSON.stringify(PRELOAD)});`,
      `console.log(JSON.stringify({ home: process.env.GBRAIN_HOME ?? null }));`,
    ].join('\n');
    const out = runBunEval(script, { GBRAIN_HOME: undefined });
    const parsed = JSON.parse(out.split('\n').pop()!) as { home: string | null };
    expect(parsed.home).not.toBeNull();
    expect(parsed.home!).toContain('gbrain-test-home-');
  });

  test('respects a pre-set GBRAIN_HOME (the e2e wrapper sets its own)', () => {
    const script = [
      `await import(${JSON.stringify(PRELOAD)});`,
      `console.log(JSON.stringify({ home: process.env.GBRAIN_HOME ?? null }));`,
    ].join('\n');
    const out = runBunEval(script, { GBRAIN_HOME: '/tmp/gbrain-preload-preset-pin' });
    const parsed = JSON.parse(out.split('\n').pop()!) as { home: string | null };
    expect(parsed.home).toBe('/tmp/gbrain-preload-preset-pin');
  });
});
