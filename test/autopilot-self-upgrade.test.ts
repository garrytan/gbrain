import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSystemdUnit, reconcileSelfUpgradeAtBoot } from '../src/commands/autopilot.ts';
import { readRecentSelfUpgrades } from '../src/core/audit/self-upgrade-audit.ts';
import { VERSION } from '../src/version.ts';
import { surfaceFileSource, surfaceSource } from './helpers/source-surface.ts';
import { withEnv } from './helpers/with-env.ts';

// W4 autopilot: containment reads the autopilot surface; the positional spans stay on
// autopilot.ts, which still holds attemptAutopilotSelfUpgrade.
const AUTOPILOT_SRC = surfaceSource('autopilot');
const SELF_UPGRADE_SRC = surfaceFileSource('autopilot', 'src/commands/autopilot.ts');

describe('generateSystemdUnit', () => {
  const unit = generateSystemdUnit('/home/u/.gbrain/autopilot-run.sh');

  test('uses Restart=always (NOT on-failure) so a clean exit-for-relaunch respawns', () => {
    expect(unit).toContain('Restart=always');
    expect(unit).not.toContain('Restart=on-failure');
  });
  test('caps a clean-exit respawn storm with StartLimit*', () => {
    expect(unit).toContain('StartLimitIntervalSec=');
    expect(unit).toContain('StartLimitBurst=');
  });
  test('runs the given wrapper path', () => {
    expect(unit).toContain('ExecStart=/home/u/.gbrain/autopilot-run.sh');
  });
});

describe('autopilot self-upgrade static-shape regressions', () => {
  test('supervisor-relaunch, NOT in-process re-exec (Bun has no execve) — no exec*-call', () => {
    // Match call-shape, not the word (the comments legitimately say "no execve").
    expect(AUTOPILOT_SRC).not.toMatch(/execve\s*\(/);
    expect(AUTOPILOT_SRC).not.toMatch(/execvp\s*\(/);
  });
  test('the silent channel does swap-only, never a blocking full post-upgrade in the tick', () => {
    expect(AUTOPILOT_SRC).toContain("execSync('foresights upgrade --swap-only'");
    // The tick must not invoke the (up-to-30-min) post-upgrade inline.
    expect(AUTOPILOT_SRC).not.toContain("execSync('foresights post-upgrade'");
  });
  test('boot reconciles the breadcrumb and the tick attempts the channel', () => {
    expect(AUTOPILOT_SRC).toContain('reconcileSelfUpgradeAtBoot()');
    expect(AUTOPILOT_SRC).toContain('attemptAutopilotSelfUpgrade(engine, engineType, lockPath, () => !configurationBlocked())');
    expect(SELF_UPGRADE_SRC).toMatch(/if \(!mayContinue\(\)\) return;[\s\S]*?execSync\('(?:foresights|gbrain) upgrade --swap-only'/);
  });
  test('apply path unlinks the lock before exit so the relaunched binary does not self-exit on a stale lock', () => {
    // The exit-for-relaunch block unlinks lockPath then process.exit(0).
    expect(SELF_UPGRADE_SRC).toMatch(/unlinkSync\(lockPath\)[\s\S]{0,120}process\.exit\(0\)/);
  });
});

describe('reconcileSelfUpgradeAtBoot', () => {
  test('a relaunch onto a NEWER version than attempted is confirmed, prunes known-bad, and names both versions (#5813)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-su-boot-'));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await withEnv({ GBRAIN_HOME: dir, GBRAIN_AUDIT_DIR: join(dir, 'audit') }, () => {
        const configPath = join(dir, '.gbrain', 'config.json');
        mkdirSync(join(dir, '.gbrain'), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
          engine: 'pglite',
          self_upgrade: { mode: 'auto', attempting_version: '0.1.0.0', failed_versions: ['0.0.9.0'] },
        }));

        reconcileSelfUpgradeAtBoot();

        const su = JSON.parse(readFileSync(configPath, 'utf-8')).self_upgrade;
        expect(su.attempting_version).toBeUndefined();
        expect(su.last_applied_version).toBe(VERSION);
        expect(su.failed_versions).toBeUndefined();
        const events = readRecentSelfUpgrades(7);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ outcome: 'applied', current: VERSION, latest: '0.1.0.0' });
        const lines = log.mock.calls.map((args) => String(args[0]));
        expect(lines.some((l) => l.includes('0.1.0.0') && l.includes(VERSION))).toBe(true);
      });
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
