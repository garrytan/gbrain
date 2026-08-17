/**
 * Regression test: `gbrain doctor`'s `supervisor_singleton` check should read
 * the pid-file path that was used at supervisor start (recorded on the
 * 'started' audit event as `pid_file` — `this.opts.pidFile` in
 * `MinionSupervisor.start()`), not blindly re-derive `DEFAULT_PID_FILE`
 * locally.
 *
 * Pre-fix, `doctor.ts` read `readSupervisorPid(DEFAULT_PID_FILE).pid` even
 * though the 'started' event already carried the real path. A supervisor
 * launched with a custom `--pid-file` (e.g. a launchd/systemd unit passing an
 * explicit pidfile path) could then produce a false "singleton mismatch" warn against its
 * own live DB lock, because the pidfile doctor.ts checked was never the one
 * the supervisor actually wrote.
 *
 * #1849 established the queue-scoped DB lock as the real singleton
 * authority — `supervisor_singleton` is a diagnostic display derived from
 * that lock, not a second enforcement mechanism. This fix only corrects
 * which pidfile the display reads; it does not touch the DB lock itself.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnv } from './helpers/with-env.ts';
import { doctorSource } from './helpers/doctor-source.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { supervisorLockId } from '../src/core/minions/supervisor.ts';
import { computeSupervisorAuditFilename } from '../src/core/minions/handlers/supervisor-audit.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

let auditDir: string;
let pidFileDir: string;

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks`);
  auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-supervisor-singleton-audit-'));
  pidFileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-supervisor-singleton-pidfile-'));
});

afterEach(() => {
  try { fs.rmSync(auditDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(pidFileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeStartedEvent(fields: Record<string, unknown>): void {
  const file = path.join(auditDir, computeSupervisorAuditFilename());
  const row = { event: 'started', ts: new Date().toISOString(), supervisor_pid: process.pid, ...fields };
  fs.writeFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

async function holdLiveLock(queue: string, holderPid: number, holderHost: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
     VALUES ($1, $2, $3, now(), now() + interval '30 minutes', now())`,
    [supervisorLockId(queue), holderPid, holderHost],
  );
}

async function findSingletonCheck() {
  const checks = await buildChecks(engine, []);
  return checks.find((c) => c.name === 'supervisor_singleton');
}

describe('doctor supervisor_singleton — honors the recorded pid_file (custom --pid-file)', () => {
  test('custom --pid-file matching the live DB lock holder → single, not mismatch', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // A pid-file at a path OTHER than DEFAULT_PID_FILE, holding the pid of
      // this very test process (guaranteed alive via process.kill(pid, 0)).
      const customPidFile = path.join(pidFileDir, 'custom-supervisor.pid');
      fs.writeFileSync(customPidFile, String(process.pid), 'utf8');

      // The 'started' event records that custom path, matching what
      // MinionSupervisor.start() actually emits (this.opts.pidFile).
      writeStartedEvent({ pid_file: customPidFile, queue: 'default', max_rss_mb: 512 });

      // The DB lock (the real singleton authority per #1849) is held by
      // this same (host, pid) — a single, healthy supervisor.
      await holdLiveLock('default', process.pid, os.hostname());

      const check = await findSingletonCheck();
      expect(check).toBeDefined();
      expect(check?.status).toBe('ok');
      expect(check?.message).toContain('Single supervisor');
      // Pre-fix this would have read DEFAULT_PID_FILE (which this test never
      // writes to), gotten pid=null, and warned 'mismatch' instead.
      expect(check?.message).not.toContain('mismatch');
    });
  });

  test('pid_file that does not resolve to the lock holder → mismatch (an absent/wrong local pidfile still warns)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // pid_file recorded, but nothing is written at that path — readSupervisorPid
      // resolves to pid=null, so the DB lock holder can't be locally confirmed.
      const customPidFile = path.join(pidFileDir, 'never-written-supervisor.pid');
      writeStartedEvent({ pid_file: customPidFile, queue: 'default', max_rss_mb: 512 });

      await holdLiveLock('default', process.pid, os.hostname());

      const check = await findSingletonCheck();
      expect(check).toBeDefined();
      expect(check?.status).toBe('warn');
      expect(check?.message).toContain('singleton lock is held by');
    });
  });
});

// Compatibility fallback: a 'started' event from before this fix (or any
// caller that never recorded `pid_file`) has no such field. doctor.ts falls
// back to DEFAULT_PID_FILE for those — behavior-preserving relative to
// pre-fix. Pinned as a source-grep (rather than a behavioral run against the
// real DEFAULT_PID_FILE) because DEFAULT_PID_FILE is a module-load-time
// constant derived from $HOME; asserting against it directly would make the
// test's outcome depend on whatever real supervisor state happens to exist
// on the machine running the suite.
describe('doctor supervisor_singleton — pid_file fallback (source-grep)', () => {
  test('falls back to DEFAULT_PID_FILE when the started event has no pid_file', async () => {
    const source = doctorSource();
    expect(source).toMatch(
      /typeof lastStarted\.pid_file === 'string' && lastStarted\.pid_file\.length > 0\s*\n\s*\? lastStarted\.pid_file\s*\n\s*: DEFAULT_PID_FILE/,
    );
    expect(source).toContain('readSupervisorPid(pidFilePath)');
  });
});
