import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { writeSupervisorEvent } from '../src/core/minions/handlers/supervisor-audit.ts';

async function withIsolatedHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-fast-sup-'));
  try {
    return await withEnv(
      { GBRAIN_HOME: dir, GBRAIN_AUDIT_DIR: join(dir, 'audit') },
      () => fn(dir),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function supervisorCheck(checks: Awaited<ReturnType<typeof buildChecks>>) {
  return checks.find((c) => c.name === 'supervisor');
}

describe('#4518: supervisor check under --fast with no default-path pidfile', () => {
  test('no supervisor ever observed → no check surfaced at all (unaffected by the fix)', async () => {
    await withIsolatedHome(async () => {
      const checks = await buildChecks(null, ['--fast']);
      expect(supervisorCheck(checks)).toBeUndefined();
    });
  });

  test('supervisor WAS observed (audit events exist) but no pidfile at the default path, under --fast → ok/inconclusive, not a false "not running" warn', async () => {
    await withIsolatedHome(async () => {
      // Simulates the documented multi-queue pattern: a supervisor that was
      // started with an explicit, non-default --pid-file (e.g.
      // supervisor-cron.pid) never writes DEFAULT_PID_FILE, so
      // readSupervisorPid(DEFAULT_PID_FILE) reports not-running even though
      // the process is alive — the audit trail is the only local evidence.
      writeSupervisorEvent({ event: 'started', ts: new Date().toISOString() }, 12345);

      const checks = await buildChecks(null, ['--fast']);
      const check = supervisorCheck(checks);
      expect(check).toBeDefined();
      // The regression this guards against: this used to be status:'warn',
      // message starting with "Supervisor not running" — a false positive,
      // because the #1849 DB-lock fallback that could have proven liveness
      // was never attempted (engine is null under --fast by CLI design).
      expect(check?.status).not.toBe('warn');
      expect(check?.message).not.toContain('Supervisor not running');
      expect(check?.message).toContain('inconclusive under --fast');
    });
  });

  test('same fixture WITHOUT --fast (engine still null here, simulating DB-down rather than DB-skipped) → still just inconclusive, never asserts running=true', async () => {
    await withIsolatedHome(async () => {
      writeSupervisorEvent({ event: 'started', ts: new Date().toISOString() }, 12345);
      // No --fast this time: engine is still null (this test doesn't stand
      // up a real DB), but dbLockCheckSkippedUnderFast requires fastMode to
      // be true — so this exercises the ORIGINAL (pre-#4518) branch, which
      // legitimately warns when nothing can prove liveness and it isn't the
      // --fast case. Confirms the fix is --fast-specific, not a blanket
      // "engine is null" suppression that would swallow a real DB-down signal.
      const checks = await buildChecks(null, []);
      const check = supervisorCheck(checks);
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('Supervisor not running');
    });
  });
});
