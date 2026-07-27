import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { checkSelfUpgradeHealth } from '../src/commands/doctor.ts';
import { writeUpdateCache } from '../src/core/self-upgrade.ts';
import { logSelfUpgrade } from '../src/core/audit/self-upgrade-audit.ts';

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
      expect(c.message).toContain('0.99.0');
    });
  });

  test('recent failed auto-upgrade → warn with hint', async () => {
    await withHome(() => {
      logSelfUpgrade({ channel: 'autopilot', action: 'apply', current: '0.42.0', latest: '0.99.0', outcome: 'failed', error: 'boom' });
      const c = checkSelfUpgradeHealth();
      expect(c.status).toBe('warn');
      expect(c.message).toContain('self-upgrade failure');
      expect(c.message).toContain('gbrain self-upgrade');
    });
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
