/**
 * The exit seam ends as soon as piped output is delivered (real Bun pipes).
 *
 * flushThenExit used to sleep the full non-TTY grace (250ms) on every exit.
 * Now process.stdout's one-shot writes go through the fd-1 write chain and
 * process.stderr's native-writer queue is tracked (Bun 1.4: write() returns
 * false exactly when bytes stayed queued, 'drain' fires when the queue empties),
 * so the process exits right after the fence when nothing is queued and at the
 * stream's 'drain' when something is. The grace is set to 5s here: a run that
 * still slept it would take 5s or more, so the duration bounds below separate
 * the two behaviors by a wide margin, and every case also checks that no byte
 * was lost.
 */

import { describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { resolve } from 'path';

const HARNESS = resolve(import.meta.dir, 'fixtures', 'exit-drain-harness.ts');
const GRACE_MS = 5_000;

function runHarness(env: Record<string, string>, readerDelayMs: number): Promise<{
  stdout: number;
  stderr: number;
  code: number | null;
  durationMs: number;
}> {
  return new Promise((resolveOut, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HARNESS], {
      env: { ...process.env, GBRAIN_FLUSH_GRACE_MS: String(GRACE_MS), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = 0;
    let stderr = 0;
    child.stdout.pause();
    child.stderr.pause();
    setTimeout(() => {
      child.stdout.on('data', (d: Buffer) => (stdout += d.length));
      child.stderr.on('data', (d: Buffer) => (stderr += d.length));
      child.stdout.resume();
      child.stderr.resume();
    }, readerDelayMs);
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`harness did not exit (stdout ${stdout}, stderr ${stderr})`));
    }, 30_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolveOut({ stdout, stderr, code, durationMs: Date.now() - t0 });
    });
  });
}

describe('exit seam waits for delivery, not a fixed grace (real Bun pipes)', () => {
  test('nothing queued: exits right after the fence, output complete', async () => {
    const run = await runHarness({ HARNESS_STDOUT_BYTES: '100', HARNESS_STDERR_BYTES: '100', HARNESS_EXIT_CODE: '3' }, 0);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe(100);
    expect(run.stderr).toBe(100);
    expect(run.durationMs).toBeLessThan(GRACE_MS / 2);
  }, 40_000);

  test('stderr past the pipe buffer with a late reader: waits for drain, then exits', async () => {
    const size = 1_000_000;
    const run = await runHarness({ HARNESS_STDERR_BYTES: String(size), HARNESS_EXIT_CODE: '0' }, 300);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe(size);
    expect(run.durationMs).toBeLessThan(GRACE_MS / 2 + 300);
  }, 40_000);

  test('stdout past the pipe buffer with a late reader: the write chain delivers it, then exits', async () => {
    const size = 1_000_000;
    const run = await runHarness({ HARNESS_STDOUT_BYTES: String(size), HARNESS_EXIT_CODE: '0' }, 300);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(size);
    expect(run.durationMs).toBeLessThan(GRACE_MS / 2 + 300);
  }, 40_000);
});
