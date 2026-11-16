/**
 * #8013: follow-ups to the #7475 serve restart. The attempt is remembered per build across autopilot relaunches, a
 * serve service installed for another brain is never restarted, and the restart command runs without blocking the
 * autopilot's event loop.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostExecutor, restartServeAfterSelfUpgrade, type ServeRestartOutcome } from '../src/commands/upgrade-restart.ts';
import { readRecentSelfUpgrades } from '../src/core/audit/self-upgrade-audit.ts';
import { launchdPlistPath, renderServeLaunchdPlist, renderServeSystemdUnit, serveServiceRunsWrapper, systemdUnitPath } from '../src/core/serve-service.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

describe('serve restart attempt marker (#8013)', () => {
  function brainHome(): { home: string; audit: string } {
    const root = tempDir('gbrain-serve-restart-8013-');
    const start = new Date().getUTCHours();
    mkdirSync(join(root, '.gbrain'), { recursive: true });
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite', database_path: join(root, '.gbrain', 'brain.pglite'),
      self_upgrade: { mode: 'auto', quiet_hours: { start, end: (start + 2) % 24, tz: 'UTC' } },
    }));
    return { home: root, audit: join(root, 'audit') };
  }

  test('a failed restart is not repeated by the next autopilot process on the same build', async () => {
    const { home, audit } = brainHome();
    let calls = 0;
    const restart = async (): Promise<ServeRestartOutcome> => { calls++; return { outcome: 'unverified', detail: 'serve did not come back' }; };
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, async () => {
      await restartServeAfterSelfUpgrade(async () => true, { state: { tried: false }, restart });
      await restartServeAfterSelfUpgrade(async () => true, { state: { tried: false }, restart });
      expect(readRecentSelfUpgrades(1).filter(e => e.action === 'restart_serve')).toHaveLength(1);
    });
    expect(calls).toBe(1);
  });

  test('a marker left by another build does not hold the restart back', async () => {
    const { home, audit } = brainHome();
    writeFileSync(join(home, '.gbrain', 'serve-restart-attempt.json'), JSON.stringify({ version: '0.0.1.0', ts: '2026-01-01T00:00:00.000Z' }));
    let calls = 0;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, () =>
      restartServeAfterSelfUpgrade(async () => true, { state: { tried: false }, restart: async () => { calls++; return { outcome: 'current' }; } }));
    expect(calls).toBe(1);
  });

  test('a busy brain leaves no marker, so a later idle tick still tries', async () => {
    const { home, audit } = brainHome();
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: audit }, () =>
      restartServeAfterSelfUpgrade(async () => false, { state: { tried: false }, restart: async () => ({ outcome: 'current' }) }));
    expect(existsSync(join(home, '.gbrain', 'serve-restart-attempt.json'))).toBe(false);
  });
});

describe('serveServiceRunsWrapper (#8013)', () => {
  const own = '/srv/brain-a/.gbrain/serve/gbrain-serve.sh';
  const other = '/srv/brain-b/.gbrain/serve/gbrain-serve.sh';

  test('launchd: true only for the plist that starts this brain\'s wrapper', () => {
    const home = tempDir('gbrain-serve-owner-mac-');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(launchdPlistPath(home), renderServeLaunchdPlist({ wrapperPath: own, home, logPath: '/tmp/l', errPath: '/tmp/e' }));
    expect(serveServiceRunsWrapper('darwin', home, own)).toBe(true);
    expect(serveServiceRunsWrapper('darwin', home, other)).toBe(false);
  });

  test('systemd: true only for the unit that starts this brain\'s wrapper, including a path with spaces', () => {
    const home = tempDir('gbrain-serve-owner-linux-');
    const spaced = '/srv/brain a/.gbrain/serve/gbrain-serve.sh';
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(systemdUnitPath(home), renderServeSystemdUnit({ wrapperPath: spaced, logPath: '/tmp/l', errPath: '/tmp/e' }));
    expect(serveServiceRunsWrapper('linux', home, spaced)).toBe(true);
    expect(serveServiceRunsWrapper('linux', home, other)).toBe(false);
  });

  test('no service file, or another platform, is never this brain\'s', () => {
    const home = tempDir('gbrain-serve-owner-none-');
    expect(serveServiceRunsWrapper('darwin', home, own)).toBe(false);
    expect(serveServiceRunsWrapper('linux', home, own)).toBe(false);
    expect(serveServiceRunsWrapper('win32', home, own)).toBe(false);
  });
});

describe('hostExecutor run (#8013)', () => {
  test('a slow restart command leaves the event loop running', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    try {
      const r = await hostExecutor('/nonexistent/supervisor.pid').run(['sleep', '0.5']);
      expect(r.status).toBe(0);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(10);
  });

  test('a command past its timeout is killed and reported as failed', async () => {
    const started = Date.now();
    const r = await hostExecutor('/nonexistent/supervisor.pid', 200).run(['sleep', '5']);
    expect(r.status).toBeNull();
    expect(r.output).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test('output and exit status come back as before', async () => {
    const r = await hostExecutor('/nonexistent/supervisor.pid').run(['sh', '-c', 'echo out; echo err >&2; exit 3']);
    expect(r.status).toBe(3);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
  });
});
