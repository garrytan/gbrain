import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  canSelfUpdate,
  clearSnooze,
  clearUpdateCache,
  decideSelfUpgrade,
  formatMarker,
  gateOnTargetRuntime,
  isCacheFresh,
  isSnoozeActive,
  parseMarker,
  readSnooze,
  readUpdateCache,
  reconcileBreadcrumb,
  resolveSelfUpgradeMode,
  snoozeDurationMs,
  writeSnooze,
  writeUpdateCache,
  type DecideSelfUpgradeInputs,
  type SelfUpgradeAction,
  type SelfUpgradeState,
} from '../src/core/self-upgrade.ts';
import type { HostBun, TargetFloor } from '../src/core/bun-floor.ts';

function baseInputs(over: Partial<DecideSelfUpgradeInputs> = {}): DecideSelfUpgradeInputs {
  return {
    mode: 'notify',
    currentVersion: '0.42.0',
    latestVersion: '0.43.0',
    failedVersions: [],
    channel: 'invocation',
    ...over,
  };
}

async function withTmpHome<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-selfupgrade-'));
  try {
    return await withEnv({ GBRAIN_HOME: dir, GBRAIN_SELF_UPGRADE_MODE: undefined }, fn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('decideSelfUpgrade — pure branches', () => {
  test('mode=off short-circuits', () => {
    expect(decideSelfUpgrade(baseInputs({ mode: 'off' })).action).toBe('off');
  });

  test('null/invalid latest → not_behind (fail-open)', () => {
    expect(decideSelfUpgrade(baseInputs({ latestVersion: null })).action).toBe('not_behind');
    expect(decideSelfUpgrade(baseInputs({ latestVersion: 'garbage' })).action).toBe('not_behind');
    expect(decideSelfUpgrade(baseInputs({ latestVersion: 'rm -rf /' })).action).toBe('not_behind');
  });

  test('equal version → not_behind', () => {
    expect(decideSelfUpgrade(baseInputs({ latestVersion: '0.42.0' })).action).toBe('not_behind');
  });

  test('latest < current → downgrade_or_yanked (never acts)', () => {
    const d = decideSelfUpgrade(baseInputs({ currentVersion: '0.43.0', latestVersion: '0.42.0' }));
    expect(d.action).toBe('downgrade_or_yanked');
  });

  test('patch and micro releases → behind', () => {
    expect(decideSelfUpgrade(baseInputs({ currentVersion: '0.42.0', latestVersion: '0.42.1' })).action).toBe('notify');
    expect(decideSelfUpgrade(baseInputs({ currentVersion: '0.42.3.0', latestVersion: '0.42.3.1' })).action).toBe('notify');
  });

  test('minor bump → behind', () => {
    expect(decideSelfUpgrade(baseInputs({ currentVersion: '0.42.0', latestVersion: '0.43.0' })).action).toBe('notify');
  });

  test('major bump → behind', () => {
    expect(decideSelfUpgrade(baseInputs({ currentVersion: '0.42.0', latestVersion: '1.0.0' })).action).toBe('notify');
  });

  test('known-bad latest → known_bad (no retry)', () => {
    const d = decideSelfUpgrade(baseInputs({ failedVersions: ['0.43.0'] }));
    expect(d.action).toBe('known_bad');
  });

  test('invocation channel: snoozed → throttled', () => {
    expect(decideSelfUpgrade(baseInputs({ snoozed: true })).action).toBe('throttled');
  });

  test('invocation channel: not snoozed → notify', () => {
    expect(decideSelfUpgrade(baseInputs({ snoozed: false })).action).toBe('notify');
  });

  describe('autopilot channel gates', () => {
    const auto = (over: Partial<DecideSelfUpgradeInputs> = {}) =>
      decideSelfUpgrade(
        baseInputs({
          mode: 'auto',
          channel: 'autopilot',
          idle: true,
          inQuietHours: true,
          canSelfUpdate: true,
          throttledByInterval: false,
          ...over,
        }),
      );

    test('all gates pass → apply', () => {
      expect(auto().action).toBe('apply');
    });
    test('throttledByInterval → throttled', () => {
      expect(auto({ throttledByInterval: true }).action).toBe('throttled');
    });
    test('not idle → busy', () => {
      expect(auto({ idle: false }).action).toBe('busy');
    });
    test('outside quiet hours → outside_quiet_hours', () => {
      expect(auto({ inQuietHours: false }).action).toBe('outside_quiet_hours');
    });
    test('cannot self-update → unsupported_install', () => {
      expect(auto({ canSelfUpdate: false }).action).toBe('unsupported_install');
    });
    test('gate order: known_bad beats idle/quiet gates', () => {
      expect(auto({ failedVersions: ['0.43.0'], idle: false }).action).toBe('known_bad');
    });

    test('#5855: an apply is held when the target Bun floor is above the host Bun, or either is unknown', () => {
      const bun = (version: string): HostBun => ({ label: 'bun on PATH', path: '/opt/bun', version });
      const floor = (f: string): TargetFloor => ({ ok: true, floor: f, version: null });
      const cases: Array<{ target: TargetFloor; host: HostBun | null; action: SelfUpgradeAction; reason?: string[] }> = [
        { target: floor('1.4.0'), host: bun('1.4.2'), action: 'apply' },
        { target: floor('1.4.0'), host: bun('1.4.0'), action: 'apply' },
        { target: floor('1.4.0'), host: bun('1.4.0+5a1b2c3'), action: 'apply' },
        { target: floor('1.4.0'), host: bun('1.5.0-canary.2'), action: 'apply' },
        { target: floor('1.4.0'), host: bun('1.4.0-canary.9'), action: 'unsupported_runtime', reason: ['gbrain 0.43.0 requires Bun >=1.4.0', 'bun on PATH is 1.4.0-canary.9'] },
        { target: floor('1.4.0'), host: bun('1.3.14'), action: 'unsupported_runtime', reason: ['gbrain 0.43.0 requires Bun >=1.4.0', 'bun on PATH is 1.3.14', 'Fix: bun upgrade, then gbrain upgrade'] },
        { target: { ok: false, failedRead: '`git fetch` in the source clone failed' }, host: bun('1.4.2'), action: 'unsupported_runtime', reason: ['Could not read the Bun floor of gbrain 0.43.0', 'The next quiet-hours tick retries'] },
        { target: floor('1.4.0'), host: null, action: 'unsupported_runtime', reason: ['could not run `bun --version` on PATH'] },
      ];
      for (const c of cases) {
        const d = gateOnTargetRuntime(auto(), c.target, c.host);
        expect(d.action, JSON.stringify(c)).toBe(c.action);
        expect(d.latest).toBe('0.43.0');
        for (const fragment of c.reason ?? []) expect(d.reason).toContain(fragment);
        expect(d.reason).not.toContain('/opt/bun');
      }
    });

    test('#5855: the runtime gate leaves a non-apply decision unchanged', () => {
      const busy = auto({ idle: false });
      expect(gateOnTargetRuntime(busy, { ok: true, floor: '9.0.0', version: null }, null)).toEqual(busy);
    });
  });
});

describe('canSelfUpdate', () => {
  test('bun / bun-link / clawhub always self-update', () => {
    for (const m of ['bun', 'bun-link', 'clawhub']) {
      expect(canSelfUpdate(m, 'darwin', 'arm64')).toBe(true);
      expect(canSelfUpdate(m, 'win32', 'x64')).toBe(true);
    }
  });
  test('binary self-updates only where a release asset exists (darwin-arm64, linux-x64)', () => {
    expect(canSelfUpdate('binary', 'darwin', 'arm64')).toBe(true);
    expect(canSelfUpdate('binary', 'linux', 'x64')).toBe(true);
    expect(canSelfUpdate('binary', 'darwin', 'x64')).toBe(false); // no asset published
    expect(canSelfUpdate('binary', 'linux', 'arm64')).toBe(false); // no asset published
    expect(canSelfUpdate('binary', 'win32', 'x64')).toBe(false);
  });
  test('unknown method cannot self-update', () => {
    expect(canSelfUpdate('unknown', 'darwin', 'arm64')).toBe(false);
  });
});

describe('marker grammar', () => {
  test('round-trips up_to_date and upgrade_available', () => {
    const a = { kind: 'up_to_date' as const, current: '0.42.0' };
    expect(parseMarker(formatMarker(a))).toEqual(a);
    const b = { kind: 'upgrade_available' as const, current: '0.42.0', latest: '0.43.0' };
    expect(parseMarker(formatMarker(b))).toEqual(b);
  });
  test('rejects forged / malformed markers', () => {
    expect(parseMarker('UPGRADE_AVAILABLE 0.42.0 $(rm -rf /)')).toBeNull();
    expect(parseMarker('UPGRADE_AVAILABLE 0.42.0')).toBeNull();
    expect(parseMarker('EVIL 0.42.0 0.43.0')).toBeNull();
    expect(parseMarker('UP_TO_DATE not-a-version')).toBeNull();
    expect(parseMarker('')).toBeNull();
  });
});

describe('snooze', () => {
  test('escalating durations cap at 7d', () => {
    expect(snoozeDurationMs(1)).toBe(24 * 3600 * 1000);
    expect(snoozeDurationMs(2)).toBe(48 * 3600 * 1000);
    expect(snoozeDurationMs(3)).toBe(7 * 24 * 3600 * 1000);
    expect(snoozeDurationMs(99)).toBe(7 * 24 * 3600 * 1000);
  });
  test('isSnoozeActive: time-based, holds across newer releases, ends at its expiry or on a rollback below the snoozed version', () => {
    const now = 1_000_000_000_000;
    const rec = { version: '0.43.0', level: 1, ts: now, until: now + 24 * 3600 * 1000 };
    expect(isSnoozeActive(rec, '0.43.0', now + 1000)).toBe(true);
    expect(isSnoozeActive(rec, '0.44.0', now + 1000)).toBe(true); // a newer release does not end it
    expect(isSnoozeActive(rec, '0.99.0', now + 23 * 3600 * 1000)).toBe(true);
    expect(isSnoozeActive(rec, '0.43.0', now + 25 * 3600 * 1000)).toBe(false); // expired
    expect(isSnoozeActive(rec, '0.42.0', now + 1000)).toBe(false); // rolled back below the snoozed version
    expect(isSnoozeActive(null, '0.43.0', now)).toBe(false);
  });
  test('writeSnooze escalates per channel whatever version is offered (24h, 48h, 7d), atomically; clearSnooze clears every channel', async () => {
    await withTmpHome(() => {
      const now = 1_700_000_000_000;
      const h = 3600 * 1000;
      expect(writeSnooze('0.43.0', now, 'alpha')).toMatchObject({ level: 1, until: now + 24 * h });
      expect(writeSnooze('0.44.0', now, 'alpha')).toMatchObject({ level: 2, until: now + 48 * h });
      expect(writeSnooze('0.45.0', now, 'alpha')).toMatchObject({ level: 3, until: now + 7 * 24 * h });
      expect(writeSnooze('0.46.0', now, 'alpha').level).toBe(3); // capped
      expect(writeSnooze('0.43.0', now, 'stable').level).toBe(1); // channels are independent
      expect(readSnooze('alpha')).toMatchObject({ version: '0.46.0', level: 3 });
      expect(readSnooze('stable')).toMatchObject({ version: '0.43.0', level: 1 });
      clearSnooze();
      expect(readSnooze('alpha')).toBeNull();
      expect(readSnooze('stable')).toBeNull();
    });
  });
  test('corrupt snooze file → null', async () => {
    await withTmpHome(async () => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { gbrainPath } = await import('../src/core/config.ts');
      mkdirSync(gbrainPath(), { recursive: true });
      writeFileSync(gbrainPath('update-snoozed'), 'garbage not three fields here');
      expect(readSnooze()).toBeNull();
      writeFileSync(gbrainPath('update-snoozed.stable.json'), '{"version":"0.43.0","level":"x"}');
      expect(readSnooze('stable')).toBeNull();
    });
  });
});

describe('cache', () => {
  test('write → read round-trip, atomic, fresh check', async () => {
    await withTmpHome(() => {
      writeUpdateCache({ kind: 'upgrade_available', current: '0.42.0', latest: '0.43.0' });
      const entry = readUpdateCache();
      expect(entry?.marker).toEqual({ kind: 'upgrade_available', current: '0.42.0', latest: '0.43.0' });
      expect(isCacheFresh(entry!, entry!.mtimeMs + 1000)).toBe(true);
      expect(isCacheFresh(entry!, entry!.mtimeMs + 13 * 3600 * 1000)).toBe(false); // > 12h
      clearUpdateCache();
      expect(readUpdateCache()).toBeNull();
    });
  });
  test('up_to_date uses the 60min TTL', async () => {
    await withTmpHome(() => {
      writeUpdateCache({ kind: 'up_to_date', current: '0.42.0' });
      const entry = readUpdateCache()!;
      expect(isCacheFresh(entry, entry.mtimeMs + 59 * 60 * 1000)).toBe(true);
      expect(isCacheFresh(entry, entry.mtimeMs + 61 * 60 * 1000)).toBe(false);
    });
  });
  test('corrupt cache file → null (fail-open)', async () => {
    await withTmpHome(async () => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { gbrainPath } = await import('../src/core/config.ts');
      mkdirSync(gbrainPath(), { recursive: true });
      writeFileSync(gbrainPath('last-update-check'), 'EVIL not a marker');
      expect(readUpdateCache()).toBeNull();
    });
  });
});

describe('writeJustUpgraded', () => {
  test('writes the from-version breadcrumb the CLI startup hook reads', async () => {
    await withTmpHome(async () => {
      const { writeJustUpgraded, justUpgradedPath } = await import('../src/core/self-upgrade.ts');
      const { readFileSync } = await import('node:fs');
      writeJustUpgraded('0.42.0');
      expect(readFileSync(justUpgradedPath(), 'utf8').trim()).toBe('0.42.0');
    });
  });
});

describe('reconcileBreadcrumb', () => {
  test('no breadcrumb → no transition', () => {
    expect(reconcileBreadcrumb(undefined, '0.42.0').transition).toBeNull();
    expect(reconcileBreadcrumb({}, '0.42.0').transition).toBeNull();
  });
  test('breadcrumb matches running version → applied, breadcrumb cleared, last_applied set', () => {
    const r = reconcileBreadcrumb({ attempting_version: '0.43.0' }, '0.43.0');
    expect(r.transition).toBe('applied');
    expect(r.state.attempting_version).toBeUndefined();
    expect(r.state.last_applied_version).toBe('0.43.0');
  });
  test('breadcrumb != running version → failed, recorded known-bad, breadcrumb cleared', () => {
    const r = reconcileBreadcrumb({ attempting_version: '0.43.0' }, '0.42.0');
    expect(r.transition).toBe('failed');
    expect(r.state.attempting_version).toBeUndefined();
    expect(r.state.failed_versions).toContain('0.43.0');
  });
  test('failed dedups into existing failed_versions', () => {
    const r = reconcileBreadcrumb({ attempting_version: '0.43.0', failed_versions: ['0.43.0', '0.41.0'] }, '0.42.0');
    expect(r.state.failed_versions?.filter((v) => v === '0.43.0').length).toBe(1);
  });
  test('unparseable running version → failed (no ordering to trust)', () => {
    const r = reconcileBreadcrumb({ attempting_version: '0.43.0' }, 'dev');
    expect(r.transition).toBe('failed');
    expect(r.state.failed_versions).toEqual(['0.43.0']);
  });
  // #5813: the swap installs whatever is current at swap time (git pull, bun
  // update, releases/latest), so the relaunched binary can be NEWER than the
  // version the breadcrumb recorded from the update cache.
  const appliedCases: Array<{ name: string; su: SelfUpgradeState; running: string; failed: string[] | undefined }> = [
    { name: 'running newer than attempted', su: { attempting_version: '0.60.22.0' }, running: '0.60.25.0', failed: undefined },
    {
      name: 'prunes known-bad entries at or below the running version',
      su: { attempting_version: '0.60.22.0', failed_versions: ['0.59.2.0', '0.60.25.0', '0.60.30.0'] },
      running: '0.60.25.0',
      failed: ['0.60.30.0'],
    },
    {
      name: 'exact match prunes too and keeps unparseable entries',
      su: { attempting_version: '0.43.0', failed_versions: ['0.41.0', 'not-a-version'] },
      running: '0.43.0',
      failed: ['not-a-version'],
    },
    {
      name: 'pruning every entry drops the key',
      su: { attempting_version: '0.60.22.0', failed_versions: ['0.59.2.0', '0.60.8.0'] },
      running: '0.60.25.0',
      failed: undefined,
    },
  ];
  for (const c of appliedCases) {
    test(`applied: ${c.name}`, () => {
      const r = reconcileBreadcrumb(c.su, c.running);
      expect(r.transition).toBe('applied');
      expect(r.state.attempting_version).toBeUndefined();
      expect(r.state.last_applied_version).toBe(c.running);
      expect(r.state.failed_versions).toEqual(c.failed);
    });
  }
});

describe('resolveSelfUpgradeMode', () => {
  test('defaults to notify', async () => {
    await withEnv({ GBRAIN_SELF_UPGRADE_MODE: undefined }, () => {
      expect(resolveSelfUpgradeMode(null)).toBe('notify');
      expect(resolveSelfUpgradeMode({})).toBe('notify');
      expect(resolveSelfUpgradeMode({ self_upgrade: { mode: 'bogus' } })).toBe('notify');
    });
  });
  test('config plane honored', async () => {
    await withEnv({ GBRAIN_SELF_UPGRADE_MODE: undefined }, () => {
      expect(resolveSelfUpgradeMode({ self_upgrade: { mode: 'auto' } })).toBe('auto');
      expect(resolveSelfUpgradeMode({ self_upgrade: { mode: 'off' } })).toBe('off');
    });
  });
  test('env overrides config', async () => {
    await withEnv({ GBRAIN_SELF_UPGRADE_MODE: 'off' }, () => {
      expect(resolveSelfUpgradeMode({ self_upgrade: { mode: 'auto' } })).toBe('off');
    });
  });
});
