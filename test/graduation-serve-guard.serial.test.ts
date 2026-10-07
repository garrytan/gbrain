/**
 * Engine graduation and long-lived clients (plan §6.4): a serve relaunched
 * during a run exits 75 with graduation_in_progress (a real `gbrain serve`
 * child), a stale config pointing at a tombstone gets status-only
 * `engine_graduated` with its one-step fix, a status-only/degraded serve
 * exits for relaunch when the engine identity changes, the resident serve
 * hand-off fires only for another live run, doctor's graduation finding and
 * pglite_leftovers report the run and the retained copy, and
 * `gbrain engine status --json` shows the graduation state. File fixtures
 * follow the plan's marker and tombstone formats.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import type { IntentMarker, Tombstone } from '../src/core/persistence/engine-graduation.types.ts';
import {
  engineIdentity, exitOnEngineIdentityChange, graduationHandoffRequested, graduationStatusReason, serveGraduationStartRefusal,
} from '../src/core/persistence/graduation-serve-guard.ts';
import { probeStatus, statusPayload, initialStatusState } from '../src/mcp/status-mode.ts';
import { graduationStateCheck } from '../src/commands/doctor/checks/engine-graduation.ts';
import { assessPgliteLeftovers } from '../src/core/pglite-leftovers-check.ts';
import { inspectLockHolder } from '../src/core/pglite-lock.ts';
import { homeDirInWorktreeEntry } from '../src/commands/doctor/checks/local-audits.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const target = { id: 'tid', host: 'db.acme-example.test', port: 5432, database: 'brain', user: 'alice' };
let home: string;
let dataDir: string;

function deadPid(): number {
  return Bun.spawnSync(['true']).pid;
}

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(cfg));
}

function writeMarker(over: Partial<IntentMarker>): void {
  const m: IntentMarker = { runId: 'run-1', state: 'copying', pid: process.ppid, bootId: null, pidNs: null, processStart: null, target, updatedAt: new Date().toISOString(), ...over };
  writeFileSync(`${dataDir}.gbrain-graduation.json`, JSON.stringify(m));
}

function writeTombstone(): void {
  rmSync(dataDir, { recursive: true, force: true });
  const t: Tombstone = { kind: 'gbrain-engine-graduated', runId: 'run-1', brainId: 'b1', movedTo: `${dataDir}.graduated-run-1`, target,
    targetDisplayUrl: 'postgresql://alice:***@db.acme-example.test:5432/brain', graduatedAt: new Date().toISOString(), fixArgv: ['gbrain', 'migrate', '--resume'] };
  writeFileSync(dataDir, JSON.stringify(t));
  mkdirSync(`${dataDir}.graduated-run-1`, { recursive: true });
  writeFileSync(join(`${dataDir}.graduated-run-1`, 'PG_VERSION'), '17');
}

const inHome = <T>(fn: () => T | Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_GRADUATION_RUN: undefined, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, fn);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-grad-serve-'));
  mkdirSync(join(home, '.gbrain'));
  dataDir = join(home, '.gbrain', 'brain.pglite');
  mkdirSync(dataDir);
  writeConfig({ engine: 'pglite', database_path: dataDir });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('serve start during a run', () => {
  test('a live run marker refuses with graduation_in_progress; a dead one or none does not', () => inHome(() => {
    expect(serveGraduationStartRefusal()).toBeNull();
    writeMarker({ pid: deadPid() });
    expect(serveGraduationStartRefusal()).toBeNull();
    writeMarker({});
    expect(serveGraduationStartRefusal()?.code).toBe('graduation_in_progress');
    expect(graduationHandoffRequested()?.code).toBe('graduation_in_progress');
    writeMarker({ pid: process.pid });
    expect(graduationHandoffRequested(), 'the run itself never hands off to itself').toBeNull();
  }));

  test('a relaunched `gbrain serve` exits 75 with the envelope and touches nothing', async () => {
    writeMarker({ pid: process.pid });
    const proc = Bun.spawn(['bun', CLI, 'serve'], {
      env: { ...process.env, GBRAIN_HOME: home, GBRAIN_DATABASE_URL: '', DATABASE_URL: '', GBRAIN_NO_UPDATE_CHECK: '1' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).toBe(75);
    const envelope = JSON.parse(stderr.slice(stderr.indexOf('{')));
    expect(envelope.code).toBe('graduation_in_progress');
    expect(envelope.fix.next).toBe('wait');
    expect(Bun.file(join(dataDir, 'PG_VERSION')).size).toBe(0);
  }, 60_000);
});

describe('stale config after cutover', () => {
  test('a tombstoned path is status-only engine_graduated with the config fix', () => inHome(() => {
    writeTombstone();
    expect(graduationStatusReason()?.reason).toBe('engine_graduated');
    expect(probeStatus()?.reason).toBe('engine_graduated');
    const payload = statusPayload(initialStatusState('engine_graduated')) as { reason: string; fix: { argv?: string[]; next: string }; user_message: string };
    expect(payload.reason).toBe('engine_graduated');
    expect(payload.fix.argv).toEqual(['gbrain', 'config', 'set', 'database_url', '<target_url>']);
    expect(payload.fix.next).toBe('tell_user_to_run');
    expect(payload.user_message).toContain('restart');
  }));

  test('identity change, a new tombstone or a run start exits the status/degraded serve for relaunch', () => inHome(() => {
    const start = engineIdentity();
    const exits: number[] = [];
    const opts = { exit: (c: number) => { exits.push(c); }, log: () => {} };
    exitOnEngineIdentityChange(start, opts);
    expect(exits).toEqual([]);
    writeTombstone();
    exitOnEngineIdentityChange(start, opts);
    expect(exits).toEqual([75]);
    exitOnEngineIdentityChange(start, { ...opts, startedGraduated: true });
    expect(exits).toEqual([75]);
    writeConfig({ engine: 'postgres', database_url: 'postgresql://alice:pw@db.acme-example.test:5432/brain' });
    exitOnEngineIdentityChange(start, { ...opts, startedGraduated: true });
    expect(exits).toEqual([75, 75]);
    exitOnEngineIdentityChange(null, opts);
    expect(exits, 'a serve that started with no config recovers in place').toEqual([75, 75]);
  }));
});

describe('doctor and engine status', () => {
  test('graduation_interrupted fails for a dead run, is ok for a live one, exempts the verify child, silent otherwise', () => inHome(() => {
    expect(graduationStateCheck()).toBeNull();
    writeMarker({ pid: deadPid() });
    const failing = graduationStateCheck()!;
    expect(failing).toMatchObject({ name: 'graduation_interrupted', status: 'fail' });
    expect((failing.fix as { argv?: string[] }).argv).toEqual(['gbrain', 'migrate', '--resume']);
    expect(graduationStateCheck({ env: { GBRAIN_GRADUATION_RUN: 'run-1' } })).toBeNull();
    writeMarker({});
    expect(graduationStateCheck()).toMatchObject({ status: 'ok' });
  }));

  test('pglite_leftovers reports the retained copy with size and stays silent mid-run', () => {
    writeTombstone();
    const a = assessPgliteLeftovers('postgres', join(home, '.gbrain'));
    expect(a.status).toBe('warn');
    expect(a.retained?.[0]?.path).toBe(`${dataDir}.graduated-run-1`);
    expect(a.message).toContain('private memory and access-token hashes');
    expect(assessPgliteLeftovers('postgres', join(home, '.gbrain'), undefined, { inFlight: true }).status).toBe('skip');
    expect(assessPgliteLeftovers('pglite', join(home, '.gbrain')).status).toBe('skip');
  });

  test('doctor pglite_leftovers says a rollback refuses once the copy is deleted, and names no discard flag', async () => {
    writeTombstone();
    writeConfig({ engine: 'postgres', database_url: 'postgresql://alice@db.acme-example.test:5432/brain' });
    const checks = (await inHome(() => homeDirInWorktreeEntry.run({} as DoctorContext))) as Check[];
    const leftovers = checks.find(c => c.name === 'pglite_leftovers')!;
    expect(leftovers.status).toBe('warn');
    expect(leftovers.fix).toMatchObject({ argv: ['rm', '-rf', `${dataDir}.graduated-run-1`], consent: ['destructive'] });
    expect(String((leftovers.fix as { why?: string }).why)).toContain('a rollback to PGLite refuses with not_found');
    expect(JSON.stringify(leftovers)).not.toContain('--discard-source');
  });

  test('engine status --json carries the graduation block', async () => {
    writeTombstone();
    const proc = Bun.spawn(['bun', CLI, 'engine', 'status', '--json'], {
      env: { ...process.env, GBRAIN_HOME: home, GBRAIN_DATABASE_URL: '', DATABASE_URL: '', GBRAIN_NO_UPDATE_CHECK: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    await proc.exited;
    const report = JSON.parse(await new Response(proc.stdout).text());
    expect(report.graduation).toMatchObject({ state: 'graduated', run_id: 'run-1', tombstone: { moved_to: `${dataDir}.graduated-run-1` } });
    expect(JSON.stringify(report)).not.toContain(':pw@');
  }, 60_000);
});

describe('resident serve hand-off', () => {
  test('a stdio serve holding a real PGLite brain releases it and exits 75 when a live run writes its marker', async () => {
    const env = { ...process.env, GBRAIN_HOME: home, GBRAIN_DATABASE_URL: '', DATABASE_URL: '', GBRAIN_NO_UPDATE_CHECK: '1', GBRAIN_SWEEP: '0' };
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(join(home, '.gbrain', 'config.json'));
    const init = Bun.spawnSync(['bun', CLI, 'init', '--pglite', '--no-embedding', '--path', dataDir, '--json'], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(init.exitCode, init.stderr.toString()).toBe(0);
    const serve = Bun.spawn(['bun', CLI, 'serve'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const deadline = Date.now() + 45_000;
    while (!inspectLockHolder(dataDir).held && Date.now() < deadline) await Bun.sleep(100);
    expect(inspectLockHolder(dataDir).held).toBe(true);
    writeMarker({ pid: process.pid, state: 'quiesced' });
    const code = await Promise.race([serve.exited, Bun.sleep(20_000).then(() => 'timeout' as const)]);
    if (code === 'timeout') serve.kill();
    expect(code).toBe(75);
    expect(await new Response(serve.stderr).text()).toContain('graduation_in_progress');
    expect(inspectLockHolder(dataDir).held).toBe(false);
  }, 90_000);
});
