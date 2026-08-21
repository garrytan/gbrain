import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { buildChecks, doctorReportRemote, checkSelfUpgradeHealth, type Check } from '../src/commands/doctor.ts';
import { writeUpdateCache } from '../src/core/self-upgrade.ts';
import { logSelfUpgrade } from '../src/core/audit/self-upgrade-audit.ts';
import { VERSION } from '../src/version.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { doctorSource } from './helpers/doctor-source.ts';

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

/**
 * #3747 — `self_upgrade_health` was registered as a doctor check (see
 * `META_CHECK_NAMES` in doctor-categories.ts) and correctly emitted by the
 * REMOTE/thin-client surface (`doctorReportRemote()`), but the LOCAL CLI
 * surface (`buildChecks()`, what a plain `gbrain doctor` actually runs) never
 * called `checkSelfUpgradeHealth()` — so a CLI-install user's local doctor
 * output silently omitted the check entirely, even though it was
 * "registered". Same cross-surface-parity bug class as #550
 * (pages_slug_unique_index); these tests pin both surfaces AND add a
 * source-grep regression guard so it can't silently regress to one-surface-only
 * again.
 */
function findCheck(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}

describe('#3747 doctor surface wiring', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('buildChecks() includes self_upgrade_health (local CLI surface — the regression this fixes)', async () => {
    await withHome(async () => {
      const checks = await buildChecks(engine, ['--scope=brain']);
      const check = findCheck(checks, 'self_upgrade_health');
      expect(check).toBeDefined();
      expect(check!.status).toBe('ok');
    });
  });

  test('doctorReportRemote() still includes self_upgrade_health (regression guard — this side already worked)', async () => {
    await withHome(async () => {
      const report = await doctorReportRemote(engine);
      const check = findCheck(report.checks, 'self_upgrade_health');
      expect(check).toBeDefined();
      expect(check!.status).toBe('ok');
    });
  });
});

describe('#3747 cross-surface parity (source-grep regression guard)', () => {
  test('doctor.ts wires checkSelfUpgradeHealth() into BOTH buildChecks and doctorReportRemote', () => {
    // Static regression assertion: the check-building call must appear in
    // BOTH surfaces on the concatenated doctor source (façade + peeled
    // modules — see doctor-source.ts). Matches the exact call shape
    // (`checks.push(checkSelfUpgradeHealth())`), NOT the bare symbol name —
    // a bare-name pattern would also match the `export function
    // checkSelfUpgradeHealth(): Check {` definition line, which stays
    // present even if one of the two call sites is deleted, silently
    // defeating the guard. If a future maintainer removes the call from one
    // surface, this test fails pointing at the asymmetry (same pattern as
    // the pages_slug_unique_index guard in pages-slug-index-check.test.ts,
    // and the embedding_env_override guard in
    // doctor-embedding-env-override.test.ts).
    const src = doctorSource();
    const matches = src.match(/checks\.push\(checkSelfUpgradeHealth\(\)\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
