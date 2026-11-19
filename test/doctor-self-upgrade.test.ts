import { describe, expect, setSystemTime, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { buildChecks, checkSelfUpgradeHealth } from '../src/commands/doctor.ts';
import { decideSelfUpgrade, gateOnTargetRuntime, writeUpdateCache } from '../src/core/self-upgrade.ts';
import { logSelfUpgrade } from '../src/core/audit/self-upgrade-audit.ts';
import { VERSION } from '../src/version.ts';

async function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-su-'));
  try {
    return await withEnv({ GBRAIN_HOME: dir, GBRAIN_AUDIT_DIR: join(dir, 'audit'), GBRAIN_SELF_UPGRADE_MODE: undefined }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('checkSelfUpgradeHealth', () => {
  test('mode=off → ok, names disabled', async () => {
    await withEnv({ GBRAIN_SELF_UPGRADE_MODE: 'off' }, () => {
      const c = checkSelfUpgradeHealth();
      expect(c.name).toBe('self_upgrade_health');
      expect(c.status).toBe('ok');
      expect(c.message).toContain('disabled');
    });
  });

  test('fresh install (no cache) → ok, mode=notify', async () => {
    await withHome(() => {
      const c = checkSelfUpgradeHealth();
      expect(c.status).toBe('ok');
      expect(c.message).toContain('mode=notify');
    });
  });

  test('pending upgrade in cache → ok, surfaces it', async () => {
    await withHome(() => {
      writeUpdateCache({ kind: 'upgrade_available', current: '0.42.0', latest: '0.99.0' });
      const c = checkSelfUpgradeHealth();
      expect(c.status).toBe('ok');
      expect(c.message).toContain('update available');
      expect(c.message).toContain('-> 0.99.0');
    });
  });

  test('fresh cache with latest == running version → suppressed (no update-available nag)', async () => {
    await withHome(() => {
      // Stale/foreign cache: the recorded latest is the version we are already
      // running. The shared pendingUpgradeVersion guard must suppress the nag.
      writeUpdateCache({ kind: 'upgrade_available', current: VERSION, latest: VERSION });
      const c = checkSelfUpgradeHealth();
      expect(c.status).toBe('ok');
      expect(c.message).not.toContain('update available');
    });
  });

  test('recent failed auto-upgrade → warn with hint', async () => {
    await withHome(() => {
      logSelfUpgrade({ channel: 'autopilot', action: 'apply', current: '0.42.0', latest: '0.99.0', outcome: 'failed', error: 'boom' });
      const c = checkSelfUpgradeHealth();
      expect(c.status).toBe('warn');
      expect(c.message).toContain('self-upgrade failure');
      expect(c.message).toContain('foresights self-upgrade');
    });
  });

  test('#5855: an auto-upgrade held for the Bun floor warns with the fix line until a later apply or a manual upgrade to it', async () => {
    const apply = decideSelfUpgrade({ mode: 'auto', channel: 'autopilot', currentVersion: '0.42.0', latestVersion: '0.99.0', failedVersions: [], idle: true, inQuietHours: true, canSelfUpdate: true });
    const unmet = gateOnTargetRuntime(apply, { ok: true, floor: '9.0.0', version: '0.99.0' }, { label: 'bun on PATH', path: '/opt/bun', version: '1.4.2' });
    await withHome(() => {
      logSelfUpgrade({ channel: 'autopilot', action: 'apply', current: '0.42.0', latest: '0.43.0', outcome: 'failed', error: 'boom' });
      logSelfUpgrade({ channel: 'autopilot', action: unmet.action, current: '0.42.0', latest: '0.99.0', outcome: 'skipped', reason: unmet.reason });
      const c = checkSelfUpgradeHealth();
      expect(c.status).toBe('warn');
      expect(c.message).toContain('Auto-upgrade to 0.99.0 held: foresights 0.99.0 requires Bun >=9.0.0; bun on PATH is 1.4.2. Fix: bun upgrade, then foresights upgrade. Docs: docs/guides/upgrades-auto-update.md#bun-floor');

      logSelfUpgrade({ channel: 'autopilot', action: 'apply', current: '0.42.0', latest: '0.99.0', reason: 'auto-upgrading 0.42.0 -> 0.99.0' });
      expect(checkSelfUpgradeHealth().message).not.toContain('held');

      logSelfUpgrade({ channel: 'autopilot', action: 'unsupported_runtime', current: '0.42.0', latest: VERSION, outcome: 'skipped', reason: `foresights ${VERSION} requires Bun >=9.0.0` });
      expect(checkSelfUpgradeHealth().message).not.toContain('held');
    });
  });

  test('#5855: a hold on an unreadable floor names the failed read', async () => {
    const apply = decideSelfUpgrade({ mode: 'auto', channel: 'autopilot', currentVersion: '0.42.0', latestVersion: '0.99.0', failedVersions: [], idle: true, inQuietHours: true, canSelfUpdate: true });
    const unreadable = gateOnTargetRuntime(apply, { ok: false, failedRead: 'GET https://raw.githubusercontent.com/aimonk2025/gbrain/HEAD/package.json returned HTTP 503' }, { label: 'bun on PATH', path: '/opt/bun', version: '1.4.2' });
    await withHome(() => {
      logSelfUpgrade({ channel: 'autopilot', action: unreadable.action, current: '0.42.0', latest: '0.99.0', outcome: 'skipped', reason: unreadable.reason });
      const c = checkSelfUpgradeHealth();
      expect(c.status).toBe('warn');
      expect(c.message).toContain('Auto-upgrade to 0.99.0 held: Could not read the Bun floor of foresights 0.99.0: GET https://raw.githubusercontent.com/aimonk2025/gbrain/HEAD/package.json returned HTTP 503.');
      expect(c.message).toContain('The next quiet-hours tick retries.');
    });
  });

  test('#5855: the newest event decides across the ISO-week boundary (held state and the last failure)', async () => {
    // Wednesday of ISO week 40; the previous-week events sit on Sunday of week 39.
    setSystemTime(new Date('2026-09-30T12:00:00Z'));
    try {
      await withHome(() => {
        logSelfUpgrade({ ts: '2026-09-27T23:00:00.000Z', channel: 'autopilot', action: 'apply', current: '0.42.0', latest: '0.43.0', reason: 'auto-upgrading 0.42.0 -> 0.43.0' });
        logSelfUpgrade({ channel: 'autopilot', action: 'unsupported_runtime', current: '0.43.0', latest: '0.99.0', outcome: 'skipped', reason: 'foresights 0.99.0 requires Bun >=9.0.0' });
        expect(checkSelfUpgradeHealth().message).toContain('Auto-upgrade to 0.99.0 held');
      });
      await withHome(() => {
        logSelfUpgrade({ ts: '2026-09-27T23:00:00.000Z', channel: 'autopilot', action: 'apply', current: '0.42.0', latest: '0.43.0', outcome: 'failed', error: 'older' });
        logSelfUpgrade({ channel: 'autopilot', action: 'apply', current: '0.42.0', latest: '0.44.0', outcome: 'failed', error: 'newer' });
        const message = checkSelfUpgradeHealth().message;
        expect(message).toContain('Last: 0.44.0');
        expect(message).toContain('newer');
        expect(message).not.toContain('older');
      });
    } finally {
      setSystemTime();
    }
  });

  test('known-bad versions in config are surfaced', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({ engine: 'pglite', self_upgrade: { mode: 'notify', failed_versions: ['0.50.0'] } }),
      );
      const c = checkSelfUpgradeHealth();
      expect(c.message).toContain('known-bad');
      expect(c.message).toContain('0.50.0');
    });
  });
});

describe('#3747: LOCAL doctor emits self_upgrade_health', () => {
  // Pre-fix, only the remote report (doctor/report-remote.ts) pushed this
  // check — `foresights doctor` on the host machine, the surface an operator
  // actually diagnoses upgrade problems from, never showed it.
  test('buildChecks includes self_upgrade_health (engine-free, --fast)', async () => {
    await withHome(async () => {
      const checks = await buildChecks(null, ['--scope=brain', '--fast']);
      const c = checks.find((ch) => ch.name === 'self_upgrade_health');
      expect(c).toBeDefined();
      expect(c!.status).toBe('ok');
    });
  });

  test('buildChecks surfaces a recent failed auto-upgrade as warn', async () => {
    await withHome(async () => {
      logSelfUpgrade({ channel: 'autopilot', action: 'apply', current: '0.42.0', latest: '0.99.0', outcome: 'failed', error: 'boom' });
      const checks = await buildChecks(null, ['--scope=brain', '--fast']);
      const c = checks.find((ch) => ch.name === 'self_upgrade_health');
      expect(c).toBeDefined();
      expect(c!.status).toBe('warn');
      expect(c!.message).toContain('self-upgrade failure');
    });
  });
});
