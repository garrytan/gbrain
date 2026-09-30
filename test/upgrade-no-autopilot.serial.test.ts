import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');

describe('upgrade autopilot opt-out propagation', () => {
  test('upgrade forwards the opt-out through package postinstall and post-upgrade', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-optout-'));
    try {
      const bin = join(home, 'bin');
      const pkg = join(home, 'node_modules', 'gbrain');
      mkdirSync(bin);
      mkdirSync(join(pkg, 'src'), { recursive: true });
      mkdirSync(join(home, '.bun', 'install', 'global'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'gbrain', repository: { url: 'https://github.com/garrytan/gbrain' } }));
      const driver = join(pkg, 'src', 'cli.ts');
      writeFileSync(driver, `const { runUpgrade } = await import(${JSON.stringify(join(REPO, 'src/commands/upgrade.ts'))});\nawait runUpgrade(['--no-autopilot-install']);\n`);
      writeFileSync(join(bin, 'bun'), `#!/bin/sh\nprintf 'bun:%s:no-autopilot=%s\\n' "$*" "$GBRAIN_NO_AUTOPILOT_INSTALL" >> "$HOME/calls.log"\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO, 'scripts/postinstall.ts'))}\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nprintf 'gbrain:%s:no-autopilot=%s\\n' "$*" "$GBRAIN_NO_AUTOPILOT_INSTALL" >> "$HOME/calls.log"\nif [ "$1" = '--version' ]; then echo 'gbrain ${VERSION}'; fi\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, ['--no-env-file', driver], {
        cwd: home,
        env: { HOME: home, GBRAIN_HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: `${bin}:/usr/bin:/bin` },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const calls = readFileSync(join(home, 'calls.log'), 'utf8');
      expect(calls).toContain('bun:update gbrain:no-autopilot=1');
      expect(calls).toContain('gbrain:apply-migrations --yes --non-interactive:no-autopilot=1');
      expect(calls).toContain('gbrain:post-upgrade --no-autopilot-install:no-autopilot=1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('post-upgrade passes the opt-out to migrations without rewriting an existing service', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-post-upgrade-optout-'));
    try {
      const driver = join(home, 'driver.ts');
      const unitPath = join(home, '.config', 'systemd', 'user', 'gbrain-autopilot.service');
      const unit = 'Description=GBrain Autopilot\nExecStart=/example/start.sh\nRestart=on-failure\nStandardOutput=append:%h/.gbrain/autopilot.log\n';
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, unit);
      const bin = join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho called > "$HOME/unexpected-service.log"\nexit 91\n', { mode: 0o755 });
      writeFileSync(driver, `import { mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
mock.module(${JSON.stringify(join(REPO, 'src/commands/apply-migrations.ts'))}, () => ({
  runApplyMigrations: async (args) => writeFileSync(${JSON.stringify(join(home, 'args.json'))}, JSON.stringify(args)),
}));
const { runPostUpgrade } = await import(${JSON.stringify(join(REPO, 'src/commands/upgrade.ts'))});
await runPostUpgrade(['--no-autopilot-install']);
`);
      const result = spawnSync(process.execPath, ['--no-env-file', driver], {
        cwd: home,
        env: { HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, GBRAIN_SKIP_REFERENCE_SWEEP: '1' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(readFileSync(join(home, 'args.json'), 'utf8'))).toEqual(['--yes', '--non-interactive', '--no-autopilot-install']);
      expect(readFileSync(unitPath, 'utf8')).toBe(unit);
      expect(existsSync(join(home, 'unexpected-service.log'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
