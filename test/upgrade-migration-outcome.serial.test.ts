/**
 * #5693: `gbrain upgrade` owns migrations through post-upgrade, so package
 * postinstall defers them; an install that failed after the version swapped
 * is reported as installed; and the run ends with separate binary and
 * migration lines (complete, running with the holder, or failed with the
 * recovery command).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');
const NEWER = VERSION.split('.').map((part, i) => (i === 2 ? String(Number(part) + 1) : part)).join('.');

function runUpgradeHarness(opts: { bunExit?: number; postUpgradeExit?: number; config?: object; setup?: (home: string) => void }) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-outcome-'));
  const bin = join(home, 'bin');
  const pkg = join(home, 'node_modules', 'gbrain');
  mkdirSync(bin);
  mkdirSync(join(pkg, 'src'), { recursive: true });
  mkdirSync(join(home, '.bun', 'install', 'global'), { recursive: true });
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  if (opts.config) writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(opts.config));
  opts.setup?.(home);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'gbrain', repository: { url: 'https://github.com/garrytan/gbrain' } }));
  const driver = join(pkg, 'src', 'cli.ts');
  writeFileSync(driver, `const { runUpgrade } = await import(${JSON.stringify(join(REPO, 'src/commands/upgrade.ts'))});\nawait runUpgrade([]);\n`);
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\nprintf 'bun:%s:owns=%s\\n' "$*" "$GBRAIN_UPGRADE_OWNS_MIGRATIONS" >> "$HOME/calls.log"\n${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO, 'scripts/postinstall.ts'))}\nexit ${opts.bunExit ?? 0}\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nprintf 'gbrain:%s\\n' "$*" >> "$HOME/calls.log"\nif [ "$1" = '--version' ]; then echo 'gbrain ${NEWER}'; fi\nif [ "$1" = 'post-upgrade' ]; then exit ${opts.postUpgradeExit ?? 0}; fi\nexit 0\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, ['--no-env-file', driver], {
    cwd: home,
    env: { HOME: home, GBRAIN_HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8', timeout: 60_000,
  });
  const calls = readFileSync(join(home, 'calls.log'), 'utf8');
  rmSync(home, { recursive: true, force: true });
  return { status: result.status, out: result.stdout + result.stderr, calls };
}

describe('gbrain upgrade migration ownership and outcome (#5693)', () => {
  test('package postinstall under upgrade defers migrations to post-upgrade', () => {
    const r = runUpgradeHarness({});
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContain('bun:update gbrain:owns=1');
    expect(r.calls).not.toContain('gbrain:apply-migrations');
    expect(r.calls).toContain('gbrain:post-upgrade');
    expect(r.out).toContain(`Binary: installed ${NEWER}`);
    expect(r.out).toContain('Migrations: complete');
  });

  test('an install that failed after the version swapped reports the upgrade as installed', () => {
    const r = runUpgradeHarness({ bunExit: 1 });
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain('Upgrade failed');
    expect(r.calls).toContain('gbrain:post-upgrade');
    expect(r.out).toContain(`Binary: installed ${NEWER}`);
  });

  test('a migration failure after a successful swap prints the failure line with its command', () => {
    const r = runUpgradeHarness({ postUpgradeExit: 1 });
    expect(r.out).toContain(`Binary: installed ${NEWER}`);
    expect(r.out).toContain('Migrations: failed');
    expect(r.out).toContain('gbrain apply-migrations --yes');
    expect(r.out).not.toMatch(/^Upgrade succeeded/m);
  });

  test('a competing runner is reported as running with its host and pid, not as a failed upgrade', () => {
    const r = runUpgradeHarness({
      postUpgradeExit: 75,
      config: { engine: 'pglite', database_path: '/tmp/gbrain-upgrade-outcome-brain.pglite' },
      setup: () => writeFileSync('/tmp/gbrain-upgrade-outcome-brain.pglite.gbrain-migrations.json', JSON.stringify({ host: 'host-a', pid: 4242 })),
    });
    rmSync('/tmp/gbrain-upgrade-outcome-brain.pglite.gbrain-migrations.json', { force: true });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`Binary: installed ${NEWER}`);
    expect(r.out).toContain('Migrations: running (host host-a, pid 4242)');
    expect(r.out).not.toContain('Migrations: failed');
  });
});
