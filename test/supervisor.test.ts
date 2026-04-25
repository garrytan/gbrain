import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync, rmSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSupervisorEvents, computeSupervisorAuditFilename } from '../src/core/minions/handlers/supervisor-audit.ts';
import { calculateBackoffMs } from '../src/core/minions/supervisor.ts';

const TEST_PID_FILE = '/tmp/gbrain-supervisor-test.pid';

afterEach(() => {
  try { unlinkSync(TEST_PID_FILE); } catch { /* noop */ }
});

// ----- Integration test helpers -----

interface IntegrationHarness {
  pidFile: string;
  auditDir: string;
  workerScript: string;
  envOutFile: string;
  cleanup: () => void;
}

/** Create per-test temp files + a fake worker shell script. */
function makeHarness(name: string, workerBody: string): IntegrationHarness {
  const tmpRoot = join(tmpdir(), `gbrain-sup-test-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
  const pidFile = join(tmpRoot, 'supervisor.pid');
  const auditDir = join(tmpRoot, 'audit');
  const workerScript = join(tmpRoot, 'worker.sh');
  const envOutFile = join(tmpRoot, 'env-out.txt');

  writeFileSync(workerScript, `#!/bin/sh\n${workerBody}\n`, 'utf8');
  chmodSync(workerScript, 0o755);

  return {
    pidFile,
    auditDir,
    workerScript,
    envOutFile,
    cleanup: () => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ } },
  };
}

/**
 * Spawn the supervisor runner as a subprocess. Returns a handle with the
 * child, a promise resolving to exit code + signal, and a kill helper.
 */
function spawnSupervisor(h: IntegrationHarness, overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SUP_PID_FILE: h.pidFile,
    SUP_CLI_PATH: h.workerScript,
    SUP_AUDIT_DIR: h.auditDir,
    SUP_BACKOFF_FLOOR_MS: '5',
    SUP_MAX_CRASHES: '3',
    SUP_HEALTH_INTERVAL_MS: '999999',   // effectively off
    ...overrides,
  };

  const child = spawn('bun', [join(import.meta.dir, 'fixtures/supervisor-runner.ts')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => { stdout += d.toString(); });
  child.stderr?.on('data', (d) => { stderr += d.toString(); });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    exited,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

/** Read the audit JSONL for the current week. */
function readAudit(auditDir: string) {
  const origEnv = process.env.GBRAIN_AUDIT_DIR;
  process.env.GBRAIN_AUDIT_DIR = auditDir;
  try {
    return readSupervisorEvents();
  } finally {
    if (origEnv === undefined) delete process.env.GBRAIN_AUDIT_DIR;
    else process.env.GBRAIN_AUDIT_DIR = origEnv;
  }
}

/** Poll until predicate returns true or deadline elapses. */
async function waitFor(pred: () => boolean, timeoutMs: number, tickMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, tickMs));
  }
  return pred();
}

describe('MinionSupervisor', () => {
  describe('calculateBackoffMs', () => {
    it('returns ~1s for first crash', () => {
      const backoff = calculateBackoffMs(0);
      expect(backoff).toBeGreaterThanOrEqual(1000);
      expect(backoff).toBeLessThan(1200); // 1000 + 10% jitter max
    });

    it('doubles with each crash', () => {
      const b0 = calculateBackoffMs(0);
      const b1 = calculateBackoffMs(1);
      const b2 = calculateBackoffMs(2);
      // Approximate: b1 should be ~2x b0, b2 ~2x b1 (within jitter)
      expect(b1).toBeGreaterThan(1800);
      expect(b2).toBeGreaterThan(3600);
    });

    it('caps at 60s', () => {
      const backoff = calculateBackoffMs(20); // 2^20 * 1000 would be huge
      expect(backoff).toBeLessThanOrEqual(66_000); // 60s + 10% jitter
    });

    it('includes jitter (not perfectly deterministic)', () => {
      const values = new Set<number>();
      for (let i = 0; i < 10; i++) {
        values.add(Math.round(calculateBackoffMs(3)));
      }
      // With 10% jitter, we should get some variation
      expect(values.size).toBeGreaterThan(1);
    });
  });

  describe('PID file management', () => {
    it('detects stale PID files', () => {
      // Write a PID file with a non-existent PID
      writeFileSync(TEST_PID_FILE, '999999999');
      expect(existsSync(TEST_PID_FILE)).toBe(true);

      // A real supervisor would detect this as stale and overwrite
      const existingPid = parseInt(readFileSync(TEST_PID_FILE, 'utf8').trim(), 10);
      let isAlive = false;
      try {
        process.kill(existingPid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }
      expect(isAlive).toBe(false);
    });

    it('detects live PID files (current process)', () => {
      // Write our own PID
      writeFileSync(TEST_PID_FILE, String(process.pid));

      const existingPid = parseInt(readFileSync(TEST_PID_FILE, 'utf8').trim(), 10);
      let isAlive = false;
      try {
        process.kill(existingPid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }
      expect(isAlive).toBe(true);
      expect(existingPid).toBe(process.pid);
    });
  });

  describe('crash count tracking', () => {
    it('backoff escalates with crash count', () => {
      const backoffs = [];
      for (let i = 0; i < 7; i++) {
        backoffs.push(calculateBackoffMs(i));
      }
      // Each should be roughly 2x the previous (within jitter)
      for (let i = 1; i < 6; i++) {
        // The base doubles, so even with jitter the next should be > 1.5x previous
        expect(backoffs[i]).toBeGreaterThan(backoffs[i - 1] * 1.5);
      }
    });
  });

  // --------------------------------------------------------------
  // Integration tests: real spawn(), real signals, real audit file.
  // Each test uses a unique tmpdir harness so they can run in parallel
  // without colliding. `_backoffFloorMs: 5` (set via SUP_BACKOFF_FLOOR_MS)
  // keeps the whole suite under a few seconds.
  // --------------------------------------------------------------

  describe('integration: crash → restart → max-crashes lifecycle', () => {
    it('respawns the worker after a crash and eventually exits with max-crashes code=1', async () => {
      // Worker always exits with code 1; supervisor should respawn it 3 times,
      // hit max-crashes, then exit via shutdown() with code 1.
      const h = makeHarness('max-crashes', 'exit 1');
      try {
        const sup = spawnSupervisor(h, { SUP_MAX_CRASHES: '3' });
        const { code } = await sup.exited;

        expect(code).toBe(1);

        // PID file cleaned up on exit (synchronous process.on('exit') handler).
        expect(existsSync(h.pidFile)).toBe(false);

        // Audit file should contain started + 3x worker_spawned/worker_exited +
        // max_crashes_exceeded + shutting_down + stopped.
        const events = readAudit(h.auditDir);
        const eventTypes = events.map(e => e.event);
        expect(eventTypes).toContain('started');
        expect(eventTypes.filter(t => t === 'worker_spawned').length).toBeGreaterThanOrEqual(3);
        expect(eventTypes.filter(t => t === 'worker_exited').length).toBeGreaterThanOrEqual(3);
        expect(eventTypes).toContain('max_crashes_exceeded');
        expect(eventTypes).toContain('shutting_down');
        expect(eventTypes).toContain('stopped');

        // The stopped event should carry exit_code=1 and reason=max_crashes.
        const stoppedEvt = events.filter(e => e.event === 'stopped').pop();
        expect((stoppedEvt as Record<string, unknown>).exit_code).toBe(1);
        expect((stoppedEvt as Record<string, unknown>).reason).toBe('max_crashes');
      } finally {
        h.cleanup();
      }
    }, 15_000);
  });

  describe('integration: graceful SIGTERM during backoff', () => {
    it('receives SIGTERM while sleeping between crashes and exits 0 cleanly', async () => {
      // Worker always exits with code 1; supervisor has a high max-crashes
      // and a long-enough backoff floor that we can reliably catch it mid-sleep.
      const h = makeHarness('sigterm-backoff', 'exit 1');
      try {
        const sup = spawnSupervisor(h, {
          SUP_MAX_CRASHES: '100',
          SUP_BACKOFF_FLOOR_MS: '800',  // 800ms between restarts — enough to catch
        });

        // Wait until the supervisor has written the PID file AND survived at
        // least one worker_exited (so it's definitely in the backoff sleep).
        const ready = await waitFor(() => {
          if (!existsSync(h.pidFile)) return false;
          const events = readAudit(h.auditDir);
          return events.some(e => e.event === 'worker_exited');
        }, 3000);
        expect(ready).toBe(true);

        // Now SIGTERM the supervisor. It must exit cleanly within 200ms
        // (short-circuits the 800ms backoff sleep via the stopping flag).
        const sigSentAt = Date.now();
        sup.child.kill('SIGTERM');

        const { code, signal } = await sup.exited;
        const elapsed = Date.now() - sigSentAt;

        // Exit code 0 = clean; signal=null means we exited via process.exit, not got killed.
        expect(code).toBe(0);
        expect(signal).toBe(null);
        // Graceful, not hung: exit within 5s (process.exit() through shutdown()
        // should be near-instant; generous bound to tolerate CI slowness).
        expect(elapsed).toBeLessThan(5000);

        const events = readAudit(h.auditDir);
        const eventTypes = events.map(e => e.event);
        expect(eventTypes).toContain('shutting_down');
        expect(eventTypes).toContain('stopped');

        const shuttingEvt = events.filter(e => e.event === 'shutting_down').pop();
        expect((shuttingEvt as Record<string, unknown>).reason).toBe('SIGTERM');

        // PID file cleaned up.
        expect(existsSync(h.pidFile)).toBe(false);
      } finally {
        h.cleanup();
      }
    }, 20_000);
  });

  describe('integration: env-var inheritance regression (codex #9 / eng #8)', () => {
    it('strips inherited GBRAIN_ALLOW_SHELL_JOBS when allowShellJobs=false, even if parent has it set', async () => {
      const outFile = join(tmpdir(), `gbrain-sup-env-${process.pid}-${Date.now()}.txt`);
      try { unlinkSync(outFile); } catch { /* may not exist */ }

      const h = makeHarness('env-strip-outfile', `printf '%s\\n' "\${GBRAIN_ALLOW_SHELL_JOBS-UNSET}" > "$OUT_FILE" ; exit 0`);

      try {
        const sup = spawnSupervisor(h, {
          OUT_FILE: outFile,
          GBRAIN_ALLOW_SHELL_JOBS: '1',  // parent has it
          SUP_ALLOW_SHELL_JOBS: '0',     // supervisor says NO
          SUP_MAX_CRASHES: '1',
        });

        await sup.exited;

        // Worker should have written "UNSET" (parent env var stripped from child).
        expect(existsSync(outFile)).toBe(true);
        const childSawEnv = readFileSync(outFile, 'utf8').trim();
        expect(childSawEnv).toBe('UNSET');
      } finally {
        try { unlinkSync(outFile); } catch { /* noop */ }
        h.cleanup();
      }
    }, 15_000);

    it('DOES pass GBRAIN_ALLOW_SHELL_JOBS to child when allowShellJobs is true', async () => {
      const outFile = join(tmpdir(), `gbrain-sup-env-ok-${process.pid}-${Date.now()}.txt`);
      try { unlinkSync(outFile); } catch { /* may not exist */ }

      const h = makeHarness('env-pass-on-opt-in', `printf '%s\\n' "\${GBRAIN_ALLOW_SHELL_JOBS-UNSET}" > "$OUT_FILE" ; exit 0`);

      try {
        const sup = spawnSupervisor(h, {
          OUT_FILE: outFile,
          SUP_ALLOW_SHELL_JOBS: '1',
          SUP_MAX_CRASHES: '1',
        });

        await sup.exited;

        expect(existsSync(outFile)).toBe(true);
        expect(readFileSync(outFile, 'utf8').trim()).toBe('1');
      } finally {
        try { unlinkSync(outFile); } catch { /* noop */ }
        h.cleanup();
      }
    }, 15_000);
  });

  describe('integration: audit file rotation + helper', () => {
    it('computeSupervisorAuditFilename returns supervisor-YYYY-Www.jsonl format', () => {
      const jan15_2026 = new Date(Date.UTC(2026, 0, 15));  // Thu
      expect(computeSupervisorAuditFilename(jan15_2026)).toMatch(/^supervisor-2026-W\d\d\.jsonl$/);
    });

    it('year-boundary ISO week: 2027-01-01 reports as 2026-W53', () => {
      const jan1_2027 = new Date(Date.UTC(2027, 0, 1));
      // ISO week: 2027-01-01 is Friday of W53 of 2026
      expect(computeSupervisorAuditFilename(jan1_2027)).toBe('supervisor-2026-W53.jsonl');
    });
  });
});
