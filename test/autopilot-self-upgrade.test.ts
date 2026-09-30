import { describe, expect, test } from 'bun:test';
import { generateSystemdUnit } from '../src/commands/autopilot.ts';
import { surfaceFileSource, surfaceSource } from './helpers/source-surface.ts';

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
    expect(AUTOPILOT_SRC).toContain("execSync('gbrain upgrade --swap-only'");
    // The tick must not invoke the (up-to-30-min) post-upgrade inline.
    expect(AUTOPILOT_SRC).not.toContain("execSync('gbrain post-upgrade'");
  });
  test('boot reconciles the breadcrumb and the tick attempts the channel', () => {
    expect(AUTOPILOT_SRC).toContain('reconcileSelfUpgradeAtBoot()');
    expect(AUTOPILOT_SRC).toContain('attemptAutopilotSelfUpgrade(engine, engineType, lockPath, () => !configurationBlocked())');
    expect(SELF_UPGRADE_SRC).toMatch(/if \(!mayContinue\(\)\) return;[\s\S]*?execSync\('gbrain upgrade --swap-only'/);
  });
  test('apply path unlinks the lock before exit so the relaunched binary does not self-exit on a stale lock', () => {
    // The exit-for-relaunch block unlinks lockPath then process.exit(0).
    expect(SELF_UPGRADE_SRC).toMatch(/unlinkSync\(lockPath\)[\s\S]{0,120}process\.exit\(0\)/);
  });
});
