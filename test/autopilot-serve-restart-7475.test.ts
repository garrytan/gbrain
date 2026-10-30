/**
 * #7475: the autopilot self-upgrade swaps and relaunches only autopilot, so a serve the installed serve service runs
 * stayed on the old build (restart_pending true for days). The relaunched autopilot now restarts that serve once,
 * under the swap's own auto-mode, quiet-hours and idle gates, and audits the outcome. A serve the service does not
 * run is never touched: it is reported for `gbrain upgrade --restart-only`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planServeRestart, restartServeAfterSelfUpgrade, type ServeRestartOutcome } from '../src/commands/upgrade-restart.ts';
import { logSelfUpgrade, readRecentSelfUpgrades } from '../src/core/audit/self-upgrade-audit.ts';
import { checkSelfUpgradeHealth } from '../src/commands/doctor/checks/upgrade-health.ts';
import type { HostProcess } from '../src/core/upgrade-restart.ts';
import { withEnv } from './helpers/with-env.ts';

const NEW = '0.60.430.0';
const OLD = '0.60.371.0';
const SERVE_SERVICE = { argv: ['launchctl', 'kickstart', '-k', 'gui/501/com.gbrain.serve'], pid: 9 };
const serve = (pid: number, version: string | null, over: Partial<HostProcess> = {}): HostProcess =>
  ({ pid, ppid: null, role: 'serve', version, started_ms: 1_000, ancestors: [SERVE_SERVICE.pid], args: ['serve', '--http'], ...over });

describe('planServeRestart (#7475)', () => {
  test('a stale serve the service runs gets the service restart and nothing else', () => {
    const plan = planServeRestart([serve(9, OLD), { ...serve(40, OLD), role: 'worker', ancestors: [] }], SERVE_SERVICE, NEW, null);
    expect('steps' in plan && plan.steps).toEqual([{ kind: 'service', role: 'serve', argv: SERVE_SERVICE.argv, pids: [9] }]);
  });

  test('a serve already on the build needs nothing', () => {
    expect(planServeRestart([serve(9, NEW)], SERVE_SERVICE, NEW, null)).toEqual({ outcome: 'current' });
    expect(planServeRestart([], SERVE_SERVICE, NEW, null)).toEqual({ outcome: 'current' });
  });

  test('a hand-started stale serve is never restarted, only reported', () => {
    const plan = planServeRestart([serve(77, OLD, { ancestors: [1] })], SERVE_SERVICE, NEW, null);
    expect(plan).toMatchObject({ outcome: 'manual' });
    expect('detail' in plan && plan.detail).toContain('gbrain upgrade --restart-only');
    expect('detail' in plan && plan.detail).toContain('kill 77');
  });

  test('a serve with no recorded build restarts only when it started before the install was written', () => {
    expect(planServeRestart([serve(9, null, { started_ms: 1_000 })], SERVE_SERVICE, NEW, null, 5_000)).toMatchObject({ steps: [{ kind: 'service', pids: [9] }] });
    expect(planServeRestart([serve(9, null, { started_ms: 9_000 })], SERVE_SERVICE, NEW, null, 5_000)).toEqual({ outcome: 'current' });
    expect(planServeRestart([serve(9, null)], SERVE_SERVICE, NEW, null, null)).toEqual({ outcome: 'current' });
    expect(planServeRestart([serve(9, null, { started_ms: null })], SERVE_SERVICE, NEW, null, 5_000)).toEqual({ outcome: 'current' });
  });

  test('a serve on a newer build than the autopilot is left alone', () => {
    expect(planServeRestart([serve(9, '0.60.999.0')], SERVE_SERVICE, NEW, null, 5_000)).toEqual({ outcome: 'current' });
  });

  test('a serve the service starts from another install is reported, not restarted onto the old build', () => {
    const other = '/opt/example/install/global/node_modules/gbrain';
    const plan = planServeRestart([serve(9, OLD, { install_root: other, install_version: OLD })], SERVE_SERVICE, NEW, '/srv/gbrain-example');
    expect(plan).toMatchObject({ outcome: 'manual' });
  });
});

describe('restartServeAfterSelfUpgrade (#7475)', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const idle = async () => true;

  function brainHome(mode: string, inQuietHours: boolean): { home: string; audit: string } {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-serve-restart-7475-'));
    dirs.push(root);
    const hour = new Date().getUTCHours();
    const start = inQuietHours ? hour : (hour + 3) % 24;
    mkdirSync(join(root, '.gbrain'), { recursive: true });
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite', database_path: join(root, '.gbrain', 'brain.pglite'),
      self_upgrade: { mode, quiet_hours: { start, end: (start + 2) % 24, tz: 'UTC' } },
    }));
    return { home: root, audit: join(root, 'audit') };
  }

  async function run(mode: string, inQuietHours: boolean, results: ServeRestartOutcome[]) {
    const { home, audit } = brainHome(mode, inQuietHours);
    const state = { tried: false };
    let calls = 0;
    const restart = async () => results[calls++]!;
    return withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, async () => {
      await restartServeAfterSelfUpgrade(idle, { state, restart });
      await restartServeAfterSelfUpgrade(idle, { state, restart });
      return { calls, state, audit: readRecentSelfUpgrades(1).filter(e => e.action === 'restart_serve') };
    });
  }

  test('auto mode in quiet hours restarts the stale serve once and audits it', async () => {
    const r = await run('auto', true, [{ outcome: 'restarted', detail: 'serve pid 9 (v0.60.371.0)' }]);
    expect(r.calls).toBe(1);
    expect(r.state.tried).toBe(true);
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0]).toMatchObject({ channel: 'autopilot', action: 'restart_serve', outcome: 'applied', reason: 'restarted' });
  });

  test('a restart that does not verify is audited as skipped, never as a failed self-upgrade', async () => {
    const r = await run('auto', true, [{ outcome: 'unverified', detail: 'serve did not come back' }]);
    expect(r.calls).toBe(1);
    expect(r.audit[0]).toMatchObject({ action: 'restart_serve', outcome: 'skipped', reason: 'unverified' });
  });

  test('a serve already on the build is checked once and writes no audit row', async () => {
    const r = await run('auto', true, [{ outcome: 'current' }]);
    expect(r.calls).toBe(1);
    expect(r.audit).toHaveLength(0);
  });

  test('a busy brain is not restarted, and the next idle tick may try', async () => {
    const { home, audit } = brainHome('auto', true);
    const state = { tried: false };
    let calls = 0;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, () =>
      restartServeAfterSelfUpgrade(async () => false, { state, restart: async () => { calls++; return { outcome: 'current' }; } }));
    expect(calls).toBe(0);
    expect(state.tried).toBe(false);
  });

  test('outside quiet hours, or in notify mode, nothing is restarted and the next tick may try', async () => {
    for (const [mode, quiet] of [['auto', false], ['notify', true]] as const) {
      const r = await run(mode, quiet, [{ outcome: 'restarted', detail: 'unused' }]);
      expect(r.calls).toBe(0);
      expect(r.state.tried).toBe(false);
    }
  });

  test('a restart_serve row does not hide doctor\'s held auto-upgrade warning', async () => {
    const { home, audit } = brainHome('auto', true);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, async () => {
      logSelfUpgrade({ channel: 'autopilot', action: 'unsupported_runtime', current: '0.42.0', latest: '0.99.0', outcome: 'skipped', reason: 'gbrain 0.99.0 requires Bun >=9.0.0' });
      await restartServeAfterSelfUpgrade(idle, { state: { tried: false }, restart: async () => ({ outcome: 'unverified', detail: 'serve did not come back' }) });
      expect(checkSelfUpgradeHealth().message).toContain('Auto-upgrade to 0.99.0 held');
    });
  });
});
