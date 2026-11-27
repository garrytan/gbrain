/**
 * #10536: `gbrain upgrade` (bun install) checks the release it just installed by running it. It used to look `gbrain` up
 * on PATH, so from a shell whose PATH lacks Bun's bin directory (a non-interactive bash, CI, bun added only to .zshrc) a
 * healthy upgrade failed its post-swap smoke with "Executable not found in $PATH", told the user to downgrade and left a
 * `post-swap-smoke` row that kept doctor's `upgrade_errors` warning up. The checks now run the installed binary in Bun's
 * bin directory by absolute path; a binary that really does not start still fails, records the row and names the way back.
 *
 * Spawned (not in-process): Bun snapshots PATH at process start for child-spawn lookup, so the stripped PATH has to be
 * the child's startup PATH. The test only spawns children with their own HOME and env, so it shares a process safely.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');
const NEW_VERSION = '9.9.9.9';
const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

/** A bun global install whose `gbrain` lives only in $BUN_INSTALL/bin, which the upgrade's PATH does not include. */
function upgradeWithoutBunBinOnPath(opts: { helpExit?: number; installGbrain?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-10536-'));
  homes.push(home);
  const bunInstall = join(home, '.bun');
  const bunBin = join(bunInstall, 'bin');
  const pathBin = join(home, 'path-bin');
  const pkg = join(bunInstall, 'install', 'global', 'node_modules', 'gbrain');
  mkdirSync(bunBin, { recursive: true });
  mkdirSync(pathBin);
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(bunInstall, 'install', 'global', 'package.json'), JSON.stringify({ dependencies: { gbrain: 'github:garrytan/gbrain' } }));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'gbrain', repository: { url: 'https://github.com/garrytan/gbrain' } }));
  const driver = join(pkg, 'src', 'cli.ts');
  writeFileSync(driver, `const { runUpgrade } = await import(${JSON.stringify(join(REPO, 'src/commands/upgrade.ts'))});\nawait runUpgrade(['--no-autopilot-install', '--no-bun-floor-check', '--no-restart']);\n`);
  writeFileSync(join(pathBin, 'bun'), `#!/bin/sh\nprintf 'bun:%s\\n' "$*" >> "$HOME/calls.log"\n`, { mode: 0o755 });
  if (opts.installGbrain !== false) {
    writeFileSync(join(bunBin, 'gbrain'), [
      '#!/bin/sh',
      'printf \'gbrain:%s\\n\' "$*" >> "$HOME/calls.log"',
      `if [ "$1" = '--version' ]; then echo 'gbrain ${NEW_VERSION}'; fi`,
      `if [ "$1" = '--help' ] && [ -n '${opts.helpExit ?? ''}' ]; then echo 'GBrain requires Bun 1.4.0 or newer (found Bun 1.3.14).' >&2; exit ${opts.helpExit ?? 0}; fi`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
  }
  const result = spawnSync(process.execPath, ['--no-env-file', driver], {
    cwd: home,
    env: { HOME: home, GBRAIN_HOME: home, BUN_INSTALL: bunInstall, PATH: `${pathBin}:/usr/bin:/bin`, GBRAIN_RELEASE_CHANNEL: 'alpha' },
    encoding: 'utf8', timeout: 60_000,
  });
  const errorsFile = join(home, '.gbrain', 'upgrade-errors.jsonl');
  return {
    status: result.status,
    out: result.stdout + result.stderr,
    calls: existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8') : '',
    errors: existsSync(errorsFile) ? readFileSync(errorsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
  };
}

describe('#10536 upgrade checks the installed gbrain by path, not through PATH', () => {
  test('a healthy upgrade from a shell without Bun\'s bin directory on PATH verifies, smokes and finishes with no upgrade error', () => {
    const run = upgradeWithoutBunBinOnPath();
    expect(run.status, run.out).toBe(0);
    expect(run.calls).toContain('bun:update --backend=copyfile gbrain');
    expect(run.out).toContain(`Upgrade complete. Now running: gbrain ${NEW_VERSION}`);
    expect(run.out).not.toContain('does not start');
    expect(run.out).not.toContain('Executable not found');
    expect(run.calls).toContain('gbrain:--help');
    expect(run.calls).toContain('gbrain:post-upgrade --no-autopilot-install');
    expect(run.out).toContain('Migrations: complete');
    expect(run.errors).toEqual([]);
  }, 90_000);

  test('an installed release that does not start still fails the smoke, records it and names the way back', () => {
    const run = upgradeWithoutBunBinOnPath({ helpExit: 1 });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain(`gbrain ${NEW_VERSION} was installed but does not start: \`gbrain --help\` failed (exit 1).`);
    expect(run.out).toContain('GBrain requires Bun 1.4.0 or newer (found Bun 1.3.14).');
    expect(run.out).toContain(`To return to ${VERSION}:`);
    expect(run.calls).not.toContain('gbrain:post-upgrade');
    expect(run.errors.at(-1)).toMatchObject({ phase: 'post-swap-smoke', from_version: VERSION, to_version: NEW_VERSION });
  }, 90_000);

  test('no gbrain anywhere is reported as not found, without advice to downgrade', () => {
    const run = upgradeWithoutBunBinOnPath({ installGbrain: false });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('found no gbrain executable to check that it starts');
    expect(run.out).not.toContain('does not start:');
    expect(run.out).not.toContain('To return to');
    expect(run.errors.at(-1)).toMatchObject({ phase: 'post-swap-smoke', from_version: VERSION });
  }, 90_000);
});
