/**
 * #7245: doctor `runtime_build_skew` compares the builds of this host's
 * long-running gbrain processes with each other and with the build each one's
 * install holds on disk: serve (heartbeat row), the jobs supervisor (PID file),
 * worker parents (worker registry) and the job children they spawned (the
 * `job_build_skew:` history entry a child writes). Stub sources for the
 * processes; real PGLite for the job-history read.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { runtimeBuildSkewCheck, type RuntimeBuildSources } from '../src/commands/doctor/checks/runtime-build-skew.ts';
import { jobChildBuildVerdict, CHILD_READINESS_PROTOCOL_VERSION } from '../src/core/minions/child-readiness.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { VERSION } from '../src/version.ts';

const OLD = '0.60.1.0';
const OLDER = '0.60.0.9';
const INSTALL = '/srv/install-example';
const HOST = '00000000-0000-4000-8000-000000000001';
const home = mkdtempSync(join(tmpdir(), 'gbrain-runtime-skew-'));
const service = { platform: 'linux', home, uid: 501 };
afterAll(() => rmSync(home, { recursive: true, force: true }));

const heartbeat = (over: { kind?: string; pid?: number; version?: string } = {}) => ({
  host_id: HOST, pid: over.pid ?? 4242, nonce: `n-${over.pid ?? 4242}`, pid_ns: null, kind: over.kind ?? 'serve', mode: 'full',
  started_at: '2026-10-14 05:00:00+00', renewed_at: '2026-10-14 12:00:00+00', restart_required: false, root_barrier_age_ms: null, pool: null,
  host_json_path: `${INSTALL}/host.json`, persistence_home: INSTALL, minted_under: null, version: over.version ?? VERSION, boot_id: null, process_start: null,
  renewed_age_ms: '2000', age_ms: '25200000' });
const childLine = (workerPid: number, workerVersion: string) => jobChildBuildVerdict(JSON.stringify({ version: workerVersion, protocol_version: CHILD_READINESS_PROTOCOL_VERSION,
  features: ['local-configuration-outcome-v1', 'postgres-cancellation-v1'] }), workerPid)!.note;

function stub(heartbeats: unknown[], children: Array<{ id: number; line: string }> = []) {
  const sql: string[] = [];
  const engine = { kind: 'postgres', executeRaw: async (statement: string) => {
    sql.push(statement);
    return statement.includes('persistence_consumers') ? heartbeats : statement.includes('minion_jobs') ? children : [];
  } } as unknown as BrainEngine;
  return { engine, sql };
}
function sources(over: Partial<{ workers: Array<{ pid: number; version?: string; install_root?: string | null }>; supervisor: { pid: number; version: string | null; install_root: string | null } | null; installed: string | null }> = {}): RuntimeBuildSources {
  return {
    workers: () => over.workers ?? [],
    supervisor: async () => over.supervisor ?? null,
    installedVersion: root => (root ? (over.installed === undefined ? VERSION : over.installed) : null),
  };
}

describe('doctor runtime_build_skew', () => {
  test('the incident shape: serve, supervisor and worker on old builds while job children run the install build', async () => {
    const { engine } = stub([heartbeat({ version: OLDER }), heartbeat({ kind: 'jobs', pid: 5151, version: OLD })],
      [{ id: 11, line: childLine(5151, OLD) }, { id: 12, line: childLine(5151, OLD) }]);
    const check = await runtimeBuildSkewCheck(engine, HOST, sources({
      workers: [{ pid: 5151, version: OLD, install_root: INSTALL }],
      supervisor: { pid: 6161, version: OLD, install_root: INSTALL },
    }), service);
    expect(check.status).toBe('fail');
    expect(check.message).toStartWith(`runtime_build_skew: 3 gbrain builds are running on this host (newest v${VERSION})`);
    expect(check.message).toContain(`serve pid 4242 v${OLDER}`);
    expect(check.message).toContain(`supervisor pid 6161 v${OLD} (its install now holds v${VERSION})`);
    expect(check.message).toContain(`worker pid 5151 v${OLD} (its install now holds v${VERSION})`);
    expect(check.message).toContain(`job children of worker pid 5151 ran v${VERSION} (jobs #11, #12)`);
    const fix = check.fix as { argv: string[]; actor: string; ask_user?: boolean; user_message: string; verify: { argv: string[] } };
    expect(fix.argv).toEqual(['gbrain', 'upgrade', '--restart-only']);
    expect(fix.actor).toBe('agent');
    expect(fix.ask_user).toBe(true);
    expect(fix.user_message).toContain(`serve pid 4242 v${OLDER}`);
    expect(check.message).toContain('By hand: restart with `kill 4242`');
    expect(fix.verify.argv).toEqual(['gbrain', 'doctor', '--only', 'runtime_build_skew', '--json']);
    expect(check.details).toMatchObject({ count: 3, newest: VERSION, earlier_job_children: 0 });
    expect(JSON.stringify(check)).not.toContain(INSTALL);
  });

  test('one build everywhere reads ok, and so does an idle host', async () => {
    const same = await runtimeBuildSkewCheck(stub([heartbeat()]).engine, HOST, sources({
      workers: [{ pid: 5151, version: VERSION, install_root: INSTALL }], supervisor: { pid: 6161, version: VERSION, install_root: INSTALL } }), service);
    expect(same.status).toBe('ok');
    expect(same.message).toContain(`runs v${VERSION}`);
    const idle = await runtimeBuildSkewCheck(stub([]).engine, HOST, sources(), service);
    expect(idle.status).toBe('ok');
    expect(idle.message).toContain('No long-running gbrain process');
  });

  test('a worker whose install moved under it warns even when it is the only process', async () => {
    const check = await runtimeBuildSkewCheck(stub([]).engine, HOST, sources({ workers: [{ pid: 5151, version: OLD, install_root: INSTALL }] }), service);
    expect(check.status).toBe('warn');
    expect(check.message).toStartWith(`runtime_build_skew: a gbrain process runs an older build than its install (newest v${OLD})`);
    expect((check.fix as { argv: string[] }).argv).toEqual(['gbrain', 'upgrade', '--restart-only']);
    expect(check.message).toContain('By hand: restart with `kill 5151`');
  });

  test('a stale supervisor is restarted before its worker', async () => {
    const check = await runtimeBuildSkewCheck(stub([heartbeat()]).engine, HOST, sources({
      workers: [{ pid: 5151, version: OLD, install_root: INSTALL }], supervisor: { pid: 6161, version: OLD, install_root: INSTALL } }), service);
    expect(check.status).toBe('fail');
    expect(check.message).toContain('By hand: restart with `gbrain jobs supervisor stop`');
    expect(check.message).toContain('gbrain jobs supervisor start --detach');
  });

  test('job children of a worker that is gone are history, not a warning; an unrecorded build is named', async () => {
    const check = await runtimeBuildSkewCheck(stub([heartbeat()], [{ id: 9, line: childLine(9999, OLD) }]).engine, HOST, sources({
      supervisor: { pid: 6161, version: null, install_root: null } }), service);
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ earlier_job_children: 1, job_children: [], unknown_builds: [{ role: 'supervisor', pid: 6161 }] });
    expect(check.message).toContain('supervisor pid 6161 started before builds were recorded');
  });

  test('registered as its own entry', () => {
    const entry = DOCTOR_CHECK_REGISTRY.find(e => e.emits.includes('runtime_build_skew'));
    expect(entry?.name).toBe('runtime_build_skew');
  });
});

describe('doctor runtime_build_skew on PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  test('reads job-child builds from the job history of a live worker', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('sync', {});
    await engine.executeRaw(`UPDATE minion_jobs SET stacktrace = jsonb_build_array('earlier failure', $1::text) WHERE id = $2`, [childLine(process.pid, OLD), job.id]);
    const check = await runtimeBuildSkewCheck(engine as unknown as BrainEngine, HOST, sources({ workers: [{ pid: process.pid, version: OLD, install_root: INSTALL }] }), service);
    expect(check.status).toBe('fail');
    expect(check.details).toMatchObject({ job_children: [{ job_id: job.id, child_version: VERSION, worker_pid: process.pid, worker_version: OLD, refused: false }] });
    expect(check.message).toContain(`job children of worker pid ${process.pid} ran v${VERSION} (jobs #${job.id})`);
  });
});
