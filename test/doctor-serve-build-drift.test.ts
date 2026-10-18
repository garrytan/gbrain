/**
 * #6696 C6: a checkout that moved to a newer build while the serve kept running the old one ran new one-shot CLI code
 * against an old consumer for hours, and nothing said so. Doctor `serve_build_drift` compares the live resident
 * consumers' heartbeat `version` (persistence_consumers) with this binary's VERSION in one read and warns with a
 * service-specific restart and a verify; a serve that predates heartbeats is named through `consumers_without_heartbeat`.
 * Stub engines only: the check reads one statement.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { VERSION } from '../src/version.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-build-drift-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const row = (over: { kind?: string; pid?: number; version?: string; renewedAgoMs?: number; mode?: string } = {}) => ({
  host_id: '00000000-0000-4000-8000-000000000001', pid: over.pid ?? 4242, nonce: `n-${over.pid ?? 4242}`, pid_ns: null, kind: over.kind ?? 'serve', mode: over.mode ?? 'full',
  started_at: '2026-10-14 05:00:00+00', renewed_at: '2026-10-14 12:00:00+00', restart_required: false, root_barrier_age_ms: null, pool: null,
  host_json_path: '/srv/acme-example/.gbrain/persistence/host.json', persistence_home: '/srv/acme-example/.gbrain/persistence', minted_under: null,
  version: over.version ?? VERSION, boot_id: null, process_start: null, renewed_age_ms: String(over.renewedAgoMs ?? 2_000), age_ms: '25200000' });
function stub(rows: unknown[], kind: 'postgres' | 'pglite' = 'postgres') {
  const sql: string[] = [];
  const engine = { kind, executeRaw: async (statement: string) => { sql.push(statement); return rows; } } as unknown as BrainEngine;
  return { engine, sql };
}
async function runEntry(engine: BrainEngine): Promise<Check> {
  const entry = DOCTOR_CHECK_REGISTRY.find(e => e.emits.includes('serve_build_drift'));
  expect(entry).toBeDefined();
  const checks = await withEnv({ GBRAIN_HOME: home }, () => entry!.run({ engine, args: [], only: null } as unknown as DoctorContext));
  const check = (checks as Check[]).find(c => c.name === 'serve_build_drift');
  expect(check).toBeDefined();
  return check!;
}

describe('doctor serve_build_drift', () => {
  test('a live serve on an older build warns with a restart and a verify, in one read', async () => {
    const { engine, sql } = stub([row({ version: '0.60.209.0' }), row({ kind: 'jobs', pid: 5151, version: '0.60.209.0', mode: 'waiter_only' })]);
    const check = await runEntry(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('serve is running an older build than this checkout; restart serve and workers');
    expect(check.message).toContain('serve pid 4242 v0.60.209.0');
    expect(check.message).toContain('jobs pid 5151 v0.60.209.0');
    expect(check.message).toContain(`v${VERSION}`);
    expect(check.details).toMatchObject({ count: 2, this_version: VERSION, owner: { kind: 'serve', pid: 4242, version: '0.60.209.0' } });
    const fix = check.fix as { argv: string[]; verify: { argv: string[] }; actor: string };
    expect(fix.argv.length).toBeGreaterThan(0);
    expect(fix.actor).toBe('user');
    expect(fix.verify.argv).toEqual(['gbrain', 'doctor', '--only', 'serve_build_drift', '--json']);
    expect(sql).toHaveLength(1);
  });

  test('consumers on this build, lapsed old rows and short-lived kinds read ok', async () => {
    const same = await runEntry(stub([row()]).engine);
    expect(same.status).toBe('ok');
    const lapsed = await runEntry(stub([row({ version: '0.60.100.0', renewedAgoMs: 120_000 }), row({ kind: 'put', pid: 7, version: '0.60.100.0' })]).engine);
    expect(lapsed.status).toBe('ok');
    expect(lapsed.details).toMatchObject({ count: 0 });
  });

  test('no heartbeat row names consumers_without_heartbeat for a serve that predates heartbeats', async () => {
    const check = await runEntry(stub([]).engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('consumers_without_heartbeat');
  });

  test('a serve newer than this checkout is reported, not warned', async () => {
    const check = await runEntry(stub([row({ version: '99.0.0.0' })]).engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('older than the running serve');
  });

  test('PGLite keeps no heartbeat rows: not applicable, no read', async () => {
    const { engine, sql } = stub([], 'pglite');
    const check = await runEntry(engine);
    expect(check.status).toBe('ok');
    expect(sql).toHaveLength(0);
  });

  test('the restart is service-specific: systemd unit, launchd agent, else the pid', async () => {
    const { serveBuildDriftCheck } = await import('../src/commands/doctor/checks/persistence-consumers.ts');
    const older = () => stub([row({ version: '0.60.209.0' })]).engine;
    const linuxHome = join(home, 'linux'), macHome = join(home, 'mac');
    mkdirSync(join(linuxHome, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(linuxHome, '.config', 'systemd', 'user', 'gbrain-serve.service'), '[Unit]\n');
    mkdirSync(join(macHome, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(macHome, 'Library', 'LaunchAgents', 'com.gbrain.serve.plist'), '<plist/>');
    const argv = async (service: { platform: string; home: string; uid: number }) => ((await serveBuildDriftCheck(older(), 'host', service)).fix as { argv: string[] }).argv;
    expect(await argv({ platform: 'linux', home: linuxHome, uid: 1000 })).toEqual(['systemctl', '--user', 'restart', 'gbrain-serve.service']);
    expect(await argv({ platform: 'darwin', home: macHome, uid: 501 })).toEqual(['launchctl', 'kickstart', '-k', 'gui/501/com.gbrain.serve']);
    expect(await argv({ platform: 'linux', home: join(home, 'none'), uid: 1000 })).toEqual(['kill', '4242']);
  });
});
