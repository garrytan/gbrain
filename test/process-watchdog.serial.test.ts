/**
 * Bun-pinned integration for the out-of-band watchdog (#1633, plan A4).
 *
 * Bun's worker_threads Worker is flagged "experimental", and the whole #1633
 * fix rests on a worker timer firing + SIGKILLing the process while the MAIN
 * thread is starved by a synchronous loop. These tests spawn a real harness
 * process that starves its own loop and assert the watchdog kills it anyway.
 *
 * Serial because they use real subprocesses + wall-clock timing.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const HARNESS = join(import.meta.dir, 'fixtures', 'watchdog-harness.ts');

async function runHarness(
  mode: string,
  deadlineMs: number,
  graceMs: number,
  hardCapMs: number,
): Promise<{ exitCode: number | null; signalled: boolean; elapsedMs: number; stdout: string; stderr: string; killedByTest: boolean }> {
  const proc = Bun.spawn(['bun', HARNESS, mode, String(deadlineMs), String(graceMs)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const start = Date.now();
  let killedByTest = false;
  const cap = setTimeout(() => { killedByTest = true; proc.kill('SIGKILL'); }, hardCapMs);
  await proc.exited;
  clearTimeout(cap);
  const elapsedMs = Date.now() - start;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  // Bun surfaces signal death via exitCode === null + signalCode, or a negative
  // exitCode on some platforms. Treat "not a clean 0" as signalled for our purpose.
  const signalled = proc.exitCode !== 0;
  return { exitCode: proc.exitCode, signalled, elapsedMs, stdout, stderr, killedByTest };
}

describe('process-watchdog integration (Bun-pinned)', () => {
  test('starved process IS killed by the watchdog around deadline+grace', async () => {
    // deadline 300 + grace 200 = ~500ms expected death. Hard cap 4s: if the
    // watchdog failed, the test's own SIGKILL fires and the assertion catches it.
    const r = await runHarness('starve-with', 300, 200, 4000);
    expect(r.stdout).not.toContain('SURVIVED'); // the bug symptom
    expect(r.killedByTest).toBe(false);          // watchdog, not the test, killed it
    expect(r.signalled).toBe(true);
    // Died well before the harness's 8s self-exit safety net, near deadline+grace.
    expect(r.elapsedMs).toBeLessThan(3000);
  }, 15000);

  test('control: a starved process WITHOUT the watchdog does not self-exit', async () => {
    // Proves the busy loop genuinely starves (so the death above is the watchdog).
    // No watchdog installed; the test's hard cap (1.2s) is what kills it.
    const r = await runHarness('starve-without', 300, 200, 1200);
    expect(r.killedByTest).toBe(true);   // only the test's SIGKILL stopped it
    expect(r.stdout).not.toContain('SURVIVED');
  }, 15000);

  test('clean dispose: a disposed watchdog never kills the process', async () => {
    // Long deadline, disposed immediately, process exits 0 fast and prints DISPOSED.
    const r = await runHarness('clean-dispose', 60000, 60000, 5000);
    expect(r.exitCode).toBe(0);
    expect(r.killedByTest).toBe(false);
    expect(r.stdout).toContain('DISPOSED');
    expect(r.elapsedMs).toBeLessThan(4000);
  }, 15000);
});

describe('loop-stall watchdog integration (Bun-pinned, #4281)', () => {
  test('starved loop with a SIGTERM listener is SIGTERMed then SIGKILLed around stall+grace', async () => {
    // stall 300 + grace 250 = ~550ms expected death (plus worker boot). The
    // harness registers a SIGTERM listener, so only the SIGKILL escalation can
    // actually kill it — exactly the serve-http shape (process-cleanup's
    // handler can't run on a starved loop).
    const r = await runHarness('stall-with', 300, 250, 5000);
    expect(r.stdout).not.toContain('SURVIVED'); // the bug symptom
    expect(r.killedByTest).toBe(false);          // watchdog, not the test, killed it
    expect(r.signalled).toBe(true);
    expect(r.elapsedMs).toBeLessThan(3500);
    // The worker latched SIGTERM first, then escalated — both visible in its log.
    expect(r.stderr).toContain('SIGTERM');
    expect(r.stderr).toContain('SIGKILL');
  }, 15000);

  test('healthy petting loop is NEVER killed across multiple stall windows', async () => {
    // The false-positive pin: the harness idles (pets flowing) for well past
    // stall+grace. Any signal is a watchdog bug — a false SIGTERM prints
    // TERMED and exits 1; a false SIGKILL shows as non-zero exit.
    const r = await runHarness('stall-healthy', 300, 200, 6000);
    expect(r.killedByTest).toBe(false);
    expect(r.stdout).not.toContain('TERMED');
    expect(r.stdout).toContain('HEALTHY');
    expect(r.exitCode).toBe(0);
  }, 15000);

  test('disposed stall watchdog never kills, even under genuine starvation', async () => {
    // Disposed immediately, then the harness truly starves past stall+grace.
    const r = await runHarness('stall-dispose', 300, 200, 6000);
    expect(r.killedByTest).toBe(false);
    expect(r.stdout).toContain('DISPOSED');
    expect(r.exitCode).toBe(0);
  }, 15000);
});
