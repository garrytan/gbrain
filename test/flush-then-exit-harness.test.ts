/**
 * #2084 (D10) — flushThenExit proven on a real spawned Bun process.
 *
 * The unit tests in cli-finish-teardown.test.ts inject fake streams; they
 * prove the helper's logic but not Bun's actual pipe behavior (does an empty
 * write('', cb) really fence all prior buffered chunks?). These tests spawn
 * test/fixtures/flush-then-exit-harness.ts and assert:
 *   1. multi-MB piped stdout arrives byte-complete with the right exit code
 *      even when the reader attaches late (#1959 truncation regression pin);
 *   2. with empty buffers the fence resolves promptly — the process does NOT
 *      sit out the flush guard (canary for Bun eliding empty-write callbacks).
 */

import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import { resolve } from 'path';

const HARNESS = resolve(import.meta.dir, 'fixtures', 'flush-then-exit-harness.ts');

function runHarness(env: Record<string, string>, readerDelayMs: number): Promise<{
  bytes: number;
  code: number | null;
  durationMs: number;
}> {
  return new Promise((resolveOut, reject) => {
    const t0 = Date.now();
    const child = spawn('bun', ['run', HARNESS], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let bytes = 0;
    child.stdout.pause();
    setTimeout(() => {
      child.stdout.on('data', (d: Buffer) => (bytes += d.length));
      child.stdout.resume();
    }, readerDelayMs);
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`harness did not exit (bytes so far: ${bytes})`));
    }, 30_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolveOut({ bytes, code, durationMs: Date.now() - t0 });
    });
  });
}

describe('flushThenExit on a real Bun process (D10)', () => {
  test('4MB piped stdout arrives byte-complete with the exit code, late reader', async () => {
    // Bun delivers queued pipe writes only while the process is alive (see the
    // cli-force-exit.ts module header). The reader attaches 200ms late; the
    // 1500ms aliveness grace must cover attach + transfer. Pre-#2084 (immediate
    // process.exit, no grace) this received 0 of the 4MB — verified during
    // implementation; that is the #1959 truncation class.
    const SIZE = 4_000_000;
    const { bytes, code } = await runHarness(
      {
        HARNESS_BYTES: String(SIZE),
        HARNESS_EXIT_CODE: '7',
        HARNESS_GUARD_MS: '2000',
        HARNESS_GRACE_MS: '1500',
      },
      200,
    );
    expect(bytes).toBe(SIZE);
    expect(code).toBe(7);
  }, 40_000);

  test('default grace: small output survives exit with a concurrent reader', async () => {
    // No HARNESS_GRACE_MS → production default (non-TTY grace). Immediate
    // reader, 100-byte output: must arrive complete. Pre-#2084 even this case
    // lost ALL bytes when exit fired before a loop turn.
    const { bytes, code } = await runHarness(
      { HARNESS_BYTES: '100', HARNESS_EXIT_CODE: '0', HARNESS_GUARD_MS: '2000' },
      0,
    );
    expect(bytes).toBe(100);
    expect(code).toBe(0);
  }, 40_000);

  test('fence resolves promptly — wall time well under guard + grace ceiling', async () => {
    // Guard 8s, grace 250ms: if Bun ever elides the empty-write callback, the
    // process sits out the full guard and wall time exceeds it. A working
    // fence exits in startup time + grace (~1-2s).
    const { code, durationMs } = await runHarness(
      {
        HARNESS_BYTES: '100',
        HARNESS_EXIT_CODE: '0',
        HARNESS_GUARD_MS: '8000',
        HARNESS_GRACE_MS: '250',
      },
      0,
    );
    expect(code).toBe(0);
    expect(durationMs).toBeLessThan(6_000);
  }, 40_000);
});
