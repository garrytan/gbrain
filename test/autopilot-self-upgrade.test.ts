import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateSystemdUnit } from '../src/commands/autopilot.ts';
import { drainUpgradeWorker, mayRetryUnchangedInstall, stopOnUpgradeReportFailure } from '../src/commands/autopilot-upgrade-runtime.ts';
import { VERSION } from '../src/version.ts';
import { withEnv } from './helpers/with-env.ts';

const AUTOPILOT_SRC = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');

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

describe('autopilot relaunch setup', () => {
  test('pending setup survives a lost config and blocks brain startup', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-pending-'));
    try {
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'autopilot-upgrade-pending'), JSON.stringify({ targetVersion: VERSION }));
      const result = spawnSync(process.execPath, ['--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'autopilot', '--repo', join(home, 'content')], {
        cwd: home,
        env: { HOME: home, GBRAIN_HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('post-upgrade setup failed');
      expect(result.stdout).not.toContain('Autopilot starting');
      expect(existsSync(join(home, '.gbrain', 'autopilot-upgrade-pending'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('staged official binary completes strict setup before bypassing a source guard', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-binary-recovery-'));
    try {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'source-upgrade-incomplete'), JSON.stringify({ repoRoot: '/tmp/fixture-source', targetVersion: VERSION }));
      const currentBinary = join(bin, 'gbrain-darwin-arm64');
      writeFileSync(currentBinary, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/calls.log"\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'gbrain'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
      const driver = join(home, 'driver.ts');
      writeFileSync(driver, `process.execPath = ${JSON.stringify(currentBinary)};\nconst { preflightAutopilotCommand } = await import(${JSON.stringify(join(import.meta.dir, '../src/commands/autopilot-upgrade.ts'))});\nconst { currentExitCode } = await import(${JSON.stringify(join(import.meta.dir, '../src/core/cli-force-exit.ts'))});\nconst result = preflightAutopilotCommand(['--repo', '/tmp/fixture']);\nconsole.log('HANDLED=' + result.handled);\nprocess.exit(currentExitCode());\n`);
      const run = () => spawnSync(process.execPath, ['--no-env-file', driver], {
        cwd: home,
        env: { HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
        encoding: 'utf8', timeout: 30_000,
      });
      const first = run();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('HANDLED=false');
      expect(readFileSync(join(home, 'calls.log'), 'utf8').trim()).toBe('post-upgrade --no-autopilot-install --strict');
      expect(JSON.parse(readFileSync(join(home, '.gbrain', 'source-upgrade-incomplete'), 'utf8')).recoveredBinaryVersion).toBe(VERSION);
      const second = run();
      expect(second.status, second.stderr).toBe(0);
      expect(readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test('incomplete source swap blocks boot before opening the brain', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-source-guard-'));
    try {
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'source-upgrade-incomplete'), 'interrupted\n');
      const result = spawnSync(process.execPath, ['--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'autopilot', '--repo', join(home, 'content')], {
        cwd: home,
        env: { HOME: home, GBRAIN_HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('source upgrade incomplete');
      expect(result.stdout).not.toContain('Autopilot starting');
      expect(existsSync(join(home, '.gbrain', 'source-upgrade-incomplete'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  for (const status of [0, 42]) {
    test(`pending upgrade runs post-upgrade before boot; child exit ${status}`, () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-upgrade-'));
      try {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        mkdirSync(join(home, '.gbrain'));
        writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
          engine: 'pglite', self_upgrade: { mode: 'auto', attempting_version: VERSION },
        }));
        const currentBinary = join(bin, 'gbrain-darwin-arm64');
        writeFileSync(currentBinary, '#!/bin/sh\nprintf "%s|%s\\n" "$*" "$GBRAIN_NO_AUTOPILOT_INSTALL" > "$HOME/calls.log"\nexit ' + status + '\n', { mode: 0o755 });
        const driver = join(home, 'driver.ts');
        writeFileSync(driver, `process.execPath = ${JSON.stringify(currentBinary)};\nconst { completePendingAutopilotUpgrade } = await import(${JSON.stringify(join(import.meta.dir, '../src/commands/autopilot-upgrade.ts'))});\nif (!completePendingAutopilotUpgrade()) process.exitCode = 1;\n`);
        const result = spawnSync(process.execPath, ['--no-env-file', driver], {
          cwd: home,
          env: { HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
          encoding: 'utf8', timeout: 30_000,
        });
        expect(result.status, result.stderr).toBe(status === 0 ? 0 : 1);
        expect(readFileSync(join(home, 'calls.log'), 'utf8').trim()).toBe('post-upgrade --no-autopilot-install --strict|1');
        // The breadcrumb is reconciled only after successful setup and engine start.
        expect(JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')).self_upgrade.attempting_version).toBe(VERSION);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test('CLI stops before opening the brain when post-upgrade fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-boot-'));
    try {
      mkdirSync(join(home, '.gbrain'));
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'pglite', database_path: join(home, 'db'),
        self_upgrade: { mode: 'auto', attempting_version: VERSION },
      }));
      const result = spawnSync(process.execPath, ['--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'autopilot', '--repo', join(home, 'content')], {
        cwd: home,
        env: { HOME: home, GBRAIN_HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_POST_UPGRADE_TIMEOUT_MS: '1' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('post-upgrade setup failed');
      expect(result.stdout).not.toContain('Autopilot starting');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('autopilot self-upgrade static-shape regressions', () => {
  test('supervisor-relaunch, NOT in-process re-exec (Bun has no execve) — no exec*-call', () => {
    // Match call-shape, not the word (the comments legitimately say "no execve").
    expect(AUTOPILOT_SRC).not.toMatch(/execve\s*\(/);
    expect(AUTOPILOT_SRC).not.toMatch(/execvp\s*\(/);
  });
  test('the silent channel does swap-only, never a blocking full post-upgrade in the tick', () => {
    expect(AUTOPILOT_SRC).toContain("currentCliInvocation(['upgrade', '--swap-only', '--no-autopilot-install'])");
    expect(AUTOPILOT_SRC).toContain('GBRAIN_UPGRADE_TARGET_VERSION: latestVersion');
    // The tick must not invoke the (up-to-30-min) post-upgrade inline.
    expect(AUTOPILOT_SRC).not.toContain("execSync('gbrain post-upgrade'");
  });
  test('boot reconciles the breadcrumb and the tick attempts the channel', () => {
    expect(AUTOPILOT_SRC).toContain('reconcileSelfUpgradeAtBoot()');
    expect(AUTOPILOT_SRC).toContain('attemptAutopilotSelfUpgrade(engine, engineType, lockPath,');
  });
  test('apply path unlinks the lock before exit so the relaunched binary does not self-exit on a stale lock', () => {
    // The exit-for-relaunch block unlinks lockPath then process.exit(0).
    expect(AUTOPILOT_SRC).toMatch(/unlinkSync\(lockPath\)[\s\S]{0,120}process\.exit\(0\)/);
  });
});

test('managed worker is drained before an unattended swap', async () => {
  const events: string[] = [];
  let alive = true;
  const worker = {
    get childAlive() { return alive; },
    killChild(signal: string) { events.push(signal); },
    async awaitChildExit(timeout: number) {
      events.push(`wait:${timeout}`);
      if (timeout === 35_000) alive = false;
    },
  } as unknown as NonNullable<Parameters<typeof drainUpgradeWorker>[0]>;
  await drainUpgradeWorker(worker);
  expect(events).toEqual(['SIGTERM', 'wait:35000']);
});

test('worker drain waits for SIGKILL and refuses a surviving child', async () => {
  const events: string[] = [];
  let alive = true;
  const worker = {
    get childAlive() { return alive; },
    killChild(signal: string) { events.push(signal); },
    async awaitChildExit(timeout: number) {
      events.push(`wait:${timeout}`);
      if (timeout === 5_000) alive = false;
    },
  } as unknown as NonNullable<Parameters<typeof drainUpgradeWorker>[0]>;
  await drainUpgradeWorker(worker);
  expect(events).toEqual(['SIGTERM', 'wait:35000', 'SIGKILL', 'wait:5000']);
  alive = true;
  worker.awaitChildExit = async () => {};
  await expect(drainUpgradeWorker(worker)).rejects.toThrow('managed worker did not stop');
});

test('failed package-manager swaps require repair, while unchanged atomic swaps may retry', () => {
  expect(mayRetryUnchangedInstall('binary')).toBe(true);
  expect(mayRetryUnchangedInstall('bun-link')).toBe(true);
  expect(mayRetryUnchangedInstall('bun')).toBe(false);
  expect(mayRetryUnchangedInstall('clawhub')).toBe(false);
});

test('a failed error-report write still stops on an incomplete swap marker', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-error-guard-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, () => {
      mkdirSync(join(home, '.gbrain'));
      expect(stopOnUpgradeReportFailure()).toBe(false);
      expect(stopOnUpgradeReportFailure(true)).toBe(true);
      writeFileSync(join(home, '.gbrain', 'source-upgrade-incomplete'), '{}');
      expect(stopOnUpgradeReportFailure()).toBe(true);
      rmSync(join(home, '.gbrain', 'source-upgrade-incomplete'));
      writeFileSync(join(home, '.gbrain', 'autopilot-upgrade-pending'), '{}');
      expect(stopOnUpgradeReportFailure()).toBe(true);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
