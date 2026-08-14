/**
 * Unit tests for `pendingUpgradeVersion` — the ONE shared "is an upgrade
 * actually pending for THIS binary?" predicate (src/core/self-upgrade.ts).
 *
 * Every upgrade-nag surface (CLI startup marker, doctor, advisor,
 * get_brain_identity) routes through it, so this file pins the suppression
 * rule centrally: a stale or foreign cache (latest <= running version) must
 * return null. The cache records the version of whatever binary WROTE it —
 * an older gbrain on PATH can write `UPGRADE_AVAILABLE 0.0.1 X` — so the
 * comparison must be against the RUNNING version, never `marker.current`.
 *
 * Also covers the advisor consumer (collect-version.ts): version_drift fires
 * only when the shared predicate says an upgrade is pending.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  CACHE_TTL_UPGRADE_AVAILABLE_MS,
  pendingUpgradeVersion,
  updateCachePath,
  writeUpdateCache,
} from '../src/core/self-upgrade.ts';
import { collectVersion } from '../src/core/advisor/collect-version.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

/** Run `fn` with GBRAIN_HOME pointed at a fresh temp dir (env restored after). */
async function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-pending-'));
  try {
    return await withEnv({ GBRAIN_HOME: dir }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Backdate the cache file's mtime so `isCacheFresh` sees it as expired. */
function backdateCache(byMs: number): void {
  const then = new Date(Date.now() - byMs);
  utimesSync(updateCachePath(), then, then);
}

describe('pendingUpgradeVersion', () => {
  test('fresh cache, latest > running → returns latest', async () => {
    await withHome(() => {
      writeUpdateCache({ kind: 'upgrade_available', current: '0.42.0', latest: '0.99.0' });
      expect(pendingUpgradeVersion('0.42.0')).toBe('0.99.0');
    });
  });

  test('fresh cache, latest == running → null (already current; suppress the nag)', async () => {
    await withHome(() => {
      writeUpdateCache({ kind: 'upgrade_available', current: '0.42.0', latest: '0.42.0' });
      expect(pendingUpgradeVersion('0.42.0')).toBeNull();
    });
  });

  test('fresh cache, latest < running → null (downgrade/yanked never nags)', async () => {
    await withHome(() => {
      writeUpdateCache({ kind: 'upgrade_available', current: '0.0.1', latest: '0.42.0' });
      expect(pendingUpgradeVersion('0.99.0')).toBeNull();
    });
  });

  test('foreign-writer cache: comparison is against the RUNNING version, not marker.current', async () => {
    await withHome(() => {
      // An old 0.0.1 binary on PATH wrote the cache. The running binary must
      // compare ITS version to latest — marker.current is untrusted.
      writeUpdateCache({ kind: 'upgrade_available', current: '0.0.1', latest: '0.99.0' });
      expect(pendingUpgradeVersion('0.99.0')).toBeNull(); // already on latest → suppressed
      expect(pendingUpgradeVersion('0.42.0')).toBe('0.99.0'); // genuinely behind → nag
    });
  });

  test('stale cache (mtime beyond upgrade_available TTL) → null', async () => {
    await withHome(() => {
      writeUpdateCache({ kind: 'upgrade_available', current: '0.42.0', latest: '0.99.0' });
      backdateCache(CACHE_TTL_UPGRADE_AVAILABLE_MS + 60_000);
      expect(pendingUpgradeVersion('0.42.0')).toBeNull();
    });
  });

  test('missing cache → null', async () => {
    await withHome(() => {
      expect(pendingUpgradeVersion('0.42.0')).toBeNull();
    });
  });

  test('up_to_date marker kind → null', async () => {
    await withHome(() => {
      writeUpdateCache({ kind: 'up_to_date', current: '0.42.0' });
      expect(pendingUpgradeVersion('0.42.0')).toBeNull();
    });
  });

  test('corrupt cache content → null (never throws)', async () => {
    await withHome((home) => {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(updateCachePath(), 'UPGRADE_AVAILABLE not-a-version; rm -rf /\n');
      expect(pendingUpgradeVersion('0.42.0')).toBeNull();
    });
  });
});

describe('advisor collectVersion (consumer of the shared predicate)', () => {
  const ctx = (version: string) => ({ version } as unknown as AdvisorContext);

  test('fresh cache with newer latest → one version_drift finding', async () => {
    await withHome(async () => {
      writeUpdateCache({ kind: 'upgrade_available', current: '0.42.0', latest: '0.99.0' });
      const findings = await collectVersion.collect(ctx('0.42.0'));
      expect(findings).toHaveLength(1);
      expect(findings[0].id).toBe('version_drift');
      expect(findings[0].title).toContain('0.99.0');
      expect(findings[0].title).toContain('0.42.0');
    });
  });

  test('latest == ctx.version → no findings (stale/foreign cache suppressed)', async () => {
    await withHome(async () => {
      writeUpdateCache({ kind: 'upgrade_available', current: '0.42.0', latest: '0.99.0' });
      const findings = await collectVersion.collect(ctx('0.99.0'));
      expect(findings).toEqual([]);
    });
  });
});
