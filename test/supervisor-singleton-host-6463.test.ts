/**
 * PR #6463: doctor's `supervisor_singleton` compared the lock's acquisition-time
 * `holder_host` with `os.hostname()` now, and worded any difference as a second
 * supervisor ("Stop the extra one") even when the only change was the
 * machine's hostname label (macOS `.local` / `.lan` / DHCP drift).
 *
 * The supervisor now records the hostname it put in the lock on line 3 of its
 * PID file (line 1 pid, line 2 kernel start time: the recycled-pid fence that
 * `gbrain jobs supervisor stop` reads stays where it is). Doctor: same pid and
 * the recorded host equals the lock holder's host → `ok` with
 * `host_label_drift`; a two-line legacy PID file with the same pid → `warn`
 * that says what the difference may mean (`same_pid_host_label_differs`); a
 * different pid → the unchanged second-supervisor warning. The stop command
 * still refuses a recycled pid under the three-line format.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { classifySupervisorSingleton, supervisorLockId } from '../src/core/minions/supervisor.ts';
import { pidFileContents, readSupervisorPid } from '../src/core/minions/supervisor-pid.ts';
import { processStartTime } from '../src/core/pglite-lock.ts';
import { computeSupervisorAuditFilename } from '../src/core/minions/handlers/supervisor-audit.ts';

const OLD_HOST = 'old-label-6463.local';
let engine: PGLiteEngine;
let auditDir: string;
let pidDir: string;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
  auditDir = mkdtempSync(join(tmpdir(), 'sup-host-6463-audit-'));
  pidDir = mkdtempSync(join(tmpdir(), 'sup-host-6463-pid-'));
});
afterEach(() => { rmSync(auditDir, { recursive: true, force: true }); rmSync(pidDir, { recursive: true, force: true }); });

function started(pidFile: string): void {
  writeFileSync(join(auditDir, computeSupervisorAuditFilename()),
    `${JSON.stringify({ event: 'started', ts: new Date().toISOString(), supervisor_pid: process.pid, pid_file: pidFile, queue: 'default', max_rss_mb: 512 })}\n`);
}
async function lock(holderPid: number, holderHost: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
    VALUES ($1, $2, $3, now(), now() + interval '30 minutes', now())`, [supervisorLockId('default'), holderPid, holderHost]);
}
async function singleton() {
  return withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => (await buildChecks(engine, [])).find(c => c.name === 'supervisor_singleton'));
}
const start = processStartTime(process.pid) ?? '';

describe('the supervisor PID file records the lock hostname on line 3', () => {
  test('pidFileContents: pid, start time, hostname; readers take line 1 and expose the host', () => {
    const lines = pidFileContents(process.pid).trimEnd().split('\n');
    expect(lines[0]).toBe(String(process.pid));
    expect(lines[2]).toBe(hostname());
    if (process.platform === 'linux') expect(lines[1]).toMatch(/^\d+$/);
    const file = join(pidDir, 'three.pid');
    writeFileSync(file, pidFileContents(process.pid));
    expect(readSupervisorPid(file)).toEqual({ pid: process.pid, running: true, host: hostname() });
    const legacy = join(pidDir, 'two.pid');
    writeFileSync(legacy, `${process.pid}\n${start}\n`);
    expect(readSupervisorPid(legacy)).toEqual({ pid: process.pid, running: true });
  });

  test('classifier: same pid and the recorded host equals the lock host → single even when the live label differs', () => {
    const base = { lockLive: true, lockHolderHost: OLD_HOST, lockHolderPid: 42, localHost: 'new-label', localPid: 42 };
    expect(classifySupervisorSingleton({ ...base, pidfileHost: OLD_HOST })).toBe('single');
    expect(classifySupervisorSingleton({ ...base, pidfileHost: null })).toBe('mismatch');
    expect(classifySupervisorSingleton({ ...base, pidfileHost: 'yet-another' })).toBe('mismatch');
    expect(classifySupervisorSingleton({ ...base, pidfileHost: OLD_HOST, localPid: 43 })).toBe('mismatch');
    expect(classifySupervisorSingleton({ lockLive: true, lockHolderHost: 'box', lockHolderPid: 42, localHost: 'box', localPid: 42 })).toBe('single');
  });
});

describe('doctor supervisor_singleton under a hostname label change (PR #6463)', () => {
  test('three-line PID file, same pid, recorded host = lock host, live hostname differs → ok with host_label_drift', async () => {
    const pidFile = join(pidDir, 'supervisor.pid');
    writeFileSync(pidFile, `${process.pid}\n${start}\n${OLD_HOST}\n`);
    started(pidFile);
    await lock(process.pid, OLD_HOST);
    const check = await singleton();
    expect(check).toMatchObject({ status: 'ok', details: { host_label_drift: true, lock_holder_host: OLD_HOST, local_host: hostname() } });
    expect(String(check?.message)).toContain('Single supervisor');
    expect(String(check?.message)).toContain(`hostname changed from ${OLD_HOST} to ${hostname()}`);
    expect(String(check?.message)).not.toContain('Stop the extra one');
  });

  test('two-line legacy PID file, same pid, different host label → warn that names both readings, not a proven second supervisor', async () => {
    const pidFile = join(pidDir, 'supervisor.pid');
    writeFileSync(pidFile, `${process.pid}\n${start}\n`);
    started(pidFile);
    await lock(process.pid, OLD_HOST);
    const check = await singleton();
    expect(check).toMatchObject({ status: 'warn', details: { same_pid_host_label_differs: true } });
    expect(String(check?.message)).toContain('same pid');
    expect(String(check?.message)).toMatch(/hostname/);
    expect(String(check?.message)).not.toMatch(/^.*A second supervisor may be running.*Stop the extra one/);
  });

  test('a different pid keeps the second-supervisor warning', async () => {
    const pidFile = join(pidDir, 'supervisor.pid');
    writeFileSync(pidFile, `${process.pid}\n${start}\n${hostname()}\n`);
    started(pidFile);
    await lock(process.pid + 100_000, hostname());
    const check = await singleton();
    expect(check?.status).toBe('warn');
    expect(check?.details).not.toHaveProperty('same_pid_host_label_differs');
    expect(String(check?.message)).toContain('A second supervisor may be running');
  });
});

const linuxOnly = process.platform === 'linux' ? describe : describe.skip;
linuxOnly('jobs supervisor stop keeps the recycled-pid fence under the three-line PID file', () => {
  test('a live pid whose start time differs from line 2 is never signaled, hostname line present', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sup-host-6463-home-'));
    const proc = Bun.spawn({ cmd: ['sleep', '300'], stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') }));
      const pidFile = join(home, 'sup.pid');
      writeFileSync(pidFile, `${proc.pid}\n1\n${hostname()}\n`);
      const result = await runCli(['jobs', 'supervisor', 'stop', '--json', '--pid-file', pidFile], { home, timeoutMs: 60_000, env: { GBRAIN_AUDIT_DIR: join(home, 'audit') } });
      const line = result.stdout.split('\n').find(l => l.startsWith('{'));
      const payload = line ? JSON.parse(line) : null;
      expect(payload?.reason, result.stderr).toBe('stale_pid_file');
      expect(payload?.stopped).toBe(false);
      expect(() => process.kill(proc.pid, 0)).not.toThrow();
    } finally {
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
